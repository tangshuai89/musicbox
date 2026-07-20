import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '../common/config';
import { StorageService } from '../common/storage';
import { Session, SessionService } from '../common/session';
import { MusicService } from '../music/music.service';
import { normalizeKey } from '../music/search.util';
import type { UnifiedSearchItem } from '../music/types';

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat';
/** 每次 run 喂给模型的「口味档案」采样规模。不再固定取前 N——从全库随机采样
 *  这么多首，既控 token 又让每次 run 换一批种子（避免推荐同质化）。 */
const LIBRARY_SAMPLE_SIZE = 150;
/** prompt 里额外点名的「高频歌手」条数——给模型更强的口味锚点。 */
const TOP_ARTISTS_HINT = 8;
/** 向模型「超额要」的倍数：dedup + 匹配校验会滤掉一部分，多要一些兜底，
 *  保证最终能凑够 count。上限 40 防 token 爆 / 响应过长。 */
const OVERASK_FACTOR = 2;
const OVERASK_MAX = 40;
/** fillPlatforms 每波并行搜索的额外余量（need + 这个数），补匹配失败的坑。 */
const FILL_WAVE_SLACK = 3;
/** fillPlatforms 单波最大并发搜索数。每个 searchUnified 会并行打 4 个平台，
 *  所以这里压住并发，避免几十个请求同时砸 netease/QQ 触发「操作频繁」限流。 */
const FILL_CONCURRENCY = 6;
/** 每 session「最近推荐过」历史上限——手动连点推荐也据此自动去重复读。 */
const RECO_HISTORY_MAX = 200;
/** DeepSeek chat 补全的硬超时——LLM 偶尔卡很久，25s 后 abort。 */
const RECOMMEND_TIMEOUT_MS = 25_000;

/** 用户填的 key 存哪。 */
const SECRETS_KEY = 'secrets:deepseek';

/** 解析后的推荐条目（先只有 title + artist，等下拿这俩去搜真实平台）。 */
export interface RecoRawItem {
  title: string;
  artist: string;
  reason?: string;
}

/** Reco 响应。 */
export interface RecoResult {
  items: UnifiedSearchItem[];
  model: string;
  runAt: number;
  /** 调试用：模型原始响应，方便排查 prompt 调优。 */
  raw: string;
}

interface DeepSeekChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; type?: string };
}

@Injectable()
export class RecoService {
  private readonly logger = new Logger(RecoService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly sessionService: SessionService,
    private readonly musicService: MusicService,
  ) {}

  // ── Key 管理 ────────────────────────────────────────────

  /**
   * 把用户填的 key 写到 .storage/secrets.json（git-ignored）。
   * 同时 process.env.DEEPSEEK_API_KEY 同步设上，方便当次会话立刻用。
   * ⚠️ 不进任何日志——logger 只记 key 末 4 位。
   */
  setApiKey(apiKey: string): { ok: true; tail: string } {
    if (!apiKey || apiKey.length < 8) {
      throw new BadRequestException('apiKey 太短');
    }
    const tail = apiKey.slice(-4);
    this.storage.set(SECRETS_KEY, { apiKey });
    process.env.DEEPSEEK_API_KEY = apiKey;
    this.logger.log(`DeepSeek key set (tail=${tail})`);
    return { ok: true, tail };
  }

  /** 探测当前是否已设 key（不返回 key 本身）。 */
  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  /** 拿 key。优先 process.env（容器部署用），回退到 storage。 */
  private getApiKey(): string | null {
    const fromEnv = process.env.DEEPSEEK_API_KEY;
    if (fromEnv && fromEnv.length >= 8) return fromEnv;
    const stored = this.storage.get<{ apiKey?: string }>(SECRETS_KEY);
    return stored?.apiKey ?? null;
  }

  // ── 状态查询 ────────────────────────────────────────────

  status(session: Session): { configured: boolean; librarySize: number } {
    const lib = this.musicService.getLibrary(session);
    return { configured: this.isConfigured(), librarySize: lib?.items.length ?? 0 };
  }

  // ── 主体：跑一次推荐 ────────────────────────────────────

  async run(
    session: Session,
    opts: {
      count?: number;
      language?: string;
      mood?: string;
      /** 额外排除的歌（在库排除之外）。auto-continue 用它避免续播复读上一批。 */
      exclude?: Array<{ title: string; artist: string }>;
    } = {},
  ): Promise<RecoResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new HttpException(
        'deepseek_key_not_configured',
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    const lib = this.musicService.getLibrary(session);
    if (!lib || lib.items.length === 0) {
      throw new BadRequestException('library_empty：先 POST /music/library/import');
    }

    const count = Math.min(Math.max(opts.count ?? 10, 1), 30);
    // #4 超额要：dedup + 匹配校验会滤掉一部分，多要一些，最后 fill 到 count 为止。
    const askCount = Math.min(count * OVERASK_FACTOR, OVERASK_MAX);

    // #5 排除集合 = 前端传的（auto-continue 队列里的歌）∪ 本 session 最近推荐过
    // 的历史。后者让「手动连点推荐」也不复读（前端不带 exclude 也能去重）。
    const history = this.loadRecoHistory(session);
    const exclude = this.mergeExclude(opts.exclude, history);

    // #3 从全库随机采样一批当种子（而非固定前 N）→ 每次 run 口味档案不同，
    // 长库（1000+）里靠后的歌也有机会影响推荐，缓解同质化。
    const librarySample = this.sampleLibrary(lib.items, LIBRARY_SAMPLE_SIZE);
    // #6 高频歌手锚点：从**全库**统计（不只采样），给模型更稳的口味信号。
    const topArtists = this.topArtists(lib.items, TOP_ARTISTS_HINT);

    const prompt = this.buildPrompt(librarySample, {
      count: askCount,
      language: opts.language,
      mood: opts.mood,
      exclude,
      topArtists,
    });
    const raw = await this.callDeepSeek(apiKey, prompt);
    const rawItems = this.parseRecommendations(raw);
    const deduped = this.dedupAgainstLibrary(rawItems, lib.items, exclude);
    const filled = await this.fillPlatforms(session, deduped, count);

    // #5 记录本次真正产出的歌进历史（用平台侧规范名；normalizeKey 足够模糊，
    // 下次能和模型的命名对上），供后续 run 去重。
    if (filled.length) {
      this.saveRecoHistory(session, [
        ...history,
        ...filled.map((it) => ({ title: it.title, artist: it.artist })),
      ]);
    }

    return {
      items: filled,
      model: DEEPSEEK_MODEL,
      runAt: Date.now(),
      raw: raw.slice(0, 4000), // 截断防爆
    };
  }

  // ── prompt 拼装 ─────────────────────────────────────────

  private buildPrompt(
    library: UnifiedSearchItem[],
    opts: {
      count: number;
      language?: string;
      mood?: string;
      exclude?: Array<{ title: string; artist: string }>;
      topArtists?: string[];
    },
  ): Array<{ role: 'system' | 'user'; content: string }> {
    const libList = library
      .map(
        (it, i) =>
          `${i + 1}. ${it.title} - ${it.artist}` +
          (it.album ? ` (${it.album})` : ''),
      )
      .join('\n');

    // #6 更强的规则：正名/原文歌手/排除翻唱·live·remix·伴奏，降低 fill 阶段
    // 搜到错版本 / 搜不到的概率。
    const system = `你是一个资深音乐推荐助手。用户会给你他喜欢的 ${library.length} 首歌（口味采样），
你要据此推荐 ${opts.count} 首他**尚未听过**、**风格/氛围相近但有惊喜**的歌曲。
硬性要求：
1. 严格输出 JSON 数组，不要任何解释文字或 markdown 围栏
2. 每项 { "title": "歌名", "artist": "歌手", "reason": "一句为什么(简短中文)" }
3. 不要推荐库里已有的歌，不要在本次结果内重复
4. 只推荐**真实存在、正式发行**的歌，用户能在 QQ音乐/网易云/Deezer 搜到
5. title 用官方原名、artist 用**原文**（日文/英文歌手别翻译成中文），方便精确搜索
6. 默认推荐**录音室原版**：不要 live/翻唱/remix/伴奏/纯音乐版本（除非用户库里本就偏好这类）
7. 宁可少推也不要编造不存在的歌`;

    const lang = opts.language && opts.language !== 'auto'
      ? `语言偏好：${opts.language === 'zh' ? '中文' : opts.language === 'en' ? '英文' : opts.language === 'ja' ? '日文' : opts.language}`
      : '语言不限';
    const mood = opts.mood ? `当前心情：${opts.mood}` : '';
    // #6 高频歌手锚点：明确点名用户最常听的歌手，让「风格相近」更贴脸。
    const anchor =
      opts.topArtists && opts.topArtists.length
        ? `\n我最常听的歌手：${opts.topArtists.join('、')}（可推荐他们的其它歌或相近风格的其他歌手）`
        : '';
    // auto-continue / 历史：把最近已推荐过的歌喂给模型，明确要求避开，提升新
    // 批次的产出率（否则 temperature 再高也可能重复，被后置 dedup 滤成不足 count）。
    const avoid =
      opts.exclude && opts.exclude.length
        ? `\n\n以下歌曲最近已经推荐过，请**不要再推荐**：\n${opts.exclude
            .slice(-50)
            .map((e) => `- ${e.title} - ${e.artist}`)
            .join('\n')}`
        : '';
    const user = `我的口味库（采样）：\n${libList}${anchor}\n\n${lang}\n${mood}${avoid}\n\n请按 JSON 数组输出 ${opts.count} 首推荐。`;

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  /** 从全库随机采样 n 首当口味种子（部分 Fisher-Yates，O(n)）。库 ≤ n 时原样
   *  返回。每次 run 随机 → 口味档案不僵化、长库靠后的歌也能进 prompt（#3）。 */
  private sampleLibrary(
    items: UnifiedSearchItem[],
    n: number,
  ): UnifiedSearchItem[] {
    if (items.length <= n) return items;
    const copy = items.slice();
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (copy.length - i));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }

  /** 全库里出现次数最多的前 n 个歌手（去空白）。用作 prompt 的口味锚点（#6）。 */
  private topArtists(items: UnifiedSearchItem[], n: number): string[] {
    const count = new Map<string, number>();
    for (const it of items) {
      const a = it.artist?.trim();
      if (!a) continue;
      count.set(a, (count.get(a) ?? 0) + 1);
    }
    return [...count.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, n)
      .map(([a]) => a);
  }

  // ── DeepSeek 调用 ───────────────────────────────────────

  private async callDeepSeek(
    apiKey: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
  ): Promise<string> {
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RECOMMEND_TIMEOUT_MS);
      try {
        res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages,
            temperature: 0.9,
            response_format: { type: 'json_object' },
          }),
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.logger.error(`deepseek fetch failed: ${(err as Error).message}`);
      throw new HttpException(
        'deepseek_unreachable',
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (res.status === 429) {
      // 之前抛的是普通 Error（非 HttpException），NestJS 默认过滤器会把它
      // 变成 500——客户端拿不到真正的 429，也丢了 Retry-After。改抛 429。
      const ra = Number(res.headers.get('retry-after'));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'deepseek_rate_limit',
          message: 'DeepSeek 频率限制，请稍后重试',
          retryAfterSec: Number.isFinite(ra) ? ra : undefined,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (res.status >= 500) {
      this.logger.error(`deepseek 5xx: ${res.status}`);
      throw new HttpException('deepseek_upstream_5xx', HttpStatus.BAD_GATEWAY);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`deepseek ${res.status}: ${text.slice(0, 200)}`);
      throw new HttpException(
        `deepseek_${res.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data = (await res.json()) as DeepSeekChatResponse;
    if (data.error?.message) {
      this.logger.error(`deepseek error: ${data.error.message}`);
      throw new HttpException(
        `deepseek_error: ${data.error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    return data.choices?.[0]?.message?.content ?? '';
  }

  // ── 响应解析（带 retry: 围栏 / 整体 JSON 两种） ─────────

  private parseRecommendations(raw: string): RecoRawItem[] {
    // strategy 1: 整体就是 JSON
    try {
      const parsed = JSON.parse(raw);
      return this.extractArray(parsed);
    } catch {
      // fall through
    }
    // strategy 2: ```json ... ``` 围栏
    const fence = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
    if (fence) {
      try {
        return this.extractArray(JSON.parse(fence[1]));
      } catch {
        // fall through
      }
    }
    // 之前还有 strategy 3（找首个 [ ... ] 块）——它会被模型输出里的任何
    // 方括号噪声污染（explanations / 引用标记 / 多段输出），slice 出来
    // 不是合法 JSON 时直接抛，对 retry 没帮助。删掉。
    this.logger.warn(`recommend parse failed, raw: ${raw.slice(0, 200)}`);
    throw new BadRequestException('recommend_parse_failed: 模型响应无法解析');
  }

  /** 把可能的 { items: [...] } / 直接 [...] / 单个 object 都规整成数组。 */
  private extractArray(parsed: unknown): RecoRawItem[] {
    if (Array.isArray(parsed)) return parsed as RecoRawItem[];
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['items', 'recommendations', 'songs', 'tracks', 'data']) {
        if (Array.isArray(obj[key])) return obj[key] as RecoRawItem[];
      }
    }
    throw new Error('not an array');
  }

  // ── 推荐去重：和库 + 自己内部 ───────────────────────────

  private dedupAgainstLibrary(
    raw: RecoRawItem[],
    library: UnifiedSearchItem[],
    exclude?: Array<{ title: string; artist: string }>,
  ): RecoRawItem[] {
    // #7 统一复用 search.util 的 normalizeKey（含全角→半角），和搜索/匹配同口径，
    // 堵住全角/半角变体漏去重（之前 dedup 用的是另一套简化归一）。
    const seen = new Set<string>();
    for (const it of library) seen.add(normalizeKey(it.title, it.artist));
    // auto-continue / 历史：把已推荐过的也当作"库"排除，避免续播/连点复读。
    for (const it of exclude ?? []) seen.add(normalizeKey(it.title, it.artist));
    const result: RecoRawItem[] = [];
    for (const r of raw) {
      if (!r.title || !r.artist) continue;
      const k = normalizeKey(r.title, r.artist);
      if (seen.has(k)) continue;
      seen.add(k);
      result.push(r);
    }
    return result;
  }

  /** 合并前端 exclude（auto-continue 队列）与 session 历史，去重成一个列表。 */
  private mergeExclude(
    front: Array<{ title: string; artist: string }> | undefined,
    history: Array<{ title: string; artist: string }>,
  ): Array<{ title: string; artist: string }> {
    const seen = new Set<string>();
    const out: Array<{ title: string; artist: string }> = [];
    for (const e of [...history, ...(front ?? [])]) {
      if (!e?.title || !e?.artist) continue;
      const k = normalizeKey(e.title, e.artist);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ title: e.title, artist: e.artist });
    }
    return out;
  }

  // ── 最近推荐历史（每 session，手动连点也据此去重复读）─────
  private historyKey(sessionId: string): string {
    return `reco:history:${sessionId}`;
  }

  private loadRecoHistory(
    session: Session,
  ): Array<{ title: string; artist: string }> {
    const h = this.storage.get<Array<{ title: string; artist: string }>>(
      this.historyKey(session.id),
    );
    return Array.isArray(h) ? h : [];
  }

  private saveRecoHistory(
    session: Session,
    items: Array<{ title: string; artist: string }>,
  ): void {
    // 保留最近 RECO_HISTORY_MAX 首（按加入顺序，旧的先淘汰）。
    this.storage.set(
      this.historyKey(session.id),
      items.slice(-RECO_HISTORY_MAX),
    );
  }

  // ── 拿推荐 → 走 P0 统一搜索填实平台 ────────────────────

  /**
   * 把模型推荐的「歌名+歌手」逐条走统一搜索，回填成可播放的 UnifiedSearchItem。
   *
   * #2 并行 + #4 补位：一波并行搜 `need + slack` 条（need=还差几首），命中的按
   * **原始顺序**收下；不够就用下一波候选补，直到凑够 wantCount 或候选用尽。这
   * 比原来的串行 for-await 快得多（总耗时从 Σ 降到 max），且不足时会自动往后取。
   *
   * #1 匹配校验：不再无脑取 items[0]——在候选里找**真的等于推荐那首**的
   * （先精确 normalizeKey 相等，再退化到歌名+歌手双向包含），都不匹配就丢弃，
   * 避免把同名翻唱 / live / 纯音乐 / 甚至完全不相关的首条当成推荐塞进队列。
   */
  private async fillPlatforms(
    session: Session,
    items: RecoRawItem[],
    wantCount: number,
  ): Promise<UnifiedSearchItem[]> {
    const out: UnifiedSearchItem[] = [];
    let cursor = 0;
    while (out.length < wantCount && cursor < items.length) {
      const need = wantCount - out.length;
      // 多搜一点余量补掉匹配失败/搜空的坑；但压在并发上限内，别一次砸太多。
      const waveSize = Math.min(
        items.length - cursor,
        need + FILL_WAVE_SLACK,
        FILL_CONCURRENCY,
      );
      const wave = items.slice(cursor, cursor + waveSize);
      cursor += waveSize;
      // Promise.all 保序 → 命中按推荐原始顺序进 out。
      const matched = await Promise.all(
        wave.map((r) => this.searchAndMatch(session, r)),
      );
      for (const m of matched) {
        if (m && out.length < wantCount) out.push(m);
      }
    }
    return out;
  }

  /**
   * "坏版本"标记：DJ/remix/伴奏/加速/抖音/翻唱/纯音乐… 这类**没人想循环听**的
   * 二次加工版本。命中 → 强惩罚（PEN_BAD），除非用户/模型本就点名要这个版本。
   * ⚠️ 只扫 title，不扫 artist——避免误伤 "DJ Okawari" 这类合法艺人名。
   */
  private static readonly VERSION_BAD: RegExp[] = [
    /\bdj\b/i, /re-?mix/i, /mash-?up/i, /bootleg/i, /nightcore/i,
    /sped ?-?up/i, /slowed/i, /8-?bit/i, /\b[38]d\b/i,
    /伴奏/, /纯音乐|純音樂/, /off ?vocal/i, /instrumental/i, /karaoke/i, /\bktv\b/i,
    /加速/, /减速|減速/, /慢摇|慢搖/, /抖音/, /tik ?tok/i, /钢琴(版|曲)|鋼琴(版|曲)/,
    /八音盒/, /翻唱|翻自|\bcover\b/i, /清唱|a-?ca?pella/i, /\bdemo\b/i, /重混/,
  ];
  /** "可接受但非首选"：live/现场/acoustic。用户认可，但有录音室原版时让原版优先。 */
  private static readonly VERSION_SOFT: RegExp[] = [
    /\blive\b/i, /现场|現場/, /\bacoustic\b/i, /演唱会|演唱會/, /concert/i, /unplugged/i,
  ];
  private static readonly PEN_BAD = 100;
  private static readonly PEN_SOFT = 10;

  /** 版本纯净度惩罚：录音室原版 0 < live/现场 10 << DJ/remix/伴奏… 100。 */
  private versionPenalty(title: string): number {
    const t = (title ?? '').toLowerCase();
    if (RecoService.VERSION_BAD.some((re) => re.test(t))) {
      return RecoService.PEN_BAD;
    }
    if (RecoService.VERSION_SOFT.some((re) => re.test(t))) {
      return RecoService.PEN_SOFT;
    }
    return 0;
  }

  /**
   * 单条推荐：统一搜索 → 在匹配上的候选里**挑最"正常"的版本**，命中返回带
   * reason 的 UnifiedSearchItem，否则返回 null（搜不到 / 无匹配 / 只有坏版本 →
   * 交给上层补位换一首）。
   *
   * 挑选打分（升序取最小）：
   *  1. 版本惩罚（录音室 0 < live 10 << DJ/remix/伴奏 100）——修「晴天搜出 DJ 版」；
   *  2. 非精确匹配排后（歌名+歌手完全一致优先）；
   *  3. 归一标题更短优先（越接近原名，变体后缀越少）。
   * 若最优仍是"坏版本"（≥PEN_BAD）且用户没点名要 → 返回 null（"没人想听 DJ 版"，
   * 宁可让上层补位换一首正常的歌）。用户 rec 自己点名了版本（remix/live…）则豁免。
   */
  private async searchAndMatch(
    session: Session,
    r: RecoRawItem,
  ): Promise<UnifiedSearchItem | null> {
    const q = `${r.title} ${r.artist}`;
    try {
      // 多取一些候选（15），才有机会在一堆 DJ/加速版里捞到录音室原版。
      const res = await this.musicService.searchUnified(session, q, 1, 15);
      const wantKey = normalizeKey(r.title, r.artist);
      // 只保留能播（有 bestSource）且确实是这首歌的候选。
      const candidates = res.items.filter(
        (it) =>
          it.bestSource &&
          (normalizeKey(it.title, it.artist) === wantKey ||
            this.looseMatch(r, it)),
      );
      if (!candidates.length) return null;
      // 用户/模型自己就点名要某版本（rec.title 里带 remix/live…）→ 不惩罚版本。
      const waived = this.versionPenalty(r.title) > 0;
      const scored = candidates
        .map((it) => ({
          it,
          pen: waived ? 0 : this.versionPenalty(it.title),
          notExact: normalizeKey(it.title, it.artist) === wantKey ? 0 : 1,
          len: normalizeKey(it.title, '').length,
        }))
        .sort(
          (a, b) => a.pen - b.pen || a.notExact - b.notExact || a.len - b.len,
        );
      const best = scored[0];
      // 最优仍是坏版本（DJ/remix/伴奏…）且没被豁免 → 丢弃，换一首正常歌。
      if (best.pen >= RecoService.PEN_BAD) return null;
      return {
        ...best.it,
        // reason 塞进 album 字段是 hack，UI 在 source 描述里看。
        album: r.reason ? `${best.it.album} · ${r.reason}` : best.it.album,
      };
    } catch (err) {
      this.logger.warn(`reco fill failed for "${q}": ${(err as Error).message}`);
      return null;
    }
  }

  /** 宽松匹配：歌名双向包含（"感電" vs "感電 (…)"）+ 歌手双向包含（放宽 feat/
   *  合唱差异；歌名已是主锚）。用于精确归一不相等时的兜底，拦掉不相关首条。 */
  private looseMatch(r: RecoRawItem, item: UnifiedSearchItem): boolean {
    const rt = normalizeKey(r.title, '');
    const it = normalizeKey(item.title, '');
    if (!rt || !it) return false;
    const titleOk = it.includes(rt) || rt.includes(it);
    if (!titleOk) return false;
    const ra = normalizeKey(r.artist, '');
    const ia = normalizeKey(item.artist, '');
    // 歌手任一为空 → 只认歌名；否则要求双向包含（拦掉别人翻唱的同名歌）。
    return !ra || !ia || ia.includes(ra) || ra.includes(ia);
  }
}

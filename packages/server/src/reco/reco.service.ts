import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '../common/config';
import { StorageService } from '../common/storage';
import { Session, SessionService } from '../common/session';
import { MusicService } from '../music/music.service';
import type { UnifiedSearchItem } from '../music/types';

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat';
/** 喂 prompt 的库歌曲上限——超过就截前 200 节省 token。 */
const LIBRARY_PROMPT_LIMIT = 200;
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

/** 429 / 5xx 用。NestJS 自带 ServiceUnavailableException 不够用，自己抛。 */
class RateLimitError extends Error {
  retryAfterSec?: number;
  constructor(message: string, retryAfterSec?: number) {
    super(message);
    this.retryAfterSec = retryAfterSec;
  }
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
    opts: { count?: number; language?: string; mood?: string } = {},
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
    const librarySlice = lib.items.slice(0, LIBRARY_PROMPT_LIMIT);
    const prompt = this.buildPrompt(librarySlice, {
      count,
      language: opts.language,
      mood: opts.mood,
    });
    const raw = await this.callDeepSeek(apiKey, prompt);
    const rawItems = this.parseRecommendations(raw);
    const deduped = this.dedupAgainstLibrary(rawItems, lib.items);
    const filled = await this.fillPlatforms(session, deduped, count);

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
    opts: { count: number; language?: string; mood?: string },
  ): Array<{ role: 'system' | 'user'; content: string }> {
    const libList = library
      .map(
        (it, i) =>
          `${i + 1}. ${it.title} - ${it.artist}` +
          (it.album ? ` (${it.album})` : ''),
      )
      .join('\n');

    const system = `你是一个音乐推荐助手。用户会给你他最近喜欢的 ${library.length} 首歌，
你需要根据这份"口味档案"推荐 ${opts.count} 首他**尚未听过**、**风格相近但有惊喜**的歌曲。
要求：
1. 严格输出 JSON 数组，不要任何解释文字或 markdown 围栏
2. 每项 { "title": "歌名", "artist": "歌手", "reason": "一句为什么" }
3. 不要推荐库里的歌
4. 优先推荐真实存在的、用户能在 QQ/网易云/Deezer 搜到的歌`;

    const lang = opts.language && opts.language !== 'auto'
      ? `语言偏好：${opts.language === 'zh' ? '中文' : opts.language === 'en' ? '英文' : opts.language === 'ja' ? '日文' : opts.language}`
      : '语言不限';
    const mood = opts.mood ? `当前心情：${opts.mood}` : '';
    const user = `我的口味库：\n${libList}\n\n${lang}\n${mood}\n\n请按 JSON 数组输出 ${opts.count} 首推荐。`;

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
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
      const ra = Number(res.headers.get('retry-after'));
      throw new RateLimitError('deepseek_rate_limit', Number.isFinite(ra) ? ra : undefined);
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
  ): RecoRawItem[] {
    const seen = new Set<string>();
    const norm = (t: string, a: string) =>
      `${t} ${a}`.toLowerCase().replace(/[\s\p{P}]+/gu, '');
    for (const it of library) seen.add(norm(it.title, it.artist));
    const result: RecoRawItem[] = [];
    for (const r of raw) {
      if (!r.title || !r.artist) continue;
      const k = norm(r.title, r.artist);
      if (seen.has(k)) continue;
      seen.add(k);
      result.push(r);
    }
    return result;
  }

  // ── 拿推荐 → 走 P0 统一搜索填实平台 ────────────────────

  private async fillPlatforms(
    session: Session,
    items: RecoRawItem[],
    wantCount: number,
  ): Promise<UnifiedSearchItem[]> {
    const out: UnifiedSearchItem[] = [];
    // 每个推荐单独搜，5 秒超时由 searchUnified 内部 Promise.all 控制；
    // 单个超时不影响其他。
    for (const r of items) {
      if (out.length >= wantCount) break;
      const q = `${r.title} ${r.artist}`;
      try {
        const res = await this.musicService.searchUnified(
          session,
          q,
          1,
          5, // 每条最多 5 个候选里挑第一个
        );
        const first = res.items[0];
        if (first) {
          out.push({
            ...first,
            // 把 reason 塞到 album 字段是 hack，UI 可以在 source 描述里看
            // 后续可以扩 UnifiedSearchItem 加 reason 字段。
            album: r.reason ? `${first.album} · ${r.reason}` : first.album,
          });
        }
      } catch (err) {
        this.logger.warn(
          `reco fill failed for "${q}": ${(err as Error).message}`,
        );
        // 跳过这一条，继续下一个
      }
    }
    return out;
  }
}

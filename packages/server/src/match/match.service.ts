import { Injectable, Logger } from '@nestjs/common';
import { QqMusicProvider } from '../music/qq.provider';
import { NeteaseMusicProvider } from '../music/netease.provider';
import { DeezerMusicProvider } from '../music/deezer.provider';
import type { Track } from '../music/music.service';
import type { UnifiedSearchItem } from '../music/types';
import type { MusicProvider } from '../common/provider';
import { withTimeout } from '../common/timeout';
import { buildUnifiedItems, dedupTracks, normalizeKey } from '../music/search.util';

/** 跨平台匹配候选 + 置信度。 */
export interface MatchResult {
  seed: Track;
  equivalents: Partial<Record<MusicProvider, Track>>;
  /**
   * - 'exact': 所有非 seed 平台都搜到了 **strict normalizeKey** 等价的版本
   *            （duration gate 验过）。v2 比 v1 多一道"strict key 一致"门槛。
   * - 'fuzzy': 部分平台 strict 找到 / 部分平台 fuzzy 找到 / 部分缺席的混合。
   *            v2 在 strict 没命中且 duration gate 通过时仍允许 fuzzy 命中
   *            （见 pickBest 的兜底），但 *fuzzy 的 UI 提示将留给阶段 C 加*
   *            score 字段后再开。
   * - 'none':  没有任何非 seed 平台找到（连 fuzzy 都没命中）。
   */
  confidence: 'exact' | 'fuzzy' | 'none';
}

/** 同 normalizeKey 的两首 track 视为"同一首"的最大 duration 差（秒）。 */
const DURATION_TOLERANCE_SEC = 3;
/** 单平台 search 的硬超时。 */
const SEARCH_TIMEOUT_MS = 5_000;
/** 单次 search 拉多少条候选（多查询变体后，按平台聚合后通常 ≤ N * V）。 */
const TOP_N_PER_SEARCH = 5;

/**
 * 阶段 B 的额外搜索变体数量：query 形态数量。
 * 当前为 1（仅 V1 = "${title} ${artist}"），保留 hook 给将来 V2/V3 拓展
 * （如"去括号 title"或"仅 title"）。
 *
 * 注意：扩展 query 形态时**只**用于搜索（让平台能 index 命中），不影响
 * normalizeKey 比较——后者仍按阶段 A 的"保守保留版本差异"语义。
 */
const QUERY_VARIANT_COUNT = 1;

@Injectable()
export class MatchService {
  private readonly logger = new Logger(MatchService.name);

  constructor(
    private readonly qq: QqMusicProvider,
    private readonly netease: NeteaseMusicProvider,
    private readonly deezer: DeezerMusicProvider,
  ) {}

  /**
   * 把多平台的 tracks 合并成统一库（去重）。底层复用 search.util 的
   * buildUnifiedItems——保证"统一搜索"和"库聚合"用同一份归一化逻辑，不会
   * 出现"搜索里没合并、库聚合里合并了"的不一致。
   *
   * v1 严格按 normalizeKey 合并；duration 差异通过把每个 track 挂上"主记录
   * 的 duration"实现：buildUnifiedItems 当前不感知 duration gate，所以
   * 真正需要 duration gate 的场景请用 findEquivalent。
   */
  mergeLibrary(tracks: Track[]): UnifiedSearchItem[] {
    const deduped = dedupTracks(tracks.map((t) => ({ track: t, platform: t.provider })));
    return buildUnifiedItems(
      deduped,
      tracks.map((t) => ({ track: t, platform: t.provider })),
    );
  }

  /**
   * 给定一首 seed track，去其他平台找等价版本。
   *
   * 策略（阶段 B）：
   *   1) 对 seed 派生 **多个查询变体**（V1 当前只用全 title+artist；hook
   *      留给将来拓 V2/V3）。多查询让平台能 index 命中阶段 A 归一后同 key
   *      的候选——这是阶段 A 修复生效的前提。
   *   2) 对每个非 seed 平台并行跑 *所有变体*，每次拉 top-N=5，5s 单平台超时。
   *      （Promise.all 受最慢 task 约束，整体仍 ≤ 5s。）
   *   3) 按平台聚合候选 → duration gate 过滤 → strict normalizeKey 相等
   *      命中取首条（pickBest）。phase C 会加 fuzzy fallback。
   *
   * 失败处理：单平台单变体 throw 被 catch；超时被 withTimeout 接住返空数组。
   * 都不影响其他 (provider, variant) 任务。
   *
   * Confidence 提升：v2 在 v1 基础上**额外**要求 strict normalizeKey 相等
   *   才算 exact；否则一律 fuzzy 或 none。
   */
  async findEquivalent(seed: Track): Promise<MatchResult> {
    const otherProviders: MusicProvider[] = (
      ['qq', 'netease', 'deezer'] as MusicProvider[]
    ).filter((p) => p !== seed.provider);

    const variants = this.generateQueryVariants(seed.title, seed.artist);
    const variantCount = Math.min(variants.length, QUERY_VARIANT_COUNT);

    const tasks: Array<() => Promise<Track[]>> = [];
    const taskMeta: Array<{ provider: MusicProvider; query: string }> = [];
    for (const p of otherProviders) {
      for (let v = 0; v < variantCount; v++) {
        const query = variants[v];
        tasks.push(() => this.searchTopN(p, query, TOP_N_PER_SEARCH));
        taskMeta.push({ provider: p, query });
      }
    }
    const resultLists = await Promise.all(tasks.map((t) => t()));

    // 按平台聚合候选。同一 (platform, candidate) 在多个变体里出现也算一次。
    const byProvider = new Map<MusicProvider, Track[]>();
    for (let i = 0; i < resultLists.length; i++) {
      const { provider } = taskMeta[i];
      const tracks = resultLists[i] ?? [];
      const arr = byProvider.get(provider) ?? [];
      for (const t of tracks) {
        if (!arr.some((x) => x.provider === t.provider && x.id === t.id)) {
          arr.push(t);
        }
      }
      byProvider.set(provider, arr);
    }

    const seedKey = normalizeKey(seed.title, seed.artist);
    const equivalents: Partial<Record<MusicProvider, Track>> = {};
    let strictFound = 0;
    let looseFound = 0;
    for (const p of otherProviders) {
      const candidates = byProvider.get(p) ?? [];
      const picked = this.pickBest(candidates, seed, seedKey);
      if (picked) {
        equivalents[p] = picked;
        looseFound++;
        if (normalizeKey(picked.title, picked.artist) === seedKey) strictFound++;
      }
    }

    // Confidence（v2）：所有非 seed 平台都 strict 命中 = exact；部分找到
    // （含 fuzzy 命中）= fuzzy；全没 = none。
    let confidence: MatchResult['confidence'];
    if (looseFound === 0) confidence = 'none';
    else if (strictFound === otherProviders.length) confidence = 'exact';
    else confidence = 'fuzzy';

    return { seed, equivalents, confidence };
  }

  /**
   * 生成查询变体（用于搜索，不影响 normalizeKey 比较）。
   *
   * 当前仅 V1：\`${title} ${artist}\`。保留 `QUERY_VARIANT_COUNT` hook 让
   * 将来拓 V2（去括号）、V3（仅 title）时不影响上游调用。
   *
   * Set 去重：title 跟 stripped title 一样时不会重复发请求。
   */
  private generateQueryVariants(title: string, artist: string): string[] {
    const out = new Set<string>();
    out.add(`${title} ${artist}`.trim());
    return Array.from(out);
  }

  /**
   * 从候选中挑最合适的，按优先级：
   *   1. duration gate：与 seed.duration 差 ≤ ±3s（或任一侧 ≤ 0 视作通过）
   *   2. strict normalizeKey 相等 → 取首条命中
   *   3. 当前 v2：无 strict 命中 → 视为该平台缺席（fuzzy 兜底留给阶段 C）。
   *
   * 返回 null = 该平台没找到。
   */
  private pickBest(
    candidates: Track[],
    seed: Track,
    seedKey: string,
  ): Track | null {
    const inDuration = candidates.filter((c) => this.inDurationTolerance(c, seed));
    if (!inDuration.length) return null;
    const strict = inDuration.find(
      (c) => normalizeKey(c.title, c.artist) === seedKey,
    );
    return strict ?? null;
  }

  private inDurationTolerance(c: Track, seed: Track): boolean {
    if (seed.duration <= 0 || c.duration <= 0) return true;
    return Math.abs(c.duration - seed.duration) <= DURATION_TOLERANCE_SEC;
  }

  /**
   * 单平台单变体的 top-N 搜索，带超时；返回的数组在失败 / 超时时是 []
   * （不抛、不污染 Promise.all）。
   */
  private async searchTopN(
    provider: MusicProvider,
    query: string,
    limit: number,
  ): Promise<Track[]> {
    const result = await withTimeout(
      async () => {
        try {
          if (provider === 'qq') {
            return await this.qq.search({}, query, limit);
          }
          if (provider === 'netease') {
            try {
              return await this.netease.search(
                {} as never,
                query,
                limit,
              );
            } catch {
              return [];
            }
          }
          if (provider === 'deezer') {
            return await this.deezer.search({}, query, limit);
          }
          // spotify 等需要 token 的平台：findEquivalent 无 session，无法搜。
          return [];
        } catch (err) {
          this.logger.debug(
            `${provider} search failed: ${(err as Error).message}`,
          );
          return [];
        }
      },
      SEARCH_TIMEOUT_MS,
      () =>
        this.logger.warn(
          `${provider} search timed out (>${SEARCH_TIMEOUT_MS}ms) for "${query}"`,
        ),
    );
    return result ?? [];
  }

  /**
   * Pure helper exposed for tests + utilities. 复用 search.util 的
   * normalizeKey，让外部代码不需要直接 import search.util。
   */
  normalizeKey(title: string, artist: string): string {
    return normalizeKey(title, artist);
  }
}

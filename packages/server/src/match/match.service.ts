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
   * - 'exact': 所有非 seed 平台都搜到了等价版本（按 duration gate 验过）
   * - 'fuzzy': 只有部分平台找到，或某个平台没经过 duration 验证
   * - 'none':  没有任何非 seed 平台找到
   */
  confidence: 'exact' | 'fuzzy' | 'none';
}

/** 同 normalizeKey 的两首 track 视为"同一首"的最大 duration 差（秒）。 */
const DURATION_TOLERANCE_SEC = 3;
/** 单平台 search 的硬超时。 */
const SEARCH_TIMEOUT_MS = 5_000;

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
   * 策略：对每个非 seed 平台用 title + artist 搜一遍，结果里 duration
   * 差 ≤ DURATION_TOLERANCE_SEC 的视为同一首，取第一个匹配。
   *
   * 失败处理：单平台搜索 5 秒超时抛 AbortError，被 Promise.race 接住返
   * null 候选——不影响其他平台。
   */
  async findEquivalent(seed: Track): Promise<MatchResult> {
    // 只在能"无 session / catch 掉 session"搜索的平台里找等价：
    //  - qq / deezer：匿名可搜
    //  - netease：需登录，未登录 search 抛错被 catch → null
    //  - spotify：需 OAuth token，而 findEquivalent 签名里没有 session，
    //    拿不到 token，所以刻意不含 spotify（不是遗漏）。将来若要支持，
    //    得给 findEquivalent 传 session。
    const otherProviders: MusicProvider[] = (
      ['qq', 'netease', 'deezer'] as MusicProvider[]
    ).filter((p) => p !== seed.provider);

    const searches = await Promise.all(
      otherProviders.map(async (p) => {
        const t = await this.searchWithTimeout(p, seed.title, seed.artist);
        if (!t) return [p, null] as const;
        // duration gate
        if (
          seed.duration > 0 &&
          t.duration > 0 &&
          Math.abs(t.duration - seed.duration) > DURATION_TOLERANCE_SEC
        ) {
          this.logger.debug(
            `match miss by duration: ${p}/${t.id} (${t.duration}s) vs seed (${seed.duration}s)`,
          );
          return [p, null] as const;
        }
        return [p, t] as const;
      }),
    );

    const equivalents: Partial<Record<MusicProvider, Track>> = {};
    let found = 0;
    for (const [p, t] of searches) {
      if (t) {
        equivalents[p] = t;
        found++;
      }
    }

    // 置信度：所有非 seed 平台都找到 = exact；部分找到 = fuzzy；全没 = none
    let confidence: MatchResult['confidence'];
    if (found === 0) {
      confidence = 'none';
    } else if (found === otherProviders.length) {
      confidence = 'exact';
    } else {
      confidence = 'fuzzy';
    }

    return { seed, equivalents, confidence };
  }

  /**
   * 用 withTimeout 给单平台搜索加超时。返回 null 表示失败。
   * 内部吞掉异常（避免 reject 污染 Promise.all）。
   */
  private async searchWithTimeout(
    provider: MusicProvider,
    title: string,
    artist: string,
  ): Promise<Track | null> {
    return withTimeout(
      async () => {
        try {
          if (provider === 'qq') {
            const tracks = await this.qq.search({}, `${title} ${artist}`, 5);
            return tracks[0] ?? null;
          }
          if (provider === 'netease') {
            try {
              const tracks = await this.netease.search(
                {} as never,
                `${title} ${artist}`,
                5,
              );
              return tracks[0] ?? null;
            } catch {
              return null;
            }
          }
          if (provider === 'deezer') {
            const tracks = await this.deezer.search({}, `${title} ${artist}`, 5);
            return tracks[0] ?? null;
          }
          // spotify 等需要 token 的平台：findEquivalent 无 session，无法搜。
          // 显式返回 null，而不是隐式 fallthrough 到 deezer.search（旧 bug）。
          return null;
        } catch (err) {
          this.logger.debug(
            `${provider} search failed: ${(err as Error).message}`,
          );
          return null;
        }
      },
      SEARCH_TIMEOUT_MS,
      () =>
        this.logger.warn(
          `${provider} search timed out (>${SEARCH_TIMEOUT_MS}ms) for "${title}"`,
        ),
    );
  }

  /**
   * Pure helper exposed for tests + utilities. 复用 search.util 的
   * normalizeKey，让外部代码不需要直接 import search.util。
   */
  normalizeKey(title: string, artist: string): string {
    return normalizeKey(title, artist);
  }
}

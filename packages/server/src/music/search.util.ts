/**
 * 统一搜索的纯函数：去重 + 聚合 + 选 bestSource。
 *
 * 抽到独立文件是为了能直接被白盒测试覆盖（无需 DI 启动 NestJS）。
 * MusicService 内部也复用同一份实现。
 */
import type { Track } from './music.service';
import type {
  SourceInfo,
  UnifiedSearchItem,
} from './types';
import type { MusicProvider } from '../common/provider';

export type RawSearchEntry = { track: Track; platform: MusicProvider };

/** 歌名+歌手标准化: 全角→半角、去空格、去标点、全小写。 */
export function normalizeKey(title: string, artist: string): string {
  const raw = `${title} ${artist}`
    // 全角 → 半角
    .replace(/[！-～]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
    )
    // 去掉空格、常见标点
    .replace(/[\s\-_,.()（）【】《》'"′″·&+/!?！？:：;；]+/g, '')
    .toLowerCase();
  return raw;
}

/** 去重: 相同 normalizeKey 的歌合并为一条，保留第一个出现的。 */
export function dedupTracks(all: RawSearchEntry[]): Map<string, Track> {
  const map = new Map<string, Track>();
  for (const { track } of all) {
    const key = normalizeKey(track.title, track.artist);
    if (!map.has(key)) {
      map.set(key, track);
    }
  }
  return map;
}

/** 播放优先级: qq > netease > deezer > spotify。只有 hasCopyright 的才可选。
 *  Spotify 排最后——30s 预览是它的硬限制，能用但不优；QQ/网易云通常有完整曲流。
 *  ⚠️ 加新 provider 时务必在这里 append，否则 unified 永远拿不到它当 bestSource。 */
export const PLAY_PRIORITY: MusicProvider[] = [
  'qq',
  'netease',
  'deezer',
  'spotify',
];

/** 同 normalizeKey 的两首视为"同一版本"的最大 duration 差（秒）。与
 *  match.service 的 DURATION_TOLERANCE_SEC 保持一致。 */
export const VERSION_DURATION_TOLERANCE_SEC = 3;

/**
 * 在同一个 normalizeKey 组内，按 duration 就近聚类成「版本」。
 * 每个 cluster = 一个版本（一个 UnifiedSearchItem）。
 *
 * 规则：
 *  - duration ≤ 0（未知，如部分 Deezer 结果）不参与门槛 → 全部并入第一个
 *    cluster（或自成一 cluster）。这保证老测试（duration 全 0）仍合并为一条。
 *  - duration > 0：按升序贪心，cluster 宽度 ≤ TOLERANCE（anchor=cluster 最小值），
 *    差 > TOLERANCE 就开新 cluster。→ "晴天"的 album/live/remix 各自成条。
 */
function clusterByDuration(entries: RawSearchEntry[]): RawSearchEntry[][] {
  const withDur = entries
    .filter((e) => e.track.duration > 0)
    .sort((a, b) => a.track.duration - b.track.duration);
  const zeroDur = entries.filter((e) => !(e.track.duration > 0));

  const clusters: { anchor: number; items: RawSearchEntry[] }[] = [];
  for (const e of withDur) {
    const last = clusters[clusters.length - 1];
    if (
      last &&
      e.track.duration - last.anchor <= VERSION_DURATION_TOLERANCE_SEC
    ) {
      last.items.push(e);
    } else {
      clusters.push({ anchor: e.track.duration, items: [e] });
    }
  }
  if (zeroDur.length) {
    if (clusters.length) clusters[0].items.push(...zeroDur);
    else clusters.push({ anchor: 0, items: zeroDur });
  }
  return clusters.map((c) => c.items);
}

/**
 * 将所有平台的原始搜索结果聚合为 UnifiedSearchItem。
 *
 * 先按 normalizeKey（歌名+歌手）分组，再在组内按 duration 聚类成「版本」——
 * 同名不同时长的版本（album / live / remix ...）各自成条，跨平台**同版本**
 * （时长接近）才合并。这样搜索里能看到多个版本，点 ❤ 时 sources 里就是
 * 同一个版本的跨平台源。
 *
 * `deduped` 参数保留是为了兼容旧签名/测试；分组逻辑不再依赖它。
 */
export function buildUnifiedItems(
  _deduped: Map<string, Track>,
  all: RawSearchEntry[],
): UnifiedSearchItem[] {
  // 1) 按 normalizeKey 分组
  const byKey = new Map<string, RawSearchEntry[]>();
  for (const e of all) {
    const key = normalizeKey(e.track.title, e.track.artist);
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }

  const items: UnifiedSearchItem[] = [];
  for (const entries of byKey.values()) {
    // 2) 组内按 duration 聚类成版本
    for (const cluster of clusterByDuration(entries)) {
      const sources: SourceInfo[] = cluster.map(({ track }) => ({
        platform: track.provider,
        trackId: track.id,
        // QQ/网易云的搜索结果默认有版权（搜索阶段无法完全判断，
        // 播放时 getStreamUrl 才最终裁决）。
        hasCopyright: true,
        url: track.audioUrl,
        // 透传 QQ 的 media_mid，让统一搜索结果走「标准→320→无损」时仍可升级。
        mediaMid: track.mediaMid,
      }));
      // main：取 cluster 内优先级最高平台的 track（决定 id / 展示信息），
      // 保证同一版本的 id 稳定、标题优先用 QQ/网易云的中文名。
      const main =
        PLAY_PRIORITY.map((p) =>
          cluster.find((e) => e.track.provider === p),
        ).find(Boolean)?.track ?? cluster[0].track;
      const bestSource =
        PLAY_PRIORITY.find((p) =>
          sources.some((s) => s.platform === p && s.hasCopyright),
        ) ?? null;
      items.push({
        id: `merged-${main.provider}-${main.id}`,
        title: main.title,
        artist: main.artist,
        album: main.album,
        coverUrl: main.coverUrl,
        duration: main.duration,
        sources,
        bestSource,
      });
    }
  }
  return items;
}

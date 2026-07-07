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

/** 将去重后的 track 和所有平台的原始结果聚合为 UnifiedSearchItem。 */
export function buildUnifiedItems(
  deduped: Map<string, Track>,
  all: RawSearchEntry[],
): UnifiedSearchItem[] {
  // group: dedup key → 各平台的 SourceInfo
  const grouped = new Map<string, { main: Track; sources: SourceInfo[] }>();

  for (const { track } of all) {
    const key = normalizeKey(track.title, track.artist);
    const main = deduped.get(key)!;
    const source: SourceInfo = {
      platform: track.provider,
      trackId: track.id,
      // QQ/网易云的搜索结果默认有版权（搜索阶段无法完全判断，
      // 播放时 getStreamUrl 才最终裁决）。
      hasCopyright: true,
      url: track.audioUrl,
      // 透传 QQ 的 media_mid，让统一搜索结果走「标准→320→无损」时仍可升级。
      mediaMid: track.mediaMid,
    };

    if (!grouped.has(key)) {
      grouped.set(key, { main, sources: [] });
    }
    grouped.get(key)!.sources.push(source);
  }

  return [...grouped.values()].map(({ main, sources }) => {
    const bestSource =
      PLAY_PRIORITY.find((p) => sources.some((s) => s.platform === p)) ?? null;
    return {
      id: `merged-${main.provider}-${main.id}`,
      title: main.title,
      artist: main.artist,
      album: main.album,
      coverUrl: main.coverUrl,
      duration: main.duration,
      sources,
      bestSource,
    };
  });
}

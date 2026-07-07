import { MusicProvider } from '../common/provider';
import { Track } from './music.service';

/** 单个平台上的搜索结果条目。 */
export interface SourceInfo {
  platform: MusicProvider;
  trackId: string;
  hasCopyright: boolean;
  url: string;
  /** QQ 高音质取流用 media_mid（standard 不需要，high/lossless 必须）。 */
  mediaMid?: string;
}

/** 去重合并后的一条搜索结果。 */
export interface UnifiedSearchItem {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  duration: number;
  sources: SourceInfo[];
  /** 推荐播放平台（按优先级 + hasCopyright 选出）。 */
  bestSource: MusicProvider | null;
}

export interface UnifiedSearchResult {
  q: string;
  total: number;
  page: number;
  pageSize: number;
  items: UnifiedSearchItem[];
}

/** 单个平台的搜索结果（provider 内部返回的 raw list + 总数）。 */
export interface ProviderSearchRaw {
  platform: MusicProvider;
  tracks: Track[];
  total: number;
  error?: string;
}

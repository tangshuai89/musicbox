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

/** Heart fan-out 请求体。sources 是搜索结果里这个 merged track 的所有平台源；
 *  liked=true 时把 sources 里全部 hasCopyright=true 的写入；false 时按持久化的
 *  fanOut[mergedId] 列表反写——这样可以幂等清除，避免对"已经没喜欢的平台"误调
 *  unlike。 */
export interface FanOutLikeRequest {
  mergedId: string;
  sources: Array<{ platform: MusicProvider; trackId: string }>;
  liked: boolean;
}

/** Heart fan-out 响应。
 *  - liked=true 时 fannedOutTo = 当前 mergedId 心动过的**全部平台**（含之前
 *    单独心过的，非仅本次 flip）——UI 角标直接用它的 length，语义 = 这首歌
 *    在几个平台有 ❤。
 *  - liked=false 时 fannedOutTo = []（全部清掉）。 */
export interface FanOutLikeResponse {
  success: boolean;
  liked: boolean;
  fannedOutTo: MusicProvider[];
}

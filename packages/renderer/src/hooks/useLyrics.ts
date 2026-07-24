import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLyrics, fetchLyricsByName } from '../api';
import type { LyricsResult, MusicProvider, Track } from '../api';

/**
 * Fetch lyrics whenever the track changes. Clears previous lyrics
 * immediately so the panel shows its loading state during the fetch, not
 * stale content from the old track. Keyed on (track.id, provider).
 *
 * `altSources` are the same song's equivalents on other platforms (from the
 * unified-search item) — the server falls back through them and then
 * lyrics.ovh when the primary provider has no lyrics.
 *
 * `retryByName()` is the manual fallback: when the standard fan-out
 * (primary → altSources → lyrics.ovh) returns null, the UI exposes a
 * "换个源找歌词" button that calls this — server then does a fresh
 * title+artist search on each lyrics-capable platform and returns the
 * first match.
 */
export function useLyrics(
  track: Track | null,
  provider: MusicProvider | null,
  altSources?: Array<{ platform: MusicProvider; trackId: string }>,
) {
  const [result, setResult] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const trackRef = useRef(track);
  trackRef.current = track;

  const runFetch = useCallback(() => {
    const cur = trackRef.current;
    if (!cur?.id || !provider) return Promise.resolve(null);
    setLoading(true);
    return fetchLyrics(provider, cur.id, {
      title: cur.title,
      artist: cur.artist,
      sources: altSources?.filter(
        (s) => !(s.platform === provider && s.trackId === cur.id),
      ),
    });
  }, [provider, altSources]);

  useEffect(() => {
    if (!track?.id || !provider) {
      setResult(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setResult(null);
    runFetch()
      .then((res) => {
        if (!cancelled) {
          setResult(res);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // altSources 是随 track 一起变的派生数组，track.id 变化已覆盖其变化时机；
    // 不放进依赖，避免父组件每次 render 的新数组引用触发重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, provider]);

  /**
   * 「换个源找歌词」按钮调用：按 title+artist 去每个有歌词 API 的平台搜同名
   * 同时长的曲目再拉一次。命中就替换当前 lyrics；没命中保持上一次结果。
   */
  const retryByName = useCallback(async () => {
    const cur = trackRef.current;
    if (!cur?.title || !cur.artist) return;
    setLoading(true);
    try {
      const res = await fetchLyricsByName(cur.title, cur.artist, cur.duration);
      if (res) setResult(res);
    } catch {
      // 保持上一次的 lyrics
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    lyrics: result?.lines ?? null,
    synced: result?.synced ?? true,
    source: result?.source ?? null,
    loading,
    retryByName,
  };
}

import { useEffect, useState } from 'react';
import { fetchLyrics } from '../api';
import type { LyricsResult, MusicProvider, Track } from '../api';

/**
 * Fetch lyrics whenever the track changes. Clears previous lyrics
 * immediately so the panel shows its loading state during the fetch, not
 * stale content from the old track. Keyed on (track.id, provider).
 *
 * `altSources` are the same song's equivalents on other platforms (from the
 * unified-search item) — the server falls back through them and then
 * lyrics.ovh when the primary provider has no lyrics.
 */
export function useLyrics(
  track: Track | null,
  provider: MusicProvider | null,
  altSources?: Array<{ platform: MusicProvider; trackId: string }>,
) {
  const [result, setResult] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!track?.id || !provider) {
      setResult(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setResult(null);
    fetchLyrics(provider, track.id, {
      title: track.title,
      artist: track.artist,
      sources: altSources?.filter(
        (s) => !(s.platform === provider && s.trackId === track.id),
      ),
    })
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

  return {
    lyrics: result?.lines ?? null,
    synced: result?.synced ?? true,
    source: result?.source ?? null,
    loading,
  };
}

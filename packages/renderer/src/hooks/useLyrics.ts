import { useEffect, useState } from 'react';
import { fetchLyrics } from '../api';
import type { LyricLine, MusicProvider, Track } from '../api';

/**
 * Fetch lyrics whenever the track changes. Clears previous lyrics
 * immediately so the panel shows its loading state during the fetch, not
 * stale content from the old track. Keyed on (track.id, provider).
 */
export function useLyrics(track: Track | null, provider: MusicProvider | null) {
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!track?.id || !provider) {
      setLyrics(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLyrics(null);
    fetchLyrics(provider, track.id)
      .then((result) => {
        if (!cancelled) {
          setLyrics(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLyrics(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [track?.id, provider]);

  return { lyrics, loading };
}

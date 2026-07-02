import { useEffect, useMemo, useRef } from 'react';
import type { LyricLine } from './api';

interface Props {
  lyrics: LyricLine[] | null;
  /** audio.currentTime in seconds — drives the active-line highlight */
  currentTime: number;
  /** True while the fetch is in flight */
  loading: boolean;
  /** Callback when the user clicks a lyric line — parent seeks audio */
  onSeek?: (time: number) => void;
}

/**
 * Synced-lyrics panel for the Bento side column. Reads a sorted
 * LyricLine[] and binary-searches `currentTime` to find the currently
 * active line, then scrolls it into view with smooth behaviour.
 *
 * When `lyrics` is null and loading is false, we show the "暂无歌词"
 * placeholder. When loading, a slow-pulse shimmer acts as a spinner.
 * This keeps the card dimension stable — no layout jumps when the
 * fetch lands.
 *
 * Auto-scroll uses a ref on the active line (not scrollIntoView on
 * every render) so we only call .scrollIntoView when the active index
 * actually changes. This avoids competing scrolls from RAF jitter.
 */
export default function LyricsPanel({ lyrics, currentTime, loading, onSeek }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Binary search: find the line whose `time` is the last one ≤
  // currentTime. If currentTime is before the first line, returns -1
  // (no line highlighted). After the last line's timestamp, the last
  // line stays highlighted (the song is in the instrumental outro).
  const activeIdx = useMemo(() => {
    if (!lyrics || lyrics.length === 0) return -1;
    let lo = 0;
    let hi = lyrics.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (lyrics[mid].time <= currentTime) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hi; // hi is the last index where time ≤ currentTime
  }, [lyrics, currentTime]);

  // Scroll the active line into the centre of the panel when it
  // changes. Only fires when the index changes (the useEffect dep),
  // not on every RAF tick — one scroll per lyric line advance.
  useEffect(() => {
    if (activeIdx < 0) return;
    const el = activeRef.current;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIdx]);

  // When lyrics are loading, show a low-contrast shimmer so the
  // panel height doesn't collapse.
  if (loading) {
    return (
      <div className="lyrics-panel" aria-busy="true">
        <div className="lyrics-empty lyrics-loading" aria-label="加载歌词中">
          加载歌词…
        </div>
      </div>
    );
  }

  // No lyrics available.
  if (!lyrics || lyrics.length === 0) {
    return (
      <div className="lyrics-panel" aria-label="暂无歌词">
        <div className="lyrics-empty" aria-hidden="true">
          <div className="lyrics-empty-glyph">♫</div>
          <div className="lyrics-empty-hint">暂无歌词</div>
        </div>
      </div>
    );
  }

  return (
    <div className="lyrics-panel" ref={listRef}>
      <div className="lyrics-list">
        {lyrics.map((line, i) => {
          const isActive = i === activeIdx;
          return (
            <button
              key={i}
              ref={isActive ? activeRef : undefined}
              className={`lyrics-line${isActive ? ' is-active' : ''}`}
              onClick={() => onSeek?.(line.time)}
              tabIndex={0}
            >
              {line.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

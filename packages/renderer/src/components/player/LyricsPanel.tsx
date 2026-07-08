import { useEffect, useMemo, useRef } from 'react';
import type { LyricLine } from '../../api';

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
 * Synced-lyrics panel for the Bento side column. Reads a sorted LyricLine[]
 * and binary-searches `currentTime` to find the active line, then scrolls it
 * into view. Auto-scroll uses a ref on the active line so we only call
 * .scrollIntoView when the active index actually changes (not on every RAF).
 */
export default function LyricsPanel({ lyrics, currentTime, loading, onSeek }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Binary search: last line whose `time` is ≤ currentTime. Before the first
  // line, returns -1 (nothing highlighted); after the last, the last line
  // stays highlighted (instrumental outro).
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
    return hi;
  }, [lyrics, currentTime]);

  // Scroll the active line to the centre when it changes (index dep only,
  // not every RAF tick).
  useEffect(() => {
    if (activeIdx < 0) return;
    const el = activeRef.current;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIdx]);

  if (loading) {
    return (
      <div className="lyrics-panel" aria-busy="true">
        <div className="lyrics-empty lyrics-loading" aria-label="加载歌词中">
          加载歌词…
        </div>
      </div>
    );
  }

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

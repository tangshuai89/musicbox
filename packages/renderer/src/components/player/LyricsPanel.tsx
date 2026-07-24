import { useEffect, useMemo, useRef } from 'react';
import type { LyricLine } from '../../api';

interface Props {
  lyrics: LyricLine[] | null;
  /** audio.currentTime in seconds — drives the active-line highlight */
  currentTime: number;
  /** True while the fetch is in flight */
  loading: boolean;
  /** False for plain-text lyrics (lyrics.ovh / Deezer) — no highlight/seek */
  synced: boolean;
  /** Callback when the user clicks a lyric line — parent seeks audio */
  onSeek?: (time: number) => void;
  /** Copy a single line (with toast feedback) — owned by LyricsCard */
  onCopyLine?: (text: string) => void;
  /** "歌名 歌手" — powers the no-lyrics NetEase submission link */
  noLyricsQuery?: string;
  /**
   * 「换个源找歌词」按钮回调。当前没有任何歌词时显示；点击后按歌名+歌手
   * 去其他平台再搜一次。
   */
  onRetryByName?: () => void | Promise<void>;
}

/**
 * Synced-lyrics panel for the Bento side column. Reads a sorted LyricLine[]
 * and binary-searches `currentTime` to find the active line, then scrolls it
 * into view. Auto-scroll uses a ref on the active line so we only call
 * .scrollIntoView when the active index actually changes (not on every RAF).
 *
 * Interaction model:
 *  - synced: line click seeks; the ⧉ hover button copies the line.
 *  - unsynced (plain text): no highlight; line click copies directly.
 */
export default function LyricsPanel({
  lyrics,
  currentTime,
  loading,
  synced,
  onSeek,
  onCopyLine,
  noLyricsQuery,
  onRetryByName,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Binary search: last line whose `time` is ≤ currentTime. Before the first
  // line, returns -1 (nothing highlighted); after the last, the last line
  // stays highlighted (instrumental outro). Unsynced lyrics (all time=0)
  // never highlight.
  const activeIdx = useMemo(() => {
    if (!synced || !lyrics || lyrics.length === 0) return -1;
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
  }, [lyrics, currentTime, synced]);

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
        <div className="lyrics-empty">
          <div className="lyrics-empty-glyph" aria-hidden="true">
            ♫
          </div>
          <div className="lyrics-empty-hint">暂无歌词</div>
          {onRetryByName && (
            <button
              type="button"
              className="lyrics-retry-btn"
              onClick={() => void onRetryByName()}
              title="按歌名+歌手去其他平台（QQ / 网易云 / Deezer）再搜一次"
            >
              换个源找歌词
            </button>
          )}
          {noLyricsQuery && (
            <a
              className="lyrics-submit-link"
              href={`https://music.163.com/#/search/m/?s=${encodeURIComponent(noLyricsQuery)}`}
              target="_blank"
              rel="noreferrer"
              title="各平台都没找到歌词——去网易云找到这首歌，可在歌曲页贡献歌词"
            >
              去网易云提交歌词 ↗
            </a>
          )}
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
            <div
              key={i}
              ref={isActive ? activeRef : undefined}
              className={`lyrics-line-row${isActive ? ' is-active' : ''}`}
            >
              <button
                className={`lyrics-line${isActive ? ' is-active' : ''}`}
                onClick={() =>
                  synced ? onSeek?.(line.time) : onCopyLine?.(line.text)
                }
                title={synced ? '点击跳到这句' : '点击复制这句'}
                tabIndex={0}
              >
                {line.text}
              </button>
              {synced && onCopyLine && (
                <button
                  className="lyrics-line-copy"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyLine(line.text);
                  }}
                  aria-label="复制这句歌词"
                  title="复制这句"
                >
                  ⧉
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

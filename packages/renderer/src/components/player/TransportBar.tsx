interface Props {
  hasTrack: boolean;
  loading: boolean;
  playing: boolean;
  liked: boolean;
  fanOutCount: number;
  onDislike: () => void;
  onLike: () => void;
  onPlayPause: () => void;
  onSkip: () => void;
}

/** Bottom transport: dislike / like / play-pause / skip. */
export default function TransportBar({
  hasTrack,
  loading,
  playing,
  liked,
  fanOutCount,
  onDislike,
  onLike,
  onPlayPause,
  onSkip,
}: Props) {
  return (
    <div className="transport-row">
      <button
        className="control-btn dislike-btn"
        onClick={onDislike}
        disabled={!hasTrack}
        title="不感兴趣"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>

      <button
        className={`control-btn like-btn${liked ? ' liked' : ''}`}
        onClick={onLike}
        disabled={!hasTrack}
        title={
          liked
            ? fanOutCount > 0
              ? `已心动 ${fanOutCount} 个平台，再点取消红心`
              : '再点取消红心'
            : '红心'
        }
      >
        {liked ? (
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z" />
          </svg>
        )}
        {fanOutCount > 1 && <span className="like-btn-badge">{fanOutCount}❤</span>}
      </button>

      <button
        className="control-btn play-btn"
        onClick={onPlayPause}
        disabled={!hasTrack || loading}
        title={playing ? '暂停' : '播放'}
      >
        {loading ? (
          <svg className="spinner" viewBox="0 0 24 24" width="28" height="28">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="31.4 31.4" />
          </svg>
        ) : playing ? (
          <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      <button
        className="control-btn skip-btn"
        onClick={onSkip}
        disabled={loading}
        title="下一首"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
          <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
        </svg>
      </button>
    </div>
  );
}

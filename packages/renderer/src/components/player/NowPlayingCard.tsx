import { PROVIDER_LABELS, QQ_QUALITY_LABELS } from '../../api';
import type { MusicProvider, QqQuality } from '../../api';

interface Props {
  provider: MusicProvider;
  qqQuality: QqQuality;
  loading: boolean;
  playing: boolean;
  accountName: string;
}

/** The Now Playing info card — a 2×2 grid of source / quality / status / account. */
export default function NowPlayingCard({
  provider,
  qqQuality,
  loading,
  playing,
  accountName,
}: Props) {
  return (
    <div className="glass-card side-card">
      <div className="side-card-label">Now Playing</div>
      <div className="now-playing-grid">
        <div className="now-playing-cell">
          <div className="now-playing-cell-label">Source</div>
          <div className="now-playing-cell-value">{PROVIDER_LABELS[provider]}</div>
        </div>
        <div className="now-playing-cell">
          <div className="now-playing-cell-label">Quality</div>
          <div className="now-playing-cell-value">{QQ_QUALITY_LABELS[qqQuality]}</div>
        </div>
        <div className="now-playing-cell">
          <div className="now-playing-cell-label">Status</div>
          <div className="now-playing-cell-value">
            {loading ? 'Loading…' : playing ? 'Playing' : 'Paused'}
          </div>
        </div>
        <div className="now-playing-cell">
          <div className="now-playing-cell-label">Account</div>
          <div className="now-playing-cell-value">{accountName}</div>
        </div>
      </div>
    </div>
  );
}

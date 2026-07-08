import type { CSSProperties, ReactNode, MouseEvent } from 'react';
import { formatTime } from '../../lib/format';

interface Props {
  currentTime: number;
  duration: number;
  /** Seek to an absolute time in seconds. */
  onSeek: (seconds: number) => void;
  /** Right-hand slot on the meta line — the volume control. */
  children?: ReactNode;
}

/**
 * Full-width progress row: a click-to-seek bar with a hover-grown thumb, and
 * below it the time codes (left) + a slot for the volume group (right). The
 * fill width is fed via the --progress custom property (0–100) so the width
 * rule stays in SCSS.
 */
export default function ProgressBar({
  currentTime,
  duration,
  onSeek,
  children,
}: Props) {
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleBarClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  };

  return (
    <div className="progress-row">
      <div className="progress-bar" onClick={handleBarClick}>
        <div className="progress-fill" style={{ '--progress': pct } as CSSProperties} />
      </div>
      <div className="progress-meta">
        <div className="progress-time">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

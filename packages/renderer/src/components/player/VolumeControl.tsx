import type { ChangeEvent, CSSProperties } from 'react';
import VolumeIcon from './VolumeIcon';

interface Props {
  volume: number;
  muted: boolean;
  onVolumeChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onToggleMute: () => void;
}

/**
 * Mute button + slim range slider. The slider's filled portion is driven by
 * the --volume custom property (0–100) rather than an inline gradient rule —
 * the styling lives in SCSS, tsx only feeds the value.
 */
export default function VolumeControl({
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
}: Props) {
  return (
    <div className="volume-group">
      <button
        className={`volume-btn${muted ? ' is-muted' : ''}`}
        onClick={onToggleMute}
        title={muted ? '取消静音' : '静音'}
        aria-label={muted ? '取消静音' : '静音'}
      >
        <VolumeIcon volume={volume} muted={muted} />
      </button>
      <input
        type="range"
        className="volume-slider"
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        onChange={onVolumeChange}
        aria-label="音量"
        style={{ '--volume': volume * 100 } as CSSProperties}
      />
    </div>
  );
}

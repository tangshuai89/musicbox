import type { LyricLine } from '../../api';
import LyricsPanel from './LyricsPanel';

interface Props {
  lyrics: LyricLine[] | null;
  currentTime: number;
  loading: boolean;
  onSeek: (seconds: number) => void;
}

/** Side-column card wrapping the synced lyrics panel. */
export default function LyricsCard({ lyrics, currentTime, loading, onSeek }: Props) {
  return (
    <div className="glass-card side-card lyrics-card">
      <div className="side-card-label">Lyrics</div>
      <LyricsPanel
        lyrics={lyrics}
        currentTime={currentTime}
        loading={loading}
        onSeek={onSeek}
      />
    </div>
  );
}

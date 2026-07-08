import type { RefObject } from 'react';
import type { Track } from '../../api';
import { resetCoverColor } from '../../lib/coverColor';
import ErrorPanel from '../common/ErrorPanel';

interface Props {
  track: Track | null;
  playing: boolean;
  /** Receives the cover background-image (written by useCoverArt). */
  coverBackdropRef: RefObject<HTMLDivElement>;
  error: string | null;
  onCloseError: () => void;
}

/**
 * Hero cover card: the cover art + its mirror reflection + the track meta
 * (title / artist / album) and the error panel slot. The `key` on cover-stack
 * and cover-meta forces React to remount them on every track change, which
 * replays the enter animations defined in _cover-card.scss.
 */
export default function CoverCard({
  track,
  playing,
  coverBackdropRef,
  error,
  onCloseError,
}: Props) {
  return (
    <div className={`glass-card cover-card${playing ? ' is-playing' : ''}`}>
      <div className="cover-stack" key={`stack-${track?.id ?? 'empty'}`}>
        <div className="cover-art" ref={coverBackdropRef} onError={resetCoverColor}>
          {!track?.coverUrl && <div className="cover-art-placeholder">♪</div>}
        </div>
        {/* Mirror reflection — picks up the same background-image via
            `background-image: inherit`, flipped + blurred + masked. */}
        <div className="cover-art-reflection" aria-hidden="true" />
      </div>
      <div className="cover-meta" key={`meta-${track?.id ?? 'empty'}`}>
        <div className="track-title">{track?.title || '...'}</div>
        <div className="track-artist">{track?.artist || '正在加载'}</div>
        {track?.album && <div className="track-album">{track.album}</div>}
        {error && <ErrorPanel message={error} onClose={onCloseError} />}
      </div>
    </div>
  );
}

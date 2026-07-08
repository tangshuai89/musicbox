import { useEffect, useState, type ChangeEvent, type RefObject } from 'react';
import {
  readStoredMuted,
  readStoredVolume,
  writeStoredVolume,
} from '../lib/storage';
import type { Track } from '../api';

/**
 * Volume + mute, persisted to localStorage and pushed onto the live <audio>
 * element. `muted` is kept separate from `volume` so unmuting restores the
 * user's previous level — the effective output is `muted ? 0 : volume`.
 *
 * `track` is a dependency of the push effect so a freshly-mounted source
 * starts at the persisted level without a flash of full-volume audio.
 */
export function useVolume(
  audioRef: RefObject<HTMLAudioElement | null>,
  track: Track | null,
) {
  const [volume, setVolume] = useState<number>(() => readStoredVolume());
  const [muted, setMuted] = useState<boolean>(() => readStoredMuted());

  // Persist volume + muted (single JSON key).
  useEffect(() => {
    writeStoredVolume(volume, muted);
  }, [volume, muted]);

  // Push the preference onto the live <audio> element whenever it changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = muted ? 0 : volume;
    }
  }, [volume, muted, track, audioRef]);

  /** Slider drag: if the user drags up from 0 while muted, auto-unmute — the
   *  gesture implies "I want sound now". */
  const handleVolumeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value) / 100;
    setVolume(v);
    if (v > 0 && muted) setMuted(false);
  };

  /** Toggle muted without touching volume, so unmuting restores the level. */
  const toggleMute = () => setMuted((m) => !m);

  return { volume, muted, handleVolumeChange, toggleMute };
}

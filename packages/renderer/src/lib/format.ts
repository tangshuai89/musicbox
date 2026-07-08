/** Format a duration in seconds as `m:ss`. Returns `0:00` for invalid input. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Like formatTime, but returns an empty string for non-positive input —
 * used by the search rows, which omit the duration entirely when unknown
 * (rather than showing a bogus `0:00`).
 */
export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

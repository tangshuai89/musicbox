/**
 * Parse a standard LRC body into sorted `LyricLine[]`. Each line has
 * the form "[mm:ss.xx]text" or "[mm:ss.xxx]text"; multi-tag lines
 * like "[mm:ss.xx][mm:ss.xx]text" are split into one line per tag
 * (this is how NetEase emits chorus repeats).
 *
 * Metadata tags without time stamps (e.g. "[ti:Title]", "[ar:Artist]")
 * are skipped — they're not singable lines.
 *
 * Returns null if no timestamped lines were found, so callers can
 * distinguish "no lyrics" from "lyrics but all unparseable".
 */
export function parseLrc(body: string): LyricLine[] | null {
  const lines: LyricLine[] = [];
  // Match one or more time tags followed by the line text. The
  // capture groups are:
  //   1: minutes
  //   2: seconds (with optional decimal)
  //   3: text (rest of line)
  const tagRe = /\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]([^\n]*)/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(body)) !== null) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const text = match[3].trim();
    const time = minutes * 60 + seconds;
    // Skip lines whose "text" is actually just whitespace or
    // punctuation-only — these are common in NetEase LRCs as
    // visual breath marks and look ugly in the panel.
    if (!text) continue;
    lines.push({ time, text });
  }
  if (lines.length === 0) return null;
  // Sort ascending so the renderer can binary-search by currentTime.
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

export interface LyricLine {
  time: number;
  text: string;
}

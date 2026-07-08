/**
 * The cover-driven colour is exposed to CSS through two custom properties on
 * :root — --cover-accent (the dominant colour of the current cover) and
 * --cover-glow (a translucent version for the cover's halo). JS writes them
 * as a track's artwork loads; the SCSS reads them everywhere the UI "echoes"
 * the current song. These helpers centralise the write so the default/reset
 * values aren't duplicated across call sites.
 */

/** Apply a sampled RGB triplet as the live cover accent + glow. */
export function setCoverColor(r: number, g: number, b: number): void {
  const root = document.documentElement.style;
  root.setProperty('--cover-accent', `rgb(${r}, ${g}, ${b})`);
  root.setProperty('--cover-glow', `rgba(${r}, ${g}, ${b}, 0.32)`);
}

/** Reset to the neutral pre-load colour (no cover, or colour extraction failed). */
export function resetCoverColor(): void {
  const root = document.documentElement.style;
  root.setProperty('--cover-accent', '#1a1a1f');
  root.setProperty('--cover-glow', 'transparent');
}

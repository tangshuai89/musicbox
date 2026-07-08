import type { MusicProvider, QqQuality } from '../api';

/**
 * Every localStorage key the renderer uses, in one place, plus typed
 * readers/writers that own the parsing + validation. Keeping this out of the
 * components means a key rename is a one-line change and the try/catch
 * quirks (private-mode quota errors, malformed JSON) live in exactly one
 * spot rather than being copy-pasted through the app.
 */
export const STORAGE_KEYS = {
  provider: 'music-provider',
  volume: 'musicbox:volume',
  quality: 'musicbox:qq-quality',
  deezerPreset: 'musicbox:deezer-preset',
  theme: 'musicbox:theme',
} as const;

export type ThemeMode = 'dark' | 'light' | 'system';

// ── Provider ──
export function readStoredProvider(): MusicProvider | null {
  const stored = localStorage.getItem(STORAGE_KEYS.provider);
  if (
    stored === 'qq' ||
    stored === 'netease' ||
    stored === 'deezer' ||
    stored === 'spotify'
  ) {
    return stored;
  }
  return null;
}

export function writeStoredProvider(provider: MusicProvider): void {
  localStorage.setItem(STORAGE_KEYS.provider, provider);
}

export function clearStoredProvider(): void {
  localStorage.removeItem(STORAGE_KEYS.provider);
}

// ── Volume + mute (single JSON key, so we can extend later without a
// migration). ──
export function readStoredVolume(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.volume);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.volume === 'number' &&
        parsed.volume >= 0 &&
        parsed.volume <= 1
      ) {
        return parsed.volume;
      }
    }
  } catch {
    /* fall through */
  }
  return 1;
}

export function readStoredMuted(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.volume);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.muted === 'boolean') return parsed.muted;
    }
  } catch {
    /* fall through */
  }
  return false;
}

export function writeStoredVolume(volume: number, muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.volume, JSON.stringify({ volume, muted }));
  } catch {
    /* quota / private mode — silently skip */
  }
}

// ── QQ / NetEase stream quality ──
export function readStoredQuality(): QqQuality {
  const v = localStorage.getItem(STORAGE_KEYS.quality);
  return v === 'high' || v === 'lossless' ? v : 'standard';
}

export function writeStoredQuality(q: QqQuality): void {
  localStorage.setItem(STORAGE_KEYS.quality, q);
}

// ── Deezer editorial preset ──
export function readStoredDeezerPreset(): string {
  return localStorage.getItem(STORAGE_KEYS.deezerPreset) ?? 'asia';
}

export function writeStoredDeezerPreset(preset: string): void {
  localStorage.setItem(STORAGE_KEYS.deezerPreset, preset);
}

// ── Theme ──
export function readStoredTheme(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEYS.theme) as ThemeMode | null;
  return saved ?? 'system';
}

export function writeStoredTheme(theme: ThemeMode): void {
  localStorage.setItem(STORAGE_KEYS.theme, theme);
}

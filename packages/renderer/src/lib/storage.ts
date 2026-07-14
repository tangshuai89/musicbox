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
  volume: 'maestro:volume',
  quality: 'maestro:qq-quality',
  deezerPreset: 'maestro:deezer-preset',
  theme: 'maestro:theme',
} as const;

export type ThemeMode = 'dark' | 'light' | 'system';

// 一次性迁移：项目改名 musicbox → maestro，把旧 `musicbox:*` 键的值搬到新
// `maestro:*` 键，避免老用户的 音量/主题/预设/音质 被重置。模块首次 import
// 时（早于任何 hook 读取）执行一次；搬完删旧键，幂等。
const LEGACY_KEY_MAP: Record<string, string> = {
  'musicbox:volume': STORAGE_KEYS.volume,
  'musicbox:qq-quality': STORAGE_KEYS.quality,
  'musicbox:deezer-preset': STORAGE_KEYS.deezerPreset,
  'musicbox:theme': STORAGE_KEYS.theme,
};
(function migrateLegacyKeys(): void {
  try {
    for (const [oldKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
      const oldVal = localStorage.getItem(oldKey);
      if (oldVal == null) continue;
      if (localStorage.getItem(newKey) == null) localStorage.setItem(newKey, oldVal);
      localStorage.removeItem(oldKey);
    }
  } catch {
    /* private mode / quota — 迁移失败就用默认值，不致命 */
  }
})();

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

// ── Backup: collect / restore all known keys ──
// The export bundle carries these so a fresh install restores prefs too, not
// just the server-side login/liked state. Driven off STORAGE_KEYS so adding a
// key here automatically includes it in backups.
export function collectLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.values(STORAGE_KEYS)) {
    const v = localStorage.getItem(key);
    if (v != null) out[key] = v;
  }
  return out;
}

export function restoreLocalStorage(data: Record<string, string>): void {
  // Only restore keys we recognise (ignore anything unexpected in the file).
  const known = new Set<string>(Object.values(STORAGE_KEYS));
  for (const [key, value] of Object.entries(data ?? {})) {
    if (known.has(key) && typeof value === 'string') {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* quota / private mode — skip */
      }
    }
  }
}

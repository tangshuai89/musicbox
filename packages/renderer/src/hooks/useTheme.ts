import { useEffect, useState } from 'react';
import { readStoredTheme, writeStoredTheme, type ThemeMode } from '../lib/storage';

/**
 * Theme state: 'dark' | 'light' | 'system'. Persists to localStorage and
 * writes the [data-theme] attribute on <html> so the CSS token blocks flip.
 * When 'system', the attribute is removed and CSS follows
 * prefers-color-scheme. (No component currently reads `theme` — the toggle
 * button was removed in a prior pass — but we keep reading/persisting it so
 * a future UI can re-surface it.)
 */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());

  useEffect(() => {
    writeStoredTheme(theme);
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  return { theme, setTheme, resetTheme: () => setTheme('system') };
}

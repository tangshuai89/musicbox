export type MusicProvider = 'qq' | 'netease' | 'deezer' | 'spotify';

export const MUSIC_PROVIDERS: MusicProvider[] = [
  'qq',
  'netease',
  'deezer',
  'spotify',
];

export function normalizeProvider(value: string | undefined): MusicProvider {
  if (value === 'netease') return 'netease';
  if (value === 'deezer') return 'deezer';
  if (value === 'spotify') return 'spotify';
  return 'qq';
}

export const PROVIDER_LABELS: Record<MusicProvider, string> = {
  qq: 'QQ 音乐',
  netease: '网易云音乐',
  deezer: 'Deezer',
  spotify: 'Spotify',
};

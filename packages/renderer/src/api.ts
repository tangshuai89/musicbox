const API_BASE = '/api';

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  audioUrl: string;
  duration: number;
  liked: boolean;
}

export interface AuthStatus {
  loggedIn: boolean;
  user: { nickname: string; avatarUrl: string; openId: string } | null;
}

export async function fetchNextTrack(): Promise<Track> {
  const res = await fetch(`${API_BASE}/music/next`);
  return res.json();
}

export async function toggleLike(trackId: string): Promise<{ success: boolean; liked: boolean }> {
  const res = await fetch(`${API_BASE}/music/like/${trackId}`, { method: 'POST' });
  return res.json();
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${API_BASE}/auth/status`);
  return res.json();
}

export function getLoginUrl(): string {
  return `${API_BASE}/auth/login`;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`);
}

import { Injectable } from '@nestjs/common';

export interface QQUserProfile {
  openId: string;
  nickname: string;
  avatarUrl: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

@Injectable()
export class AuthService {
  private currentUser: QQUserProfile | null = null;

  /**
   * QQ Music OAuth uses the QQ Connect platform.
   * Authorization URL: https://graph.qq.com/oauth2.0/authorize
   * Token URL: https://graph.qq.com/oauth2.0/token
   * User Info URL: https://graph.qq.com/user/get_user_info
   */
  getAuthUrl(): string {
    const clientId = process.env.QQ_APP_ID || 'YOUR_QQ_APP_ID';
    const redirectUri = encodeURIComponent('http://localhost:3200/auth/callback');
    const state = Math.random().toString(36).substring(2);
    return (
      `https://graph.qq.com/oauth2.0/authorize` +
      `?response_type=code` +
      `&client_id=${clientId}` +
      `&redirect_uri=${redirectUri}` +
      `&state=${state}` +
      `&scope=get_user_info,get_listen_song`
    );
  }

  async handleCallback(code: string): Promise<QQUserProfile> {
    // In production, exchange the code for an access token:
    // POST https://graph.qq.com/oauth2.0/token
    // Then use the token to get user info and QQ Music data.
    //
    // For development/demo, we simulate the response:
    const profile: QQUserProfile = {
      openId: `demo_${code.substring(0, 8)}`,
      nickname: 'QQ Music User',
      avatarUrl: '',
      accessToken: `token_${Date.now()}`,
      expiresAt: Date.now() + 7200 * 1000,
    };
    this.currentUser = profile;
    return profile;
  }

  getCurrentUser(): QQUserProfile | null {
    return this.currentUser;
  }

  logout(): void {
    this.currentUser = null;
  }

  isLoggedIn(): boolean {
    return this.currentUser !== null;
  }
}

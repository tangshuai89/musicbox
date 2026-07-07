/**
 * Spotify provider 白盒测试（Node built-in assert）。
 * 运行: npx ts-node packages/server/src/music/spotify.test.ts
 *
 * 不启动 nest、不调真实 Spotify API：测纯逻辑（PKCE 流程、token 刷新
 * 边界判断、字段映射 Web API → Track）。
 */
export {}; // 顶层 const 不与其他 .test.ts 冲突
const assert = require('node:assert');
const { SpotifyMusicProvider } = require('./spotify.provider');

// stub StorageService：resolveClientId 回退读它，这里恒返回 undefined，
// 所以"无 client_id → refresh 返 null"（测试 5）仍然成立。
const fakeStorage = { get: () => undefined, set: () => {} };
const svc = new SpotifyMusicProvider(fakeStorage);

// ── 1. PKCE start：authorizeUrl 包含所有 OAuth 参数 ────
{
  const r = svc.startAuth('test-client-id-123', 'http://localhost:3200/cb');
  assert.ok(r.authorizeUrl.startsWith('https://accounts.spotify.com/authorize'));
  assert.ok(r.state.length > 16, 'state 应够随机');
  const u = new URL(r.authorizeUrl);
  assert.strictEqual(u.searchParams.get('client_id'), 'test-client-id-123');
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'http://localhost:3200/cb');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('code_challenge'), '必须有 code_challenge');
  assert.ok(u.searchParams.get('scope'), '必须有 scope');
  console.log('✅ 1. PKCE start: URL 包含 client_id/redirect/scope/challenge');
}

// ── 2. exchangeCode: invalid state → 400 ──────────────────
void (async () => {
{
  try {
    await svc.exchangeCode({}, 'code', 'never-issued', 'http://cb');
    assert.fail('应该抛错');
  } catch (e: any) {
    assert.ok(/invalid_state/.test(e.message), '应抛 invalid_state');
    console.log('✅ 2. exchangeCode: invalid state 拒绝');
  }
}

// ── 3. isConfigured: 没 session 字段 → false ─────────────
{
  assert.strictEqual(svc.isConfigured(undefined), false);
  assert.strictEqual(svc.isConfigured({}), false);
  console.log('✅ 3. isConfigured: 无 token = false');
}

// ── 4. isConfigured: 有 token → true ─────────────────────
{
  const session = {
    spotify: {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 1_000_000,
    },
  };
  assert.strictEqual(svc.isConfigured(session), true);
  console.log('✅ 4. isConfigured: 有 token = true');
}

// ── 5. getValidAccessToken: 过期 token 应触发 refresh ─────
{
  // 我们不打真实 fetch，验"逻辑路径会调 refresh"——通过把 expiresAt
  // 设到 0 触发。
  const session = {
    spotify: {
      accessToken: 'expired',
      refreshToken: 'r',
      expiresAt: 0, // 已过期
    },
  };
  const tok: string | null = await svc.getValidAccessToken(session);
  // 没有 SPOTIFY_CLIENT_ID env，refresh 内部会返回 null
  assert.strictEqual(tok, null, '无 client_id 时 refresh 返 null');
  console.log('✅ 5. getValidAccessToken: 过期无 client_id 返 null');
}

// ── 6. getValidAccessToken: 未过期直接返回 ──────────────
{
  const session = {
    spotify: {
      accessToken: 'still-valid',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
    },
  };
  const tok: string | null = await svc.getValidAccessToken(session);
  assert.strictEqual(tok, 'still-valid');
  console.log('✅ 6. getValidAccessToken: 未过期直接返回');
}

// ── 7. saveToken: 写回 session ──────────────────────────
{
  const before = { nickname: 'foo' };
  const tok = {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: 1234,
  };
  const after = svc.saveToken(before, tok);
  assert.strictEqual(after.nickname, 'foo', '原字段保留');
  assert.deepStrictEqual(after.spotify, tok, 'spotify 字段写入');
  assert.notStrictEqual(after, before, '不可变（immutable）');
  console.log('✅ 7. saveToken: 写 spotify 字段 + 保留其他');
}

console.log('\n🎉 全部 7 个测试通过');
})();

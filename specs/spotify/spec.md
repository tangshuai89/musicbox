# Spotify Adapter

## 做什么

把 Spotify 作为第四个音乐源接入：
- 登录：OAuth PKCE（不需要 client secret，纯前端友好的标准流程）
- 搜索：Web API `/v1/search`
- 播放：Web API `/v1/tracks/{id}` → preview_url（30s 预览，同 Deezer 限制）
- ❤：Web API `/v1/me/tracks` (PUT/DELETE)
- liked 导入：Web API `/v1/me/tracks`

## 验收标准

- [ ] 登录入口：用户填 client_id → /auth/spotify/start 跳到 accounts.spotify.com 授权
- [ ] 回调 /auth/spotify/callback 收 code → 用 PKCE verifier 换 access_token + refresh_token
- [ ] token 持久化到 .storage（access + refresh + expires_at）
- [ ] access_token 过期（1 小时）→ 自动用 refresh_token 续
- [ ] 搜索返回 Web API 标准化 Track[]
- [ ] 播放走 preview_url（30s 限制同 Deezer，UI 提示）
- [ ] ❤ PUT/DELETE 写远端 liked
- [ ] liked 导入：拉 me/tracks → 进统一库
- [ ] 区域受限（preview_url=null）→ 仍展示但灰态（无版权）
- [ ] 客户端 ID 缺失 → 友好提示"先去 Spotify Developer 申请"

## 接口规格

### 后端

```
GET  /api/auth/spotify/status
→ { configured, loggedIn, expiresAt? }

POST /api/auth/spotify/start
Request: { clientId?: string }   // 不传 = 用之前保存的
Response: { authorizeUrl, codeVerifier, state }
   → renderer 跳到 authorizeUrl
   → state 写 session，callback 校验

GET  /api/auth/spotify/callback?code=&state=
→ 校验 state，code + verifier 换 token
   → 写 session.providers.spotify = { accessToken, refreshToken, expiresAt }

POST /api/auth/spotify/logout
→ 清 token

GET  /api/auth/spotify/client-id
POST /api/auth/spotify/client-id
Request: { clientId }
→ 存到 .storage/secrets.json（git-ignored）
   ⚠️ 跟 DeepSeek key 同样规则：只本地，不上传
```

### Spotify 端点

```
GET  /api/music/search?provider=spotify&q=...
   走 Spotify Web API /v1/search?q=...&type=track&limit=30

GET  /api/music/stream/spotify/{trackId}
   重定向到 preview_url（30s mp3），或 502 'no_preview' 当没有
```

## 实现范围（v1）

- ✅ OAuth PKCE 完整闭环（start / callback / refresh）
- ✅ search：Web API 调用 + 字段映射到 Track
- ✅ getStreamPath：preview_url 暴露
- ✅ like/unlike：PUT/DELETE /v1/me/tracks
- ✅ fetchLiked：GET /v1/me/tracks，importLiked 接入
- ❌ 完整曲库播放（Spotify 不允许非 Premium 完整曲流，仅 30s 预览）
- ❌ 设备切换 / Web Playback SDK

## 不做什么

- 不做"歌词"（Spotify API 需要另外 scopes，本轮不申请）
- 不做"按 genre 搜"（同 QQ 一样只走关键词搜索）
- 不做 client credentials 流程（PKCE 已经够 user 用）

## 技术约束

- 新模块 packages/server/src/music/spotify.provider.ts
- MusicProvider 接口：search / getStreamPath / like / unlike / fetchRadioBatch / fetchLiked
- 复用 P3 MatchService 匹配 Spotify 与其他平台
- 复用 P1 fanOutLike 把 ❤ 写到 Spotify
- 复用 P2 importLiked 把 Spotify liked 拉进统一库
- 客户端 ID 走 .storage secrets，跟 DeepSeek key 同档管理
- token 存 session.providers.spotify，刷新逻辑自己写（不依赖外部 SDK）

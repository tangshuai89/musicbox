- [x] 1. packages/server/src/music/spotify.provider.ts: 实现 MusicProvider 接口 (search/getStreamPath/like/unlike/fetchRadioBatch/fetchLiked + PKCE startAuth/exchangeCode + token refresh)
- [x] 2. OAuth PKCE: /auth/spotify/start + /callback + token refresh
- [x] 3. 客户端 ID 管理（同 DeepSeek key，存 secrets.json:spotify-client-id）
- [x] 4. 接入 MusicProvider 注册表（common/provider.ts 加 'spotify'）
- [x] 5. 接入 searchUnified / getStreamPath / fanOutLike / importLiked
- [x] 6. 前端 api.ts：startSpotify / getSpotifyStatus / setSpotifyClientId（v1 已实际接线，非 TODO）
- [x] 7. 前端音源选择页加 Spotify 项（v1 已实际接线：SourceSelect / SourceMenu / useAuth.handleSpotifyLogin）
- [x] 8. 白盒测试 7 条：PKCE URL 包含所有 OAuth 参数 / exchangeCode invalid state 拒绝 / isConfigured 边界 / token 过期 refresh 路径 / saveToken 不可变
- [x] 9. typecheck + 39/39 测试通过（search 12 + match 8 + reco 12 + spotify 7）
- [x] 10. e2e: 5 个 case (status / no client_id 400 / 短 client_id 400 / set client_id 200 / start returns real accounts.spotify.com URL)

## v2（全曲播放 + ❤ 写回）

- [x] 11. scopes 加 user-read-email + user-modify-playback-state（streaming 已在）
- [x] 12. exchangeCode 缓存 tier（/v1/me product）到 session.spotify.tier；session.ts 扩字段
- [x] 13. provider 加 getValidTokenForRenderer + getMeInfo + fetchMeInfo
- [x] 14. auth.controller 加 GET /auth/spotify/token + /me；status 带 tier
- [x] 15. renderer lib/spotify-wps.ts：WPS SDK 包装（connect/play/pause/resume/seek/transferHere/onStateChange）
- [x] 16. renderer hooks/useSpotifyWpsPlayer.ts：懒初始化 + token 续期重连 + 状态镜像
- [x] 17. api.ts：getSpotifyStatus 带 tier + getSpotifyToken + getSpotifyMe；AuthStatus 加 tier
- [x] 18. useAuth：透出 tier（登录成功 + provider 切换两条路径）
- [x] 19. SourceSelect：按 tier 切 desc（premium=全曲 / free=30s 预览）
- [x] 20. usePlayer：wpsRef 参数 + spotify+premium+wpsReady 分支（play/pause/resume/seek + audioUrl 清空 + applyWpsProgress 时间轴桥）
- [x] 21. App.tsx：wpsRef 桥接 usePlayer↔useSpotifyWpsPlayer 循环 + WPS 进度回喂
- [x] 22. index.html：defer 加载 sdk.scdn.co/spotify-player.js
- [x] 23. spotify.test.ts 加 5 条 v2 白盒（like PUT / unlike DELETE / like 401 / getValidTokenForRenderer 边界）——共 12 条
- [x] 24. typecheck 干净 + npm test 全绿（55+ case）+ renderer vite build 通过 + SDK script 进产物
- [ ] 25. 【需 Premium 手动】全曲播放 / 设备可见 / transport / token 重连 —— 开发者无 Premium，代码 code-complete 未运行验证（见 spec v2 验收）

## v2.1（Widevine 运行时：换 castLabs Electron —— 解决 WPS 起不来的真正卡点）

> v2 应用层 code-complete 但 vanilla Electron 无 Widevine CDM + 无 VMP 签名，
> WPS 永远 initialization_error 退 30s。换 castLabs fork 解决。

- [x] 26. electron devDep 换 `github:castlabs/electron-releases#v31.7.7+wvcus`（drop-in，同版）+ npm install
- [x] 27. main.ts: import `components` + 建窗口前 `await components.whenReady()` + log `components.status()`
- [x] 28. main.ts: 删无效的 `enable-features=EncryptedMedia` hack + 修 webPreferences Widevine 注释
- [x] 29. 删死路脚本 scripts/get-widevine-cdm.js（手动下 CDM 过不了 VMP）
- [x] 30. 打包 VMP：afterPack-vmp.cjs 调 `castlabs_evs.vmp sign-pkg`（codesign 前）+ build.afterPack + build.electronDist 指本地 castLabs dist
- [x] 31. typecheck 干净 + build:electron 通过 + 启动看 components.status() Widevine 就绪
- [ ] 32. ⚠️ 本机 iOA 挡 CDM 运行时下载：`components.whenReady()` 报 error 0 但 WidevineCdm/ 空，直连 CDM CDN 返回 567B HTML 拦截页。代码/配置正确，全曲无法在此机验证（见 spec v2 已知限制）
- [ ] 33. 【需无 TLS 拦截网络 + Premium 手动】dev 下 CDM 能下 + Premium 播整曲；【需 EVS 账号 + Premium】打包 DMG VMP 签名后仍能播整曲

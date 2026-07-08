# Next iteration

> 下一期（Phase 7+）的计划。每一项都有：目标、范围、验收标准、参考 spec
> （如有）。本文件随代码演进被修订；粒度按"一两个工作日一项"分块。

## 当前状态（基线）

Phase 0–5 + 前端架构重构（PR #13）已合入 `claude/next-iteration`，
主要能力 4 个平台都跑通：登录、搜索、radio、跨平台 match、统一库、
DeepSeek 推荐、跨平台 fan-out ❤、visionOS 风 Bento UI。

剩 ~15% 的工作集中在三类：

1. **生产化**：把 dev 跑得动的产品打包成能装的桌面包。
2. **平台对等**：Spotify 还没做到全曲播放 + ❤ 写回。
3. **UX 收尾**：歌词、第一帧、首次启动等小但高频场景的体验。

---

## 1. 生产打包（packaging）— **优先级最高**

- **Spec**: `specs/packaging/spec.md` + `tasks.md`（11/12 已勾，仅剩 README 同步）
- **范围**：
  - Electron main：prod 模式 spawn NestJS sidecar，等端口 ready 再 loadFile，
    关闭时 kill（已实现，需要端到端跑通 `npm run pack` 出 dmg）
  - preload 暴露 `apiBase` 到 `window.electronAPI.apiBase`（已实现）
  - renderer `api.ts` 优先读 `electronAPI.apiBase`（已实现）
  - `electron-builder` extraResources 把 `packages/server/dist` 打进 `.app/Contents/Resources/`
  - 端到端验证：装 dmg → 启 App → 能选源 → 放歌 → 关 App 时 sidecar 退出
- **验收**：
  - [ ] `npm run pack` 成功出 macOS dmg
  - [ ] 装到 `/Applications` 后双击启动：选源 → 电台放歌 → 重启 session 仍在
  - [ ] 关 App 时 Activity Monitor 看 `node` 进程已退
  - [ ] `packages/server/.storage/` 路径在 `~/Library/Application Support/musicbox/` 下
- **风险**：
  - 第一次跑 `electron-builder` 经常卡在 code signing（开发期 unset 即可）
  - dev 模式 / prod 模式的 API base 解析路径都已实现，**主要剩冒烟测试**
- **估时**：1–2 天（其中 1 天只是把它跑通 + 修 packaging 漏的小坑）

---

## 2. Spotify 平台对等

- **Spec**: `specs/spotify/spec.md`（P5 v1：OAuth PKCE + liked-songs read）
- **当前**：
  - ✅ OAuth PKCE 登录、读 liked 库、unified-search 串入、fan-out ❤ read 路径
  - 🚧 play 只能 30s 预览（无 Premium 账号，或我们还没接 `player` endpoint）
  - 📋 ❤ 写回 Spotify（`PUT /v1/me/tracks`）
- **范围（v2）**：
  - 走通 Spotify Web Playback SDK 的 OAuth scope (`streaming user-read-email user-modify-playback-state`)
    → 桌面 App 内嵌 WebView 跑 SDK（已有 Electron 嵌页能力）
  - ❤ 写回：拿 `access_token` 调 `PUT /v1/me/tracks?ids=...`
- **验收**：
  - [ ] Premium 账号能从 Spotify 源直接播完整曲目
  - [ ] unified search 选中 Spotify bestSource → 跳 Spotify Web Playback
  - [ ] 网易云 / QQ 收 ❤ 后，Spotify 端 playlist 同步出现
- **风险**：
  - Web Playback SDK 要 Premium + active browser-like context（Electron 满足）
  - ❤ 写回需要 user-library-modify scope，OAuth 流程里加即可
- **估时**：3–4 天（SDK 集成 + 测试矩阵）

---

## 3. 本地持久化加固

- **问题**：`.storage/state.json` 现在没备份机制；用户重装 / 换电脑 = 丢全部状态
- **范围**：
  - 在 Settings 里加 "导出/导入会话快照"：把 `state.json` + localStorage 关键键
    （provider / volume / deezer preset / theme）打包成 zip 导出
  - 导入时做 schema version 检查 + 合并（不覆盖已有平台的 liked 库）
  - 加 `STORAGE_BACKUP_DIR` env + 每日自动备份到 `~/Library/Application Support/musicbox/backups/`
- **验收**：
  - [ ] 导出 zip → 卸载 App → 重装 → 导入 → 所有 liked 库、登录态、偏好恢复
  - [ ] 备份目录里至少有最近 7 天的 snapshot
- **风险**：
  - 加密保存（用户密钥）— 简单方案：导出时让用户输口令，AES-GCM 加密
  - 写 spec 之前先和用户对：是否需要加密 / 是否需要云端同步
- **估时**：1–2 天

---

## 4. 歌词体验

- **当前**：单源歌词（QQ 优先，回退到 [lyrics.ovh](https://lyrics.ovh) 公开 API），synced 滚动
- **范围**：
  - 多源歌词聚合：先 QQ → NetEase → 第三方 → LRC 合并去重
  - 词句点击 copy、点击 share (生成带 cover 的图分享到…哪都行，本地下载)
  - "无歌词" 时引导用户从网易云提交（链过去）
- **验收**：
  - [ ] 跨平台搜索结果行右侧显示 lyrics 可用性指示
  - [ ] 复制整段歌词 vs 单行（toast 反馈）
- **风险**：第三方 lyrics API 合规（GGD 之类），先不碰
- **估时**：2–3 天

---

## 5. 设置 / 首次启动收尾

- **问题**：现在没有 Settings 页；首次启动的体验全靠 SourceSelect + RecoKeyModal
- **范围**：
  - 独立 `Settings` modal：DeepSeek key 重置、登录信息、库管理、备份入口、
    "源连接健康"（每个平台最近 24h 拉取成功率）
  - 首次启动时引导流程：选源 → （如果要推荐）配 DeepSeek key → 完成
  - 没有选源就退出 App 时，提示确认
- **验收**：
  - [ ] 全新 `rm -rf state.json` 启动 → 引导流 3 步走完 → 进 player
  - [ ] Settings 能查看每个源的状态、强制重连、清空平台 liked 库
- **估时**：2–3 天

---

## 6. 长期（≥ 一季度）

| 方向 | 描述 | 触发条件 |
| --- | --- | --- |
| iOS / Android 端 | React Native 重用 renderer 业务层；audio / OAuth 桥到 native | 桌面版稳定运行 1 个月以上 |
| 协同 / 共享库 | 多人 share 一个 unified 库；本地为主 + P2P 同步 | 用户反馈有需求 |
| 插件 / 自定义源 | MusicProvider interface 暴露给用户写自定义 adapter | 有用户写 issues 想要 |
| 多模态推荐 | DeepSeek 不止用 liked 库，还用播放历史、跳过的歌 | DeepSeek 给出更准的推荐 |

---

## 排期建议（按用户对"什么时候能用上"的优先级）

| 周 | 内容 |
| --- | --- |
| W1 | #1 打包（让产品能装）+ #3.1 导出/导入骨架 |
| W2 | #2 Spotify 完整播放 + ❤ 写回 |
| W3 | #4 歌词 + #5 Settings |
| W4 | 收尾、bug bash、本期发版 |

> 上面的估时是"代码写完"，实际产出还要算 review + 跑 spec 下 `tasks.md` 验收。
> 每项开工前先 `kb-spec <项目名>` 拉对应 spec 复习一遍。

## 工作流

- 每个新功能开工前：读 `specs/<name>/spec.md` 的 **验收标准** 段，作为 done 的判定
- 实现期间：实现完一项勾 `specs/<name>/tasks.md` 一条
- 收尾：跑 `npm run typecheck` + `npm test`（server 测）+ 浏览器/Electron 端到端走一遍
- 提 PR：commit message 沿用 `feat(<scope>): …` / `fix(<scope>): …` / `refactor(<scope>): …` 三段前缀

## 知识库挂钩

做完 #1 后，把"如何打包" 的踩坑沉淀到 `~/knowledge/musicbox/packaging.md`；
做完 #2 后沉淀 Spotify OAuth + Web Playback SDK 的 notes 到
`~/knowledge/musicbox/spotify.md`。这样下期迭代（或交接）的人有现成入口。

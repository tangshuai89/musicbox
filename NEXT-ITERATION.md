# Next iteration

> 下一期（Phase 7+）的计划。每一项都有：目标、范围、验收标准、参考 spec
> （如有）。本文件随代码演进被修订；粒度按"一两个工作日一项"分块。

## 当前状态（基线）

Phase 0–5 + 前端架构重构（PR #13）+ Spotify v2 全曲播放 + ❤ 写回（PR #34–#39）
均已合入 `master`。四大平台能力**端到端可用**：登录、搜索、radio、跨平台
match、统一库、DeepSeek 推荐、跨平台 fan-out ❤、visionOS 风 Bento UI、
Spotify Premium 全曲播放（Web Playback SDK + Widevine + castLabs Electron fork）。

剩 ~10% 的工作集中在三类：

1. **生产化最后一步**：`npm run pack` 端到端冒烟 + castLabs EVS VMP 签名
   把"能装"做成"装完能 Premium 播整曲"。
2. **Settings 收尾**：独立设置页（备份入口、DeepSeek key 管理、源连接健康、
   渠道优先级）+ 首次启动引导流。
3. **桌面体验与 AI 深化**：Lite 模式、桌面歌词浮窗、媒体键/全局热键、
   自然语言歌单（战略重点）。

---

## 1. 生产打包（packaging）— **接近完成，只剩端到端 + VMP 签名**

- **Spec**: `specs/packaging/spec.md` + `tasks.md`（task 1–15 已勾，仅 task 16 端到端冒烟未跑）
- **已完成**：
  - ✅ Electron main：prod 模式 spawn NestJS sidecar + waitForSidecar + 关闭 kill（#4–#6）
  - ✅ preload 暴露 `apiBase` 到 `window.electronAPI.apiBase`（#7）
  - ✅ renderer `api.ts` 优先读 `electronAPI.apiBase`（#8）
  - ✅ electron-builder extraResources：renderer / server / build 都进 `.app/Contents/Resources/`（#9、#13、#14）
  - ✅ macOS 应用图标（`.icns`）+ Dock 图标 + macOS Tray（播放/暂停/上下首/显示/退出）
    + 关窗到托盘、Cmd+Q 真退出并 kill sidecar（#15）
  - ✅ Spotify Widevine 路径：换 castLabs Electron fork（`v31.7.7+wvcus`）
    + `components.whenReady()` 接入（PR #39，specs/spotify v2.1）
  - ✅ 打包 VMP 钩子：`packages/electron/afterPack-vmp.cjs` 在 codesign 前
    调 `castlabs_evs.vmp sign-pkg`（含 `SKIP_VMP=1` 逃生阀），`build.electronDist`
    指本地 castLabs dist（PR #39）
- **仍剩**：
  - [ ] **task 16**：`npm run pack` 端到端冒烟出 macOS dmg（packaging spec 16）——
    需要 `npm install`（环境曾缺 7zip-bin 传递依赖，应已随 PR #39 lock 重生成恢复）
  - [ ] **本机一次性**：`pip install castlabs-evs` + `python3 -m castlabs_evs.account signup`
    跑通 VMP 签名（无 EVS 账号也可用 `SKIP_VMP=1 npm run pack` 跳签名，仅验打包管线）
  - [ ] **Premium 手动验收**：装 dmg → 登录 Premium → 播完整曲目 + Spotify 桌面端可见
    "maestro-xxxx" 设备 + transport 生效 + token 1h 重连不掉播
- **风险**：
  - 本机 iOA 拦 Widevine CDM 运行时下载（CDN `redirector.gvt1.com` 被 TLS 拦截——
    直连返 567B HTML 拦截页）。已在无 iOA 网络 + 已装 CDM 的机器上绕开。
  - EVS 签名是 castLabs 商业服务，但注册免费
- **估时**：0.5–1 天（一次性环境准备 + 一次冒烟）

---

## 2. Spotify 平台对等 — **已基本完成，仅剩 Premium 手动验证**

- **Spec**: `specs/spotify/spec.md` v1 + v2（v2 任务 1–24 全勾；v2.1 Widevine
  任务 26–31 全勾，仅 32/33 需 Premium 手动）
- **已完成**：
  - ✅ OAuth PKCE 完整闭环（start / callback / refresh）（v1 task 1–2）
  - ✅ Web API 搜索 + 字段映射到统一 Track（v1 task 5）
  - ✅ ❤ 写回（`PUT /v1/me/tracks`）+ Free 账号也能写（v2 task 11–14）
  - ✅ tier 缓存到 session，状态接口透出（v2 task 12、17、18）
  - ✅ Web Playback SDK 完整包装（spotify-wps.ts + useSpotifyWpsPlayer），
    含 token 续期重连、SDK ready 事件、wpsFatal/emeOk 兜底（v2 task 15–16）
  - ✅ usePlayer 路由：spotify + premium + wpsReady → WPS 全曲；
    否则回退 30s 预览（v2 task 20–21）
  - ✅ SourceSelect 按 tier 切 desc（v2 task 19）
  - ✅ Widevine 运行时换 castLabs fork + components.whenReady（v2.1）
- **仍剩**（specs/spotify tasks 25、32、33）：
  - [ ] Premium 手动：完整曲目播放 >30s / Spotify 桌面端可见设备 / transport / token 重连
  - [ ] 打包 DMG 经 EVS VMP 签名后 Premium 仍能播整曲
- **不做**：歌词（额外 scope，deferred）、曲末自动切歌（WPS 检测不可靠，已知限制）

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

## 3. 本地持久化加固 — ✅ #3.1 已完成（2026-07-14）

- **问题**：`.storage/state.json` 现在没备份机制；用户重装 / 换电脑 = 丢全部状态
- **已实现（#3.1）**：
  - Settings modal 加 "导出/导入会话快照"：`state.json` 全量 + localStorage 关键键
    （provider / volume / quality / deezer preset / theme）打包成**口令加密**
    （AES-256-GCM + PBKDF2）的 `.maestro-backup` 文件导出
  - 导入做 manifest version 检查 + additive 合并（`StorageService.mergeFrom`，
    不覆盖已有平台的 liked 库 / 登录态 / secrets）
  - `STORAGE_BACKUP_DIR` env + 每日自动备份（`BackupController`，保留最近 7 份）
  - Electron 打包模式把 `STORAGE_DIR` / `STORAGE_BACKUP_DIR` 指到
    `~/Library/Application Support/Maestro/`（顺手修了 sidecar 无 STORAGE_DIR 的隐患）
- **验收**：
  - [x] 导出加密快照 + 合并导入（服务端 4 路由端到端跑通；mergeFrom 6 条单测；
        AES-GCM 加解密 round-trip 验过：对口令解出、错口令拒绝）
  - [x] 备份目录每日自动 snapshot，保留最近 7 份（运行时验过：立即备份写文件 + prune）
  - [ ] 【需 GUI 手动】全新 App 里点齿轮 → 导出下载 / 选文件导入 → 状态恢复
        （SettingsModal UI 无法在无浏览器环境自动验，逻辑已全部验过）
- **不做**：云端同步（无服务器）；zip（改用 JSON+AES-GCM，零依赖更短）
- **spec**：本项无独立 spec 目录，设计见 `~/.claude/plans/` 里本轮 plan + 本节

---

## 4. 歌词体验 — **基础体验已用，多源聚合还没做**

- **当前**：单源歌词（QQ 优先，回退到 [lyrics.ovh](https://lyrics.ovh) 公开 API），synced 滚动
- **已完成**：
  - [x] 跨平台搜索结果行右侧显示 lyrics 可用性指示
  - [x] 复制整段歌词 vs 单行（toast 反馈）
- **仍剩**：
  - [ ] 多源歌词聚合：先 QQ → NetEase → 第三方 → LRC 合并去重
  - [ ] 词句点击 share（生成带 cover 的图分享到本地）
  - [ ] "无歌词" 时引导用户从网易云提交（链过去）
- **风险**：第三方 lyrics API 合规（GDPR 之类），先不碰
- **估时**：2–3 天

---

## 5. 设置 / 首次启动收尾 — **基本没动**

- **当前**：没有独立 Settings 页；首次启动体验靠 SourceSelect + RecoKeyModal
- **范围**：
  - 独立 `Settings` modal：DeepSeek key 重置、登录信息、库管理、备份入口（#3.1 已实装）、
    "源连接健康"（每个平台最近 24h 拉取成功率）
  - 首次启动时引导流程：选源 → （如果要推荐）配 DeepSeek key → 完成
  - 没有选源就退出 App 时，提示确认
- **验收**：
  - [ ] 全新 `rm -rf state.json` 启动 → 引导流 3 步走完 → 进 player
  - [ ] Settings 能查看每个源的状态、强制重连、清空平台 liked 库
- **估时**：2–3 天

---

## 6. 交互 & 桌面体验（2026-07-13 新增 · PM 自提）

> 本批 4 项来自产品侧一次集中提需求，粒度按"半天到两天一项"。
> 6.x 里凡"并入 #N"的，不重复实现，跟对应老项一起做、共用入口。

### 6.1 平台红心列表点击即播 — ✅ **已确认正常工作**

- **现状核实**：`LikedLibraryModal.tsx:122` 的"我的喜欢"合并库弹窗已可点播（`onPlay` → `usePlayer.playSearch`）。产品反馈指向另一处或旧构建——master 已无未接线列表。
- **状态**：✅ 无需代码改动；如有复现请先确认跑的是最新 master。

### 6.2 渠道优先级配置（并入 #5 Settings）

- **目标**：弱化"频繁手动切源"，改成在 Settings 里配置一次**渠道优先级**
  （QQ > 网易云 > Spotify > Deezer），日常播放交给 `bestSource` 按优先级自动选。
  首屏选源页（`SourceSelect`）**保留但弱化**——仅供快速首选，主控制移入 Settings。
- **现状**：`api.ts:314` `bestSource` 已按"版权 + 优先级"选源，服务端选源逻辑在
  `music.service`；优先级目前疑似硬编码，需暴露为用户可配。顶栏已有 `SourceMenu`。
- **范围**：
  - Settings 新增可拖拽排序的"渠道优先级"列表，存本地（与其它偏好一致，不上云）
  - `SourceMenu` 从"主操作"降级为临时覆盖（把某平台临时置顶），默认跟随优先级
  - 服务端 `bestSource` 读取该优先级（随请求携带或经 API 配置）
  - setting icon 入口与 #5 的 Settings modal 共用
- **验收**：
  - [ ] Settings 拖拽调优先级 → 保存 → 下次统一搜索/播放的 `bestSource` 按新序选
  - [ ] 首屏选源页仍在，但选过一次后不再强制弹（不再是日常必经）
  - [ ] 同名歌多平台有版权时，选中优先级最靠前的可播平台
- **依赖**：与 #5 Settings modal 合并实现。
- **估时**：+0.5～1 天（叠加在 #5 之上）

### 6.3 Lite 播放模式（normal / lite 切换）

- **目标**：新增极简播放模式。当前完整界面定为 `normal`；`lite` 模式播放器只显示：
  **歌名 + 上一首/下一首 + 一个「✨ 智能推荐」icon**（点击调 DeepSeek 推荐）。
- **范围**：
  - 全局 UI 模式状态 `normal | lite`，存本地偏好，Settings/快捷键可切
  - lite 布局：隐藏搜索面板、封面大图、歌词、源徽章等，仅留 歌名 + ◀▶ + ✨
  - ✨ icon → 调 `specs/reco-deepseek` 已有的 `POST /api/reco/run`，把推荐直接续进当前队列
  - （可选）窗口缩到小尺寸时建议/自动切 lite
- **验收**：
  - [ ] Settings 或快捷键切 normal↔lite，即时生效且记住偏好
  - [ ] lite 下界面仅剩 歌名 + 左右切歌 + ✨ 三类可视元素
  - [ ] 点 ✨ → 调 DeepSeek 推荐 → 新歌续入队列可播（无 key 时走 reco 既有友好提示）
  - [ ] normal↔lite 来回切，当前歌 / 队列 / 进度不丢
- **风险**：lite 只做**展示层裁剪**，复用现有 `usePlayer` 状态，别复制一套播放逻辑。
- **估时**：1.5～2 天

### 6.4 macOS Tray + Electron 应用图标（并入 #1 打包）— ✅ **已完成**

- **现状**：`packages/electron/src/` 只有 `main.ts` / `preload.ts`，**无 Tray、无自定义
  图标**（grep 无 `Tray` / `nativeImage` / `icon` 引用），Dock/关于面板是默认 Electron 图标。
- **范围**：
  - 应用图标：`.icns`(mac)/`.ico`(win)/png，配 electron-builder `build.icon` +
    `BrowserWindow` / Dock 图标
  - macOS Tray：托盘图标（模板图，暗黑自适应）+ 菜单（播放/暂停、上/下一首、
    显示主窗、退出）+（可选）悬浮显示当前歌名
  - 关窗到托盘（mac 习惯：关窗不退，留 Dock/Tray），Cmd+Q 才真正退出
- **验收**：
  - [ ] 打包后 Dock / 关于面板显示自定义图标，非默认 Electron
  - [ ] 托盘常驻，菜单能控制播放且状态与主窗同步
  - [ ] 关主窗 App 不退、托盘/Dock 仍在；Cmd+Q 真正退出并 kill sidecar
        （与 #1 打包的 sidecar 生命周期一致）
- **依赖**：与 #1 打包（`specs/packaging`）一起做，图标资源同时进 electron-builder 配置。
- **估时**：1 天

---

## 7. 播放体验 & AI 深化（2026-07-13 竞品分析新增）

> 来自一轮竞品扫描（MusicFree / 洛雪 lx-music / Listen1 / YesPlayMusic / Feishin /
> Spotify AI DJ / Apple AutoMix）。结论：Maestro 在 **AI 推荐 + 跨平台 ❤ 同步 + Bento UI**
> 上已领先同类开源播放器；缺的是老牌桌面播放器的"基本功"（音效/桌面歌词/桌面集成）。
> 本章前三项补基本功，7.4 深化 AI 护城河。详细分析只在 Notion 维护（个人重要，本地不留副本）→ https://app.notion.com/p/musicbox-2026-07-39c9be628711800b86f1daff4e05ad6b

### 7.1 均衡器 EQ + 交叉淡入淡出 + ReplayGain 音量均衡 — **未开始**

- **目标**：补齐洛雪 / foobar2000 / MusicBee 都有的音效与音量能力。
- **现状 / 复用点**：`usePlayer` 已在首次播放时惰性建了 **Web Audio graph**——EQ、淡入淡出、
  响度归一都挂这条链上，不用另起一套播放器。
- **范围**：
  - 10 段均衡器（BiquadFilter 级联）+ 预设（流行/摇滚/古典/人声…）+ 自定义，存本地偏好
  - 切歌交叉淡入淡出（crossfade，双 GainNode / 两个 audio 元素对接），时长可配；暂停/停止淡出防爆音
  - ReplayGain / 响度归一：优先用平台返回的响度元数据、否则 AnalyserNode 估算，统一到目标 LUFS
- **验收**：
  - [ ] EQ 开关 + 预设/自定义即时生效、记住偏好
  - [ ] 交叉淡入可开关，切歌无卡顿、无爆音
  - [ ] 跨平台连播时主观音量一致（响度归一生效）
- **风险**：HTML `<audio>` 真 gapless 较难，优先做 crossfade（更可控）；ReplayGain 精确值要解码分析，先用元数据/近似。
- **估时**：2–3 天

### 7.2 桌面歌词浮窗 — **未开始**

- **目标**：中文用户高频刚需（网易云/QQ/洛雪都有），你目前只有内嵌 synced 歌词。
- **现状 / 复用点**：已有 synced 歌词数据（QQ 优先 + lyrics.ovh 回退）与播放进度。桌面浮窗 =
  新开一个**透明、无边框、置顶**的 Electron BrowserWindow，经 IPC 接当前歌词行 + 时间轴。
- **范围**：
  - 独立透明置顶窗：可拖动/锁定位置、字号/颜色/描边可调、锁定时点击穿透
  - 双行（当前 + 下一行）滚动跟随播放进度；无歌词时隐藏或提示
  - 托盘/快捷键开关（与 6.4 Tray、7.3 热键联动）
- **验收**：
  - [ ] 开启后桌面出现置顶歌词，随播放逐行高亮
  - [ ] 可拖动定位、调样式；锁定后点击穿透不挡下层操作
  - [ ] 切歌 / 无歌词 / 暂停状态均正确
- **风险**：多显示器 / 全屏应用之上的置顶差异；mac 需处理 `visibleOnAllWorkspaces` + `setIgnoreMouseEvents`。
- **依赖**：与 6.4 Tray、7.3 热键同做入口最顺。
- **估时**：2 天

### 7.3 媒体键 + 全局热键 + 系统「正在播放」（并入 6.4 Tray）— **部分（仅 Tray）**

- **目标**：桌面集成基本功——耳机/键盘媒体键控制、全局快捷键、系统媒体中心显示当前歌。
- **现状**：6.4 的 Tray 已完成（macOS 菜单控制播放/暂停/上下首/显示/退出）。**尚未做**：
  `navigator.mediaSession`（系统媒体控件/媒体键）、`globalShortcut`（全局热键）、
  mac `MPNowPlayingInfoCenter`。
- **现状 / 复用点**：renderer 用 `navigator.mediaSession` 设 metadata +
  action handler；Electron 用 `globalShortcut` 注册全局热键；三者共享同一套播放命令。
- **范围**：
  - `navigator.mediaSession`：标题/歌手/封面 + play/pause/next/prev/seek（锁屏/系统媒体控件、部分平台媒体键）
  - Electron `globalShortcut`：全局 播放/暂停、上/下一首、音量、切 lite（6.3）、开关桌面歌词（7.2）
  - Tray 菜单动作复用同一套播放命令，不重复实现
- **验收**：
  - [ ] 键盘/耳机媒体键能控播放
  - [ ] 自定义全局热键在 App 不聚焦时也生效
  - [ ] mac「正在播放」/系统媒体控件显示当前歌名+封面并可控
- **风险**：mac `MPNowPlayingInfoCenter` 若 `navigator.mediaSession` 覆盖不全，可能需少量原生/额外模块；先做 MediaSession 能覆盖的，缺口标注。
- **依赖**：并入 6.4 Tray。
- **估时**：+1–1.5 天（叠加在 6.4 上）

### 7.4 自然语言歌单（DeepSeek）— ⭐ 本期战略重点 — **未开始**

- **目标**：**放大 AI 护城河**。对着播放器说人话——"放点适合夜跑的电子乐"/"周末慵懒的中文民谣"——
  直接生成可播队列。Spotify（DJ Requests / Prompted Playlists）、Apple（Playlist Playground）、
  YouTube 2025–2026 全在抢这能力，而开源聚合器一个都没有，你手里正好有 DeepSeek。
- **现状 / 复用点**：`specs/reco-deepseek` 已有 `POST /api/reco/run`（吃 {count, language, mood}）
  + 统一搜索回填 bestSource 的完整链路。本需求 = 在它上面加"自由文本 intent 解析"。
- **范围**：
  - 输入入口：播放器里一个文本框（lite 模式的 ✨ 复用它）；（可选）语音输入
  - DeepSeek 解析自由文本 → 结构化意图（mood/genre/tempo/语言/年代/相似艺人/排除项）
  - 意图驱动 reco.run（扩展入参）→ 产出 {title, artist}[] → 现有统一搜索填实 bestSource → 生成队列，可播/可存为歌单
  - 结果去重（对已 ❤ 库 + 上批推荐，复用 reco 既有 normalizeKey）
- **验收**：
  - [ ] 输入一句自然语言 → 数秒内生成 ≥10 首可播队列，风格/语言与描述吻合
  - [ ] "排除…""更多像 X 的"等约束能体现在结果里
  - [ ] 无 DeepSeek key 走 reco 既有友好提示；429/网络错误 fail loud 不静默
  - [ ] 生成的队列可一键存为本地歌单
- **风险**：LLM 输出强约束 JSON + 解析失败保留 raw（沿用 reco spec 做法）；带库上下文注意 token 上限。
- **依赖**：建议先落 `specs/nl-playlist/spec.md` 钉死意图 schema 与接口，再开工。
- **估时**：3–4 天（含 prompt 调试 + 搜索回填联调）

---

## 8. 长期（≥ 一季度）

| 方向 | 描述 | 触发条件 |
| --- | --- | --- |
| iOS / Android 端 | React Native 重用 renderer 业务层；audio / OAuth 桥到 native | 桌面版稳定运行 1 个月以上 |
| 协同 / 共享库 | 多人 share 一个 unified 库；本地为主 + P2P 同步 | 用户反馈有需求 |
| 插件 / 自定义源 | MusicProvider interface 暴露给用户写自定义 adapter | 有用户写 issues 想要 |
| 多模态推荐 | DeepSeek 不止用 liked 库，还用播放历史、跳过的歌 | DeepSeek 给出更准的推荐 |

---

## 排期建议（下期，按"什么时候能用上"的优先级）

| 周 | 内容 |
| --- | --- |
| **W1** | #1 收尾：`npm run pack` 端到端冒烟 + EVS VMP 签名一次性 setup + Premium 手动验收（需无 iOA 网络 + Premium 账号） |
| **W2** | #5 Settings（独立 modal：DeepSeek key、库管理、源连接健康）+ **#6.2 渠道优先级**（并入 Settings） |
| **W3** | #6.3 Lite 模式（normal/lite 切换 + ✨ 入口接 reco-deepseek） + **7.4 NL 歌单先写 `specs/nl-playlist/spec.md`** |
| **W4** | #4 歌词体验收尾（多源聚合 + share）+ 7.1 EQ / 7.2 桌面歌词（基本功打磨，优先级低于 W2/W3） |
| **W5** | 7.4 NL 歌单落地 + 7.3 媒体键/全局热键收尾 + bug bash + 发版 |

> **本轮（已发）**：
> - ✅ #1 包装主体 + #6.4 Tray/图标（packaging spec task 1–15）
> - ✅ #2 Spotify v2 全部应用层（task 1–24 + v2.1 task 26–31）+ Widevine 运行时换 castLabs fork
> - ✅ #3.1 加密备份 + 每日自动备份 + Electron 端 STORAGE_DIR 修正
> - ✅ #6.1 红心点播核实（无需改动）
>
> **不在本期范围**：
> - 6.x 全部不再做独立 PR（6.2 并入 #5、6.3 单做、6.4 已合、6.1 已合）
> - 7.x 除 7.3 媒体键外都属于"打磨批次"，发版前不必全做完
> - 7.4 NL 歌单要 W3 起 spec 先行（避免重蹈 6.4 一次性写大段发现的延迟）
>
> 上面的估时是"代码写完"，实际产出还要算 review + 跑 spec 下 `tasks.md` 验收。
> 每项开工前先读对应 spec（`specs/<name>/spec.md`）复习一遍，再决定要不要新建 ADR。

## 工作流

- 每个新功能开工前：读 `specs/<name>/spec.md` 的 **验收标准** 段，作为 done 的判定
- 实现期间：实现完一项勾 `specs/<name>/tasks.md` 一条
- 收尾：跑 `npm run typecheck` + `npm test`（server 测）+ 浏览器/Electron 端到端走一遍
- 提 PR：commit message 沿用 `feat(<scope>): …` / `fix(<scope>): …` / `refactor(<scope>): …` 三段前缀

## 知识库挂钩

**本轮（已发）的踩坑**还没沉淀到 `~/knowledge/maestro/`——下期开工前**优先**做：

- `~/knowledge/maestro/packaging.md`：sidecar 启动 + waitForSidecar + 关窗到托盘 + Cmd+Q kill
  + electron-builder extraResources / electronDist / afterPack（EVS VMP 签名 + codesign 时序）
- `~/knowledge/maestro/spotify.md`：OAuth PKCE + tier 缓存 + WPS 包装（spotify-wps.ts
  模式：window.__wpsSdkReady 旗位 + wpsFatal/emeOk/hasDeviceId 三态）
  + **Widevine 铁三角**：vanilla Electron 无 CDM、无 VMP；castLabs fork 是唯一同版
  drop-in；本机 iOA 拦 CDM CDN → 567B HTML 拦截页；换无 TLS 拦截网络或用 EVS 已签 .app

这样下期迭代（或交接）的人有现成入口。

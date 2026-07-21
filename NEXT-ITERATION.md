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
  - [ ] `packages/server/.storage/` 路径在 `~/Library/Application Support/Maestro/` 下
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

## 4. 歌词体验

- **当前**：单源歌词（QQ 优先，回退到 [lyrics.ovh](https://lyrics.ovh) 公开 API），synced 滚动
- **范围**：
  - 多源歌词聚合：先 QQ → NetEase → 第三方 → LRC 合并去重
  - 词句点击 copy、点击 share (生成带 cover 的图分享到…哪都行，本地下载)
  - "无歌词" 时引导用户从网易云提交（链过去）
- **验收**：
  - [x] 跨平台搜索结果行右侧显示 lyrics 可用性指示
  - [x] 复制整段歌词 vs 单行（toast 反馈）
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

## 6. 交互 & 桌面体验（2026-07-13 新增 · PM 自提）

> 本批 4 项来自产品侧一次集中提需求，粒度按"半天到两天一项"。
> 6.x 里凡"并入 #N"的，不重复实现，跟对应老项一起做、共用入口。

### 6.1 平台红心列表点击即播

- **现状核实（重要）**：`LikedLibraryModal.tsx:122` 的"我的喜欢"合并库弹窗，
  点行已经走 `onPlay(items, idx)` → `usePlayer.playSearch`，**已可点播**，底部
  还有"点击曲目直接播放"提示。产品反馈"上方按平台（QQ/网易云）拉取的红心列表
  点击不播"，指的**不是这个合并弹窗**。
- **范围**：
  - **先定位**到底是哪个列表不可点播——是尚未接 `onPlay` 的另一处平台原始红心
    列表，还是产品在跑**旧构建**（最新代码合并弹窗已可播）。开工第一步 `npm run dev`
    对最新代码验证，别改一个已经好的功能。
  - 若确有未接线的列表：行 `onClick` 复用现成的 `playSearch` / `onPlay(items, index)`
    队列路径（与搜索结果、合并库同源），点整行即入队播放，❤ 徽章不误触。
- **验收**：
  - [ ] 该平台红心列表点任意行 → 立刻播放该曲，并以整列表作为播放队列
  - [ ] 播放走 `bestSource`；全平台无版权的行灰态不可点（与 `SearchPanel` 一致）
  - [ ] 与"我的喜欢"合并弹窗行为一致，无第二套重复播放逻辑
- **风险**：极可能是"运行旧构建"的误报——务必先复现再动手。
- **估时**：0.5 天（定位 + 接线）

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

### 6.4 macOS Tray + Electron 应用图标（并入 #1 打包）

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

### 7.1 均衡器 EQ + 交叉淡入淡出 + ReplayGain 音量均衡

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

### 7.2 桌面歌词浮窗

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

### 7.3 媒体键 + 全局热键 + 系统「正在播放」（并入 6.4 Tray）

- **目标**：桌面集成基本功——耳机/键盘媒体键控制、全局快捷键、系统媒体中心显示当前歌。
- **现状 / 复用点**：并进 6.4 的 Tray 一起做。renderer 用 `navigator.mediaSession` 设 metadata +
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

### 7.4 自然语言歌单（DeepSeek）— ⭐ 本期战略重点

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

## 排期建议（按用户对"什么时候能用上"的优先级）

| 周 | 内容 |
| --- | --- |
| W1 | #1 打包（让产品能装）+ **#6.4 Tray/图标**（并入打包）+ #3.1 导出/导入骨架 |
| W2 | #2 Spotify 完整播放 + ❤ 写回 + **#6.1 平台红心点播**（0.5 天穿插） |
| W3 | #5 Settings + **#6.2 渠道优先级**（并入 Settings）+ #4 歌词 |
| W4 | **#6.3 Lite 模式** + 收尾、bug bash、本期发版 |

> **#7 竞品补强批次插入**：7.3 媒体键/热键随 W1 的 #6.4 Tray 一起做；7.1 EQ / 7.2 桌面歌词
> 排在 W4–W5（基本功打磨）；**7.4 自然语言歌单作为本期战略重点单列**，建议 W2 起先写
> `specs/nl-playlist/spec.md`、W4–W5 落地。
>
> 上面的估时是"代码写完"，实际产出还要算 review + 跑 spec 下 `tasks.md` 验收。
> 每项开工前先 `kb-spec <项目名>` 拉对应 spec 复习一遍。

## 工作流

- 每个新功能开工前：读 `specs/<name>/spec.md` 的 **验收标准** 段，作为 done 的判定
- 实现期间：实现完一项勾 `specs/<name>/tasks.md` 一条
- 收尾：跑 `npm run typecheck` + `npm test`（server 测）+ 浏览器/Electron 端到端走一遍
- 提 PR：commit message 沿用 `feat(<scope>): …` / `fix(<scope>): …` / `refactor(<scope>): …` 三段前缀

## 知识库挂钩

做完 #1 后，把"如何打包" 的踩坑沉淀到 `~/knowledge/maestro/packaging.md`；
做完 #2 后沉淀 Spotify OAuth + Web Playback SDK 的 notes 到
`~/knowledge/maestro/spotify.md`。这样下期迭代（或交接）的人有现成入口。

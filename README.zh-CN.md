# Maestro

[English](./README.md) · **简体中文** · [日本語](./README.ja.md)

> 你的跨平台「音乐大脑」。登录网易云音乐、QQ 音乐、Spotify、Deezer，把你在
> **每个平台的红心歌曲**都汇总到一起，用大模型（**DeepSeek**，使用**你自己**
> 的 API Key）推荐下一首值得心动的歌——当你想点红心时，就在**所有有版权的
> 平台上同时加红心**；从此再也不会因为「本地区无版权 / 无法播放」而卡住。

以 **Electron + React + NestJS** 构建，桌面客户端优先。

> ⚠️ **状态：Phase 0–5 完成，Phase 6（前端重构 + 打包）收尾中。** 四个平台
> 适配器、统一搜索、跨平台匹配引擎、统一库、DeepSeek 推荐、红心分发、visionOS
> 风 Bento 玻璃 UI、Spotify OAuth PKCE + 红心回写、Premium 全曲播放
>（Web Playback SDK + Widevine，跑在 castLabs Electron fork 上）均已在
> dev 下可用。剩余工作（VMP 签名打包、Settings / Lite 模式 UX、桌面体验细部）
> 见 [next-iteration plan](./NEXT-ITERATION.md)。

---

## 产品理念

每个流媒体平台都只握有你口味的一部分、也只握有全球曲库的一部分——而且都不
完整。你在 QQ 音乐上很爱的一首歌，网易云上没有；Spotify 推的一首歌，在你所
在地区又没版权。Maestro 把这四个平台当作**一个属于你自己的曲库**：

```
   ┌── 连接 ────────────────────────────────────────────────┐
   │  网易云 · QQ 音乐 · Spotify · Deezer                    │
   └───────────────┬────────────────────────────────────────┘
                   │  从每个平台拉取「红心 / 喜欢」的歌
                   ▼
   ┌── 汇总 ────────────────────────────────────────────────┐
   │  合并、去重，形成一个统一的「你喜欢的音乐」曲库         │
   └───────────────┬────────────────────────────────────────┘
                   │  送入 DeepSeek（你的 API Key）
                   ▼
   ┌── 推荐 ────────────────────────────────────────────────┐
   │  大模型推荐你接下来可能会爱的歌                         │
   └───────────────┬────────────────────────────────────────┘
                   │  你按下 ❤
                   ▼
   ┌── 全平台加红心 ────────────────────────────────────────┐
   │  在每一个有版权的平台上都加上 ❤                        │
   └───────────────┬────────────────────────────────────────┘
                   │  播放
                   ▼
   ┌── 永不撞墙 ────────────────────────────────────────────┐
   │  多平台同时搜索，从真正有版权的那个平台播放            │
   │  → 不再出现「无法播放」的断点                          │
   └────────────────────────────────────────────────────────┘
```

### 设计原则

- **桌面客户端优先。** 所有登录凭据与你的 DeepSeek API Key 都保存在**本地**，
  不会上传到任何 Maestro 服务器（也根本没有这样的服务器）。
- **汇总的数据归你所有。** 各平台的红心歌曲合并成唯一一份、只有你持有的曲库。
- **自带 AI Key。** 推荐通过 DeepSeek 完成，用你自己提供的 Key——成本与数据
  都由你掌控。
- **处处考虑版权。** ❤ 只会分发到有版权的平台；播放与搜索会自动回退到真正
  能提供该曲目的平台。

---

## 状态与进度

图例：✅ 已完成 · 🚧 部分 / 进行中 · 📋 计划中

### 各平台能力

| 能力                       | 网易云 | QQ 音乐 | Spotify | Deezer |
| -------------------------- | :----: | :-----: | :-----: | :----: |
| 登录                       | ✅ 扫码 | ✅ cookie（内嵌窗口） | ✅ OAuth PKCE | ✅ 匿名（免登录） |
| 播放完整曲目               | ✅ | ✅（标准 / 320 / 无损） | ✅ Premium · 🚧 Free = 30 秒预览 | 🚧 仅 30 秒预览 |
| 电台 / 推荐流              | ✅ 私人 FM | 🚧 关键词伪电台 | 🚧 短预览 | ✅ 编辑精选榜 |
| 搜索                       | ✅ | ✅ | 🚧 有限 | ✅ |
| 本地红心 / 不喜欢          | ✅ | ✅ | ✅ | ✅ |
| 红心回写到平台            | ✅ | ✅ | ✅ | ✅ |
| 导入你已有的红心歌曲      | ✅ | ✅ | ✅ | ✅ |

### 贯穿性产品功能

| 功能                                          | 状态 |
| --------------------------------------------- | :--: |
| 多音源播放器骨架（Electron/React/Nest）       | ✅ |
| 各平台登录与会话持久化                         | ✅ |
| 服务端音频代理（真实 URL 永不进入前端）        | ✅ |
| visionOS 风 Bento 玻璃 UI（封面驱动强调、低频呼吸高亮、歌词面板）| ✅ |
| 明 / 暗 / 系统主题                            | ✅ |
| **跨源统一搜索与播放回退**                     | ✅ |
| **跨平台曲目匹配**（ISRC + 标题/艺人/时长模糊）| ✅ |
| **统一红心曲库**（导入 + 去重）                | ✅ |
| **DeepSeek 自带 Key AI 推荐**                 | ✅ |
| **红心分发到所有有版权的平台**                 | ✅ |
| **Spotify 适配器**（OAuth PKCE + 读取 + 红心回写 + WPS Premium 全曲）| ✅ |
| 前端架构：CSS/tsx 解耦 + SCSS 7-1 + 拆巨石 | ✅ (PR #13) |
| **castLabs Electron fork**（Widevine CDM + VMP 签名，Spotify WPS 用）| ✅ (PR #39) |
| **生产打包**（NestJS sidecar + prod API 基址 + EVS VMP 签名）| 🚧 进行中 |

**相对完整愿景的大致完成度：约 90%。** 本产品**定义性**的核心功能（统一搜索、
匹配、曲库、DeepSeek、红心分发、Spotify 全曲播放）均端到端可用。剩余主要是
打包与 UX 收尾——见 [NEXT-ITERATION.md](./NEXT-ITERATION.md)。

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  渲染层 Renderer (React + Vite, :5173)                       │
│   - 调 /api/*（Vite 开发代理转发到 NestJS，剥掉 /api 前缀）  │
│   - <audio> src = /music/stream/{provider}/{id}             │
│   - 封面取色、主题、音源切换                                  │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTP（cookie 会话）
┌───────────────────────────────▼──────────────────────────────┐
│  NestJS 服务端 (:3200)                                        │
│   common/   配置 · 存储 · 会话                                │
│   auth/     QQ cookie 登录 · 网易云扫码登录                   │
│   music/    各平台策略 + 音频代理（302 / 转发）              │
│                                                               │
│   📋 计划：library/（红心汇总）· reco/（DeepSeek）           │
│           · match/（跨平台曲目匹配）                          │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTPS（携带各平台凭据）
       ┌──────────────┬─────────┴──────────┬──────────────┐
       ▼              ▼                     ▼              ▼
  music.163.com   y.qq.com            Spotify Web API  api.deezer.com
  （明文 /api）   （搜索 + GetVkey）    📋 计划中       （公开 API）
```

**Electron 主进程**还额外承载一个内嵌登录窗口（用真实的 Chromium 会话捕获
QQ 音乐登录 cookie）以及一个内部代理脚手架。会话与红心 / 不喜欢状态持久化到
`packages/server/.storage/state.json`（已被 git 忽略）。

---

## 目录结构

```
packages/
  electron/   Electron 主进程 —— 窗口 + 内嵌登录捕获
    src/main.ts, src/preload.ts
  renderer/   React 前端（UI、播放器、音源切换、搜索、扫码弹窗）
    src/App.tsx, api.ts, SourceSelect.tsx, SearchPanel.tsx, NeteaseCookieModal.tsx
  server/     NestJS 后端
    src/common/   配置 · 存储 · 会话 · provider 注册
    src/auth/     auth.controller · qq.strategy · netease-auth.strategy
    src/music/    music.controller · music.service
                  qq.provider · netease.provider · deezer.provider
                  netease-crypto（weapi AES/RSA —— 遗留代码，见说明）
```

---

## 安装

```bash
# 需要 Node 18+（推荐 Node 22）。使用 npm workspaces。
npm install

cp .env.example .env    # 可选 —— 每个变量都有合理的开发默认值
```

## 开发

```bash
npm run dev
# 并行运行：
#   nest start --watch   → 服务端 :3200
#   vite                 → 渲染层 :5173
#   electron             → 3 秒后打开窗口
```

Vite 开发服务器会把 `/api/*`（剥掉 `/api` 前缀）与 `/music/*` 代理到 `:3200`
的 NestJS，因此开发时整个应用同源，共享同一个会话 cookie。

## 环境变量

开发时所有变量都可选，服务端会回退到合理默认值。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3200` | NestJS 端口 |
| `RENDERER_BASE` | `http://localhost:5173` | 登录后重定向基址 |
| `RENDERER_ORIGINS` | `http://localhost:5173,http://localhost:3000` | CORS 白名单 |
| `SESSION_SECRET` | 开发占位符 | Cookie 签名密钥 —— **生产必须设置** |
| `SESSION_TTL_MS` | 30 天 | 会话有效期 |
| `STORAGE_DIR` | `.storage` | `state.json` 存放位置 |
| `NETEASE_MUSIC_U` | – | 仅开发：注入网易云 `MUSIC_U` cookie |
| `NETEASE_QR_POLL_MS` | `1500` | 扫码轮询间隔 |
| `DEEPSEEK_API_KEY` | – | 📋 计划中 —— 用于推荐的 DeepSeek Key |

---

## 各音源登录方式

- **网易云音乐** —— 点「登录」，用网易云手机 App 扫码确认。服务端直连网易云
  明文 `/api/login/qrcode/*` 端点，成功时从 `Set-Cookie` 捕获 `MUSIC_U`；另有
  「手动粘贴 `MUSIC_U`」兜底入口。cookie 约 30 天有效，接口开始返回 `301`
  时重新扫码即可。
- **QQ 音乐** —— 点「登录」（仅桌面 App）。Maestro 打开内嵌 QQ 音乐登录窗口，
  捕获真实登录 cookie（`qm_keyst` / `qqmusic_key` / `uin`）—— **不走** QQ 互联
  OAuth，无需 AppID/Secret。随后可搜索 + 播放完整曲目（标准 / 320 / 无损），
  无损需 QQ 音乐会员。
- **Deezer** —— 免登录。匿名公开编辑精选榜，播放 30 秒预览。
- **Spotify** —— ✅ OAuth PKCE 登录 + 红心回写（`PUT /v1/me/tracks`），已接入
  跨平台红心分发。Premium 账号在 castLabs Electron fork + Web Playback SDK +
  Widevine 下可播完整曲目（仍需 EVS VMP 签名打包后做最终手动验证）。Free 仍是
  30 秒预览。

---

## 生产构建

```bash
npm run build                         # server + renderer + electron
cd packages/electron && npm run pack  # electron-builder 出 macOS dmg
```

> **生产打包进度：** NestJS sidecar 化 / prod API 基址切换 / macOS Tray /
> 自定义 Dock 图标（specs/packaging #15）已完成。剩 `npm run pack` 端到端冒烟
>（packaging spec task 16）与 Widevine VMP 签名（`afterPack-vmp.cjs` 配
> `castlabs_evs` EVS 账号；EVS 注册是本机一次性手动）。

---

## 隐私与安全

这是一个**本地优先的个人工具**。平台 cookie（`MUSIC_U`、QQ 登录 cookie）、
会话、以及未来的 DeepSeek API Key，都以明文保存在你自己机器上的
`packages/server/.storage/` 目录里，且**已被 git 忽略**。没有任何数据会上传
到 Maestro 运营的服务（因为并不存在这样的服务）。请把 `.storage/` 当作密码
文件一样对待。

## 许可证

MIT

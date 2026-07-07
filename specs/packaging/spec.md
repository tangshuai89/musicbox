# 打包：把 NestJS sidecar 到 Electron 桌面包

## 做什么

目前 `npm run pack`（electron-builder mac dmg）出来的包**不能跑**：
1. NestJS 没在桌面包里 → renderer 找不到 API
2. Prod renderer 用 `http://localhost:3200/api/...`，但桌面用户不会本地跑 server

修两件事：
1. tsc 编译 NestJS → dist/；electron-builder 把 `packages/server/dist` 复制为 extraResources
2. Electron main 在 packaged 模式 spawn `node resources/server/main.js` 当 sidecar，
   等端口就绪再 loadFile（renderer）。端口由 NestJS 自己选（PORT env，默认 3200），
   preload 把 sidecar URL 透给 renderer。

## 为什么不用 esbuild bundle 成单文件

试过 esbuild bundle（external @nestjs/* + reflect-metadata + rxjs），
跑起来 DI 注入挂了：`Cannot read properties of undefined (reading 'storageDir')`。
原因：esbuild bundle 模式不生成 TypeScript 的 `__metadata("design:paramtypes", ...)`，
NestJS DI 就识别不出构造函数参数类型。
第三方插件（esbuild-plugin-tsc）能解，但本轮不引入额外依赖。
tsc 编译 + 整 dist/ 走 sidecar 是更稳的方案。

## 验收标准

- [ ] `npm run build:server` 产出 packages/server/dist/（已存在，nest build 跑过）
- [ ] `node packages/server/dist/main.js` 独立启动后 :3200 正常服务（已验过）
- [ ] `npm run pack`（electron-builder）产物 Resources 里有 server/dist
- [ ] Electron packaged 启动后，main spawn sidecar → 等端口 ready → 打开 BrowserWindow
- [ ] 关闭 BrowserWindow / app quit 时 sidecar 跟着 kill
- [ ] renderer 端通过 preload 拿到 sidecar URL（替代 hardcode localhost:3200）

## 实现范围（v1）

- ✅ tsc 编译（已存在）；electron-builder extraResources 配 server/dist
- ✅ Electron main: prod 模式 spawn sidecar + 等端口 ready + 关闭时 kill
- ✅ preload 暴露 sidecar URL 到 window.electronAPI.apiBase
- ✅ renderer api.ts: 优先读 window.electronAPI?.apiBase，回退 import.meta.env 推导
- ❌ Windows / Linux pack（只 mac 走通；electron-builder config 已有 mac 段）
- ❌ 完整 installer / auto-update（electron-builder 有但本轮不验）
- ❌ node_modules sidecar 装包（当前走 assumption：dev 模式 renderer 走 vite proxy，
      prod 模式 NestJS 起在自己 dist/，不需要 node_modules 重新装——见下方"已知限制"）

## 不做什么

- 不做内嵌 NestJS 到 Electron main 进程（child_process spawn 更稳）
- 不做 NestJS hot-reload（生产不需要）
- 不做 auto-restart sidecar（崩溃让用户重启 App）
- 不做 installer / signing / auto-update（electron-builder 有但本轮不验）

## 已知限制

- 桌面包里要带 node_modules（NestJS 运行时依赖）。这会让 .dmg 涨 ~50MB。
  真要省体积要上 esbuild 完整 bundle + 修 metadata 丢失——见上。
- 端口固定 3200；冲突时让用户手动 kill 冲突进程（不起多实例）。
- 桌面包里的 .env / secrets.json 不进 git，要用户首次启动后手动配 DeepSeek key / Spotify client id。

## 技术约束

- Electron main: 用 child_process.spawn node 启 dist/main.js，detached: false
- 端口 ready 检测：轮询 http://127.0.0.1:{port}/music/editorials（轻量 endpoint），最多 30 秒超时
- sidecar 进程注册到 app.on('before-quit') / window-all-closed 时 kill
- preload 用 contextBridge.exposeInMainWorld 暴露 apiBase
- api.ts 优先读 window.electronAPI?.apiBase → '' (走 same-origin) → http://localhost:3200


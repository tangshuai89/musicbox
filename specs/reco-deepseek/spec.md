# DeepSeek 推荐引擎

## 做什么

把用户的统一库（P2 导入得到的）喂给 DeepSeek，让它根据库里的歌推荐用户
可能喜欢的新歌。返回的"推荐歌名 + 歌手"再去统一搜索（P0）查真实可播
的平台，回填到推荐队列里播放。

## 验收标准

- [ ] 用户在 UI 设置页填入 DeepSeek API key，存到本地（.env 或 storage）
- [ ] 没设 key 时调推荐 → 友好提示"请先在设置里填入 DeepSeek API key"
- [ ] 推荐请求带统一库（最多前 200 首）+ 想要的语言 / 风格 prompt
- [ ] 响应解析：JSON 数组，每项 { title, artist }；解析失败 → 报错并保留 raw 给 debug
- [x] 推荐结果去重：和已 ❤ 库 + 上一批推荐去重（normalizeKey）
  > `run(opts.exclude)`：auto-continue 时前端把队列里已推荐的歌回传，服务端
  > 并进 dedup seen 集合 + prompt 的「请勿再推荐」清单（reco.test #13）。
- [x] 拿到推荐后用 P0 的统一搜索填实平台源（自动用 bestSource）
- [x] 推荐列表分页：每页 10 条，按用户消费进度（已听 N 条自动加页）
  > 播到最后一首 → `usePlayer.loadNextTrack` 用 `queueRef.loadMore`（reco 队列
  > 专属）取下一批 append 续播，而非循环回第一首；`useReco` 提供 loadMore
  > 并带上 exclude。空批/失败兜底回退到循环。
- [ ] rate-limit 429：暂停重试 + UI 显示"推荐暂缓，请稍候"
- [ ] 网络错误：fail loud，不静默吞

## 接口规格

### 后端

```
GET  /api/reco/status
→ { configured: boolean, lastRunAt?: number, librarySize: number }

POST /api/reco/run
Request:
  { count?: number;   // 默认 10
    language?: 'zh' | 'en' | 'ja' | 'auto';
    mood?: string;     // 自由文本
  }
Response:
  { items: UnifiedSearchItem[];   // 已 fill 平台源
    model: string;               // 'deepseek-chat'
    runAt: number;
  }
Error:
  400: 还没 import 库
  412: 没设 DeepSeek key
  429: 上游 rate-limit
  502: 上游 5xx

POST /api/reco/key
Request: { apiKey: string }
Response: { ok: true }
→ 写到 process.env.DEEPSEEK_API_KEY + .storage/secrets.json（git-ignored）
  ⚠️ 注意：secrets 文件不参与持久化 state 的 export，永远本地
```

### 前端

设置页（SettingsPanel 或 SidePanel）：
- "DeepSeek API Key" 输入框（type=password），存/改
- 留 "DeepSeek 平台" 链接：https://platform.deepseek.com
- key 状态行："已配置（key 末 4 位 ab12）"/ "未配置"

主界面：
- "🎲 推荐" 按钮（搜索按钮旁边）
- 点击 → POST /api/reco/run → 拿到 UnifiedSearchItem[] → 直接走 P0 的播放队列

## 实现范围（v1）

- ✅ DeepSeek OpenAI-compatible API 调用（base_url=https://api.deepseek.com/v1）
- ✅ prompt 模板：system + user（带 library 列表 + 偏好）
- ✅ 响应 JSON 解析（带 retry 一次：模型偶尔在 ```json 围栏里）
- ✅ 推荐结果二次去重（库内已有 + 本次重复）
- ✅ 用 P0 统一搜索填实平台源
- ❌ 长期记忆 / 反馈学习（v1 不做）
- ❌ prompt 调优工具（先 hardcode 一个能用的 prompt）

## 推荐质量调优（v1.1，2026-07）

三段流水线：**选歌（DeepSeek）→ 去重 → 填平台源（统一搜索）**。这轮 7 项优化：

- [x] **#1 填源匹配校验**：`fillPlatforms` 不再无脑取 `searchUnified` 首条——先按
      `normalizeKey(歌名+歌手)` 精确匹配，再退化到歌名+歌手双向包含（`looseMatch`），
      都不中就**丢弃**，杜绝同名翻唱/live/纯音乐/不相关首条混进队列（reco.test #14/#15）
- [x] **#2 填源并行**：串行 for-await → 分波 `Promise.all`，并发上限 `FILL_CONCURRENCY=6`
      （压住对 netease/QQ 的读并发，避免「操作频繁」），总耗时从 Σ 降到 ~max
- [x] **#3 库随机采样**：不再固定喂前 200，`sampleLibrary` 从**全库**随机采样 150 首当种子，
      每次 run 换一批 → 缓解同质化，长库靠后的歌也能影响推荐
- [x] **#4 超额要 + 补位**：向模型要 `count×2`（上限 40），fillPlatforms 分波补到 `count`
      为止（reco.test #16），避免 dedup/匹配损耗后数量不足
- [x] **#5 session 历史去重**：`reco:history:{sessionId}` 存最近 200 首，`run` 时并进
      exclude + prompt 避让 → **手动连点「推荐」也不复读**（不止 auto-continue）
- [x] **#6 prompt 强化**：明确"录音室原版、排除 live/翻唱/remix/伴奏、歌手用原文、
      宁少勿编"，并点名用户**高频歌手**（`topArtists`）当口味锚点
- [x] **#7 统一归一**：dedup 复用 `search.util.normalizeKey`（含全角→半角），与搜索/
      匹配同口径，堵全角/半角变体漏去重
- [x] **#8 版本偏好（挑正常音源）**：`searchAndMatch` 在匹配上的候选里按**版本纯净度**
      打分挑选——录音室原版 0 < live/现场 10 << DJ/remix/伴奏/加速/抖音/翻唱/纯音乐 100
      （`versionPenalty`/`VERSION_BAD`/`VERSION_SOFT`，只扫 title 免误伤 "DJ Okawari"
      这类艺人名）。修「晴天搜出来是 DJ 版」：有录音室原版就选原版；**只剩坏版本且
      用户没点名要 → 丢弃让上层补位换一首正常歌**；rec 自己点名 remix/live 则豁免。
      候选池扩到 15，且只保留可播（bestSource≠null）的。回归见 reco.test #17/#18/#19

## 不做什么

- ~~不持久化推荐历史~~ → v1.1 起持久化「最近推荐过」用于去重（不是"历史推荐结果"，
  只是去重键；库变了不影响，因为只按歌名+歌手 normalizeKey 比对）
- 不做"推荐质量反馈" UI
- 不做 AB / 模型选择——只用 deepseek-chat（温度 0.9 hardcoded）

## 技术约束

- HTTP 客户端用 fetch（统一 server 风格）
- 5xx / 网络错误：fail loud（throw），controller 转 502
- 429：throw RateLimitError，controller 转 429 + Retry-After 头
- API key 不写日志（logger 只记 key 末 4 位 + provider）
- 库规模限制：前 200 首喂给 prompt（token 预算）
- 新 module：packages/server/src/reco/reco.service.ts

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
- [ ] 推荐结果去重：和已 ❤ 库 + 上一批推荐去重（normalizeKey）
- [ ] 拿到推荐后用 P0 的统一搜索填实平台源（自动用 bestSource）
- [ ] 推荐列表分页：每页 10 条，按用户消费进度（已听 N 条自动加页）
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

## 不做什么

- 不持久化推荐历史（每次 run 重新生成，避免用户库变了之后旧推荐失真）
- 不做"推荐质量反馈" UI
- 不做 AB / 模型选择——只用 deepseek-chat

## 技术约束

- HTTP 客户端用 fetch（统一 server 风格）
- 5xx / 网络错误：fail loud（throw），controller 转 502
- 429：throw RateLimitError，controller 转 429 + Retry-After 头
- API key 不写日志（logger 只记 key 末 4 位 + provider）
- 库规模限制：前 200 首喂给 prompt（token 预算）
- 新 module：packages/server/src/reco/reco.service.ts

# Liked 导入：把各平台"我的喜欢"合并为统一库

## 做什么

从用户已登录的每个平台拉取"我的喜欢"列表（NetEase "我喜欢的音乐"，
QQ 收藏，Deezer user tracks），合并去重后存到 `.storage/library.json`。
为后续的 P4 DeepSeek 推荐 / 统一库 UI / 跨平台回退提供数据基础。

## 验收标准

- [ ] POST /music/library/import 调用后，library.json 写入
- [ ] 单平台拉取失败不阻塞——返回里 `sources[].error` 记录
- [ ] 跨平台同歌合并：用户在 QQ + 网易云都 ❤ 的同一首歌，在库里出现 1 次，sources 列表里有两条
- [ ] duration gate：同歌名但 duration 差 >3 秒视为不同版本（remix/live）
- [ ] 库读：GET /music/library 返回最近一次 import 的结果
- [ ] 未 import 时 GET /music/library → 404 `library_not_imported`
- [ ] 重新 import → 覆盖原结果（不是 merge）

## 接口规格

### POST /music/library/import

触发导入。无 request body。返回：

```ts
{
  items: UnifiedSearchItem[];            // 去重后的统一库
  sources: Array<{
    provider: 'qq' | 'netease' | 'deezer';
    count: number;                        // 拉取成功数
    error?: string;                       // 'not_logged_in' / 'qq_favorites_requires_signature_not_yet_implemented' / 等
  }>;
  importedAt: number;                     // ms timestamp
}
```

### GET /music/library

返回最近一次 import 的同 shape 数据，404 `library_not_imported` 当未 import。

## 实现范围（v1）

- ✅ NetEase: `fetchLiked` 走 `/api/nuser/account/get` → `/api/user/playlist` →
  `/api/v6/playlist/detail` 三步拉取"我喜欢的音乐"歌单
- ❌ QQ: 收藏 API 需要 vkey/g_tk 签名，本轮不接；返回 `error: 'qq_favorites_requires_signature_not_yet_implemented'`
- ❌ Deezer: 匿名模式无 user 概念；返回 `error: 'deezer_anonymous_no_user_likes'`
- ✅ 跨平台合并：复用 P3 的 MatchService.mergeLibrary

## 持久化

`.storage/state.json` 里 session 下新增键 `library:{sessionId}`：

```ts
{
  importedAt: number;
  items: UnifiedSearchItem[];
  sources: Array<{provider, count, error?}>;
}
```

## 不做什么

- 不做"增量同步"——每次 import 是全量覆盖
- 不做"导入后自动 ❤ 到其他平台"——用户可以手动点 fan-out ❤（P1 路径）
- 不做 UI 集成——本轮只做后端 + endpoint，UI 是下一轮

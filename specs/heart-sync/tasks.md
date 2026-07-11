# Heart 跨平台同步 — tasks

## 同步队列（MQ 思路）
- [x] 1. 新建 `music/like-sync.queue.ts`：`LikeSyncQueue`（合并去重 + 串行 drain + 退避重试）
- [x] 2. `enqueue` 空 targets 忽略；同 key 方向一致合并、方向翻转覆盖
- [x] 3. `dedupeByPlatform` 兜底「每平台一首」
- [x] 4. 在 `music.module.ts` 注册 `LikeSyncQueue`
- [x] 5. `MusicService` 构造函数注入并 `registerProcessor` → `syncLikeRemoteOnce`

## 检测改造（只读 + 入队）
- [x] 6. `syncLikeRemoteOnce`：单次远端写，成功更新缓存、失败 throw（供队列重试）
- [x] 7. `canSyncLike`：deezer / 未登录 → false
- [x] 8. `detectLikedAndSync` 改为只读检测；发现红心 → 乐观点亮本地 + 每平台一首入队
- [x] 9. `fanOutLike`：本地 setLike 保持同步（e2e 依赖），远端写改走队列
- [x] 10. `toggleLike`（单平台电台）远端写也走队列

## 网易云接口修正
- [x] 11. `netease.setRadioLike(liked)` 收敛 like/unlike；`unlike` = `radio/like?like=false`
- [x] 12. 新增 `netease.fmTrash` = `radio/trash/add`（踩/不喜欢）
- [x] 13. `markDisliked` 改用 `fmTrash`

## Deezer 结构性排除（高危 #4：匿名源污染本地红心）
- [x] D1. `isLikeable(provider)`：`!ANONYMOUS_PROVIDERS.has(provider)`
- [x] D2. `setLike` 守卫：非 likeable → no-op（bulletproof，任何路径误传都不落地）
- [x] D3. `toggleLike` 对非 likeable 早退 no-op（Deezer 电台点 ❤ 不点亮/不入队）
- [x] D4. `fanOutLike` 循环跳过非 likeable；构建 current 时过滤历史 Deezer
- [x] D5. `canSyncLike` 显式先过 `isLikeable`
- [x] D6. `loadState`：清掉历史污染的 Deezer `liked` + 过滤 `fanOut` 里的 Deezer
- [x] D7. like.e2e：1–4 改用 qq/netease/spotify；新增 4b 断言 Deezer 不计账（共 12 项）

## 踩 = 取消跨平台红心
- [x] 14. `MusicService.dislikeMerged`：fanOutLike(false) 取消红心 + disliked 标记 + fmTrash
- [x] 15. `POST /music/dislike/merged`（注册在 `/dislike/:trackId` 之前）+ 入参校验
- [x] 16. `api.ts` 加 `dislikeMerged(mergedId, sources)`
- [x] 17. `usePlayer.handleDislike`：统一队列上下文走 dislikeMerged + 熄灭 ❤/归零角标，
        单平台电台仍走 dislike

## 验证
- [x] 18. `npm run typecheck` 三包全过
- [x] 19. `npm test`：like.e2e 扩到 11 项（+ dislike/merged 路由/取消/校验），全绿
- [x] 20. `npm run lint`（renderer）通过
- [x] 21. `search-unified.e2e` 手工构造 `MusicService` 补第 7 个参数（likeSync stub）

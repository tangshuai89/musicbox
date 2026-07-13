# Heart 跨平台同步（检测 + 队列 + 踩取消）

> 建立在 [`heart-fanout`](../heart-fanout/spec.md)（手动点 ❤ 一次性写全平台）之上，
> 补上「自动检测同步」「异步同步队列」「踩=取消跨平台红心」三层，并修掉网易云
> 取消红心用错接口的问题。

## 做什么

1. **切歌自动检测**：播到一首统一 track 时，查它在各**已登录**平台的红心情况。
   任一平台已红心 → 立即点亮 ❤ + 角标显示平台数，并把「还没红心、且能写」的
   其余平台**异步补齐**（fan-out）。全都没红心 → 什么都不写（纯只读检测）。
2. **异步同步队列（MQ 思路）**：远端红心写操作不在切歌时内联执行，改为推入
   进程内同步队列——**合并去重 + 串行消费 + 失败退避重试**，不阻塞播放。
3. **踩 = 取消跨平台红心**：踩一首统一 track → 取消它在所有 fan-out 平台的红心
   （真正从各平台收藏移除）+ 标记不喜欢。修「踩了一首却在其它平台红心还在、
   下次 detect 又把它点亮/收藏回来」的复活循环。
4. **网易云取消红心用正确接口**：`radio/like?like=false`（从「我喜欢的音乐」歌单
   移除），**不是** `radio/trash/add`（那是私人 FM「不喜欢」，不会删收藏）。

## 关键不变量

- **每平台最多一首**：统一搜索按「歌名+歌手+时长」聚类，仍会把同版本的多平台
  源、乃至同平台的近似变体塞进一个 item 的 `sources`。检测 / 同步 / 踩都必须按
  平台取**一个代表 trackId**，绝不把一首歌的 20 个音源全同步。三道闸：
  `groupByPlatform`（service）→ 入队 targets 每平台一首 → 队列 `dedupeByPlatform`
  兜底。
- **检测只读**：`detectLikedAndSync` 本身不写远端；只有「发现某平台已红心」才入队
  补齐其余平台。
- **Deezer 结构性排除**：Deezer 是匿名源、没有 per-user library（`importLiked` 也
  标记为 `anonymous_no_user_likes`），因此**永不参与红心记账**——本地 `liked` 集合、
  `fanOut` 记录、角标数、同步队列一律跳过（`isLikeable`）。点 ❤ 对 Deezer 是静默
  no-op。历史 bug 污染进 `liked`/`fanOut` 的 Deezer 记录在 `loadState` 时一次性清掉。
- **未登录 likeable 平台（QQ/网易云/Spotify）**：与 Deezer 不同，仍记本地「意图」，
  只是当前不入同步队列（`canSyncLike=false`）；登录后 detect 会补同步。
- **best-effort + 自愈**：远端写失败只告警 + 重试（3 次退避）；本地态乐观更新；
  下次切到这首歌 detect 会重新入队补偿。
- **收藏是「只加不减」**：手动 ❤ 永远只加不取消（见 heart-fanout）；唯一的移除
  入口是「踩」。

## 验收标准

### 检测 + 同步
- [x] 播到一首在 QQ 已红心、网易云未红心的歌 → ❤ 点亮，角标显示 ≥1，网易云被
      异步补上红心（「我喜欢的音乐」里出现）
- [x] 播到一首所有平台都没红心的歌 → 不写任何远端，角标为 0
- [x] 同一 item 的 sources 里某平台有 20 个变体 → 该平台只同步 1 首（不是 20 首）
- [x] Deezer 在 fan-out / detect / 单平台 ❤ 里都不写本地 liked、不计入角标（结构性排除）
- [x] 未登录 likeable 平台 → 记本地意图但暂不入队（登录后 detect 补同步）
- [x] 老 state.json 里污染的 Deezer liked/fanOut → loadState 时清理，Deezer 电台不再显示假红心
- [x] 快速连续切歌 → 旧歌的检测结果不会盖掉新歌的 ❤ 态（前端 `activeMergedIdRef` 守卫）
- [x] 远端同步失败 → 不影响播放，不影响本地点亮；有重试

### 队列
- [x] 相同 `(session, mergedId)` 的重复入队被合并，不会重复同步
- [x] 队列串行消费，不并发打爆平台 API
- [x] 单个平台写失败 → 退避重试，最终失败只记日志

### 踩取消
- [x] 踩一首 fan-out 过的歌 → 所有 fan-out 平台的红心被取消（本地 liked 清空，
      网易云「我喜欢的音乐」里同步移除），`fanOut` 记录被删
- [x] 踩后角标归 0、❤ 熄灭，并自动切下一首
- [x] 踩一首从没心动过的歌 → 取消红心是 no-op，仍标记不喜欢并切歌（不报错）
- [x] `/dislike/merged` 路由不被 `/dislike/:trackId` 截胡

### 网易云接口
- [x] `netease.unlike` 走 `radio/like?like=false`，真正从「我喜欢的音乐」移除
- [x] `netease.fmTrash` 走 `radio/trash/add`，用于「踩/不喜欢」减少推荐（≠ 取消红心）
- [x] 单平台 `markDisliked`（电台踩）用 `fmTrash`，语义不变

## 接口规格

### 切歌检测（沿用）

```
POST /music/like/detect
Request:  { "mergedId": "...", "sources": [{"platform","trackId"}, ...] }
Response: { "liked": true|false, "fannedOutTo": ["qq","netease"] }
          // liked=true：任一平台已红心；fannedOutTo=能写红心且已/将红心的平台
          //（不含 deezer / 未登录）。远端补齐是异步的，响应立即返回。
```

### 踩取消（新增）

```
POST /music/dislike/merged
Request:  { "mergedId": "...", "sources": [{"platform","trackId"}, ...] }
Response: { "success": true }

Error:
  400: mergedId 缺失 / sources 为空 / source 项缺 platform|trackId

⚠️ 路由必须注册在 /dislike/:trackId 之前（Express 按声明顺序匹配，否则
   trackId='merged' 会截胡走单平台 markDisliked）。
```

单平台电台的踩仍走 `POST /music/dislike/:trackId?provider=qq`（不变）。

### 内部：同步队列 `LikeSyncQueue`

进程内、非 broker、不持久化。对外只有 `enqueue(task)` 与 `registerProcessor(fn)`。

```ts
interface LikeSyncTask {
  session: Session;        // 捕获引用（cookie 随登录态实时反映）
  mergedId: string;        // 合并去重的 key
  liked: boolean;          // true=同步收藏，false=同步取消
  targets: Array<{ platform: MusicProvider; trackId: string }>; // 每平台一首
}
```

- **合并**：同 `${sessionId}:${mergedId}` 且方向一致 → 平台并集；方向翻转 → 新任务覆盖。
- **消费**：后台单飞 `drain`；每个 target 退避重试（500ms → 1.5s，共 3 次）。
- **写一次**：processor = `MusicService.syncLikeRemoteOnce`，成功后乐观更新
  `likedCache`；平台返回 code≠0 / success=false → throw 触发重试；未登录 / Deezer
  → 直接返回（视为无需同步，不 throw、不占重试）。

## 数据流

```
切歌 (usePlayer.loadNextTrack / playSearch)
  └─ POST /like/detect
       └─ detectLikedAndSync   [只读检测各平台 likedSet（5min TTL 缓存）]
            ├─ 无任何红心 → return {liked:false}
            └─ 有红心 → 本地乐观点亮 + 记 fanOut + enqueue(targets, liked:true)
                            │
                            ▼
                     LikeSyncQueue（合并/串行/重试）
                            │
                            ▼
                syncLikeRemoteOnce(platform, trackId, true)
                     ├─ qq/netease/spotify.like(...)
                     └─ 成功 → updateLikedCache

踩 (usePlayer.handleDislike, 统一队列上下文)
  └─ POST /dislike/merged
       └─ dislikeMerged
            ├─ fanOutLike(false)  → 本地清 liked + 删 fanOut + enqueue(unlike)
            ├─ 本地 disliked 标记（每平台一首）
            └─ netease.fmTrash（best-effort，减少推荐）
```

## 状态存储

沿用 heart-fanout 的 `music:{sessionId}.fanOut`（mergedId → 心动平台集合）。
`liked` / `disliked` 仍是 per-provider 集合。**两套「已红心」真值源**并存：

- `state.providers[p].liked`：本地持久化，`GET /music/liked`、fanOutLike 读写。
- `likedCache[sessionId:provider]`：远端派生，5min TTL，detect 读、同步成功后乐观更新。

同步成功时 `updateLikedCache` 让两者收敛；失败时以下次 detect 的远端重拉为准。

## 不做什么

- **不引外部 MQ / broker**：本地 Electron 播放器无服务端（CLAUDE.md「也没有服务器」）
  → 进程内队列达成同样的解耦 + 重试。
- **不持久化队列**：进程重启丢未消费任务可接受——detect 在下次播放该曲时重新入队。
- **不修 `mergedId` 跨次搜索漂移**：时长聚类 + 平台优先级决定 id，不同次搜索可能
  变化，理论上同平台可能先后收藏到两个不同变体。既有问题，本 spec 不引入也不加重。
- **不改手动 ❤ 的「只加不减」语义**（见 heart-fanout）。

## 技术约束

- 队列独立文件 `music/like-sync.queue.ts`（infra）；「何时/同步什么/每平台一首」的
  业务判断留在 `music.service.ts`。
- 新端点 `dislike/merged` 放 controller，业务逻辑（取消红心 + 标记 + trash）放 service。
- 外部调用统一 `fetch`；同步写不套整体超时（best-effort，队列自己控重试节奏）。
- 网易云 like/unlike 收敛到 `setRadioLike(liked)`；trash 独立为 `fmTrash`。

## 后续修订（中危收尾 / heart-followups）

在检测 + 队列 + 踩取消 + Deezer 排除之外，补三个一致性 / 性能小修：

- **[#7] 切回电台清角标**：radio（server）曲目不是 unified item、没有 fan-out。
  `loadNextTrack` 进 radio 分支时 `setFanOutCount(0)`，否则上一首搜索歌的平台数
  会残留在电台曲目上（❤ 填充仍由 `next.liked` 驱动，正常）。
- **[#10] fanOut 记录合并而非覆盖**：`detectLikedAndSync` 写 `state.fanOut[mergedId]`
  时与旧记录取并集（只留 likeable 平台）。某次搜索缺某平台 source（超时 / 聚类不同）
  时，不再把那平台从记录里抹掉、角标少算；`dislikeMerged` 已 `delete` 整条记录，
  故不会复活被取消的红心。
- **[#9] importLiked 顺手暖缓存**：拉全量「我的喜欢」后 `primeLikedCache` 填充
  `likedCache`，紧接着的切歌 detect 不必把 QQ 1000+ 首再重拉一遍（此前两条路径
  各拉各的）。

仍**不做**（既有限制 / 设计如此，需产品决策再动）：

- **[#5] 两套真值源不主动对账**：`state.providers[].liked`（本地）与 `likedCache`
  （远端派生）并存；队列重试已大幅收窄失配窗口，全量 reconcile 收益低、风险高。
- **[#6] mergedId 跨次搜索漂移**：同 [不做什么] 所述，属版本拆分搜索的固有特性。
- **[#8] 无「取消红心」正常入口**：手动 ❤ 是「只加不减」的设计；移除意图统一走
  「踩」（dislikeMerged）。如需独立的取消红心按钮，属产品决策。

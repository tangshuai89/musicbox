# Heart 跨平台 fan-out

## 做什么

在统一搜索结果里点 ❤ → 把红心同步到所有 hasCopyright=true 的平台；再点一次 → 取消全部。
这样"我喜欢的歌"在所有平台都生效，配合"我有版权的那个平台给我播"的回退链，
从此告别"QQ 搜得到但网易云没下、网易云有下但 QQ 没版权"。

## 验收标准

- [ ] 搜索得到一首在 QQ + 网易云 + Deezer 都有版权的歌 → 点 ❤ → 三个平台本地 liked 都加进去
- [ ] 网易云已登录：网易云那边真的能在「我喜欢的音乐」歌单里看到
- [ ] QQ / Deezer 未登录或没公开 ❤ API：只本地记录，不报错
- [ ] 再点 ❤ 一次：三个平台本地 liked 都清掉；网易云「我喜欢的音乐」里同步移除
- [ ] 单平台未登录（搜索结果里只有 QQ 一份）：点 ❤ 行为等同现在的 toggleLike，不报错
- [ ] 当前正在播的歌曲 ❤ 状态显示：已 fan-out 时，❤ 图标高亮 + 后面带"3❤"小角标
- [ ] 平台搜索失败的 source 不写入 liked 集合（避免幽灵态）
- [ ] `fanOut` 状态持久化到 .storage/state.json，重启后保留

## 接口规格

### 后端

```
POST /music/like/merged
Request:
  {
    "mergedId": "merged-qq-0039MnYb0qxYhV",
    "sources": [
      {"platform": "qq",      "trackId": "0039MnYb0qxYhV"},
      {"platform": "netease", "trackId": "1234567"},
      {"platform": "deezer",  "trackId": "8086126"}
    ],
    "liked": true   // false = 取消
  }

Response:
  {
    "success": true,
    "liked": true,
    "fannedOutTo": ["qq", "netease", "deezer"]   // 这次实际写入/清掉的平台
  }

Error:
  400: sources 为空 / mergedId 缺失
  500: 持久化失败
```

### 单平台（保持现有行为不变）

```
POST /music/like/:trackId?provider=qq
```

仍可用，播放队列里纯单平台的歌（电台）走这条；统一搜索的队列走新端点。

## 状态存储

`.storage/state.json` 里每个 session 增加：

```ts
{
  "music:{sessionId}": {
    qq:      { queue, liked, disliked },
    netease: { queue, liked, disliked },
    deezer:  { queue, liked, disliked },
    // 新增
    fanOut: {
      "merged-qq-0039MnYb0qxYhV": ["qq", "netease", "deezer"]
    }
  }
}
```

`fanOut` 只存"目前被心动了的统一 track"，及其 fan-out 到的平台集合。
切换 liked=false 时按这里写的平台去 unheart（保证幂等：只动我们之前心过的平台）。

## 不做什么

- 不解决"QQ/Deezer 没有公开 ❤ API"的问题——只本地记录。
- 不做跨平台 track 自动匹配（P3 的活），fan-out 完全按用户搜出来的 sources 列表原样写。
- 不动播放队列本身。

## 技术约束

- 新端点放 music.controller.ts；业务逻辑放 music.service.ts
- 复用现有 toggleLike 做 per-platform 写入（避免重复实现 NetEase 同步）
- 失败策略：单个平台 like 失败不能阻塞其他平台，整体 success 仍为 true，fannedOutTo 不含失败项
- 类型定义放 music/types.ts

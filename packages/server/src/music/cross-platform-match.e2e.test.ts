/**
 * 回归测试：跨平台红心匹配（heart-sync 的 P3「跨平台匹配」落地）。
 *
 * 背景：fan-out / detect 以前只写 item.sources 里已有的平台，从不主动去别的
 * 平台「找同一首歌」。实测用户库里几乎没有跨平台合并的条目（1060/1088 QQ-only），
 * 于是点 ❤ / 播放已红心歌几乎同步不到网易云。
 *
 * 本测试用 stub provider（search + like）+ 真实 LikeSyncQueue，验证：
 *  1) fanOutLike(qq-only, liked, meta) → 后台去 netease 搜同名同时长的等价曲目，
 *     命中后本地点亮 + 调 netease.like 同步远端 + 记进 fanOut。
 *  2) 时长差 > ±3s → 不匹配（严格 duration gate）。
 *  3) 歌名/歌手对不上 → 不匹配。
 *  4) detect 到某平台已红心（qq）→ 后台同样跨平台匹配补齐 netease。
 *  5) 取消方向（liked=false）不触发匹配。
 *
 * 运行: npx ts-node src/music/cross-platform-match.e2e.test.ts
 */
export {};
const assert = require('node:assert');

/* eslint-disable @typescript-eslint/no-var-requires */
const { MusicService } = require('./music.service');
const { LikeSyncQueue } = require('./like-sync.queue');

// 真·内存 storage：loadState/saveState 要能 round-trip（断言靠 getLikedTracks 读回）。
const store: Record<string, unknown> = {};
const fakeStorage = {
  get: (k: string) => store[k],
  set: (k: string, v: unknown) => {
    store[k] = v;
  },
};

// 每个用例可变的搜索返回 + like 调用记录。
let neteaseSearchResults: any[] = [];
let qqSearchResults: any[] = [];
const neteaseLikes: string[] = [];
let qqLikedRemote: string[] = [];
const netease = {
  search: async () => neteaseSearchResults,
  like: async (_ps: unknown, id: string) => {
    neteaseLikes.push(id);
    return true;
  },
  unlike: async () => true,
};
const qq = {
  search: async () => qqSearchResults,
  like: async () => true,
  unlike: async () => true,
  fetchLikedMidSet: async () => new Set(qqLikedRemote),
};
const deezer = {};
const spotify = {}; // 未登录 → canSyncLike=false → 匹配时跳过
const match = {};

const likeSync = new LikeSyncQueue(); // 真队列，跑后台 discover + 同步
const svc = new MusicService(
  fakeStorage,
  qq,
  netease,
  deezer,
  spotify,
  match,
  likeSync,
);

// qq + netease 都已登录（canSyncLike 为真）。
const session = {
  id: 'sess-xpm',
  providers: { qq: { qqCookie: 'c' }, netease: { musicU: 'u' } },
};

async function likedIds(provider: string): Promise<string[]> {
  const arr = await svc.getLikedTracks(session, provider);
  return arr.map((t: { id: string }) => t.id);
}

async function waitFor(
  pred: () => Promise<boolean>,
  ms = 2000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

function neTrack(id: string, title: string, artist: string, duration: number) {
  return {
    id,
    provider: 'netease',
    title,
    artist,
    album: '',
    coverUrl: '',
    audioUrl: '',
    duration,
    liked: false,
  };
}

function qqTrack(
  id: string,
  title: string,
  artist: string,
  duration: number,
  mediaMid?: string,
) {
  return {
    id,
    provider: 'qq',
    title,
    artist,
    album: '',
    coverUrl: '',
    audioUrl: '',
    duration,
    liked: false,
    mediaMid,
  };
}

async function main() {
  // ── 1. fanOutLike(qq-only) → 后台匹配到 netease 等价曲目并同步 ──────
  {
    neteaseSearchResults = [neTrack('n1', '晴天', '周杰伦', 271)]; // 时长差 1s ≤ 3
    await svc.fanOutLike(
      session,
      'merged-qq-1',
      [{ platform: 'qq', trackId: 'q1' }],
      true,
      { title: '晴天', artist: '周杰伦', duration: 270 },
    );
    const ok = await waitFor(async () =>
      (await likedIds('netease')).includes('n1'),
    );
    assert.ok(ok, '跨平台匹配应把 netease n1 加入本地 liked');
    assert.ok(
      neteaseLikes.includes('n1'),
      '应调用 netease.like 把红心同步到远端',
    );
    assert.ok(
      (await likedIds('qq')).includes('q1'),
      'qq 原本的红心仍在',
    );
    console.log('✅ 1. fanOutLike(qq-only) → 后台匹配 netease 并同步');
  }

  // ── 2. 时长差 > ±3s → 不匹配（严格 duration gate）──────────────────
  {
    neteaseSearchResults = [neTrack('n2', '稻香', '周杰伦', 200)]; // 差 70s
    await svc.fanOutLike(
      session,
      'merged-qq-2',
      [{ platform: 'qq', trackId: 'q2' }],
      true,
      { title: '稻香', artist: '周杰伦', duration: 270 },
    );
    await new Promise((r) => setTimeout(r, 250)); // 给后台队列时间
    assert.ok(
      !(await likedIds('netease')).includes('n2'),
      '时长差 70s 不应匹配（严格 ±3s）',
    );
    console.log('✅ 2. 时长差超容差 → 不匹配');
  }

  // ── 3. 歌名/歌手对不上 → 不匹配 ────────────────────────────────────
  {
    neteaseSearchResults = [neTrack('n3', '完全不同的歌', '别的歌手', 270)];
    await svc.fanOutLike(
      session,
      'merged-qq-3',
      [{ platform: 'qq', trackId: 'q3' }],
      true,
      { title: '七里香', artist: '周杰伦', duration: 270 },
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      !(await likedIds('netease')).includes('n3'),
      '归一化歌名+歌手不一致不应匹配',
    );
    console.log('✅ 3. 歌名/歌手不一致 → 不匹配');
  }

  // ── 4. detect 到 qq 已红心 → 后台跨平台匹配补齐 netease ─────────────
  {
    qqLikedRemote = ['q-det']; // getLikedSet(qq) 会看到这首已红心
    neteaseSearchResults = [neTrack('n-det', '告白气球', '周杰伦', 215)];
    const r = await svc.detectLikedAndSync(
      session,
      'merged-det',
      [{ platform: 'qq', trackId: 'q-det' }],
      { title: '告白气球', artist: '周杰伦', duration: 215 },
    );
    assert.strictEqual(r.liked, true, 'detect 到 qq 已红心 → liked=true');
    const ok = await waitFor(async () =>
      (await likedIds('netease')).includes('n-det'),
    );
    assert.ok(ok, 'detect 后台匹配应把 netease n-det 加入');
    assert.ok(neteaseLikes.includes('n-det'), 'detect 匹配应同步远端 netease');
    console.log('✅ 4. detect(qq 已红心) → 后台匹配补齐 netease');
  }

  // ── 5. 取消方向（liked=false）不触发匹配 ──────────────────────────
  {
    neteaseLikes.length = 0;
    neteaseSearchResults = [neTrack('n5', '一路向北', '周杰伦', 300)];
    await svc.fanOutLike(
      session,
      'merged-qq-1', // 复用已存在的记录
      [{ platform: 'qq', trackId: 'q1' }],
      false,
      { title: '一路向北', artist: '周杰伦', duration: 300 },
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      !neteaseLikes.includes('n5'),
      '取消收藏方向不应触发跨平台匹配搜索',
    );
    console.log('✅ 5. 取消方向不触发匹配');
  }

  // ── 6. findPlayableEquivalent：netease 失败 → 拿到可播放的 QQ 源 ─────
  // 复刻用户 bug：突然好想你在库里只有 netease 一个 source、code=4 后无源可退。
  // 前端拿这个端点向服务端实时匹配，应返回带后端代理 URL 的 QQ 源。
  {
    qqSearchResults = [qqTrack('002M8hNI2QgtRY', '突然好想你', '五月天', 265, 'MMQQ')];
    const src = await svc.findPlayableEquivalent(session, 'netease', {
      title: '突然好想你',
      artist: '五月天',
      duration: 266, // 与 QQ 的 265s 差 1s，在 ±3s 内
    });
    assert.ok(src, 'netease-only 曲目应能匹配到 QQ 等价源');
    assert.strictEqual(src.platform, 'qq', 'fallback 源应是 QQ');
    assert.strictEqual(src.trackId, '002M8hNI2QgtRY', 'trackId 应是 QQ 命中');
    assert.ok(
      src.url.startsWith('/music/stream/qq/'),
      `url 应是可播放的后端代理路径（实际 ${src.url}）`,
    );
    assert.ok(src.url.includes('mm=MMQQ'), 'QQ 高音质取流应透传 media_mid');
    console.log('✅ 6. findPlayableEquivalent → 返回可播放 QQ 源');
  }

  // ── 7. findPlayableEquivalent：时长差超容差 → 不匹配（返回 null） ─────
  {
    qqSearchResults = [qqTrack('wrong', '突然好想你', '五月天', 180)]; // 差 86s
    const src = await svc.findPlayableEquivalent(session, 'netease', {
      title: '突然好想你',
      artist: '五月天',
      duration: 266,
    });
    assert.strictEqual(src, null, '时长差超容差不应匹配，返回 null');
    console.log('✅ 7. findPlayableEquivalent 严格时长 gate → null');
  }

  // ── 8. 跨平台匹配成功 → 增量补进「我的喜欢」库快照（bug3） ───────────
  // 库里这首只有 QQ 一个 source。播到它（detect / fanOut）触发后台匹配到
  // netease 后，库快照的 sources 应被补上 netease —— 弹窗重开即可看到新徽章。
  {
    store['library:sess-xpm'] = {
      importedAt: 1,
      items: [
        {
          id: 'lib-1',
          title: '反方向的钟',
          artist: '周杰伦',
          album: '',
          coverUrl: '',
          duration: 261,
          sources: [
            {
              platform: 'qq',
              trackId: 'q-lib',
              hasCopyright: true,
              url: '/music/stream/qq/q-lib',
            },
          ],
          bestSource: 'qq',
        },
      ],
      sources: [],
    };
    neteaseSearchResults = [neTrack('n-lib', '反方向的钟', '周杰伦', 260)];
    await svc.fanOutLike(
      session,
      'merged-lib',
      [{ platform: 'qq', trackId: 'q-lib' }],
      true,
      { title: '反方向的钟', artist: '周杰伦', duration: 261 },
    );
    const ok = await waitFor(async () => {
      const lib = store['library:sess-xpm'] as any;
      return lib.items[0].sources.some((s: any) => s.platform === 'netease');
    });
    assert.ok(ok, 'discover 匹配后应把 netease source 补进库快照');
    const neSrc = (store['library:sess-xpm'] as any).items[0].sources.find(
      (s: any) => s.platform === 'netease',
    );
    assert.strictEqual(neSrc.trackId, 'n-lib', '补进的应是匹配到的 netease 曲目');
    assert.ok(
      neSrc.url.startsWith('/music/stream/netease/'),
      `补进的 netease 源应带可播放代理 url（实际 ${neSrc.url}）`,
    );
    // QQ 原有 source 不被覆盖，仍在。
    assert.ok(
      (store['library:sess-xpm'] as any).items[0].sources.some(
        (s: any) => s.platform === 'qq',
      ),
      'QQ 原有 source 应保留',
    );
    console.log('✅ 8. 跨平台匹配 → 增量补进库快照（bug3）');
  }

  console.log('\n🎉 cross-platform-match.e2e 全部 8 项通过');
}

main().catch((err) => {
  console.error('❌ cross-platform-match.e2e 失败:', err);
  process.exit(1);
});

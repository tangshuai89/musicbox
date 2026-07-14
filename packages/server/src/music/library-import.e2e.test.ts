/**
 * 回归测试：「我的喜欢」导入的曲目必须带可播放的 audioUrl。
 *
 * 背景 bug：provider.fetchLiked() 返回的 track.audioUrl 是空字符串（QQ/网易云
 * 的取流 URL 短期过期，播放时再拿）。统一搜索路径会把 audioUrl 归一成后端代理
 * 相对路径 `/music/stream/{provider}/{id}` 再落地，但 importLiked 早期漏了这步，
 * 直接把 audioUrl='' 的 track 塞进 mergeLibrary → UnifiedSearchItem.sources[].url
 * 全是空串。前端 pickPlayableTrack 拿到空 audioUrl，<audio src> 变 undefined，
 * 于是「红心列表点击」既切不掉当前歌、也播不出这一首。
 *
 * 本测试用 stub provider 构造一个「QQ 已登录、fetchLiked 返回 audioUrl=''」的
 * 场景，断言 importLiked 落地的 items 里 sources[].url 是可播放的代理路径。
 *
 * 运行: npx ts-node src/music/library-import.e2e.test.ts
 */
export {};
const assert = require('node:assert');

const { MusicService } = require('./music.service');
const { buildUnifiedItems } = require('./search.util');

// provider.fetchLiked() 的真实形状：audioUrl 是空的，播放时才取流。
function makeLikedTrack(id: string, title: string, mediaMid = ''): any {
  return {
    id,
    provider: 'qq',
    title,
    artist: 'Artist',
    album: '',
    coverUrl: '',
    audioUrl: '', // ← fetchLiked 就是空的，这正是 bug 的源头
    duration: 200,
    liked: true,
    mediaMid,
  };
}

const fakeStorage = {
  get: () => undefined, // 无持久化 → loadState 起全新骨架
  set: () => {},
};

// QQ 已登录并有两首红心；其余平台未登录（importLiked 内部会记 error，不阻塞）。
const qq = {
  fetchLiked: async () => [
    makeLikedTrack('q1', '晴天', 'MM_q1'),
    makeLikedTrack('q2', '稻香'),
  ],
};
const netease = {};
const deezer = {};
const spotify = {};
// 真实的合并逻辑：直接委托 buildUnifiedItems，这样 items[].sources[].url 反映
// 真实产出（端到端覆盖，而不是只测中间态）。
const captured: { tracks: any[] | null } = { tracks: null };
const match = {
  mergeLibrary: (tracks: any[]) => {
    captured.tracks = tracks;
    return buildUnifiedItems(
      new Map(),
      tracks.map((t) => ({ track: t, platform: t.provider })),
    );
  },
};
const likeSync = {
  registerProcessor: () => {},
  enqueue: () => {},
  pendingTargets: () => [],
};

const svc = new MusicService(
  fakeStorage,
  qq,
  netease,
  deezer,
  spotify,
  match,
  likeSync,
);

// QQ 已登录（有 qqCookie），其余平台留空 → 未登录。
const session = {
  id: 'sess-lib',
  createdAt: Date.now(),
  providers: { qq: { qqCookie: 'ck' } },
};

async function main() {
  const res = await svc.importLiked(session);

  // ── 1. mergeLibrary 收到的 track，audioUrl 已被归一成代理路径（非空） ──
  assert.ok(captured.tracks && captured.tracks.length === 2, '应导入 2 首');
  for (const t of captured.tracks!) {
    assert.ok(
      typeof t.audioUrl === 'string' &&
        t.audioUrl.startsWith('/music/stream/qq/'),
      `mergeLibrary 收到的 audioUrl 应是代理路径，实际: "${t.audioUrl}"`,
    );
  }
  console.log('✅ 1. importLiked → 归一后的 track.audioUrl 是可播放代理路径');

  // ── 2. 落地的 UnifiedSearchItem.sources[].url 非空且可播放 ──
  assert.ok(res.items.length >= 1, 'items 不应为空');
  for (const it of res.items) {
    for (const s of it.sources) {
      assert.ok(
        typeof s.url === 'string' && s.url.startsWith('/music/stream/'),
        `sources[].url 应是可播放代理路径，实际: "${s.url}"`,
      );
    }
    assert.strictEqual(it.bestSource, 'qq', 'bestSource 应命中 qq');
  }
  console.log('✅ 2. library items 的 sources[].url 可直接当 <audio src>');

  // ── 3. 带 mediaMid 的曲目，代理路径应带上 mm 参数（高音质升级用） ──
  const withMm = captured.tracks!.find((t) => t.id === 'q1');
  assert.ok(
    withMm.audioUrl.includes('mm=MM_q1'),
    `带 mediaMid 的曲目应透传 mm，实际: "${withMm.audioUrl}"`,
  );
  console.log('✅ 3. mediaMid 透传进代理路径（?mm=...）');

  console.log('\n🎉 library-import.e2e 全部 3 项通过');
}

main().catch((err) => {
  console.error('❌ library-import.e2e 失败:', err);
  process.exit(1);
});

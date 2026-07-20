/**
 * 回归测试：统一搜索在"部分平台未登录/报错"时必须返回部分结果，绝不整体失败。
 *
 * 背景 bug：doSearchOneProvider 对 netease/spotify 调 requireProviderSession，
 * 未登录时抛 NotFoundException；旧代码没 try/catch，且 searchOneProvider 的
 * `.then()` 没有 reject 分支，异常冒泡到 searchUnified 的 Promise.all → 整个
 * 统一搜索 404。这违背了"单平台挂了不阻塞其他平台"的设计。
 *
 * 本测试用 stub provider（不打真实网络），构造一个"未登录任何平台"的 session，
 * 断言 searchUnified 正常 resolve，且 QQ/Deezer 的结果都在，netease/spotify 记
 * 录为空（error）。
 *
 * 运行: npx ts-node src/music/search-unified.e2e.test.ts
 */
export {};
const assert = require('node:assert');

const { MusicService } = require('./music.service');

function makeTrack(provider: string, id: string, title: string): any {
  return {
    id,
    provider,
    title,
    artist: 'Artist',
    album: '',
    coverUrl: '',
    audioUrl: '',
    duration: 200,
    liked: false,
  };
}

const fakeStorage = {
  get: () => undefined, // 无持久化 → loadState 起全新骨架
  set: () => {},
};

// QQ / Deezer 匿名可搜：stub 返回结果。
const qq = { search: async () => [makeTrack('qq', 'q1', '晴天')] };
const deezer = { search: async () => [makeTrack('deezer', 'd1', 'Hello')] };
// netease / spotify：本测试里 session 未登录，requireProviderSession 会先抛，
// 这俩 stub 的 search 实际不会被调用（放个会抛的实现以防万一也无妨）。
const netease = {
  search: async () => {
    throw new Error('should_not_be_called_when_not_logged_in');
  },
};
const spotify = {
  search: async () => {
    throw new Error('should_not_be_called_when_not_logged_in');
  },
};
const match = {};
// 同步队列 stub：搜索路径用不到，只需让构造函数里的 register* 不炸。
const likeSync = {
  registerProcessor: () => {},
  registerDiscoverResolver: () => {},
  enqueue: () => {},
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

// 未登录任何平台的 session。
const session = { id: 'sess-test', createdAt: Date.now(), providers: {} };

async function main() {
  // ── 1. 未登录 netease/spotify 时统一搜索不抛，返回 QQ+Deezer 部分结果 ──
  {
    const res = await svc.searchUnified(session, '周杰伦', 1, 20);
    assert.ok(res && Array.isArray(res.items), '应返回 UnifiedSearchResult');
    const platforms = new Set(
      res.items.flatMap((it: any) => it.sources.map((s: any) => s.platform)),
    );
    assert.ok(platforms.has('qq'), 'QQ 结果应在（匿名可搜）');
    assert.ok(platforms.has('deezer'), 'Deezer 结果应在（匿名可搜）');
    assert.ok(
      !platforms.has('netease') && !platforms.has('spotify'),
      '未登录的 netease/spotify 不应产出 source，但也不该让整体失败',
    );
    console.log('✅ 1. 未登录 netease/spotify → 统一搜索仍返回 QQ+Deezer 部分结果');
  }

  // ── 2. 某平台 search 直接 throw（非未登录）也不冒泡 ──
  {
    const throwingQq = {
      search: async () => {
        throw new Error('qq boom');
      },
    };
    const svc2 = new MusicService(
      fakeStorage,
      throwingQq,
      netease,
      deezer,
      spotify,
      match,
      likeSync,
    );
    const res = await svc2.searchUnified(session, 'test', 1, 20);
    const platforms = new Set(
      res.items.flatMap((it: any) => it.sources.map((s: any) => s.platform)),
    );
    assert.ok(platforms.has('deezer'), 'QQ 抛错时 Deezer 结果仍应返回');
    assert.ok(!platforms.has('qq'), '抛错的 QQ 不产出 source');
    console.log('✅ 2. 单平台 search throw → 不阻塞其他平台');
  }

  console.log('\n🎉 search-unified.e2e 全部 2 项通过');
}

main().catch((err) => {
  console.error('❌ search-unified.e2e 失败:', err);
  process.exit(1);
});

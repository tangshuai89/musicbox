/**
 * 歌词多源聚合回归测试（stub provider，不打真实网络）：
 *
 * 1. 主 provider（qq）有词 → 直接返回，source=qq，synced=true
 * 2. 主 provider 无词 → 回退到 extras 里的 netease source
 * 3. 平台全落空 → lyrics.ovh 兜底，synced=false（纯文本）
 * 4. 全部无词 → lines=null，source=null
 * 5. availability：命中即停 + 结果进缓存（第二次不再打 provider）
 * 6. availability：全 miss → available=false
 *
 * 运行: npx ts-node src/music/lyrics-aggregate.e2e.test.ts
 */
export {};
const assert = require('node:assert');

const { MusicService } = require('./music.service');

const fakeStorage = {
  get: () => undefined,
  set: () => {},
};

const SYNCED = [
  { time: 1.2, text: '第一句' },
  { time: 5.8, text: '第二句' },
];

let qqCalls = 0;
let neteaseCalls = 0;

function makeSvc(opts: {
  qqLyrics?: any;
  neteaseLyrics?: any;
  ovhLyrics?: any;
}) {
  qqCalls = 0;
  neteaseCalls = 0;
  const qq = {
    getLyrics: async () => {
      qqCalls++;
      return opts.qqLyrics ?? null;
    },
  };
  const netease = {
    getLyrics: async () => {
      neteaseCalls++;
      return opts.neteaseLyrics ?? null;
    },
  };
  const deezer = { getLyrics: async () => null };
  const spotify = {};
  const match = {};
  const lyricsOvh = { getLyrics: async () => opts.ovhLyrics ?? null };
  const likeSync = {
    registerProcessor: () => {},
    registerDiscoverResolver: () => {},
    enqueue: () => {},
  };
  return new MusicService(
    fakeStorage,
    qq,
    netease,
    deezer,
    spotify,
    lyricsOvh,
    match,
    likeSync,
  );
}

// netease getLyrics 需要登录 session
const session = {
  id: 'sess-lyrics',
  createdAt: Date.now(),
  providers: { qq: { qqCookie: 'c' }, netease: { musicU: 'u' } },
};

async function main() {
  // ── 1. 主 provider 有词 ──
  {
    const svc = makeSvc({ qqLyrics: SYNCED });
    const res = await svc.getLyricsAggregated(
      session,
      'qq',
      'q1',
      [{ platform: 'netease', trackId: 'n1' }],
      '晴天',
      '周杰伦',
    );
    assert.strictEqual(res.source, 'qq');
    assert.strictEqual(res.synced, true);
    assert.strictEqual(res.lines.length, 2);
    assert.strictEqual(neteaseCalls, 0, '主源命中不应再查其他平台');
    console.log('✅ 1. 主 provider 有词 → source=qq, synced=true');
  }

  // ── 2. 主 provider 无词 → 回退 extras 的 netease ──
  {
    const svc = makeSvc({ neteaseLyrics: SYNCED });
    const res = await svc.getLyricsAggregated(
      session,
      'qq',
      'q1',
      [{ platform: 'netease', trackId: 'n1' }],
      '晴天',
      '周杰伦',
    );
    assert.strictEqual(res.source, 'netease');
    assert.strictEqual(res.synced, true);
    assert.ok(qqCalls >= 1, 'qq 应先被查过');
    console.log('✅ 2. 主源无词 → 回退到 netease source');
  }

  // ── 3. 平台全落空 → lyrics.ovh 兜底（纯文本, synced=false）──
  {
    const svc = makeSvc({
      ovhLyrics: [
        { time: 0, text: 'line one' },
        { time: 0, text: 'line two' },
      ],
    });
    const res = await svc.getLyricsAggregated(
      session,
      'qq',
      'q1',
      [{ platform: 'netease', trackId: 'n1' }],
      'Hello',
      'Adele',
    );
    assert.strictEqual(res.source, 'lyricsovh');
    assert.strictEqual(res.synced, false, '纯文本歌词必须标记 unsynced');
    console.log('✅ 3. 平台全 miss → lyrics.ovh 兜底, synced=false');
  }

  // ── 4. 全部无词 → null ──
  {
    const svc = makeSvc({});
    const res = await svc.getLyricsAggregated(
      session,
      'qq',
      'q1',
      [],
      'Unknown',
      'Nobody',
    );
    assert.strictEqual(res.lines, null);
    assert.strictEqual(res.source, null);
    console.log('✅ 4. 全部无词 → lines=null');
  }

  // ── 5. availability：命中即停 + 缓存生效 ──
  {
    const svc = makeSvc({ qqLyrics: SYNCED });
    const sources = [
      { platform: 'qq', trackId: 'q1' },
      { platform: 'netease', trackId: 'n1' },
    ];
    const a1 = await svc.getLyricsAvailability(session, sources);
    assert.strictEqual(a1.available, true);
    assert.strictEqual(a1.source, 'qq');
    assert.strictEqual(neteaseCalls, 0, 'qq 命中后不应再探 netease');
    const callsAfterFirst = qqCalls;
    const a2 = await svc.getLyricsAvailability(session, sources);
    assert.strictEqual(a2.available, true);
    assert.strictEqual(qqCalls, callsAfterFirst, '第二次应走缓存，不再打 provider');
    console.log('✅ 5. availability 命中即停 + 缓存生效');
  }

  // ── 6. availability：全 miss ──
  {
    const svc = makeSvc({});
    const res = await svc.getLyricsAvailability(session, [
      { platform: 'qq', trackId: 'q1' },
      { platform: 'netease', trackId: 'n1' },
    ]);
    assert.strictEqual(res.available, false);
    assert.strictEqual(res.source, null);
    console.log('✅ 6. availability 全 miss → false');
  }

  console.log('\n全部通过 ✔');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

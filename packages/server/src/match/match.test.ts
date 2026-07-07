/**
 * 跨平台 track 匹配引擎白盒测试（Node built-in assert，无需 jest）。
 * 运行: npx ts-node packages/server/src/match/match.test.ts
 *
 * 因为 MatchService 强依赖三个 provider 实例，直接用 stub 对象注入构造，
 * 不启动 NestJS DI 容器。手写 fake providers 只暴露 search() 接口。
 */
export {}; // 把文件当 module 处理，避免顶层 const 与其他 .test.ts 冲突
const assert = require('node:assert');
const { MatchService } = require('./match.service');
const { normalizeKey } = require('../music/search.util');

interface TrackOpts {
  title: string;
  artist: string;
  duration: number;
  id?: string;
  provider?: string;
  album?: string;
}
function makeTrack(opts: TrackOpts): any {
  return {
    id: opts.id ?? 'auto-id',
    provider: opts.provider ?? 'qq',
    title: opts.title,
    artist: opts.artist,
    album: opts.album ?? '',
    coverUrl: '',
    audioUrl: '',
    duration: opts.duration,
    liked: false,
  };
}

/** 构造一个"会立刻返回指定 tracks"的 fake provider。 */
function fakeProvider(name: string, behavior: any): any {
  return {
    name,
    async search(_ps: unknown, keyword: string, _limit: number): Promise<any[]> {
      if (typeof behavior === 'function') return behavior(keyword) ?? [];
      return behavior ?? [];
    },
  };
}

// ── 1. normalizeKey 仍可独立调用（MatchService 透传） ─────────
{
  const m = new MatchService(fakeProvider('qq', []), fakeProvider('ne', []), fakeProvider('de', []));
  const k = m.normalizeKey('晴天 (Live)', '周杰伦');
  assert.strictEqual(k, normalizeKey('晴天 (Live)', '周杰伦'));
  console.log('✅ 1. MatchService.normalizeKey 透传正确');
}

// ── 2. mergeLibrary 跨平台去重（3 平台同歌） ──────────────────
{
  const m = new MatchService(fakeProvider('qq', []), fakeProvider('ne', []), fakeProvider('de', []));
  const tracks = [
    makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'qq', id: 'q1' }),
    makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'netease', id: 'n1' }),
    makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'deezer', id: 'd1' }),
  ];
  const merged = m.mergeLibrary(tracks);
  assert.strictEqual(merged.length, 1, '3 平台同歌应合并为 1 条');
  assert.strictEqual(merged[0].sources.length, 3, '合并后应有 3 个 source');
  assert.strictEqual(merged[0].bestSource, 'qq', 'bestSource 优先级 = qq');
  console.log('✅ 2. mergeLibrary 跨平台去重');
}

// ── 3. mergeLibrary 不同歌各自保留 ───────────────────────────
{
  const m = new MatchService(fakeProvider('qq', []), fakeProvider('ne', []), fakeProvider('de', []));
  const tracks = [
    makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'qq', id: 'q1' }),
    makeTrack({ title: '七里香', artist: '周杰伦', duration: 299, provider: 'qq', id: 'q2' }),
  ];
  const merged = m.mergeLibrary(tracks);
  assert.strictEqual(merged.length, 2);
  console.log('✅ 3. mergeLibrary 不同歌各自保留');
}

// ── 4. findEquivalent 找到所有非 seed 平台 → exact ─────────
void (async () => {
{
  const seed = makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'qq', id: 'q1' });
  const m = new MatchService(
    fakeProvider('qq', []), // 不会用到，seed 已经是 qq
    fakeProvider('ne', [makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'netease', id: 'n1' })]),
    fakeProvider('de', [makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'deezer', id: 'd1' })]),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.confidence, 'exact', '两平台都找到 → exact');
  assert.ok(r.equivalents.netease, 'netease 应有候选');
  assert.ok(r.equivalents.deezer, 'deezer 应有候选');
  assert.strictEqual(r.equivalents.netease.id, 'n1');
  console.log('✅ 4. findEquivalent 完整匹配 → exact');
}

// ── 5. findEquivalent duration 超 tolerance → 不算等价 ─────
{
  const seed = makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'qq', id: 'q1' });
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', [makeTrack({ title: '晴天', artist: '周杰伦', duration: 600, provider: 'netease', id: 'n1' })]),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.confidence, 'none', 'duration 差 5 分钟 = 不同版本');
  assert.strictEqual(r.equivalents.netease, undefined, 'duration gate 拒绝');
  console.log('✅ 5. findEquivalent duration gate 拒绝 remix');
}

// ── 6. findEquivalent 单平台超时 → 不阻塞其他平台 ──────────
{
  const seed = makeTrack({ title: 'Slow Song', artist: 'A', duration: 100, provider: 'qq', id: 'q1' });
  const slowProvider = fakeProvider('ne', () => new Promise((resolve) => setTimeout(() => resolve([]), 10_000)));
  const fastProvider = fakeProvider('de', [makeTrack({ title: 'Slow Song', artist: 'A', duration: 100, provider: 'deezer', id: 'd1' })]);
  const m = new MatchService(fakeProvider('qq', []), slowProvider, fastProvider);
  const t0 = Date.now();
  const r: any = await m.findEquivalent(seed);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 7000, `整体应 <7s 完成（实际 ${elapsed}ms），证明单平台超时不影响其他平台`);
  assert.ok(r.equivalents.deezer, 'deezer 应正常返回');
  assert.strictEqual(r.equivalents.netease, undefined, 'netease 超时应缺席');
  assert.strictEqual(r.confidence, 'fuzzy', '部分平台找到 = fuzzy');
  console.log(`✅ 6. findEquivalent 单平台超时不影响其他（${elapsed}ms）`);
}

// ── 7. findEquivalent 平台 throw 异常 → 视为该平台缺席 ───
{
  const seed = makeTrack({ title: 'X', artist: 'Y', duration: 100, provider: 'qq', id: 'q1' });
  const throwingProvider = {
    async search() { throw new Error('upstream 502'); },
  };
  const m = new MatchService(fakeProvider('qq', []), throwingProvider, fakeProvider('de', []));
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.confidence, 'none', '一个平台 throw + 一个平台空 = none');
  console.log('✅ 7. findEquivalent 平台 throw 不影响整体');
}

// ── 8. findEquivalent 完全无匹配 → none ────────────────────
{
  const seed = makeTrack({ title: 'X', artist: 'Y', duration: 100, provider: 'qq', id: 'q1' });
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', []),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.confidence, 'none');
  assert.deepStrictEqual(r.equivalents, {});
  console.log('✅ 8. findEquivalent 无匹配 → none');
}

console.log('\n🎉 全部 8 个测试通过');
})();

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

// ── 9. 阶段 B: top-N + strict normalizeKey 找正确匹配 ──────
// 首条结果不是匹配（normalizeKey 不等），但 top-N 里第 3 条是 → v2 应找到它。
{
  const seed = makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'qq', id: 'q1' });
  const neteaseCandidates = [
    // 首条：噪音（标题打错 + duration 对），不应该被认为是匹配
    makeTrack({ title: '晴天周杰伦', artist: '周杰伦精选', duration: 100, provider: 'netease', id: 'noise-1' }),
    // 次条：title 完全对不上
    makeTrack({ title: '七里香', artist: '周杰伦', duration: 299, provider: 'netease', id: 'wrong-1' }),
    // 第三条：完全匹配 + duration 在 ±3s 内
    makeTrack({ title: '晴天', artist: '周杰伦', duration: 270, provider: 'netease', id: 'match-1' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neteaseCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.ok(r.equivalents.netease, '应该找到 netease 匹配（top-N 第 3 条）');
  assert.strictEqual(r.equivalents.netease.id, 'match-1', 'pickBest 取 strict 命中而非首条');
  assert.strictEqual(r.confidence, 'fuzzy', '部分平台 strict 找到 = fuzzy（netease strict，deezer 缺席）');
  console.log('✅ 9. 阶段 B: top-N + strict normalizeKey 找正确匹配');
}

// ── 10. 阶段 B: top-N 中所有候选 normalizeKey 都不匹配 → null ────
{
  const seed = makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'qq', id: 'q1' });
  const neteaseCandidates = [
    makeTrack({ title: '七里香', artist: '周杰伦', duration: 269, provider: 'netease', id: 'a' }),
    makeTrack({ title: '听妈妈的话', artist: '周杰伦', duration: 269, provider: 'netease', id: 'b' }),
    makeTrack({ title: '晴天纪念版', artist: '周杰伦', duration: 269, provider: 'netease', id: 'c' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neteaseCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.equivalents.netease, undefined, 'strict 不命中 → null（fuzzy 兜底留给 phase C）');
  assert.strictEqual(r.confidence, 'none', '所有平台都 strict 缺席 → none');
  console.log('✅ 10. 阶段 B: 无 strict 命中 → 保守返回 none');
}

// ── 11. 阶段 B: query 变体生成 ─────────────────────────────
{
  const m = new MatchService(fakeProvider('qq', []), fakeProvider('ne', []), fakeProvider('de', []));
  const v = (m as any).generateQueryVariants('晴天 (Live)', '周杰伦');
  assert.strictEqual(v.length, 1, '当前 QUERY_VARIANT_COUNT=1，仅 V1');
  assert.strictEqual(v[0], '晴天 (Live) 周杰伦', 'V1 形态 = "${title} ${artist}"');
  console.log('✅ 11. 阶段 B: generateQueryVariants 当前仅 V1（V2/V3 hook 预留）');
}

// ── 12. 阶段 B: 多个 (provider, variant) 任务的耗时上限 ────────
// 单平台单变体慢 10s（被超时），多任务并行不会累加。结果：整体 ≤ ~5.5s 完。
{
  const seed = makeTrack({ title: 'Slow', artist: 'A', duration: 100, provider: 'qq', id: 'q1' });
  const slowNe = fakeProvider('ne', () => new Promise((resolve) => setTimeout(() => resolve([]), 10_000)));
  const fastDe = fakeProvider('de', [makeTrack({ title: 'Slow', artist: 'A', duration: 100, provider: 'deezer', id: 'd1' })]);
  const m = new MatchService(fakeProvider('qq', []), slowNe, fastDe);
  const t0 = Date.now();
  const r: any = await m.findEquivalent(seed);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 7000, `整体应 <7s 完（实际 ${elapsed}ms）`);
  assert.ok(r.equivalents.deezer, 'deezer fast 应正常 strict 命中');
  assert.strictEqual(r.equivalents.netease, undefined, 'netease 超时缺席');
  console.log(`✅ 12. 阶段 B: 多任务并行耗时上限 (${elapsed}ms)`);
}

// ── 13. 阶段 C: fuzzy 兜底 — 1 字符 typo 命中 ──────────────
// strict 不命中，但 JW 算出来命中阈值。
// seed normalized: "海阔天空beyond" (10 chars)
// candidate: "海阔天蜜beyond" (10 chars, 1 char typo at position 3)
// → JW 约 0.883
{
  const seed = makeTrack({ title: '海阔天空', artist: 'Beyond', duration: 270, provider: 'qq', id: 'q1' });
  const neCandidates = [
    // 1-字 typo（normalized 后: 海阔天蜜beyond vs 海阔天空beyond → JW ~0.883）
    makeTrack({ title: '海阔天蜜', artist: 'Beyond', duration: 270, provider: 'netease', id: 'typo-1' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.ok(r.equivalents.netease, 'fuzzy 应命中 typo 候选');
  assert.strictEqual(r.equivalents.netease.id, 'typo-1');
  assert.strictEqual(r.confidence, 'fuzzy', 'fuzzy 命中 → confidence=fuzzy');
  assert.ok(r.scores.netease > 0.88 && r.scores.netease < 1,
    `scores.netease 应在 (0.88, 1) 之间（实际 ${r.scores.netease}）`);
  console.log(`✅ 13. 阶段 C: 1 字符 typo 命中 fuzzy (score=${r.scores.netease.toFixed(4)})`);
}

// ── 14. 阶段 C: 长度差硬门 — Live 版本差异不 fuzzy 并 ──────
// 用户选"保守保留版本差异"，所以即使 JW 高也不应该把 (Live) 与 album 版合并
{
  const seed = makeTrack({ title: '海阔天空 (Live)', artist: 'Beyond', duration: 270, provider: 'qq', id: 'q1' });
  // Netease 端只有专辑版（无 (Live)），normalized 后长度差很大 → 长度门 reject
  const neCandidates = [
    makeTrack({ title: '海阔天空', artist: 'Beyond', duration: 270, provider: 'netease', id: 'album-1' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.equivalents.netease, undefined,
    '即使 JW=0.9，长度差 > 15% 触发硬门 → 不命中');
  assert.strictEqual(r.confidence, 'none', '保守策略：版本差异不 fuzzy');
  console.log('✅ 14. 阶段 C: 长度差硬门保护——Live 版本差异不被 fuzzy 并');
}

// ── 15. 阶段 C: 严格优先于 fuzzy ────────────────────
// 候选里同时有 strict 和 fuzzy 命中 → strict 拿满分 1.0
{
  const seed = makeTrack({ title: '海阔天空', artist: 'Beyond', duration: 270, provider: 'qq', id: 'q1' });
  const neCandidates = [
    makeTrack({ title: '海阔天空 beyong', artist: 'Beyond', duration: 270, provider: 'netease', id: 'fuzzy-1' }),
    makeTrack({ title: '海阔天空', artist: 'Beyond', duration: 270, provider: 'netease', id: 'strict-1' }),
    makeTrack({ title: '海阔天空', artist: 'Beyond', duration: 270, provider: 'netease', id: 'strict-2' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.equivalents.netease.id, 'strict-1', 'strict 命中优先于 fuzzy');
  assert.strictEqual(r.scores.netease, 1, 'strict 命中 score=1');
  console.log('✅ 15. 阶段 C: strict 优先于 fuzzy（首条命中）');
}

// ── 16. 阶段 C: 全 strict 命中 → confidence=exact ──────────
// 注：阶段 B 测试 4 已经覆盖"双平台 strict 命中 → exact"，本测试验证
// 阶段 C 没有破坏它。
{
  const seed = makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'qq', id: 'q1' });
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', [makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, id: 'n1' })]),
    fakeProvider('de', [makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, id: 'd1' })]),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.confidence, 'exact');
  assert.strictEqual(r.scores.netease, 1);
  assert.strictEqual(r.scores.deezer, 1);
  console.log('✅ 16. 阶段 C: 全 strict → confidence=exact (兼容阶段 B 行为)');
}

// ── 17. 阶段 C: 部分 strict + 部分 fuzzy → confidence=fuzzy ──
// 一个平台 strict 命中 + 一个平台 fuzzy 命中 → confidence = 'fuzzy'
{
  const seed = makeTrack({ title: '海阔天空', artist: 'Beyond', duration: 270, provider: 'qq', id: 'q1' });
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', [makeTrack({ title: '海阔天空', artist: 'Beyond', duration: 270, id: 'n-strict' })]),
    fakeProvider('de', [makeTrack({ title: '海阔天蜜', artist: 'Beyond', duration: 270, id: 'd-typo' })]),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.equivalents.netease.id, 'n-strict');
  assert.ok(r.equivalents.deezer, 'deezer typo 应该 fuzzy 命中');
  assert.strictEqual(r.confidence, 'fuzzy', '部分 strict + 部分 fuzzy = fuzzy');
  assert.strictEqual(r.scores.netease, 1, 'strict 命中=1');
  assert.ok(r.scores.deezer > 0.88, `deezer typo 命中 score>0.88（实际 ${r.scores.deezer}）`);
  console.log(`✅ 17. 阶段 C: strict + fuzzy 混合 → confidence=fuzzy (deezer score=${r.scores.deezer.toFixed(4)})`);
}

console.log('\n🎉 全部 17 个测试通过');
})();

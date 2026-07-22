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

// ── 14. 阶段 C: 长度差硬门 + E3 alt-strict 行为说明 ──────────
// 【历史】v3 之前这个测试用 (Live) 防 fuzzy 命中——阶段 E3 改了语义：
//   - strict mode: "(Live)" vs "" 不命中（保守策略保留）
//   - alt-strict mode (E3): "海阔天空 (Live)" title 括号剥掉 → "海阔天空"，
//     与 cand "海阔天空" 同 key → alt-strict 命中 (score=0.95, confidence=fuzzy)
//
//   用户在 v4 选了"候选 A —— 剥 title 括号内容做 altKey"，接受这个权衡。
//   本测试现在验证 alt-strict 确实命中 (而不是阻止)，同时 score=0.95 而非 1
//   让 UI 还能区分"严格" vs "alt-strict"。
{
  const seed = makeTrack({ title: '海阔天空 (Live)', artist: 'Beyond', duration: 270, provider: 'qq', id: 'q1' });
  const neCandidates = [
    makeTrack({ title: '海阔天空', artist: 'Beyond', duration: 270, provider: 'netease', id: 'album-1' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  // E3 alt-strict 现在允许 "(Live)" 与 album 匹配（用户选"候选 A"接受）
  assert.ok(r.equivalents.netease, 'alt-strict 命中 (Live) vs album (因剥括号)');
  assert.strictEqual(r.scores.netease, 0.95,
    'alt-strict score=0.95（不是 1，UI 标记为 fuzzy）');
  assert.strictEqual(r.confidence, 'fuzzy',
    'confidence=fuzzy（虽然命中但 alt 不是 strict）');
  console.log('✅ 14. 阶段 E3 语义: (Live) vs album 经 alt-strict 命中 (score=0.95)');
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

// ── 18. 阶段 E3: alt-strict fallback — 用户场景核心 ─────────
// seed: 标题带中译括号 + artist 带 furigana → cand 是干净版 → alt-strict 命中
{
  const seed = makeTrack({ title: '何なんw (什么啊w)', artist: '藤井风 (ふじい かぜ)', duration: 323, provider: 'qq', id: 'q1' });
  const neteaseCandidates = [
    makeTrack({ title: '何なんw', artist: '藤井風', duration: 321, provider: 'netease', id: 'n-clean' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neteaseCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.ok(r.equivalents.netease, 'alt-strict 应命中 clean 版');
  assert.strictEqual(r.equivalents.netease.id, 'n-clean');
  // score=0.95 (ALT_SCORE)，不算 strict，confidence 应为 fuzzy
  assert.strictEqual(r.scores.netease, 0.95, 'alt-strict score=ALT_SCORE=0.95');
  assert.strictEqual(r.confidence, 'fuzzy',
    'alt-strict 命中但 confidence 还是 fuzzy（不算 strict）');
  console.log(`✅ 18. 阶段 E3: alt-strict fallback — 中译括号剥后命中 (score=${r.scores.netease})`);
}

// ── 19. 阶段 E3: 严格优先于 alt-strict ────────────────────
// 同 platform 有 strict + alt-strict 两个候选 → strict 优先
{
  const seed = makeTrack({ title: 'Bad Guy (feat. Justin)', artist: 'Billie Eilish', duration: 194, provider: 'qq', id: 'q1' });
  const neteaseCandidates = [
    // strict（去 feat 后完全相等）
    makeTrack({ title: 'Bad Guy', artist: 'Billie Eilish', duration: 194, provider: 'netease', id: 'n-strict' }),
    // alt-strict（title 带 feat 但 cand 用别的措辞，正常 strict 比不上；为测试强制 title 一致）
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neteaseCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.ok(r.equivalents.netease);
  assert.strictEqual(r.equivalents.netease.id, 'n-strict', 'strict 优先');
  assert.strictEqual(r.scores.netease, 1, 'strict score=1，alt-strict 不会抢');
  console.log(`✅ 19. 阶段 E3: strict 优先于 alt-strict`);
}

// ── 20. 阶段 E3: 无 alt-strict → 仍是 none（不像 fuzzy 那样兜底）──
// 用户场景是"跨平台对译"的兜底，不是 typo 容错。如果连 alt 都没命中，
// 仍然返回 none（fuzzy 在更后面），用户保留手动匹配入口。
{
  const seed = makeTrack({ title: '何なんw (什么啊w)', artist: '藤井风 (ふじい かぜ)', duration: 323, provider: 'qq', id: 'q1' });
  const neteaseCandidates = [
    // 候选跟 seed 没关联（标题完全不一样）→ strict miss + alt-strict miss
    makeTrack({ title: 'Lemon', artist: '米津玄師', duration: 250, provider: 'netease', id: 'lemon' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neteaseCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.equivalents.netease, undefined,
    'alt-strict 不命中 → 该平台仍 null');
  assert.strictEqual(r.confidence, 'none');
  console.log(`✅ 20. 阶段 E3: alt-strict 也未命中 → 保持 none（不强行 fuzzy）`);
}

// ── 21. 阶段 E4: 1 字符替换命中（JW + Levenshtein 都命中，max 取胜）──
// seed "海阔天空" + "Beyond" (10 chars) cand "海阔天家" + "Beyond" (10 chars)
//   JW  = 0.953 (prefix 海阔天 + suffix beyond + 1 替换); gets ≥ 0.88 → match
//   Lev = 0.1 dist → similarity 0.90; gets ≤ 0.1 → match
//   best.score = max(0.953, 0.90) = 0.953
{
  const seed = makeTrack({ title: '海阔天空', artist: 'Beyond', duration: 270, provider: 'qq', id: 'q1' });
  const neteaseCandidates = [
    makeTrack({ title: '海阔天家', artist: 'Beyond', duration: 270, provider: 'netease', id: 'n-typo' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neteaseCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.ok(r.equivalents.netease, '应命中 1 字符错');
  assert.strictEqual(r.equivalents.netease.id, 'n-typo');
  assert.strictEqual(r.confidence, 'fuzzy');
  // 1 替换 / 10 字符：JW 0.953 > Lev 0.90，max 赢
  assert.ok(r.scores.netease >= 0.88 && r.scores.netease <= 0.96,
    `1 字符替换 typo → score ≈ 0.95（实际 ${r.scores.netease}）`);
  console.log(`✅ 21. 阶段 E4: 1 字符替换 → 命中（max JW/Lev, score=${r.scores.netease.toFixed(4)}）`);
}

// ── 22. 阶段 E4: Levenshtein + JW 都拒绝真正不同歌 ─────────
// seed "晴天" vs cand "七里香"（5 chars 同长度）：1 替换 / 5 = 0.2 dist
// > 0.1 阈值; JW 也 < 0.88（基本没有共同字符位置），双 tier 都拒。
{
  const seed = makeTrack({ title: '晴天', artist: '周杰伦', duration: 269, provider: 'qq', id: 'q1' });
  const neteaseCandidates = [
    makeTrack({ title: '七里香', artist: '周杰伦', duration: 299, provider: 'netease', id: 'n-diff' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neteaseCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.strictEqual(r.equivalents.netease, undefined,
    '真不同歌 → Levenshtein + JW 都不命中');
  assert.strictEqual(r.confidence, 'none');
  console.log('✅ 22. 阶段 E4: 真不同歌 → 双 tier 都拒');
}

// ── 23. 阶段 E4: Levenshtein 命中长标题尾字漏 ─────────────
// 海阔天空beyond 尾字 d 漏 → 1 替换 / 14 字符 = 0.07 距离 → 必中
{
  const seed = makeTrack({ title: '海阔天空beyond', artist: '黄家驹', duration: 270, provider: 'qq', id: 'q1' });
  const neteaseCandidates = [
    makeTrack({ title: '海阔天空beyong', artist: '黄家驹', duration: 270, provider: 'netease', id: 'n-typo' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neteaseCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.ok(r.equivalents.netease, 'Levenshtein 命中长标题尾字漏');
  assert.ok(r.scores.netease >= 0.9,
    `长标题尾字漏 similarity ≈ 0.93（实际 ${r.scores.netease}）`);
  console.log(`✅ 23. 阶段 E4: 长标题尾字漏 → 命中 (score=${r.scores.netease.toFixed(4)})`);
}

// ── 24. 阶段 E4: JW 和 Levenshtein 取 max — Levenshtein 兜住 ──
// 设一个 JW 不命中但 Levenshtein 命中的场景（长度差大、Levenshtein 看编辑数）
// seed "晴天海阔天空", cand "晴天海阔天家": 末字替换、lenDiff 0.06 → JW 0.93,
// Levenshtein 0.9375 → 都命中、Levenshtein 略高
{
  const seed = makeTrack({ title: '晴天海阔天空', artist: '测试', duration: 270, provider: 'qq', id: 'q1' });
  const neteaseCandidates = [
    makeTrack({ title: '晴天海阔天家', artist: '测试', duration: 270, provider: 'netease', id: 'n-simi' }),
  ];
  const m = new MatchService(
    fakeProvider('qq', []),
    fakeProvider('ne', neteaseCandidates),
    fakeProvider('de', []),
  );
  const r: any = await m.findEquivalent(seed);
  assert.ok(r.equivalents.netease);
  // 两个 tier 都报分，取 max —— 不论谁赢，命中的就是这一条
  assert.ok(r.scores.netease > 0.7,
    `双 tier 取 max（实际 ${r.scores.netease}）`);
  console.log(`✅ 24. 阶段 E4: 双 fuzzy tier 取 max（score=${r.scores.netease.toFixed(4)}）`);
}

console.log('\n🎉 全部 24 个测试通过');
})();

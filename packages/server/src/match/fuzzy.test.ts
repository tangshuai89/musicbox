/**
 * 阶段 C/D: Jaro-Winkler + Normalized Levenshtein 实现单测。
 * 运行: npx ts-node packages/server/src/match/fuzzy.test.ts
 */
export {};
const assert = require('node:assert');
const { jaroWinkler, normalizedLevenshtein } = require('./fuzzy');

// ── 1. 完全相同 → 1 ─────────────────────────────────
{
  assert.strictEqual(jaroWinkler('海阔天空', '海阔天空'), 1);
  assert.strictEqual(jaroWinkler('a', 'a'), 1);
  assert.strictEqual(jaroWinkler('', ''), 0, '空串当 0 处理');
  console.log('✅ 1. 完全相同 / 空串');
}

// ── 2. 完全无交集 → 0 ─────────────────────────────
{
  assert.strictEqual(jaroWinkler('abc', 'xyz'), 0);
  assert.strictEqual(jaroWinkler('海阔天空', '周杰伦'), 0, '中文字符无交集');
  console.log('✅ 2. 无交集');
}

// ── 3. 经典 MARTHA / MARHTA（Winkler 论文示例）───
{
  // Jaro ≈ 0.944；prefix=3，Winkler 加成 ≈ 0.0167，最终 ≈ 0.961。
  const score = jaroWinkler('MARTHA', 'MARHTA');
  assert.ok(score >= 0.95 && score <= 0.97,
    `MARTHA vs MARHTA 应 ~0.96，实际 ${score.toFixed(4)}`);
  console.log(`✅ 3. MARTHA / MARHTA (经典) = ${score.toFixed(4)}`);
}

// ── 4. DWAYNE / DUANE（前后缀不一致）─────────────
{
  // Jaro ≈ 0.822；prefix=0 (D != D... wait，D=D, W!=U, so prefix=1)
  // 实测 ≈ 0.84
  const score = jaroWinkler('DWAYNE', 'DUANE');
  assert.ok(score > 0.8 && score < 0.9,
    `DWAYNE / DUANE 应 0.8-0.9 (实际 ${score.toFixed(4)})`);
  console.log(`✅ 4. DWAYNE / DUANE = ${score.toFixed(4)}`);
}

// ── 5. 跨平台实测：normalized key 间 1 字符错 ─────
{
  // "海阔天空livebeyong" (结尾漏个 d) vs "海阔天空livebeyond"
  const a = '海阔天空livebeyond';
  const b = '海阔天空livebeyong';
  const score = jaroWinkler(a, b);
  assert.ok(score > 0.93,
    `1 字符漏字 (尾) 应 > 0.93 (实际 ${score.toFixed(4)})`);
  // 高于阶段 C 的 FUZZY_THRESHOLD (0.88)
  console.log(`✅ 5. 1 字符漏字相似度 = ${score.toFixed(4)} (应 >0.93)`);
}

// ── 6. 版本差异——纯 JW 算法层面 ────────────────────
// 注意：纯 Jaro-Winkler 对 Live 版本差异也会给出 ~0.9，因为前缀高度重合。
// "不并 Live/alb um" 的兜底由 pickBest 的 *长度差硬门* 处理，不在算法层。
// 这里仅记录 JW 给出的纯数值，作为后续 test 设计的基线参考。
{
  const score = jaroWinkler('海阔天空live', '海阔天空');
  assert.ok(score >= 0.85,
    `Live vs 专辑前缀高度重合 → JW 应 >=0.85 (实际 ${score.toFixed(4)})`);
  console.log(`📌 6. 纯 JW ("海阔天空live" vs "海阔天空") = ${score.toFixed(4)} (≥0.85，pickBest 用长度门拦)`);
}

// ── 7. 短标题 1-字符错（4 字符）─────────────────────
{
  // "海阔天空" vs "海阔天家"（尾字错） — 4 字符里错 1 位，JW ~0.883。
  // 注意：这个值**贴阈值**（FUZZY_THRESHOLD=0.88），刚好可以 fuzzy 兜底。
  // 实际音乐库中 title 长度多在 8+，距离一般 > 0.93，长度门只在极少数
  // 极短标题上有风险，duration gate 是最后一道保险。
  const short = jaroWinkler('海阔天空', '海阔天家');
  assert.ok(short >= 0.88 && short <= 0.90,
    `短标题 1 字符错应 ~0.88 (实际 ${short.toFixed(4)})`);
  console.log(`✅ 7. 短标题 1 字符错 = ${short.toFixed(4)} (~0.88，贴着 FUZZY_THRESHOLD)`);
}

// ── 8. 长标题 1-字符错（10+ 字符）──────────────────
{
  // 长字符串相同位置 typo → JW 高得多（prefix 共享 4+）。
  // 海阔天空beyond vs 海阔天空beyong (尾字 g↔d)
  const long_ = jaroWinkler('海阔天空beyond', '海阔天空beyong');
  assert.ok(long_ > 0.94,
    `长标题 1 字符错应 > 0.94 (实际 ${long_.toFixed(4)})`);
  console.log(`✅ 8. 长标题 1 字符错 = ${long_.toFixed(4)} (应 >0.94)`);
}

// ── 9. 极短标题（2 字符）错字 — JW 不可靠，但用户选项不算坑 ──
{
  // 2 字符里错 1 位 → JW < 0.7（JW 不再叠加 Winkler 调整）。
  // 这种情况应留给 strict 优先（如果 normalized key 完全相等）和手工
  // 匹配兜底；不要因为 fuzzy 误匹配不同 title。
  const tiny = jaroWinkler('晴天', '晴夭');
  assert.ok(tiny < 0.7,
    `极短标题 JW 不可靠（实际 ${tiny.toFixed(4)}），不触发 fuzzy`);
  console.log(`✅ 9. 极短标题（2 字符）错字 = ${tiny.toFixed(4)} (JW < 0.7，不触发 fuzzy)`);
}

// ── 10. 完全无关两首歌 ────────────────────────
{
  const a = '海阔天空beyong';
  const b = '七里香jaychou';
  const score = jaroWinkler(a, b);
  assert.ok(score < 0.7,
    `完全无关应 <0.7 (实际 ${score.toFixed(4)})`);
  console.log(`✅ 10. 完全无关 = ${score.toFixed(4)} (应 <0.7)`);
}

// ──────────────────────────────────────────────────────────────────────
// 阶段 E4: normalizedLevenshtein 算法单测
// ──────────────────────────────────────────────────────────────────────

// ── 11. 相同 → 0 —— 旧 jaroWinkler 是 1，本函数是 0（距离，非相似度）──
{
  assert.strictEqual(normalizedLevenshtein('abc', 'abc'), 0, '相同字符串');
  assert.strictEqual(normalizedLevenshtein('', ''), 0, '空对空');
  assert.strictEqual(normalizedLevenshtein('海阔天空', '海阔天空'), 0, 'CJK 相同');
  console.log('✅ 11. 完全相同 → distance 0');
}

// ── 12. 空串 vs 非空 → 1（最长字符全删/插）────────────────
{
  assert.strictEqual(normalizedLevenshtein('', '海阔天空'), 1, '空 vs 4 字符 = 全删 = 1.0');
  assert.strictEqual(normalizedLevenshtein('海阔天空', ''), 1, '4 字符 vs 空 = 全插 = 1.0');
  console.log('✅ 12. 空 vs 非空 → distance 1.0');
}

// ── 13. 1 字符替换（4 字符标题）─────────────────
{
  // "海阔天空" vs "海阔天家" — 同长度、位置 3 不同
  // 1 次替换 / 4 字符 = 0.25
  const d = normalizedLevenshtein('海阔天空', '海阔天家');
  assert.strictEqual(d, 0.25,
    `1 替换 / 4 字符应 = 0.25（实际 ${d.toFixed(4)}）`);
  console.log(`✅ 13. 4 字符 1 替换 = ${d.toFixed(4)} (阈值 0.3 之内的命中)`);
}

// ── 14. 1 字符末位删除（短标题尾字漏）──────────────
{
  // "海阔天空beyong" vs "海阔天空beyond" (尾 'd' 漏)
  // 1 次插入 / 13 字符 = 1/13 ≈ 0.077
  const d = normalizedLevenshtein('海阔天空beyong', '海阔天空beyond');
  assert.ok(d < 0.15,
    `1 字符漏 / 13 字符应 <0.15（实际 ${d.toFixed(4)}）`);
  console.log(`✅ 14. 尾字漏 = ${d.toFixed(4)} (低于 0.15)`);
}

// ── 15. 完全不同 ──────────────────────────────────
{
  assert.strictEqual(normalizedLevenshtein('晴天', '海阔'), 1,
    '完全不同字符 → 全替换 = 1.0');
  assert.strictEqual(normalizedLevenshtein('abc', 'xyz'), 1,
    'Latin 全替换');
  console.log('✅ 15. 完全无关 → distance 1.0');
}

// ── 16. 阈值边界（0.3 是阶段 E4 的工程阈值）────────
{
  // 短标题 1 替换 = 0.5 > 0.3 → 应 NOT match
  const diff = normalizedLevenshtein('晴天', '晴朗');
  assert.ok(diff > 0.3,
    `短标题 1 替换 = ${diff.toFixed(4)}, 应 > 0.3 阈值（不同歌）`);
  // 中等标题 1 替换 = 0.25 < 0.3 → match
  const typo = normalizedLevenshtein('海阔天空', '海阔天家');
  assert.ok(typo < 0.3,
    `4 字 1 替换 = ${typo.toFixed(4)}, 应 < 0.3 阈值（typo 命中）`);
  console.log(`✅ 16. 阈值边界: ${diff.toFixed(4)} > 0.3, ${typo.toFixed(4)} < 0.3`);
}

console.log('\n🎉 全部 10 个模糊匹配测试通过（含 6 个 Levenshtein 新增）');

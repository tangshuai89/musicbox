/**
 * RecoService 白盒测试（Node built-in assert + fetch stub）。
 * 运行: npx ts-node packages/server/src/reco/reco.test.ts
 *
 * RecoService 依赖 StorageService / MusicService / SessionService /
 * fetch（外部 API）。这里只测"无外部依赖"的逻辑：buildPrompt 拼装、
 * 响应解析（围栏 retry）、推荐去重。
 */
export {}; // 顶层 const 不与其他 .test.ts 冲突
const assert = require('node:assert');

// 直接 require 拿到 RecoService 类（不构造实例，只测静态方法逻辑）
// 因为核心纯函数都私有，所以走"构造 + 跑"的集成路线：
// 用 stub StorageService / SessionService / MusicService 注入。
// 简化：测 parseRecommendations / dedupAgainstLibrary 通过构造一个
// 小 wrapper。

// 拿到 RecoService 的私有方法 → 用一个最小 stub 包装暴露。
// 实际 RecoService 构造需要 storage/session/musicService，run() 还要
// 真实 fetch。我们用最简单的方式：构造时全部 stub 掉，只为拿到方法。
const { RecoService } = require('./reco.service');

const fakeStorage = {
  get: () => undefined,
  set: () => {},
};
const fakeSessionService = {
  resolve: () => ({}),
};
const fakeMusic = {
  getLibrary: () => null,
  searchUnified: async () => ({ items: [] }),
};
const fakeConfig = { get: (k: string) => undefined };

// ⚠️ RecoService 构造顺序: (config, storage, sessionService, musicService)
const svc = new RecoService(fakeConfig, fakeStorage, fakeSessionService, fakeMusic);

// ── 1. 响应解析：整体 JSON ────────────────────────────────
{
  const items = svc['parseRecommendations'](
    '[{"title":"X","artist":"Y"},{"title":"A","artist":"B"}]',
  );
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, 'X');
  console.log('✅ 1. 响应解析: 整体 JSON 数组');
}

// ── 2. 响应解析：{ items: [...] } 包裹 ──────────────────
{
  const items = svc['parseRecommendations'](
    '{"items":[{"title":"X","artist":"Y"}]}',
  );
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'X');
  console.log('✅ 2. 响应解析: 包裹对象 { items: [...] }');
}

// ── 3. 响应解析：```json 围栏 ───────────────────────────
{
  const items = svc['parseRecommendations'](
    '好的，下面是 JSON：\n```json\n[{"title":"A","artist":"B","reason":"因为 X"}]\n```',
  );
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].reason, '因为 X');
  console.log('✅ 3. 响应解析: ```json 围栏 retry');
}

// ── 4. 响应解析：prose 包裹裸数组（无围栏）→ 抛错 ────────
// 曾经用"首个 [ 到末个 ]"切片能救这种，但那个策略对括号噪声
// （[1] 引用 / 多段数组）会静默抓垃圾，比干净失败更坏——已删除。
// DeepSeek 调用侧已设 response_format: json_object 强制结构化输出，
// 所以裸 prose-wrapped 实际几乎不会发生；真发生了就 fail loud + retry。
{
  assert.throws(
    () => svc['parseRecommendations']('我推荐：[{"title":"A","artist":"B"}]，希望你喜欢'),
    /recommend_parse_failed/,
    'prose 包裹无围栏应干净失败（不再脆弱切片）',
  );
  console.log('✅ 4. 响应解析: prose 裸数组 → 干净失败（删了脆弱切片）');
}

// ── 5. 响应解析：全坏 → 抛错 ────────────────────────────
{
  assert.throws(
    () => svc['parseRecommendations']('garbage no json at all'),
    /recommend_parse_failed/,
  );
  console.log('✅ 5. 响应解析: 全坏 → 抛 BadRequest');
}

// ── 6. 推荐去重：和库去重 + 自己内部去重 ────────────────
{
  const lib = [
    { title: '晴天', artist: '周杰伦' } as any,
    { title: '七里香', artist: '周杰伦' } as any,
  ];
  const raw = [
    { title: '晴天', artist: '周杰伦' },          // 在库里 → 去掉
    { title: '夜曲', artist: '周杰伦' },          // 不在库 → 保留
    { title: '夜曲', artist: '周杰伦' },          // 内部重复 → 去掉
    { title: '稻香', artist: '周杰伦' },          // 不在库 → 保留
  ];
  const dedup = svc['dedupAgainstLibrary'](raw, lib);
  assert.deepStrictEqual(
    dedup.map((d: any) => d.title),
    ['夜曲', '稻香'],
    '应只剩库外 + 内部不重复的',
  );
  console.log('✅ 6. 推荐去重: 库内 + 内部重复都去除');
}

// ── 7. 推荐去重：normalize 忽略大小写 + 标点 ────────────
{
  const lib = [{ title: 'Hello!', artist: 'Adele' } as any];
  const raw = [
    { title: 'hello', artist: 'adele' },   // 应该被视为重复
    { title: 'HELLO', artist: 'Adele.' },  // 重复
  ];
  const dedup = svc['dedupAgainstLibrary'](raw, lib);
  assert.strictEqual(dedup.length, 0, '大小写 + 标点差异应归一为同首');
  console.log('✅ 7. 推荐去重: 大小写 + 标点归一化');
}

// ── 8. prompt 拼装：库 + 偏好都进 user ──────────────────
{
  const lib = [
    { title: '晴天', artist: '周杰伦', album: '叶惠美' } as any,
    { title: '七里香', artist: '周杰伦', album: '七里香' } as any,
  ];
  const messages = svc['buildPrompt'](lib, {
    count: 5,
    language: 'zh',
    mood: '通勤路上',
  });
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].role, 'system');
  assert.strictEqual(messages[1].role, 'user');
  assert.ok(messages[1].content.includes('晴天'), 'user prompt 应包含库歌曲');
  assert.ok(messages[1].content.includes('中文'), '语言偏好应进 user prompt');
  assert.ok(messages[1].content.includes('通勤路上'), '心情应进 user prompt');
  assert.ok(messages[0].content.includes('5 首'), 'system prompt 应包含推荐数量');
  console.log('✅ 8. prompt 拼装: system + user 都带库 + 偏好');
}

// ── 9. prompt 拼装：library > LIMIT 仍只取前 N ──────────
{
  const lib = Array.from({ length: 250 }, (_, i) => ({
    title: `Track ${i}`,
    artist: 'X',
  }));
  const messages = svc['buildPrompt'](lib, { count: 10 });
  // buildPrompt 内部不截断——上层 run() 负责 slice
  // 这里只验"长库能拼 prompt 不爆"
  assert.ok(messages[1].content.length > 0);
  console.log('✅ 9. prompt 拼装: 长库 (>200) 仍能跑');
}

// ── 10. key 校验：太短 → 400 ────────────────────────────
{
  assert.throws(() => svc.setApiKey('short'), /太短/);
  console.log('✅ 10. setApiKey: 短 key 拒绝');
}

// ── 11. key 写入：长度够 → 写 storage + env ─────────────
{
  // 重新构造一个能记 set 的 storage
  const stored: Record<string, unknown> = {};
  const realStorage = {
    get: (k: string) => stored[k],
    set: (k: string, v: unknown) => { stored[k] = v; },
  };
  const svc2 = new RecoService(fakeConfig, realStorage, fakeSessionService, fakeMusic);
  const r = svc2.setApiKey('sk-1234567890abcdef');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tail, 'cdef');
  assert.strictEqual(process.env.DEEPSEEK_API_KEY, 'sk-1234567890abcdef');
  assert.strictEqual((stored['secrets:deepseek'] as any).apiKey, 'sk-1234567890abcdef');
  // 恢复
  delete process.env.DEEPSEEK_API_KEY;
  console.log('✅ 11. setApiKey: 写 storage + process.env，返回 tail');
}

// ── 12. status: 未 import 库 → librarySize=0 ────────────
{
  const status = svc.status({} as any);
  assert.strictEqual(status.librarySize, 0);
  assert.strictEqual(status.configured, false);
  console.log('✅ 12. status: 无库无 key 都 false');
}

console.log('\n🎉 全部 12 个测试通过');

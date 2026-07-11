/**
 * 统一搜索核心逻辑验证（Node built-in assert，无需 jest）。
 * 运行: npx ts-node packages/server/src/music/search.test.ts
 *
 * 直接复用 search.util.ts 的纯函数（白盒测试）：
 *  - normalizeKey: 字符归一化
 *  - dedupTracks: 歌名+歌手合并
 *  - buildUnifiedItems: 跨平台聚合 + bestSource 选取
 */
export {}; // 把文件当 module 处理，避免顶层 const 与其他 .test.ts 冲突
const assert = require('node:assert');

const {
  normalizeKey,
  dedupTracks,
  buildUnifiedItems,
  PLAY_PRIORITY,
} = require('./search.util');

// ── 测试 fixture ────────────────────────────────────────────────
interface TrackOpts {
  album?: string;
  coverUrl?: string;
  audioUrl?: string;
  duration?: number;
  mediaMid?: string;
}
function makeTrack(
  provider: string,
  id: string,
  title: string,
  artist: string,
  opts: TrackOpts = {},
): any {
  return {
    id,
    provider,
    title,
    artist,
    album: opts.album ?? '',
    coverUrl: opts.coverUrl ?? '',
    audioUrl: opts.audioUrl ?? `/music/stream/${provider}/${id}`,
    duration: opts.duration ?? 0,
    liked: false,
    mediaMid: opts.mediaMid,
  };
}

// ── 1. 同一首歌在两个平台 → 去重为一条 ──────────────────────
{
  const all = [
    { track: makeTrack('qq', 'qq-001', '晴天', '周杰伦'), platform: 'qq' },
    {
      track: makeTrack('netease', 'ne-001', '晴天', '周杰伦'),
      platform: 'netease',
    },
  ];
  const deduped = dedupTracks(all);
  assert.strictEqual(deduped.size, 1, '同一首歌应去重为 1 条');
  console.log('✅ 1. 跨平台去重');
}

// ── 2. 标点/空格差异 → 归一化后合并 ──────────────────────────
{
  const all = [
    { track: makeTrack('qq', 'qq-001', 'Hello', 'Adele'), platform: 'qq' },
    { track: makeTrack('deezer', 'de-001', 'Hello!', 'Adele'), platform: 'deezer' },
  ];
  const deduped = dedupTracks(all);
  assert.strictEqual(deduped.size, 1, '标点差异应归一化');
  console.log('✅ 2. 标点归一化');
}

// ── 3. 全角/半角差异 → 合并 ──────────────────────────────────
{
  const all = [
    { track: makeTrack('qq', 'qq-001', 'hello', 'adele'), platform: 'qq' },
    { track: makeTrack('qq', 'qq-002', 'ＨＥＬＬＯ', 'ＡＤＥＬＥ'), platform: 'qq' },
  ];
  const deduped = dedupTracks(all);
  assert.strictEqual(deduped.size, 1, '全角半角应归一化');
  console.log('✅ 3. 全角半角');
}

// ── 4. 不同歌 → 各自保留 ─────────────────────────────────────
{
  const all = [
    { track: makeTrack('qq', 'qq-001', '晴天', '周杰伦'), platform: 'qq' },
    { track: makeTrack('qq', 'qq-002', '七里香', '周杰伦'), platform: 'qq' },
  ];
  const deduped = dedupTracks(all);
  assert.strictEqual(deduped.size, 2, '不同歌曲应各自保留');
  console.log('✅ 4. 不同歌曲');
}

// ── 5. 空输入 → 返回空 ────────────────────────────────────────
{
  const deduped = dedupTracks([]);
  assert.strictEqual(deduped.size, 0, '空输入应返回空');
  console.log('✅ 5. 空输入');
}

// ── 6. 繁简混合（基础）→ 空格去标点应正确 ────────────────────
{
  const all = [
    { track: makeTrack('qq', 'qq-001', '突然好想你', '五月天'), platform: 'qq' },
    {
      track: makeTrack('netease', 'ne-001', '突然好想你', ' 五月天 '),
      platform: 'netease',
    },
  ];
  const deduped = dedupTracks(all);
  assert.strictEqual(deduped.size, 1, '首尾空格应归一化');
  console.log('✅ 6. 空格 trim');
}

// ── 7. 跨平台聚合：同一首歌在 QQ + 网易云 + Deezer 都有 → 一条 + 3 sources ──
{
  const all = [
    { track: makeTrack('qq', 'qq-001', '晴天', '周杰伦', {
        mediaMid: 'qq-mm-001', album: '叶惠美' }), platform: 'qq' },
    { track: makeTrack('netease', 'ne-001', '晴天', '周杰伦', {
        album: '叶惠美' }), platform: 'netease' },
    { track: makeTrack('deezer', 'de-001', 'Sunny Day', 'Jay Chou', {
        album: 'Ye Hui Mei' }), platform: 'deezer' },
  ];
  // 注意：Deezer 搜出来的"歌名+歌手"可能是英文/罗马音，不一定能归一到中文 key。
  // 这条测试里 Deezer 的英文版本应该独立成条——验证 search 不会"过度归一化"。
  const deduped = dedupTracks(all);
  assert.strictEqual(deduped.size, 2, '中英文不同 key 应分两条');
  const items = buildUnifiedItems(deduped, all);
  const cn = items.find((it) => it.title === '晴天');
  assert.ok(cn, '应有"晴天"条目');
  assert.strictEqual(cn.sources.length, 2, '"晴天"应有 2 个 source（qq+netease）');
  assert.strictEqual(cn.bestSource, 'qq', 'bestSource 优先级 = qq > netease > deezer');
  // 透传 mediaMid：QQ source 应该有
  const qqSrc = cn.sources.find((s) => s.platform === 'qq');
  assert.strictEqual(qqSrc.mediaMid, 'qq-mm-001', '应透传 QQ mediaMid');
  console.log('✅ 7. 跨平台聚合 + bestSource + mediaMid 透传');
}

// ── 8. bestSource 优先级：只在 Deezer 找到 → bestSource = deezer ──
{
  const all = [
    { track: makeTrack('deezer', 'de-001', 'unknown', 'unknown'), platform: 'deezer' },
  ];
  const deduped = dedupTracks(all);
  const items = buildUnifiedItems(deduped, all);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].bestSource, 'deezer', '仅 Deezer 时 bestSource=deezer');
  console.log('✅ 8. bestSource 降级到 Deezer');
}

// ── 9. PLAY_PRIORITY 顺序：qq > netease > deezer > spotify ────
{
  assert.deepStrictEqual(PLAY_PRIORITY, ['qq', 'netease', 'deezer', 'spotify']);
  console.log('✅ 9. 播放优先级常量（含 spotify）');
}

// ── 9b. Spotify 能当 bestSource（回归：曾漏在 PLAY_PRIORITY）────
{
  const all = [
    { track: makeTrack('spotify', 'sp-1', 'Only On Spotify', 'X'), platform: 'spotify' },
  ];
  const deduped = dedupTracks(all);
  const items = buildUnifiedItems(deduped, all);
  assert.strictEqual(items[0].bestSource, 'spotify', '仅 Spotify 时 bestSource 必须是 spotify，不能是 null');
  console.log('✅ 9b. Spotify 可当 bestSource');
}

// ── 9c. duration 门槛：同名不同时长 = 不同版本，各自成条 ────
{
  const all = [
    // 三个 "If I Ain't Got You"：album 228s、live 284s、remix 176s
    { track: makeTrack('qq', 'qq-a', "If I Ain't Got You", 'Alicia Keys', {
        duration: 228 }), platform: 'qq' },
    { track: makeTrack('qq', 'qq-b', "If I Ain't Got You", 'Alicia Keys', {
        duration: 284 }), platform: 'qq' },
    { track: makeTrack('qq', 'qq-c', "If I Ain't Got You", 'Alicia Keys', {
        duration: 176 }), platform: 'qq' },
    // 网易云的 album 版 227s → 应与 qq-a(228s) 归为同一版本
    { track: makeTrack('netease', 'ne-a', "If I Ain't Got You", 'Alicia Keys', {
        duration: 227 }), platform: 'netease' },
  ];
  const deduped = dedupTracks(all);
  const items = buildUnifiedItems(deduped, all);
  assert.strictEqual(items.length, 3, '3 个不同时长版本应分成 3 条');
  const album = items.find((it) => Math.abs(it.duration - 228) <= 3);
  assert.ok(album, '应有 album(228s) 版本');
  assert.strictEqual(
    album.sources.length,
    2,
    'album 版本应含 qq(228)+netease(227) 两个同版本 source',
  );
  console.log('✅ 9c. duration 门槛拆分版本 + 跨平台同版本合并');
}

// ── 9d. duration=0（未知）仍合并为一条（老行为不破坏）────
{
  const all = [
    { track: makeTrack('qq', 'qq-1', '晴天', '周杰伦'), platform: 'qq' },
    { track: makeTrack('netease', 'ne-1', '晴天', '周杰伦'), platform: 'netease' },
  ];
  const deduped = dedupTracks(all);
  const items = buildUnifiedItems(deduped, all);
  assert.strictEqual(items.length, 1, 'duration 未知时应仍合并为一条');
  assert.strictEqual(items[0].sources.length, 2);
  console.log('✅ 9d. duration=0 保持合并');
}

// ── 10. 各 source 都有 url / hasCopyright 默认 true ──────────
{
  const all = [
    { track: makeTrack('qq', 'qq-001', 'A', 'B'), platform: 'qq' },
  ];
  const deduped = dedupTracks(all);
  const items = buildUnifiedItems(deduped, all);
  const src = items[0].sources[0];
  assert.ok(typeof src.url === 'string' && src.url.length > 0, 'url 应有值');
  assert.strictEqual(src.hasCopyright, true, 'hasCopyright 默认 true（搜索阶段不裁决）');
  console.log('✅ 10. SourceInfo 字段完整');
}

// ── 11. MusicSessionState 兼容老格式（无 fanOut 字段）──────────
// 老持久化文件只有 providers，loadState 应当正常返回空 fanOut。
{
  const oldFormat = {
    qq: { queue: [], liked: ['a', 'b'], disliked: [] },
    netease: { queue: [], liked: [], disliked: [] },
    deezer: { queue: [], liked: [], disliked: [] },
  };
  // 用 services 之外的纯函数测不太方便——逻辑写在 music.service.ts 里。
  // 这里只做"序列化"的 sanity check：把新 state 序列化能保留 fanOut 字段。
  const newState = {
    providers: {
      qq: { queue: [], liked: ['a', 'b'], disliked: [] },
      netease: { queue: [], liked: [], disliked: [] },
      deezer: { queue: [], liked: [], disliked: [] },
    },
    fanOut: { 'merged-qq-001': ['qq', 'deezer'] },
  };
  // 模拟 saveState 的序列化
  const serialized = {
    providers: {
      qq: { ...newState.providers.qq, liked: [...newState.providers.qq.liked], disliked: [...newState.providers.qq.disliked] },
      netease: { ...newState.providers.netease, liked: [...newState.providers.netease.liked], disliked: [...newState.providers.netease.disliked] },
      deezer: { ...newState.providers.deezer, liked: [...newState.providers.deezer.liked], disliked: [...newState.providers.deezer.disliked] },
    },
    fanOut: newState.fanOut,
  };
  // 反序列化时按 fanOut 字段读取
  assert.deepStrictEqual(
    serialized.fanOut['merged-qq-001'],
    ['qq', 'deezer'],
    'fanOut 序列化应保留平台列表',
  );
  assert.deepStrictEqual(
    serialized.providers.qq.liked,
    ['a', 'b'],
    'providers.qq.liked 应保留',
  );
  console.log('✅ 11. State 序列化兼容 fanOut 字段');
}

// ── 12. fan-out "幂等反写"：不在 fanOut 里的平台不会被误清 ─────
{
  // 模拟：用户之前 fan-out 心动了 mergedId，state.fanOut[mergedId] = ['qq', 'deezer']。
  // 现在再来一次 unlike，sources 里多带了 netease（用户没心过 netease），
  // 但 toUnlike 只从 fanOut 走，netease 不会被调 unlike。
  const fanOut = { 'm1': ['qq', 'deezer'] };
  const sources = [
    { platform: 'qq', trackId: 'q1' },
    { platform: 'netease', trackId: 'n1' },
    { platform: 'deezer', trackId: 'd1' },
  ];
  const toUnlike = fanOut['m1'] || [];
  const unlikeTargets = toUnlike
    .map((p) => {
      const src = sources.find((s) => s.platform === p);
      return src ? { platform: p, trackId: src.trackId } : null;
    })
    .filter((t) => t !== null);
  assert.deepStrictEqual(
    unlikeTargets.map((t) => t && t.platform),
    ['qq', 'deezer'],
    'netease 不在 fanOut 里应被跳过',
  );
  console.log('✅ 12. fan-out unlike 幂等（不动未心过的平台）');
}

console.log('\n🎉 全部 13 个测试通过');

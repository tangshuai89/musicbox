/**
 * 统一搜索核心逻辑验证（Node built-in assert，无需 jest）。
 * 运行: npx ts-node packages/server/src/music/search.test.ts
 *
 * 直接复用 search.util.ts 的纯函数（白盒测试）：
 *  - normalizeKey: 字符归一化
 *  - dedupTracks: 歌名+歌手合并
 *  - buildUnifiedItems: 跨平台聚合 + bestSource 选取
 */
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
  opts?: TrackOpts,
): any {
  const o = opts || {};
  return {
    id,
    provider,
    title,
    artist,
    album: o.album ?? '',
    coverUrl: o.coverUrl ?? '',
    audioUrl: o.audioUrl ?? `/music/stream/${provider}/${id}`,
    duration: o.duration ?? 0,
    liked: false,
    mediaMid: o.mediaMid,
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

// ── 9. PLAY_PRIORITY 顺序：qq > netease > deezer ─────────────
{
  assert.deepStrictEqual(PLAY_PRIORITY, ['qq', 'netease', 'deezer']);
  console.log('✅ 9. 播放优先级常量');
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

console.log('\n🎉 全部 10 个测试通过');

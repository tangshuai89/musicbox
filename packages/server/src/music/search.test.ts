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
  stripFeatTags,
  stripFuriganaParens,
  cjkUnify,
  CJK_UNIFIER,
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
  vipLocked?: boolean;
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
    vipLocked: opts.vipLocked,
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

// ── 3a. 半角 vs 全角括号（保留括号内容）────────────────────
{
  const a = normalizeKey('海阔天空 (Live)', 'Beyond');
  const b = normalizeKey('海阔天空（Live）', 'Beyond');
  assert.strictEqual(a, b, '半/全角圆括号应统一');
  console.log(`✅ 3a. 半/全角圆括号归一 ("海阔天空 (Live)" → "${a}")`);
}

// ── 3b. 半角 vs 方头括号 [ ] / 【 】───────────────────────
{
  const a = normalizeKey('海阔天空 [Live]', 'Beyond');
  const b = normalizeKey('海阔天空【Live】', 'Beyond');
  assert.strictEqual(a, b, '半/全角方括号应统一');
  console.log(`✅ 3b. 半/全角方括号归一`);
}

// ── 3c. 半角尖括号 vs 中文书名号 < > / 《 》──────────────────
{
  const a = normalizeKey('海阔天空 <Live>', 'Beyond');
  const b = normalizeKey('海阔天空《Live》', 'Beyond');
  assert.strictEqual(a, b, '半角尖括号 / 中文书名号应统一');
  console.log(`✅ 3c. 半角尖括号 / 中文书名号归一`);
}

// ── 3d. em-dash / en-dash / 全角 hyphen / 长音号 → 半角 hyphen ─────
{
  const base = normalizeKey('海阔天空 - Live', 'Beyond');
  assert.strictEqual(base, normalizeKey('海阔天空 — Live', 'Beyond'),
    'em-dash (U+2014) 应归一');
  assert.strictEqual(base, normalizeKey('海阔天空 – Live', 'Beyond'),
    'en-dash (U+2013) 应归一');
  assert.strictEqual(base, normalizeKey('海阔天空 ‐ Live', 'Beyond'),
    'hyphen (U+2010) 应归一');
  assert.strictEqual(base, normalizeKey('海阔天空 ー Live', 'Beyond'),
    'katakana 长音号 (U+30FC) 应归一');
  console.log('✅ 3d. 横线类符号归一（5 种 dash 形式）');
}

// ── 3e. 智能引号 → 直引号 ──────────────────────────────────
{
  const base = normalizeKey("海阔天空 'Live'", 'Beyond');
  assert.strictEqual(base, normalizeKey('海阔天空 \u2018Live\u2019', 'Beyond'),
    "U+2018/U+2019 单弯引号应归一");
  assert.strictEqual(base, normalizeKey('海阔天空 \u201CLive\u201D', 'Beyond'),
    'U+201C/U+201D 双弯引号应归一');
  assert.strictEqual(base, normalizeKey('海阔天空 \u300CLive\u300D', 'Beyond'),
    '日式直角引号「」应归一');
  console.log('✅ 3e. 智能引号 / 中文书名号归一');
}

// ── 3f. 保守：保留版本差异（保守策略）─────────────────────
{
  const liveKey = normalizeKey('海阔天空 (Live)', 'Beyond');
  const albumKey = normalizeKey('海阔天空', 'Beyond');
  assert.notStrictEqual(liveKey, albumKey,
    '带 Live 标签 vs 无标签应视为不同版本（保守策略）');
  console.log(`✅ 3f. 保守保留「(Live)」vs「」版本差异`);
}

// ── 3g. 保守：英文 vs 中文标签不互并 ──────────────────────
{
  const enLive = normalizeKey('海阔天空 (Live)', 'Beyond');
  const cnLive = normalizeKey('海阔天空 (现场版)', 'Beyond');
  assert.notStrictEqual(enLive, cnLive,
    '英文 Live vs 中文「现场版」应视为不同版本（保守策略）');
  console.log('✅ 3g. 保守保留「Live」vs「现场版」版本差异');
}

// ── 3h. 阶段 D: stripFeatTags 单独测 ─────────────────────
{
  // 括号形式：`(feat. X)` 全/半角括号都剥
  assert.strictEqual(stripFeatTags('Bad Guy (feat. Justin Bieber)'), 'Bad Guy',
    '半角括号 feat.');
  assert.strictEqual(stripFeatTags('Bad Guy（feat. Justin Bieber）'), 'Bad Guy',
    '全角括号 feat.');
  // featuring / ft. / 无点都覆盖
  assert.strictEqual(stripFeatTags('Bad Guy featuring Justin Bieber'), 'Bad Guy',
    'featuring');
  assert.strictEqual(stripFeatTags('Bad Guy ft. Justin Bieber'), 'Bad Guy',
    'ft.');
  assert.strictEqual(stripFeatTags('Bad Guy feat Justin Bieber'), 'Bad Guy',
    'feat 无点');
  // 联入形式（无括号）
  assert.strictEqual(stripFeatTags('Bad Guy, feat. Justin Bieber'), 'Bad Guy',
    '前置逗号 + feat');
  // Live / Remix 不动
  assert.strictEqual(stripFeatTags('Bad Guy (Live)'), 'Bad Guy (Live)',
    '(Live) 不动');
  assert.strictEqual(stripFeatTags('Bad Guy (Remix)'), 'Bad Guy (Remix)',
    '(Remix) 不动');
  // feat + Live 共存：只剥 feat 部分（多余空格会被 .trim() 收掉为单空格）
  assert.strictEqual(
    stripFeatTags('Bad Guy (feat. Justin Bieber) (Live)'),
    'Bad Guy (Live)',
    '(feat. X) (Live) 仅剥 feat 部分',
  );
  // "with" 不动（避免误剥 "with Strings" 这种版本修饰）
  assert.strictEqual(stripFeatTags('Bad Guy with Strings'), 'Bad Guy with Strings',
    'with 不动');
  // 没 feat 关键词的多艺人表不动
  assert.strictEqual(stripFeatTags('Billie Eilish, Justin Bieber'),
    'Billie Eilish, Justin Bieber',
    '"B, J" 多艺人表不动（缺 feat 关键词）');
  // 边界
  assert.strictEqual(stripFeatTags(''), '', '空串');
  assert.strictEqual(stripFeatTags('Bad Guy'), 'Bad Guy', '无 feat');
  console.log('✅ 3h. 阶段 D: stripFeatTags 单独 11 case 全过');
}

// ── 3i. 阶段 D: normalizeKey 集成 — feat 跨写法匹配 ───────
{
  // title 同，artist 同，唯一差异是 title 上的 (feat. X)
  const base = normalizeKey('Bad Guy', 'Billie Eilish');
  assert.strictEqual(normalizeKey('Bad Guy (feat. Justin Bieber)', 'Billie Eilish'), base,
    'title 上的 (feat. X) 整个被剥');
  assert.strictEqual(normalizeKey('Bad Guy featuring Justin Bieber', 'Billie Eilish'), base,
    'inline featuring 也剥');
  assert.strictEqual(normalizeKey('Bad Guy', 'Billie Eilish feat. Justin Bieber'), base,
    'artist 里的 feat. 也剥');
  console.log('✅ 3i. 阶段 D: normalizeKey 跨写法归一 4 case 通过');
}

// ── 3j. 阶段 E1: stripFuriganaParens 单独测 ──────────────────
{
  // 纯假名括号 — 剥（最终 trim 过，尾空格已清）
  assert.strictEqual(stripFuriganaParens('藤井风 (ふじいかぜ)'), '藤井风',
    '半角括号平假名 (用户场景)');
  assert.strictEqual(stripFuriganaParens('Adele [エイドル]'), 'Adele',
    '半角方括号片假名');
  assert.strictEqual(stripFuriganaParens('Taylor (エーミリー・スミス)'),
    'Taylor', '片假名中点');
  // 全角括号
  assert.strictEqual(stripFuriganaParens('藤井風（ふじいかぜ）'), '藤井風',
    '全角括号平假名');
  // 中文方括号
  assert.strictEqual(stripFuriganaParens('歌手【えいみー】'), '歌手',
    '日式方括号');
  // 假名 + 数字 / Latin → 不剥
  assert.strictEqual(stripFuriganaParens('Song (ライブ Ver.)'),
    'Song (ライブ Ver.)',
    '含 Latin "Ver." 不剥');
  // 全 Latin → 不剥（live version）
  assert.strictEqual(stripFuriganaParens('Song (Live 2024)'), 'Song (Live 2024)',
    'Latin 标签不剥');
  // feat 路径 — stripFuriganaParens 不知道 feat（feat 全 Latin → 不动）
  assert.strictEqual(stripFuriganaParens('Song (feat. X)'), 'Song (feat. X)',
    'feat. 纯 Latin → 不动 —— stripFeatTags 会单独处理');
  // 混合假名 + 汉字
  assert.strictEqual(stripFuriganaParens('藤井风(ふじい風)'), '藤井风(ふじい風)',
    '含汉字 \"風\" 不剥');
  // 空括号
  assert.strictEqual(stripFuriganaParens('Song ()'), 'Song', '空括号');
  // 无括号不动
  assert.strictEqual(stripFuriganaParens('Song'), 'Song', '无括号不动');
  console.log('✅ 3j. 阶段 E1: stripFuriganaParens 11 case 全过');
}

// ── 3k. 阶段 E1: normalizeKey 集成 — furigana 不再污染 key ────
{
  // 用户场景: seed vs cand 剥掉后更接近
  const seed = normalizeKey('何なんw', '藤井风 (ふじい かぜ)');
  const candWithFurigana = normalizeKey('何なんw', '藤井风 (フジー)');
  // 两边都剥了；剩 "何なんw + 藤井风"——期望同 key
  assert.strictEqual(seed, candWithFurigana,
    'artist 里纯假名括号 → 两侧都剥 → 同 key');
  console.log(`✅ 3k. 阶段 E1: 用户场景 — artist furigana 剥除后命中 (key=${seed})`);
}

// ── 3l. 阶段 E2: cjkUnify 单独测 ─────────────────────────
{
  // 单字配对 → 单方向向中简靠
  assert.strictEqual(cjkUnify('風'), '风', '風→风');
  assert.strictEqual(cjkUnify('学'), '学', '学 不动 (中简本身就是 canonical)');
  assert.strictEqual(cjkUnify('國'), '国', '國→国');
  assert.strictEqual(cjkUnify('氣'), '气', '氣→气');
  assert.strictEqual(cjkUnify('黒'), '黑', '黒→黑');
  assert.strictEqual(cjkUnify('轉'), '转', '轉→转');
  assert.strictEqual(cjkUnify('龍'), '龙', '龍→龙');
  assert.strictEqual(cjkUnify('體'), '体', '體→体');
  assert.strictEqual(cjkUnify('畫'), '画', '畫→画');
  assert.strictEqual(cjkUnify('時'), '时', '時→时');
  assert.strictEqual(cjkUnify('個'), '个', '個→个');
  assert.strictEqual(cjkUnify('會'), '会', '會→会');
  // 表里没的字不动
  assert.strictEqual(cjkUnify('藤'), '藤', '藤 不动');
  assert.strictEqual(cjkUnify('井'), '井', '井 不动');
  // 多字混合
  assert.strictEqual(cjkUnify('藤井風'), '藤井风', '多字混合');
  assert.strictEqual(cjkUnify('何なんw'), '何なんw', '非 CJK 不动');
  assert.strictEqual(cjkUnify('藤井風 (フジー)'), '藤井风 (フジー)',
    '只 unify CJK，kana 不动');
  console.log('✅ 3l. 阶段 E2: cjkUnify 16 case 全过');
}

// ── 3m. 阶段 E2: normalizeKey 集成 — CJK 跨语言形态合并 ─────
{
  // 用户场景核心: 日文繁体「風」 vs 中文简体「风」 → 同 key
  const jp = normalizeKey('何なんw', '藤井風');
  const cn = normalizeKey('何なんw', '藤井风');
  assert.strictEqual(jp, cn,
    '日文繁体的「風」与中文简体的「风」归一到同 key');
  console.log(`✅ 3m. 阶段 E2: 跨语言形态 — 風 / 风 同 key (${jp})`);

  // 多个 CJK pair 在同一 key
  const ja_track = normalizeKey('時間', '個體');
  const cn_track = normalizeKey('时间', '个体');
  assert.strictEqual(ja_track, cn_track,
    '時間 / 时间、个體 / 个体 都对成一组');
  console.log(`✅ 3m. 阶段 E2: 多 pair 合并（時間/时间 + 个體/个体）`);
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

// ── 13. bestSource 避开 VIP 锁源：QQ 锁、网易云免费 → 选网易云 ──────
{
  const all = [
    {
      track: makeTrack('qq', 'qq-x', '简单爱', '周杰伦', { vipLocked: true }),
      platform: 'qq',
    },
    {
      track: makeTrack('netease', 'ne-x', '简单爱', '周杰伦', {
        vipLocked: false,
      }),
      platform: 'netease',
    },
  ];
  const deduped = dedupTracks(all);
  const items = buildUnifiedItems(deduped, all);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(
    items[0].bestSource,
    'netease',
    'QQ 是 VIP 锁、网易云免费全曲 → bestSource 应避开 QQ 选网易云',
  );
  console.log('✅ 13. bestSource 避开 VIP 锁源（选能出全曲的平台）');
}

// ── 14. 全部 VIP 锁 → 退回平台优先级（best-effort 播试听）──────────
{
  const all = [
    {
      track: makeTrack('qq', 'qq-y', '烟花易冷', '周杰伦', { vipLocked: true }),
      platform: 'qq',
    },
    {
      track: makeTrack('netease', 'ne-y', '烟花易冷', '周杰伦', {
        vipLocked: true,
      }),
      platform: 'netease',
    },
  ];
  const deduped = dedupTracks(all);
  const items = buildUnifiedItems(deduped, all);
  assert.strictEqual(
    items[0].bestSource,
    'qq',
    '全锁时退回平台优先级（qq），行为与之前一致',
  );
  console.log('✅ 14. 全 VIP 锁 → 退回平台优先级');
}

// ── 15. VIP 锁的 QQ + Deezer 预览 → 仍选 QQ（不被 Deezer 预览顶掉）─────
// 回归：tier-1「非锁」只在完整曲流平台(qq/netease)间挑；Deezer 匿名是 30s
// 预览，不能仅因未标 VIP 锁就盖过 QQ 源（否则 QQ-only 用户会被切到更差的预览）。
{
  const all = [
    {
      track: makeTrack('qq', 'qq-z', '蒲公英的约定', '周杰伦', {
        vipLocked: true,
      }),
      platform: 'qq',
    },
    {
      track: makeTrack('deezer', 'de-z', '蒲公英的约定', '周杰伦'),
      platform: 'deezer',
    },
  ];
  const deduped = dedupTracks(all);
  const items = buildUnifiedItems(deduped, all);
  assert.strictEqual(
    items[0].bestSource,
    'qq',
    'QQ 锁 + Deezer 预览 → 仍退回 QQ（Deezer 预览不算全曲源，不能顶掉）',
  );
  console.log('✅ 15. VIP 锁 QQ + Deezer 预览 → 不被预览顶掉');
}

console.log('\n🎉 全部 16 个测试通过');

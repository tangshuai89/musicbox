/**
 * 统一搜索的纯函数：去重 + 聚合 + 选 bestSource。
 *
 * 抽到独立文件是为了能直接被白盒测试覆盖（无需 DI 启动 NestJS）。
 * MusicService 内部也复用同一份实现。
 */
import type { Track } from './music.service';
import type {
  SourceInfo,
  UnifiedSearchItem,
} from './types';
import type { MusicProvider } from '../common/provider';

export type RawSearchEntry = { track: Track; platform: MusicProvider };

/**
 * 剥掉字符串里的「feat./featuring/ft. <name>」标签。
 *
 * 两种形式：
 *   - 括号形式：`(feat. Name)` / `（feat. Name）` / `(Featuring Name1 & Name2)` ...
 *   - 联入形式：`Song, feat. Name` / `Song feat. Name` / `Song ft. Name` ...
 *
 * **不动**：
 *   - `(Live)` / `(Remix)` / `(伴奏)` 等版本标签——那些是 v1 保守策略要保留
 *     的差异，跟 feat 标签性质不同
 *   - `(With Strings)` / `(With Drums)` 等 —— "with" 不在 regex 里，不会误剥
 *   - 多艺人表 `"Billie Eilish, Justin Bieber"` —— 缺 "feat." 关键词，
 *     不会被当作 feat 标签；那种多艺人结构是另一种问题，留 v3 解决
 *
 * 在 `normalizeKey` 流水线之前调用，让 feat 相关字符不进 key。
 */
export function stripFeatTags(s: string): string {
  if (!s) return s;
  let out = s;

  // 1) 括号形式：`(feat. Name)` `（feat. Name）` `[feat. Name]` `【feat. Name】`
  //    内含 feat / featuring / ft.(?).+，贪婪匹配到对应右括号（含全角）
  out = out.replace(
    /[(（\[【〔](?:feat\.?|featuring|ft\.?)\s+[^)）\]】〕]+[)）\]】〕]/gi,
    '',
  );

  // 2) 联入形式：`Song, feat. Name` / `Song feat. Name`(EOL) /
  //    `Song & feat. Name` / `Song / feat. Name` / `Song ft. Name`
  //    跟着前缀可以空格 / 逗号；feat 关键词后到下一个分隔符（,/&/）
  //    或字符串尾。
  out = out.replace(
    /\s*,?\s*(?:feat\.?|featuring|ft\.?)\s+[^,;&\/]+?(?=\s*(?:,|\s*&|\s*\/|$))/gi,
    '',
  );

  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 阶段 E1：剥掉"纯假名括号"——读音注释（furigana），不是版本标签。
 *
 * 日文里 artist 字段经常这样：「藤井风 (ふじいかぜ)」——半角括号里全是
 * 平假名/片假名，那是 kanji 的读音。剥掉避免它污染 key。
 *
 * **判定**：括号内容 trim 后**完全由**平假名/片假名（含中点・长音ー/空白）
 * 构成 → 整段剥；其他类型（Latin / 汉字 / 标点）→ 保留。
 *
 * 边界情况：
 *   - `(ふじいかぜ)` → 剥（用户场景）
 *   - `[エイドル]` → 剥
 *   - `（ライブ）` → 剥（用户已确认：日文里「ライブ」一般不写进 tag，
 *                       真要版本差异会用「～のライブ」直写在标题里）
 *   - `(feat. X)` → 不动（feat 走 stripFeatTags）
 *   - `(Live)` / `(现场版)` → 不动（Latin / 汉字）
 *   - `()` → 剥（空）
 *   - `(ヒューリスティック Live 2024)` → 不动（含 Latin）
 *
 * 在 `normalizeKey` 流水线 step 0 内跟在 stripFeatTags 后。
 */
export function stripFuriganaParens(s: string): string {
  if (!s) return s;
  // 平假名 U+3040-U+309F  +  片假名 U+30A0-U+30FF（含 U+30FB 中点、U+30FC 长音）
  // 空白 \s 用于分隔假名 token（如 "ふじい かぜ" 里就有半角空格）
  const stripped = s.replace(
    /[(（\[【〔]([\u3040-\u309F\u30A0-\u30FF\s]*)[)）\]】〕]/g,
    (m, k: string) => {
      const trimmed = k.trim();
      if (!trimmed) return ''; // 空括号
      // 严格验证 trim 完只剩"平/片假名 + 空白" (空白允许分隔假名 token)
      if (/^[\u3040-\u309F\u30A0-\u30FF\s]+$/.test(trimmed)) return '';
      return m; // 含其他字符（Latin、汉字、标点）→ 整段保留
    },
  );
  return stripped.replace(/\s+/g, ' ').trim();
}

/**
 * 阶段 E2：CJK 跨语言形态合并表（简体 → 繁/日 同字不同码点）。
 *
 * 同字不同码点的常见配对（Unicode 不做这层 NFKC 统一，所以 NFKC/NFD 都
 * 没用）：日文里的繁体/异体字 vs 简体中文的简体字。例：
 *   - 風 (U+98A8, 日) / 风 (U+98CE, 中简)
 *   - 學 (U+5B78, 繁/日) / 学 (U+5B66, 中简)
 *   - 氣 (U+6C17, 日) / 气 (U+6C14, 中简)
 *   - 國 (U+570B, 繁) / 国 (U+56FD, 中简)
 *   - 黑 (U+9ED1, 中简) / 黒 (U+9ED2, 日)
 *   - ... 还有 8-10 条常用对
 *
 * 策略：**单方向向"中简"靠**。这样 QQ / 网易云（CN 风格）不被改造，
 * 而日文平台（Watanabe / Kaze）的繁体字被改写成中简 → 跨平台能同 key。
 *
 * 在 normalizeKey 的 step 5（noise strip）之后、step 6（lowercase）之前
 * 应用。这个位置已经被前面阶段清理过标点，CJK 字面只剩 Han 字符，
 * unifier 命中率高。
 */
export const CJK_UNIFIER: Record<string, string> = {
  // 繁/日 → 中简
  '風': '风',   // U+98A8 → U+98CE (日: 風 → 中: 风)
  '學': '学',   // U+5B78 → U+5B66 (繁/日: 學 → 中: 学)
  '國': '国',   // U+570B → U+56FD (繁: 國 → 中: 国)
  '氣': '气',   // U+6C17 → U+6C14 (日: 氣 → 中: 气)
  '黒': '黑',   // U+9ED2 → U+9ED1 (日: 黒 → 中: 黑)
  '轉': '转',   // U+8EE2 → U+8F6C (繁/日: 轉 → 中: 转)
  '龜': '龟',   // U+9F9C → U+9F9F (繁: 龜 → 中: 龟)
  '龍': '龙',   // U+9BCC → U+9F99 (繁: 龍 → 中: 龙)
  '廣': '广',   // U+5EE3 → U+5E7F (繁: 廣 → 中: 广)
  '體': '体',   // U+9AD4 → U+4F53 (繁/日: 體 → 中: 体)
  '畫': '画',   // U+756B → U+753B (繁/日: 畫 → 中: 画)
  '對': '对',   // U+5C0D → U+5BF9 (繁/日: 對 → 中: 对)
  '時': '时',   // U+6642 → U+65F6 (繁/日: 時 → 中: 时)
  '個': '个',   // U+500B → U+4E2A (繁/日: 個 → 中: 个)
  '會': '会',   // U+6703 → U+4F1A (繁/日: 會 → 中: 会)
  '間': '间',   // U+9592 → U+95F4 (繁/日: 間 → 中: 间)
  '從': '从',   // U+5F9E → U+4ECE (繁/日: 從 → 中: 从)
};

/**
 * CJK unifier 应用函数（导出便于测试）。
 * 不在表里的字符原样返回。
 */
export function cjkUnify(s: string): string {
  if (!s) return s;
  return s.replace(CJK_UNIFIER_REGEX, (ch) => CJK_UNIFIER[ch] || ch);
}

/**
 * 由 CJK_UNIFIER 的 keys 构建的 char-class regex（模块加载一次）。
 * 这样 normalizeKey 每调只 regex 一次，且表 key 跟 char class 自动同步。
 */
const CJK_UNIFIER_REGEX: RegExp = (() => {
  const keys = Object.keys(CJK_UNIFIER).join('');
  return new RegExp(`[${keys}]`, 'g');
})();

/**
 * 歌名+歌手归一化：把 title 和 artist 拼成一个跨平台匹配键。
 *
 * 关键约束：**保守保留"版本差异"**（specs/match-engine/spec.md 的 v2 决策）。
 *   - 不剥掉括号 / 引号里的内容——(Live) / (现场版) 这类版本标签必须保留，
 *     不能把「海阔天空 (Live)」与「海阔天空」视为同一首。
 *   - 只做「同一首歌的不同写法」归一：半/全角括号、em-dash / en-dash、智能
 *     引号、中文书名号这些。如果阶段 C 的 fuzzy 兜底启用，到时候再放宽。
 *   - 阶段 D：先跑 `stripFeatTags` 把 feat/featuring/ft. + 名字 标签整个剥掉，
 *     这样跨平台 feat 写法差异（"Bad Guy (feat. X)" vs "Bad Guy"）能匹配。
 *     注意：手动剥 `(Live)` 等版本标签 *不在* 这里——那是冲突的。
 *   - 阶段 E1：再跑 `stripFuriganaParens` 把纯假名括号注释（如
 *     「藤井风 (ふじいかぜ)」）剥掉。判定严格"trim 后全是平/片假名"
 *     才剥；版本标签不动。
 *
 * 流水线：
 *   0) [阶段 D] 剥 feat 标签
 *   0.5) [阶段 E1] 剥纯假名括号（furigana）
 *   1) 全角 ASCII (U+FF01..U+FF5E) → 半角
 *   2) 全角括号 / 方头括号 / 书名号 → 半角
 *   3) 各种 dash 类（em-dash / en-dash / figure / full-width hyphen-minus /
 *      katakana 长音号）→ '-'
 *   4) 智能引号 / 中文书名号 → 直引号
 *   5) 合并连续的"空白 + 标点 + 半角括号 + 直引号 + dash"到一组噪声字符并整段压缩
 *   5.5) [阶段 E2] CJK 跨语言形态合并（風→风 等）
 *   6) 全小写
 */
export function normalizeKey(title: string, artist: string): string {
  const stripped =
    `${stripFuriganaParens(stripFeatTags(title))} ` +
    `${stripFuriganaParens(stripFeatTags(artist))}`;
  const raw = stripped
    // 1) 全角 ASCII（FF01..FF5E）→ 半角
    .replace(/[！-～]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
    )
    // 2) 全角括号 / 方头括号 / 书名号 → 半角（让下游 strip 类统一处理）
    .replace(/[（）【】《》]/g, (ch) =>
      ch === '（' ? '(' :
      ch === '）' ? ')' :
      ch === '【' ? '[' :
      ch === '】' ? ']' :
      ch === '《' ? '<' :
      ch === '》' ? '>' :
      ch,
    )
    // 3) 各种 dash → '-'（U+2010..U+2015 = hyphen / non-breaking / figure /
    //    en-dash / em-dash / minus-bar；U+2212 = 数学 minus；U+FF0D = 全角
    //    hyphen-minus；U+30FC = 片假名长音号「ー」）
    .replace(/[\u2010-\u2015\u2212\uFF0D\u30FC]/g, '-')
    // 4) 智能引号 / 中文书名号 → 直引号
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[「」『』]/g, '"')
    // 5) 噪声字符合并：空白 + 标点 + 半角括号 + 直引号 + dash
    .replace(/[\s\-_,.()\[\]<>'"′″·&+\/!?！？:：;；]+/g, '')
    // 5.5) CJK 跨语言形态合并（阶段 E2）
    .replace(CJK_UNIFIER_REGEX, (ch) => CJK_UNIFIER[ch] || ch)
    // 6) 全小写
    .toLowerCase();
  return raw;
}

/** 去重: 相同 normalizeKey 的歌合并为一条，保留第一个出现的。 */
export function dedupTracks(all: RawSearchEntry[]): Map<string, Track> {
  const map = new Map<string, Track>();
  for (const { track } of all) {
    const key = normalizeKey(track.title, track.artist);
    if (!map.has(key)) {
      map.set(key, track);
    }
  }
  return map;
}

/** 播放优先级: qq > netease > deezer > spotify。只有 hasCopyright 的才可选。
 *  Spotify 排最后——30s 预览是它的硬限制，能用但不优；QQ/网易云通常有完整曲流。
 *  ⚠️ 加新 provider 时务必在这里 append，否则 unified 永远拿不到它当 bestSource。 */
export const PLAY_PRIORITY: MusicProvider[] = [
  'qq',
  'netease',
  'deezer',
  'spotify',
];

/** 能出「全曲」的平台。Deezer 匿名 / Spotify 非 Premium 本身就是 30s 预览，
 *  不算全曲源——所以"优先非 VIP 锁"这一档只在它们之间挑，别让一个 Deezer 预览
 *  仅因为"没被标 VIP 锁"就顶掉一个 QQ 源。 */
const FULL_SONG_PROVIDERS: ReadonlySet<MusicProvider> = new Set<MusicProvider>([
  'qq',
  'netease',
]);

/**
 * 选 bestSource：两档优先。
 *  1. **完整曲流平台里，有版权且非 VIP 锁**的（qq/网易云中能出全曲的）→ 按平台
 *     优先级选。这样"网易云免费全曲、QQ 绿钻独占"会直接选网易云，不再选中 QQ
 *     然后播成 30s 试听。
 *  2. 都没有 → 退回「按平台优先级选第一个有版权的」（**与之前完全一致**的行为，
 *     best-effort：QQ 试听仍优于 Deezer 预览，不会因 tier-1 漏选而把 Deezer 顶上来）。
 */
export function selectBestSource(sources: SourceInfo[]): MusicProvider | null {
  const byPriority = (pred: (s: SourceInfo) => boolean): MusicProvider | null =>
    PLAY_PRIORITY.find((p) => sources.some((s) => s.platform === p && pred(s))) ??
    null;
  return (
    byPriority(
      (s) => s.hasCopyright && !s.vipLocked && FULL_SONG_PROVIDERS.has(s.platform),
    ) ?? byPriority((s) => s.hasCopyright)
  );
}

/** 同 normalizeKey 的两首视为"同一版本"的最大 duration 差（秒）。与
 *  match.service 的 DURATION_TOLERANCE_SEC 保持一致。 */
export const VERSION_DURATION_TOLERANCE_SEC = 3;

/**
 * 在同一个 normalizeKey 组内，按 duration 就近聚类成「版本」。
 * 每个 cluster = 一个版本（一个 UnifiedSearchItem）。
 *
 * 规则：
 *  - duration ≤ 0（未知，如部分 Deezer 结果）不参与门槛 → 全部并入第一个
 *    cluster（或自成一 cluster）。这保证老测试（duration 全 0）仍合并为一条。
 *  - duration > 0：按升序贪心，cluster 宽度 ≤ TOLERANCE（anchor=cluster 最小值），
 *    差 > TOLERANCE 就开新 cluster。→ "晴天"的 album/live/remix 各自成条。
 */
function clusterByDuration(entries: RawSearchEntry[]): RawSearchEntry[][] {
  const withDur = entries
    .filter((e) => e.track.duration > 0)
    .sort((a, b) => a.track.duration - b.track.duration);
  const zeroDur = entries.filter((e) => !(e.track.duration > 0));

  const clusters: { anchor: number; items: RawSearchEntry[] }[] = [];
  for (const e of withDur) {
    const last = clusters[clusters.length - 1];
    if (
      last &&
      e.track.duration - last.anchor <= VERSION_DURATION_TOLERANCE_SEC
    ) {
      last.items.push(e);
    } else {
      clusters.push({ anchor: e.track.duration, items: [e] });
    }
  }
  if (zeroDur.length) {
    if (clusters.length) clusters[0].items.push(...zeroDur);
    else clusters.push({ anchor: 0, items: zeroDur });
  }
  return clusters.map((c) => c.items);
}

/**
 * 将所有平台的原始搜索结果聚合为 UnifiedSearchItem。
 *
 * 先按 normalizeKey（歌名+歌手）分组，再在组内按 duration 聚类成「版本」——
 * 同名不同时长的版本（album / live / remix ...）各自成条，跨平台**同版本**
 * （时长接近）才合并。这样搜索里能看到多个版本，点 ❤ 时 sources 里就是
 * 同一个版本的跨平台源。
 *
 * `deduped` 参数保留是为了兼容旧签名/测试；分组逻辑不再依赖它。
 */
export function buildUnifiedItems(
  _deduped: Map<string, Track>,
  all: RawSearchEntry[],
): UnifiedSearchItem[] {
  // 1) 按 normalizeKey 分组
  const byKey = new Map<string, RawSearchEntry[]>();
  for (const e of all) {
    const key = normalizeKey(e.track.title, e.track.artist);
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }

  const items: UnifiedSearchItem[] = [];
  for (const entries of byKey.values()) {
    // 2) 组内按 duration 聚类成版本
    for (const cluster of clusterByDuration(entries)) {
      const sources: SourceInfo[] = cluster.map(({ track }) => ({
        platform: track.provider,
        trackId: track.id,
        // QQ/网易云的搜索结果默认有版权（搜索阶段无法完全判断，
        // 播放时 getStreamUrl 才最终裁决）。
        hasCopyright: true,
        url: track.audioUrl,
        // 透传 QQ 的 media_mid，让统一搜索结果走「标准→320→无损」时仍可升级。
        mediaMid: track.mediaMid,
        // 透传 VIP 锁标记，selectBestSource 据此避开只能出试听的源。
        vipLocked: track.vipLocked,
      }));
      // main：取 cluster 内优先级最高平台的 track（决定 id / 展示信息），
      // 保证同一版本的 id 稳定、标题优先用 QQ/网易云的中文名。
      const main =
        PLAY_PRIORITY.map((p) =>
          cluster.find((e) => e.track.provider === p),
        ).find(Boolean)?.track ?? cluster[0].track;
      const bestSource = selectBestSource(sources);
      items.push({
        id: `merged-${main.provider}-${main.id}`,
        title: main.title,
        artist: main.artist,
        album: main.album,
        coverUrl: main.coverUrl,
        duration: main.duration,
        sources,
        bestSource,
      });
    }
  }
  return items;
}

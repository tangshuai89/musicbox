import type { UnifiedSearchItem, MusicProvider } from '../api';

/**
 * 红心库的「展示级」跨平台分组。
 *
 * 后端 `buildUnifiedItems` 用 `normalizeKey`(歌名+歌手) 严格合并，但 QQ 常给
 * 标题加中文译名括号（「夜に駆ける (向夜晚奔去)」）、歌手加别名（「YOASOBI
 * (ヨアソビ)」），于是和网易云的「夜に駆ける / YOASOBI」归一 key 不同 → 拆成
 * 两条。这里用更宽的 key（去掉成对括号内容后再归一）+ 时长就近，把「同一首歌
 * 的跨平台副本」并成一个可展开的组。
 *
 * **仅用于弹窗展示**——不改后端红心/播放数据，也不动播放队列（`onPlay` 仍按
 * 成员在原始 items 数组里的下标定位，播放行为不变）。所以即便偶尔把两个不同
 * 版本误并到一组，代价也只是展示分组，不会点错红心。
 */
export interface LibraryGroup {
  /** 稳定的 React key。 */
  key: string;
  /** 折叠态展示用的代表条目（有封面优先、标题最简洁的成员）。 */
  representative: UnifiedSearchItem;
  /** 代表条目在原始 items 数组里的下标（点折叠行播放时传给 onPlay）。 */
  representativeIndex: number;
  /** 组内所有成员（含原始下标，展开子列表 + 点击播放用）。 */
  members: Array<{ item: UnifiedSearchItem; index: number }>;
  /** 组覆盖的平台（去重、按徽章优先级排序）。 */
  platforms: MusicProvider[];
}

/** 同一 fuzzyKey 内，时长差 ≤ 此值才并入同一组（秒）。跨平台同一录音通常只差
 *  几秒；studio / live 版差得多，靠这个阈值分开，避免把不同版本误并。 */
const DURATION_TOL_SEC = 12;

/** 徽章展示顺序（与播放优先级一致）。 */
const BADGE_ORDER: MusicProvider[] = ['qq', 'netease', 'spotify', 'deezer'];

/** 归一：去成对括号及内容 → 全角转半角 → 去空格标点 → 小写。 */
function stripForFuzzy(s: string): string {
  return s
    .replace(/[（(【[][^)）\]】]*[)）\]】]/g, '') // 去成对括号及里面的内容
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-_,.·&+/!?！？:：;；'"’”‘“()（）[\]【】]+/g, '')
    .toLowerCase();
}

/** 不去括号的归一——去括号后整段为空时兜底用（罕见：标题整个在括号里）。 */
function normalizeNoStrip(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-_,.·&+/!?！？:：;；'"’”‘“()（）[\]【】]+/g, '')
    .toLowerCase();
}

/** 分组用的模糊 key：去括号归一的「歌名|歌手」。 */
export function fuzzyKey(title: string, artist: string): string {
  const t = stripForFuzzy(title) || normalizeNoStrip(title);
  return `${t}|${stripForFuzzy(artist)}`;
}

interface MutableGroup extends LibraryGroup {
  anchorDuration: number;
}

export function groupLibraryItems(items: UnifiedSearchItem[]): LibraryGroup[] {
  const byFk = new Map<string, MutableGroup[]>();
  const order: MutableGroup[] = [];

  items.forEach((item, index) => {
    const fk = fuzzyKey(item.title, item.artist);
    let bucket = byFk.get(fk);
    if (!bucket) {
      bucket = [];
      byFk.set(fk, bucket);
    }
    // 同 fk 里找一个时长相近的组并入（两边时长都已知才比，否则允许并入）。
    const g = bucket.find(
      (grp) =>
        !(grp.anchorDuration > 0 && item.duration > 0) ||
        Math.abs(grp.anchorDuration - item.duration) <= DURATION_TOL_SEC,
    );
    if (g) {
      g.members.push({ item, index });
      if (!(g.anchorDuration > 0) && item.duration > 0) {
        g.anchorDuration = item.duration;
      }
    } else {
      const fresh: MutableGroup = {
        key: `${fk}#${bucket.length}`,
        representative: item,
        representativeIndex: index,
        members: [{ item, index }],
        platforms: [],
        anchorDuration: item.duration,
      };
      bucket.push(fresh);
      order.push(fresh);
    }
  });

  for (const g of order) {
    // 代表：有封面优先，其次标题最短（通常是无译名括号的原名，更干净）。
    const rep = g.members.reduce((best, m) => {
      const bc = best.item.coverUrl ? 1 : 0;
      const mc = m.item.coverUrl ? 1 : 0;
      if (mc !== bc) return mc > bc ? m : best;
      return m.item.title.length < best.item.title.length ? m : best;
    }, g.members[0]);
    g.representative = rep.item;
    g.representativeIndex = rep.index;

    const set = new Set<MusicProvider>();
    for (const m of g.members) {
      for (const s of m.item.sources) set.add(s.platform);
    }
    g.platforms = BADGE_ORDER.filter((p) => set.has(p));
  }

  return order;
}

/** 单个统一条目覆盖的平台（去重、按徽章顺序）——子行徽章用。 */
export function itemPlatforms(item: UnifiedSearchItem): MusicProvider[] {
  const set = new Set(item.sources.map((s) => s.platform));
  return BADGE_ORDER.filter((p) => set.has(p));
}

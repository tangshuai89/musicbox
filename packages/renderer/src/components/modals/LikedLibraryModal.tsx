import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../common/Modal';
import { getLibrary, importLibrary } from '../../api';
import type { LibraryImportResult, UnifiedSearchItem, MusicProvider } from '../../api';
import { groupLibraryItems, itemPlatforms } from '../../lib/groupLibrary';
import { placeholderCover } from '../../lib/placeholderCover';

interface Props {
  onClose: () => void;
  /** 把点击的 ❤ 歌放进播放队列（与搜索结果同源）。 */
  onPlay: (items: UnifiedSearchItem[], index: number) => void;
  /** 递增计数：外部（播到红心歌、跨平台补齐后）触发一次静默刷新。 */
  refreshSignal?: number;
}

/** 平台徽章：一个平台一个色块。QQ=Q / 网易云=云 / Spotify=S / Deezer=D。 */
function PlatformBadges({ platforms }: { platforms: MusicProvider[] }) {
  return (
    <div className="liked-modal-sources">
      {platforms.map((platform) => (
        <span
          key={platform}
          className={`liked-modal-badge liked-modal-badge-${platform}`}
          title={platform}
        >
          {platform === 'qq'
            ? 'Q'
            : platform === 'netease'
              ? '云'
              : platform === 'spotify'
                ? 'S'
                : 'D'}
        </span>
      ))}
    </div>
  );
}

/**
 * "我的喜欢" 总览弹窗：展示所有平台已 ❤ 合并后的库（QQ + 网易云 v1，
 * Deezer / Spotify 留 TODO），支持滚动浏览千级条目；底部"重新导入"
 * 按钮触发一次全量 importLibrary 刷新库。
 *
 * 数据来源：服务端 /music/library 返回的 UnifiedSearchItem[]，本身已经
 * 跨平台去重合并，所以一首歌不会因为 QQ + 网易云都 ❤ 而出现两次。
 */
export default function LikedLibraryModal({
  onClose,
  onPlay,
  refreshSignal,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<LibraryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // refreshSignal 触发的静默刷新：只换数据、不闪"加载中"。首个值跳过（挂载
  // 时下面的 effect 已经拉过一次），避免打开就双拉。
  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    let cancelled = false;
    getLibrary()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        // 静默刷新失败不打扰用户（列表保持现状）。
      });
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  // 打开弹窗时拉一次缓存（不强制 import；如果从未导入过就是空态）。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getLibrary()
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await importLibrary();
      setData(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const items = useMemo(() => data?.items ?? [], [data]);
  // 展示级跨平台分组：把后端没并起来的同名副本（QQ 加了译名括号那种）折叠成
  // 一个可展开的组。仅影响展示，onPlay 仍按成员在 items 里的原始下标定位。
  const groups = useMemo(() => groupLibraryItems(items), [items]);
  // 哪些组当前展开（按 group.key）。
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // 平台计数从「分组后的组」里数（一个组含该平台就算一次），与每行徽章一致。
  // 跨平台都 ❤ 的歌会同时计入两个平台（两者之和可能 > 总数，符合直觉）。
  const qqCount = groups.filter((g) => g.platforms.includes('qq')).length;
  const neCount = groups.filter((g) => g.platforms.includes('netease')).length;

  return (
    <Modal onClose={onClose} panelClassName="liked-modal-panel">
      <div className="liked-modal-header">
        <span className="liked-modal-title">❤ 我的喜欢</span>
        <span className="liked-modal-count">
          共 {groups.length} 首
          {qqCount + neCount > 0 && (
            <span className="liked-modal-count-detail">
              {' '}· QQ {qqCount} · 网易云 {neCount}
            </span>
          )}
        </span>
        <button
          className="liked-modal-close"
          onClick={onClose}
          aria-label="关闭"
        >
          ×
        </button>
      </div>

      <div className="liked-modal-body">
        {loading && <div className="liked-modal-loading">加载中…</div>}

        {error && <div className="liked-modal-error">⚠ {error}</div>}

        {!loading && !error && items.length === 0 && (
          <div className="liked-modal-empty">
            <div className="liked-modal-empty-icon">♡</div>
            <div className="liked-modal-empty-text">
              还没有导入任何红心歌曲
            </div>
            <button
              className="liked-modal-refresh"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? '导入中…' : '现在导入'}
            </button>
          </div>
        )}

        {!loading && groups.length > 0 && (
          <ul className="liked-modal-list">
            {groups.map((g) => {
              const rep = g.representative;
              const multi = g.members.length > 1;
              const isOpen = multi && expanded.has(g.key);
              return (
                <li key={g.key} className="liked-modal-group">
                  <div
                    className={`liked-modal-row${isOpen ? ' is-open' : ''}`}
                    onClick={() => onPlay(items, g.representativeIndex)}
                  >
                    {rep.coverUrl ? (
                      <img
                        className="liked-modal-cover"
                        src={rep.coverUrl}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <div
                        className="liked-modal-cover liked-modal-cover-empty"
                        style={{
                          backgroundImage: placeholderCover(
                            `${rep.title}·${rep.artist}`,
                          ).background,
                        }}
                      >
                        ♪
                      </div>
                    )}
                    <div className="liked-modal-meta">
                      <div className="liked-modal-track">{rep.title}</div>
                      <div className="liked-modal-artist">
                        {rep.artist}
                        {rep.album && (
                          <span className="liked-modal-album">
                            {' '}
                            · {rep.album}
                          </span>
                        )}
                      </div>
                    </div>
                    <PlatformBadges platforms={g.platforms} />
                    {multi && (
                      <button
                        className="liked-modal-toggle"
                        aria-label={isOpen ? '收起' : '展开各平台版本'}
                        aria-expanded={isOpen}
                        title={`${g.members.length} 个平台版本`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(g.key);
                        }}
                      >
                        <span className="liked-modal-toggle-count">
                          {g.members.length}
                        </span>
                        <span className="liked-modal-toggle-chevron">
                          {isOpen ? '▾' : '▸'}
                        </span>
                      </button>
                    )}
                  </div>

                  {isOpen && (
                    <ul className="liked-modal-sublist">
                      {g.members.map((m) => (
                        <li
                          key={m.item.id}
                          className="liked-modal-subrow"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPlay(items, m.index);
                          }}
                        >
                          <span className="liked-modal-subrow-dot" aria-hidden />
                          <div className="liked-modal-meta">
                            <div className="liked-modal-track">
                              {m.item.title}
                            </div>
                            <div className="liked-modal-artist">
                              {m.item.artist}
                              {m.item.album && (
                                <span className="liked-modal-album">
                                  {' '}
                                  · {m.item.album}
                                </span>
                              )}
                            </div>
                          </div>
                          <PlatformBadges platforms={itemPlatforms(m.item)} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {items.length > 0 && (
        <div className="liked-modal-footer">
          <button
            className="liked-modal-refresh"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? '重新导入中…' : '🔄 重新导入'}
          </button>
          <span className="liked-modal-hint">点击曲目直接播放</span>
        </div>
      )}
    </Modal>
  );
}
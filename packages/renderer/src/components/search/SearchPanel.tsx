import { useState, useEffect, useRef, useCallback } from 'react';
import { searchUnified } from '../../api';
import type { UnifiedSearchItem } from '../../api';
import { formatDuration } from '../../lib/format';
import Modal from '../common/Modal';
import SourceChip from './SourceChip';

interface Props {
  /**
   * 点某一行播放：传入整批 UnifiedSearchItem（按当前分页顺序），index 是被点
   * 的那条。父组件在点击时把 UnifiedSearchItem 解析成 Track 后入播放队列。
   */
  onPlay: (items: UnifiedSearchItem[], index: number) => void;
  onClose: () => void;
}

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 300;
/** 搜索发起超过这个时间还没拿到结果，就显示"暂无结果"——避免慢响应时的
 *  "什么也没显示"白屏感。实际结果回来后会立即被真实数据覆盖。 */
const EMPTY_TIMEOUT_MS = 3000;

/**
 * 搜索面板——产品核心入口：输入歌手/歌名 → 跨 QQ/网易云/Deezer 同时搜 →
 * 合并去重后展示；点某条从 hasCopyright 最高的源播放；点 ❤ 之后可考虑
 * fan-out 到所有有版权的源（P1）。
 */
export default function SearchPanel({ onPlay, onClose }: Props) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<UnifiedSearchItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 搜索发起后 3 秒仍 loading → 标记 timedOut，显示"暂无结果"占位。 */
  const [emptyTimedOut, setEmptyTimedOut] = useState(false);
  const [searched, setSearched] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const emptyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 滚动容器 ref —— 用于分页加载的触底检测 */
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  /** 真正发起一次搜索请求。page=1 覆盖式，page>1 追加式。 */
  const runSearch = useCallback(
    async (keyword: string, nextPage: number, append: boolean) => {
      // 取消上一次的 in-flight 请求，避免旧响应覆盖新结果。
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setItems([]);
        setPage(1);
        setHasMore(false);
        setError(null);
        setEmptyTimedOut(false);
        setSearched(true);
      }

      // 3 秒兜底：只对 page=1 起作用，避免无限分页时反复触发
      if (!append) {
        if (emptyTimerRef.current) clearTimeout(emptyTimerRef.current);
        emptyTimerRef.current = setTimeout(() => {
          setEmptyTimedOut(true);
        }, EMPTY_TIMEOUT_MS);
      }

      try {
        const res = await searchUnified(
          keyword,
          nextPage,
          PAGE_SIZE,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        // 分页去重：追加时按 id 过滤掉已存在的项，保证列表里每个 merged item 唯一。
        setItems((prev) => {
          if (!append) return res.items;
          const seen = new Set(prev.map((it) => it.id));
          const fresh = res.items.filter((it) => !seen.has(it.id));
          return [...prev, ...fresh];
        });
        setPage(res.page);
        setHasMore(res.page * res.pageSize < res.total);
        if (!append) {
          // 成功响应回来了，3 秒兜底作废（除非确实没结果）
          if (emptyTimerRef.current) clearTimeout(emptyTimerRef.current);
          if (res.items.length === 0) setEmptyTimedOut(true);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (!append) {
          setError((e as Error).message);
          setItems([]);
        }
        // append 失败的语义是「分页失败」——不覆盖已有列表，仅记录
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  // 输入变化 → debounce 300ms → 触发搜索
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const kw = q.trim();
    if (!kw) {
      // 空输入：不发起搜索（spec 要求）。同时清空旧结果。
      abortRef.current?.abort();
      if (emptyTimerRef.current) clearTimeout(emptyTimerRef.current);
      setItems([]);
      setPage(1);
      setHasMore(false);
      setLoading(false);
      setLoadingMore(false);
      setError(null);
      setEmptyTimedOut(false);
      setSearched(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void runSearch(kw, 1, false);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, runSearch]);

  // 卸载时清理所有 in-flight 请求和 timer
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (emptyTimerRef.current) clearTimeout(emptyTimerRef.current);
    };
  }, []);

  const handleRowClick = (index: number) => {
    const item = items[index];
    if (!item || !item.bestSource) return; // 全平台无版权，灰态不可点
    onPlay(items, index);
  };

  const handleLoadMore = () => {
    const kw = q.trim();
    if (!kw || loading || loadingMore || !hasMore) return;
    void runSearch(kw, page + 1, true);
  };

  // 触底检测
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      handleLoadMore();
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="search-bar">
        <input
          autoFocus
          className="search-input"
          placeholder="搜索歌手 / 歌名（跨平台）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        {loading && <span className="search-spinner" aria-hidden="true" />}
        <button
          className="search-close"
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
        >
          ×
        </button>
      </div>

      {error && <div className="search-error">{error}</div>}

      <div className="search-results" ref={scrollerRef} onScroll={handleScroll}>
        {!searched && !loading && (
          <div className="search-empty">输入歌名 / 歌手，回车搜</div>
        )}
        {searched && !loading && items.length === 0 && (
          <div className="search-empty">暂无结果</div>
        )}
        {/* 3 秒兜底：loading 卡住时显示"暂无结果"，结果回来后自动消失 */}
        {loading && emptyTimedOut && items.length === 0 && (
          <div className="search-empty">暂无结果</div>
        )}
        {items.map((it, i) => {
          const playable = it.bestSource !== null;
          return (
            <button
              key={it.id}
              className={`search-row${playable ? '' : ' search-row--disabled'}`}
              onClick={() => handleRowClick(i)}
              disabled={!playable}
              title={
                playable
                  ? `播放：${it.title} - ${it.artist}`
                  : '所有平台都无版权'
              }
            >
              {it.coverUrl ? (
                <img className="search-cover" src={it.coverUrl} alt="" />
              ) : (
                <div className="search-cover search-cover-ph" />
              )}
              <div className="search-row-meta">
                <div className="search-row-title">{it.title}</div>
                <div className="search-row-sub">
                  {it.artist}
                  {it.album ? ` · ${it.album}` : ''}
                  {it.duration > 0 ? ` · ${formatDuration(it.duration)}` : ''}
                </div>
                <div className="search-row-sources">
                  {it.sources.map((s, si) => (
                    <SourceChip
                      key={`${s.platform}-${s.trackId}-${si}`}
                      source={s}
                      isBest={s.platform === it.bestSource}
                    />
                  ))}
                </div>
              </div>
              {playable ? (
                <svg
                  className="search-play-icon"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="currentColor"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <span className="search-no-rights">无版权</span>
              )}
            </button>
          );
        })}
        {loadingMore && <div className="search-loading-more">加载更多…</div>}
      </div>
    </Modal>
  );
}

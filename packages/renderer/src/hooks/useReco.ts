import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  fetchRecoStatus,
  importLibrary,
  runReco,
  saveRecoKey,
  PROVIDER_LABELS,
} from '../api';
import type { UnifiedSearchItem } from '../api';

interface RecoStatus {
  configured: boolean;
  librarySize: number;
}

/**
 * DeepSeek recommendation flow: status (key configured + library size), the
 * "run reco" action (auto-imports the user's likes into the library first if
 * empty), and saving the API key. Results are fed into the same playback
 * queue as search via the `playSearch` callback.
 */
export function useReco(
  playSearch: (
    items: UnifiedSearchItem[],
    index: number,
    loadMore?: () => Promise<UnifiedSearchItem[]>,
  ) => void,
  setError: Dispatch<SetStateAction<string | null>>,
) {
  const [recoStatus, setRecoStatus] = useState<RecoStatus | null>(null);
  const [recoStatusVersion, setRecoStatusVersion] = useState(0);
  const [recoRunning, setRecoRunning] = useState(false);
  const [recoKeyOpen, setRecoKeyOpen] = useState(false);

  // Fetch reco status on mount + after every key save (version bump).
  useEffect(() => {
    fetchRecoStatus()
      .then(setRecoStatus)
      .catch(() => setRecoStatus({ configured: false, librarySize: 0 }));
  }, [recoStatusVersion]);

  const handleReco = useCallback(async () => {
    setError(null);
    // Re-fetch status (guard against stale).
    let status = recoStatus;
    try {
      status = await fetchRecoStatus();
      setRecoStatus(status);
    } catch (e) {
      setError(`推荐状态查询失败：${(e as Error).message}`);
      return;
    }
    if (!status.configured) {
      setRecoKeyOpen(true);
      return;
    }
    setRecoRunning(true);
    try {
      // Empty library → auto-import each platform's "my likes" (currently
      // NetEase / Spotify, both requiring login).
      if (status.librarySize === 0) {
        const lib = await importLibrary();
        const imported = lib.sources.reduce((n, s) => n + s.count, 0);
        if (imported === 0) {
          const hints = lib.sources
            .filter((s) => s.error)
            .map((s) => `${PROVIDER_LABELS[s.provider]}: ${s.error}`)
            .join('；');
          setError(
            `没有可导入的"我的喜欢"，先登录网易云或 Spotify 再试${
              hints ? `（${hints}）` : ''
            }`,
          );
          return;
        }
        status = { ...status, librarySize: lib.items.length };
        setRecoStatus(status);
      }
      const result = await runReco({ count: 10 });
      if (result.items.length === 0) {
        setError('推荐没拿到结果，换个心情/语言试试？');
        return;
      }
      // Track everything recommended this session so the auto-continue batches
      // don't replay songs (the server dedups against the library but not
      // across reco runs). Seeded with this first batch.
      const recommended: Array<{ title: string; artist: string }> =
        result.items.map((it) => ({ title: it.title, artist: it.artist }));
      const loadMore = async (): Promise<UnifiedSearchItem[]> => {
        const next = await runReco({
          count: 10,
          // Cap the exclude list so the prompt/request stays bounded on long
          // listening sessions; the most recent picks matter most.
          exclude: recommended.slice(-100),
        });
        for (const it of next.items) {
          recommended.push({ title: it.title, artist: it.artist });
        }
        return next.items;
      };
      // Reuse the same playback link as the search queue, plus the next-batch
      // loader so playback continues past the last recommendation.
      playSearch(result.items, 0, loadMore);
    } catch (e) {
      setError(`推荐失败：${(e as Error).message}`);
    } finally {
      setRecoRunning(false);
    }
  }, [recoStatus, playSearch, setError]);

  const handleSaveRecoKey = useCallback(
    async (key: string) => {
      if (!key || key.length < 8) {
        setError('key 太短');
        return;
      }
      try {
        const r = await saveRecoKey(key);
        setRecoKeyOpen(false);
        setRecoStatusVersion((v) => v + 1);
        setError(null);
        // Don't surface the tail in the UI; the user can infer from status.
        void r;
      } catch (e) {
        setError(`保存 key 失败：${(e as Error).message}`);
      }
    },
    [setError],
  );

  return {
    recoStatus,
    recoRunning,
    recoKeyOpen,
    setRecoKeyOpen,
    handleReco,
    handleSaveRecoKey,
  };
}

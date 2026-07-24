import { useEffect, useRef, useState } from 'react';
import type { LyricLine, LyricsSource, Track } from '../../api';
import { PROVIDER_LABELS } from '../../api';
import { downloadLyricsImage } from '../../lib/lyricsShare';
import LyricsPanel from './LyricsPanel';

interface Props {
  lyrics: LyricLine[] | null;
  currentTime: number;
  loading: boolean;
  synced: boolean;
  source: LyricsSource | null;
  track: Track | null;
  onSeek: (seconds: number) => void;
  /**
   * 「换个源找歌词」按钮回调——主源 + altSources + lyrics.ovh 都拿不到词时
   * 暴露给用户：按歌名+歌手去每个有歌词 API 的平台再搜一次。命中就替换
   * 当前 lyrics。
   */
  onRetryByName?: () => void | Promise<void>;
}

const TOAST_MS = 1800;

function sourceLabel(source: LyricsSource): string {
  if (source === 'lyricsovh') return 'lyrics.ovh';
  return PROVIDER_LABELS[source] ?? source;
}

/**
 * Side-column card wrapping the synced lyrics panel, plus the lyrics
 * toolbar: source badge (which platform the lyrics actually came from),
 * copy-all, and share-as-image. Copy feedback (single line + whole
 * lyrics) surfaces through a transient in-card toast.
 */
export default function LyricsCard({
  lyrics,
  currentTime,
  loading,
  synced,
  source,
  track,
  onSeek,
  onRetryByName,
}: Props) {
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  const copyText = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(okMsg);
    } catch {
      showToast('复制失败');
    }
  };

  const handleCopyLine = (text: string) => {
    void copyText(text, '已复制这句歌词');
  };

  const handleCopyAll = () => {
    if (!lyrics || lyrics.length === 0) return;
    void copyText(lyrics.map((l) => l.text).join('\n'), '已复制整首歌词');
  };

  const handleShare = async () => {
    if (!lyrics || lyrics.length === 0 || !track) return;
    showToast('正在生成分享图…');
    const ok = await downloadLyricsImage({
      title: track.title,
      artist: track.artist,
      coverUrl: track.coverUrl,
      lines: lyrics,
    });
    showToast(ok ? '分享图已下载' : '生成分享图失败');
  };

  const hasLyrics = !!lyrics && lyrics.length > 0;

  return (
    <div className="glass-card side-card lyrics-card">
      <div className="side-card-label lyrics-card-header">
        <span>Lyrics</span>
        {hasLyrics && source && (
          <span
            className="lyrics-source-badge"
            title={`歌词来源：${sourceLabel(source)}${synced ? '' : '（纯文本，无时间轴）'}`}
          >
            {sourceLabel(source)}
          </span>
        )}
        {hasLyrics && (
          <span className="lyrics-actions">
            <button
              className="lyrics-action-btn"
              onClick={handleCopyAll}
              aria-label="复制整首歌词"
              title="复制整首歌词"
            >
              ⧉
            </button>
            <button
              className="lyrics-action-btn"
              onClick={() => void handleShare()}
              aria-label="生成歌词分享图并下载"
              title="生成带封面的歌词图，下载到本地"
            >
              ↧
            </button>
          </span>
        )}
      </div>
      <LyricsPanel
        lyrics={lyrics}
        currentTime={currentTime}
        loading={loading}
        synced={synced}
        onSeek={onSeek}
        onCopyLine={handleCopyLine}
        onRetryByName={onRetryByName}
        noLyricsQuery={
          track ? `${track.title} ${track.artist}`.trim() : undefined
        }
      />
      {toast && (
        <div className="lyrics-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  fetchNextTrack,
  toggleLike,
  fanOutLike,
  detectLiked,
  dislike,
  dislikeMerged,
  pickPlayableTrack,
  API_ORIGIN,
} from '../api';
import type {
  Track,
  MusicProvider,
  QqQuality,
  UnifiedSearchItem,
} from '../api';
import {
  readStoredProvider,
  writeStoredProvider,
  clearStoredProvider,
  readStoredQuality,
  writeStoredQuality,
  readStoredDeezerPreset,
  writeStoredDeezerPreset,
} from '../lib/storage';
import { useCoverArt } from './useCoverArt';

/**
 * The playback core: everything that touches the <audio> element, the Web
 * Audio analyser graph, the track/queue state, and provider/quality
 * switching. This is deliberately one cohesive hook — the pieces share the
 * same refs and closures and are riddled with hard-won ordering fixes
 * (epoch cancellation, effect dep arrays, the search-open freeze), so
 * splitting them further would only re-introduce the closure traps the
 * comments below guard against.
 *
 * `audioRef` is owned by the caller (App) and shared with useVolume + the
 * <audio> JSX + the progress/lyrics seek paths.
 */
export function usePlayer(audioRef: RefObject<HTMLAudioElement | null>) {
  const [provider, setProvider] = useState<MusicProvider | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const fromCallback = params.get('provider');
    if (fromCallback === 'qq' || fromCallback === 'netease') return fromCallback;
    return readStoredProvider();
  });
  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [fanOutCount, setFanOutCount] = useState<number>(0);

  const [qqQuality, setQqQuality] = useState<QqQuality>(() => readStoredQuality());
  // presentTrack reads the current quality via ref to avoid a dep on it.
  const qqQualityRef = useRef<QqQuality>(qqQuality);
  qqQualityRef.current = qqQuality;

  const [deezerPreset, setDeezerPreset] = useState<string>(() =>
    readStoredDeezerPreset(),
  );

  // Search-mode client queue. Non-empty → loadNextTrack advances within the
  // results instead of hitting the server radio. Held in a ref so
  // loadNextTrack's closure doesn't read a stale value. Unified search adds
  // unifiedItems + mergedId for the heart fan-out path.
  // `unifiedItems` is kept ALIGNED with `tracks` (both index by idx) — playSearch
  // drops non-playable items from BOTH so idx maps to the right unified item.
  // mergedId is derived per-track as unifiedItems[idx].id (not a fixed field).
  const queueRef = useRef<{
    tracks: Track[];
    idx: number;
    unifiedItems?: UnifiedSearchItem[];
  } | null>(null);
  // Guards the async detect-liked result: only apply if the queue is still on
  // the same unified track we detected for (avoids a stale detect clobbering a
  // newer song's ❤ state after a fast skip).
  const activeMergedIdRef = useRef<string | undefined>(undefined);
  // On source switch with a track playing, skip one provider-change auto-load
  // so the current song keeps playing until it ends / the user skips.
  const skipAutoLoadRef = useRef(false);
  // For quality switches: jump back to the original position after reload.
  const pendingSeekRef = useRef<number | null>(null);

  // Web Audio graph — created lazily on the first play (autoplay policy gates
  // AudioContext + MediaElementSource to user gestures). `analyser` is state
  // (not a ref) because the bass RAF effect below reads it as a dependency
  // and needs a real re-render when the graph comes online.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const { bgLayerRef, coverBackdropRef, presentCover } = useCoverArt();

  /**
   * Lazily attach a Web Audio analyser to the live <audio> element.
   * source → analyser → ctx.destination. createMediaElementSource can only
   * be called ONCE per element and permanently reroutes its output through
   * the graph — so we MUST connect to ctx.destination or playback goes
   * silent. Guarded with mediaSrcRef so a second call is a no-op.
   */
  const ensureAudioGraph = useCallback((): AnalyserNode | null => {
    if (audioCtxRef.current && analyser) {
      // Already built — just make sure the context is running (it gets
      // suspended when the window loses focus on some OSes).
      if (audioCtxRef.current.state === 'suspended') {
        void audioCtxRef.current.resume().catch((e) => {
          console.warn('[audio] context resume() rejected:', e);
        });
      }
      return analyser;
    }
    const audioEl = audioRef.current;
    if (!audioEl) return null;
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor();
      const src = mediaSrcRef.current ?? ctx.createMediaElementSource(audioEl);
      mediaSrcRef.current = src;
      const node = ctx.createAnalyser();
      node.fftSize = 256;
      node.smoothingTimeConstant = 0.72;
      src.connect(node);
      node.connect(ctx.destination);
      audioCtxRef.current = ctx;
      setAnalyser(node);
      if (ctx.state === 'suspended') {
        void ctx.resume().catch((e) => {
          console.warn('[audio] initial context resume() rejected:', e);
        });
      }
      return node;
    } catch (e) {
      console.error('[audio] failed to build audio graph', e);
      return null;
    }
  }, [analyser, audioRef]);

  // Present a Track to the player: resolve absolute audioUrl, swap cover,
  // set play intent. Shared by the server radio and search-result paths.
  const presentTrack = useCallback(
    (next: Track) => {
      let audioUrl =
        next.audioUrl && next.audioUrl.startsWith('/')
          ? API_ORIGIN + next.audioUrl
          : next.audioUrl;
      // QQ / NetEase: append the selected quality to the stream URL.
      if (
        (next.provider === 'qq' || next.provider === 'netease') &&
        audioUrl.includes(`/music/stream/${next.provider}/`)
      ) {
        const sep = audioUrl.includes('?') ? '&' : '?';
        audioUrl += `${sep}q=${qqQualityRef.current}`;
      }
      if (next.coverUrl) {
        // presentCover reads the ref.current INSIDE its async work, so it
        // writes onto the freshly-remounted cover div (key={track.id} makes
        // the cover unmount/remount on every track change).
        presentCover(next.coverUrl);
      }
      setTrack({ ...next, audioUrl });
      setCurrentTime(0);
      const audio = audioRef.current;
      if (audio) audio.dataset.wantPlay = '1';
      setPlaying(true);
      // NOTE: do NOT build the audio graph here — it requires a real user
      // gesture. The graph is built lazily on the first play (onPlay /
      // handlePlayPause). Until then audio plays through the default path.
    },
    [presentCover, audioRef],
  );

  /**
   * 切歌后的红心检测：查这首统一 track 在各平台的红心情况；任一平台已 ❤ →
   * 后端补齐其余平台 → 前端把 ❤ 点亮 + 角标显示平台数。用 activeMergedIdRef
   * 防止快速切歌时旧结果盖掉新歌状态。
   */
  const detectAndApplyLiked = useCallback(
    async (unified: UnifiedSearchItem | undefined) => {
      activeMergedIdRef.current = unified?.id;
      if (!unified) {
        setFanOutCount(0);
        return;
      }
      const sources = unified.sources
        .filter((s) => s.hasCopyright)
        .map((s) => ({ platform: s.platform, trackId: s.trackId }));
      if (!sources.length) {
        setFanOutCount(0);
        return;
      }
      try {
        const r = await detectLiked(unified.id, sources);
        // 只在还停留在这首歌时应用（防快速切歌竞态）。
        if (activeMergedIdRef.current !== unified.id) return;
        setFanOutCount(r.liked ? r.fannedOutTo.length : 0);
        setTrack((prev) => (prev ? { ...prev, liked: r.liked } : prev));
      } catch {
        // 检测失败不影响播放，静默。
      }
    },
    [],
  );

  const loadNextTrack = useCallback(async () => {
    if (!provider) return;
    // Search mode: advance within the results queue (looping).
    const q = queueRef.current;
    if (q && q.tracks.length) {
      q.idx = (q.idx + 1) % q.tracks.length;
      presentTrack(q.tracks[q.idx]);
      void detectAndApplyLiked(q.unifiedItems?.[q.idx]);
      return;
    }
    // Radio (server) track: not a unified item, so there's no fan-out. Clear
    // the badge, otherwise it keeps showing the last search song's platform
    // count on top of unrelated radio tracks. `next.liked` (from the server)
    // still drives the ❤ fill via presentTrack.
    setFanOutCount(0);
    setLoading(true);
    setError(null);
    try {
      const next = await fetchNextTrack(
        provider,
        provider === 'deezer' ? deezerPreset : undefined,
      );
      presentTrack(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [provider, deezerPreset, presentTrack, detectAndApplyLiked]);

  /** Play a search result: parse UnifiedSearchItem[] into a playable queue,
   *  dropping items with no playable source. Keeps unifiedItems aligned with
   *  tracks so handleLike / detect can map idx → the right unified item. */
  const playSearch = useCallback(
    (unifiedItems: UnifiedSearchItem[], index: number) => {
      // Keep track+unified ALIGNED: drop non-playable from both so idx maps
      // to the right unified item (for per-song ❤ detect / fan-out).
      const playable: { track: Track; unified: UnifiedSearchItem }[] = [];
      unifiedItems.forEach((it, i) => {
        const t = pickPlayableTrack(it);
        if (t) playable.push({ track: t, unified: unifiedItems[i] });
      });
      const targetSrcIndex = unifiedItems[index] ? index : 0;
      const startIdx = playable.findIndex(
        (p) => p.unified === unifiedItems[targetSrcIndex],
      );
      if (startIdx < 0 || playable.length === 0) {
        setError('没有可播放的音源');
        return;
      }
      queueRef.current = {
        tracks: playable.map((p) => p.track),
        idx: startIdx,
        unifiedItems: playable.map((p) => p.unified),
      };
      setSearchOpen(false);
      setError(null);
      // New search context → clear the old fan-out count.
      setFanOutCount(0);
      presentTrack(playable[startIdx].track);
      void detectAndApplyLiked(playable[startIdx].unified);
    },
    [presentTrack, detectAndApplyLiked],
  );

  // Auto-load on provider / preset change (but skip once when delaying a
  // source switch so the current song isn't interrupted).
  useEffect(() => {
    if (!provider) return;
    if (skipAutoLoadRef.current) {
      skipAutoLoadRef.current = false;
      return;
    }
    loadNextTrack();
  }, [provider, deezerPreset, loadNextTrack]);

  // Audio element wiring. Re-bind whenever `track` changes (NOT when
  // loadNextTrack does — that closure trap was the original bug).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onLoadedMetadata = () => {
      setDuration(audio.duration || 0);
      // After a quality-switch reload, jump back to the original position.
      if (pendingSeekRef.current != null) {
        try {
          audio.currentTime = pendingSeekRef.current;
        } catch {
          // ignore occasional out-of-range seek
        }
        pendingSeekRef.current = null;
      }
    };
    const onCanPlay = () => {
      if (audio.dataset.wantPlay === '1' && audio.paused) {
        audio.play().catch((e) => {
          console.error('[audio] play() rejected in canplay:', e);
        });
      }
    };
    const onPlay = () => {
      audio.dataset.wantPlay = '1';
      // Build the graph the moment playback actually starts (autoplay is
      // allowed in this Electron shell). Idempotent.
      ensureAudioGraph();
    };
    const onPause = () => {
      audio.dataset.wantPlay = '0';
    };
    const onEnded = () => {
      audio.dataset.wantPlay = '0';
      loadNextTrack();
    };
    const onError = () => {
      const err = audio.error;
      const code = err ? `code=${err.code}` : 'no-MediaError';
      console.error('[audio] error', code, audio.src);
      setError(`音频加载失败（${code}），请尝试切歌`);
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [track, loadNextTrack, ensureAudioGraph, audioRef]);

  // Sync play/pause — but only call play() once the audio is actually ready
  // (the src is set on mount but data hasn't streamed yet). onCanPlay retries.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (playing) {
      audio.dataset.wantPlay = '1';
      if (audio.readyState >= 3 /* HAVE_FUTURE_DATA */) {
        audio.play().catch((e) => {
          console.error('[audio] play() rejected:', e);
          setError(`播放失败: ${(e as Error).message || e}`);
        });
      }
    } else {
      audio.dataset.wantPlay = '0';
      audio.pause();
    }
  }, [playing, track, audioRef]);

  // Bass-driven breathing for the cover card. RAF loop reads the analyser's
  // low-frequency bins and writes 0..1 to --bass-intensity on :root.
  useEffect(() => {
    // Freeze the pulse while the search overlay is open: its backdrop-filter
    // re-samples the cover every scroll repaint, and a moving cover would
    // flicker through the blur. Static cover behind the overlay → no flicker.
    if (searchOpen) {
      document.documentElement.style.setProperty('--bass-intensity', '0');
      return;
    }
    let raf = 0;
    const buf = new Uint8Array(64); // small buffer; we only need low bins
    const tick = () => {
      if (analyser && playing) {
        analyser.getByteFrequencyData(buf);
        // Average bins 1..12 (bin 0 is DC; bin 12 ≈ ~1kHz at 44.1kHz with
        // fftSize=256 — covers kick + bass + low mids).
        let sum = 0;
        for (let i = 1; i <= 12; i++) sum += buf[i];
        const bass = sum / (12 * 255);
        document.documentElement.style.setProperty(
          '--bass-intensity',
          (bass * 1.1).toFixed(3),
        );
      } else {
        document.documentElement.style.setProperty('--bass-intensity', '0');
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, analyser, searchOpen]);

  const selectSource = (next: MusicProvider) => {
    writeStoredProvider(next);
    if (next === 'deezer') {
      // Pre-arm user activation for Chromium's autoplay policy: play a tiny
      // silent WAV synchronously inside this click handler so subsequent
      // play() calls from our effects are allowed.
      try {
        const tmp = new Audio();
        tmp.muted = true;
        tmp.src =
          'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
        const p = tmp.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            tmp.pause();
            tmp.src = '';
          }).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
    setProvider(next);
  };

  /** Switch source from the dropdown without interrupting playback: same
   *  source → no-op; different → only later tracks come from the new source
   *  (current song plays out, or the user skips). */
  const switchToProvider = (next: MusicProvider) => {
    if (next === provider) return;
    queueRef.current = null; // the search queue is source-specific
    setSearchOpen(false);
    writeStoredProvider(next);
    if (track) skipAutoLoadRef.current = true;
    setProvider(next);
  };

  /** Switch quality (QQ / NetEase): reload the current song at the new
   *  quality, preserving the playback position. */
  const changeQuality = (q: QqQuality) => {
    setQqQuality(q);
    qqQualityRef.current = q;
    writeStoredQuality(q);
    const audio = audioRef.current;
    if (
      audio &&
      track &&
      (track.provider === 'qq' || track.provider === 'netease') &&
      track.audioUrl
    ) {
      pendingSeekRef.current = audio.currentTime; // restore after reload
      const base = track.audioUrl
        .replace(/[?&]q=[^&]*/, '')
        .replace(/[?&]$/, '');
      const sep = base.includes('?') ? '&' : '?';
      setTrack((prev) =>
        prev ? { ...prev, audioUrl: `${base}${sep}q=${q}` } : prev,
      );
    }
  };

  const changeDeezerPreset = (next: string) => {
    setDeezerPreset(next);
    writeStoredDeezerPreset(next);
  };

  const handlePlayPause = () => {
    // Build the graph the first time the user hits play; later clicks just
    // resume the context if needed.
    ensureAudioGraph();
    setPlaying((p) => !p);
  };

  const handleSkip = () => loadNextTrack();

  const handleLike = async () => {
    if (!track || !provider) return;
    // 语义：❤ 是开关。未收藏 → 在所有有版权的平台收藏（fan-out）；已收藏 →
    // 取消之前 fan-out 过的所有平台的收藏（不写「不喜欢」、不影响 FM 推荐——
    // 那是「踩」的语义）。
    const q = queueRef.current;
    const current = q?.unifiedItems?.[q.idx];
    if (current && current.bestSource) {
      const sources = current.sources
        .filter((s) => s.hasCopyright)
        .map((s) => ({ platform: s.platform, trackId: s.trackId }));
      const next = !track.liked;
      try {
        const result = await fanOutLike(current.id, sources, next);
        setFanOutCount(next ? result.fannedOutTo.length : 0);
        setTrack((prev) => (prev ? { ...prev, liked: next } : prev));
      } catch (e) {
        setError(`心动作业失败：${(e as Error).message}`);
      }
      return;
    }
    // Single-platform path (radio): toggleLike 本身就是翻转语义。
    const result = await toggleLike(provider, track.id);
    if (result.success) {
      setTrack((prev) => (prev ? { ...prev, liked: result.liked } : prev));
      setFanOutCount(0);
    }
  };

  const handleDislike = async () => {
    if (!track || !provider) return;
    // Unified search path: 踩 = 取消这首歌在所有平台的红心 + 标记不喜欢，
    // 否则某平台残留的红心会在下次切到这首歌时被 detect 重新点亮/收藏回来。
    const q = queueRef.current;
    const current = q?.unifiedItems?.[q.idx];
    if (current && current.bestSource) {
      const sources = current.sources
        .filter((s) => s.hasCopyright)
        .map((s) => ({ platform: s.platform, trackId: s.trackId }));
      try {
        await dislikeMerged(current.id, sources);
        setFanOutCount(0);
        setTrack((prev) => (prev ? { ...prev, liked: false } : prev));
      } catch {
        // 踩失败不阻塞切歌，静默。
      }
      loadNextTrack();
      return;
    }
    // Single-platform path (radio): 单平台标记不喜欢。
    await dislike(provider, track.id);
    loadNextTrack();
  };

  /** Seek the live <audio> element (progress-bar click, lyric-line click). */
  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = seconds;
  };

  /** Clear all playback state and drop back to no-provider. The auth reset,
   *  lyric clear (auto, via useLyrics when provider→null) and localStorage
   *  wipe are orchestrated by the caller. */
  const resetForSwitch = () => {
    audioRef.current?.pause();
    setPlaying(false);
    setTrack(null);
    setCurrentTime(0);
    setDuration(0);
    queueRef.current = null;
    setSearchOpen(false);
    setProvider(null);
    // Drop the analyser so it doesn't keep reading from a MediaStream whose
    // source <audio> element we just unmounted; it rebuilds on next play.
    setAnalyser(null);
    clearStoredProvider();
  };

  return {
    // state
    provider,
    track,
    playing,
    currentTime,
    duration,
    loading,
    error,
    setError,
    searchOpen,
    setSearchOpen,
    fanOutCount,
    qqQuality,
    deezerPreset,
    // cover refs (for the JSX)
    bgLayerRef,
    coverBackdropRef,
    // actions
    selectSource,
    switchToProvider,
    changeQuality,
    changeDeezerPreset,
    loadNextTrack,
    playSearch,
    handlePlayPause,
    handleSkip,
    handleLike,
    handleDislike,
    seek,
    resetForSwitch,
  };
}

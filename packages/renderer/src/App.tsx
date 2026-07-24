import { useEffect, useRef, useState } from 'react';
import { usePlayer } from './hooks/usePlayer';
import { useSpotifyWpsPlayer } from './hooks/useSpotifyWpsPlayer';
import { useVolume } from './hooks/useVolume';
import { useLyrics } from './hooks/useLyrics';
import { useAuth } from './hooks/useAuth';
import { useReco } from './hooks/useReco';
import { useTheme } from './hooks/useTheme';
import { useDeezerEditorials } from './hooks/useDeezerEditorials';
import { getLibrary } from './api';
import type { LibraryImportResult } from './api';
import SourceSelect from './components/source-select/SourceSelect';
import Titlebar from './components/layout/Titlebar';
import CoverCard from './components/player/CoverCard';
import NowPlayingCard from './components/player/NowPlayingCard';
import LyricsCard from './components/player/LyricsCard';
import ProgressBar from './components/player/ProgressBar';
import VolumeControl from './components/player/VolumeControl';
import TransportBar from './components/player/TransportBar';
import SearchPanel from './components/search/SearchPanel';
import NeteaseCookieModal from './components/modals/NeteaseCookieModal';
import RecoKeyModal from './components/modals/RecoKeyModal';
import LikedLibraryModal from './components/modals/LikedLibraryModal';
import SettingsModal from './components/modals/SettingsModal';

/**
 * Composition layer. All logic lives in hooks/ (usePlayer owns the audio
 * core; the rest are focused concerns) and all markup in components/. App
 * just wires the hooks to the components and owns the cross-cutting resets
 * (which touch multiple hooks). `audioRef` is the one ref shared across
 * hooks — created here and threaded into usePlayer, useVolume, and the
 * <audio> element.
 */
export default function App() {
  const audioRef = useRef<HTMLAudioElement>(null);

  // WPS (Spotify Premium 全曲播放) 和 usePlayer 互相依赖：usePlayer 的
  // transport 要驱动 WPS，而 WPS 的 enabled 又要读 player.provider + auth.tier。
  // 用一个 ref 打破循环：usePlayer 拿 wpsRef（引用稳定），在 effect 里懒读
  // wpsRef.current；wps 实例本身在所有 hook 之后再填进 ref。
  const wpsRef = useRef<ReturnType<typeof useSpotifyWpsPlayer> | null>(null);

  // Spotify tier 的快照 ref：在 auth hook 之后保持同步，供 tryUpgradeFromTrial
  // 决定 Spotify Premium 是否应被当作有效全曲升级目标。
  const spotifyTierRef = useRef<string | undefined>(undefined);

  const player = usePlayer(audioRef, wpsRef, spotifyTierRef);
  const volume = useVolume(audioRef, player.track);
  const lyrics = useLyrics(player.track, player.provider, player.currentSources);
  const auth = useAuth(player.provider, player.loadNextTrack, player.setError);
  spotifyTierRef.current = auth.auth.tier ?? undefined;
  const reco = useReco(player.playSearch, player.setError);
  const theme = useTheme();
  const deezerEditorials = useDeezerEditorials();

  // WPS 仅在 spotify Premium 时启用；Free / 其他 provider 走 <audio> + 30s 预览。
  const wpsEnabled = player.provider === 'spotify' && auth.auth.tier === 'premium';
  const wps = useSpotifyWpsPlayer({ enabled: wpsEnabled });
  wpsRef.current = wps;

  // 当 WPS 从 disconnected → connected 时，当前歌如果已经在播（30s 预览），
  // 需要重调 presentTrack 让 usePlayer 切到 WPS 全曲播放路径。
  useEffect(() => {
    if (wps.wpsReady && player.track?.provider === 'spotify') {
      player.refreshTrackForWps();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wps.wpsReady]);

  // WPS → progress bar：把 SDK 上报的播放位置 / 时长喂回 usePlayer，让
  // ProgressBar / 时间轴与其它平台一致。
  const applyWpsProgress = player.applyWpsProgress;
  useEffect(() => {
    if (wps.wpsReady && wps.state.hasTrack) {
      applyWpsProgress(wps.state.positionMs, wps.state.track?.durationMs ?? 0);
    }
  }, [wps.wpsReady, wps.state, applyWpsProgress]);

  // Switch source (Deezer "account" button): drop playback + auth back to the
  // picker. Lyrics clear themselves via useLyrics when provider → null.
  const handleSwitchSource = () => {
    player.resetForSwitch();
    auth.resetAuth();
  };

  // Wipe all client-side state and bounce back to the source picker.
  const handleResetLocal = () => {
    localStorage.clear();
    sessionStorage.clear();
    player.resetForSwitch();
    auth.resetAuth();
    theme.resetTheme();
  };

  // Liked library modal: 缓存的库（getLibrary 不强制 import）—— titlebar ❤
  // 按钮上展示数量，点击弹窗内自己处理 refresh。
  const [likedOpen, setLikedOpen] = useState(false);
  const [likedCount, setLikedCount] = useState(0);
  const [likedVersion, setLikedVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const reloadLikedCount = async () => {
    try {
      const res: LibraryImportResult | null = await getLibrary();
      setLikedCount(res?.items.length ?? 0);
    } catch {
      setLikedCount(0);
    }
  };
  useEffect(() => {
    void reloadLikedCount();
  }, [player.provider, auth.auth.loggedIn]);

  // Playing a ❤ song: usePlayer's detect already kicks off the cross-platform
  // fan-out + incremental library patch in the background. That's async (it
  // has to search the other platforms), so wait a beat, then refresh the ❤
  // count + any open liked-library list + re-detect current track's fanOut
  // state so the newly-synced platform badges show up in the UI.
  const heartSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!player.track?.liked) return;
    if (heartSyncTimerRef.current) clearTimeout(heartSyncTimerRef.current);
    heartSyncTimerRef.current = setTimeout(() => {
      void reloadLikedCount();
      setLikedVersion((v) => v + 1);
      player.refreshLikedState();
    }, 2500);
    return () => {
      if (heartSyncTimerRef.current) clearTimeout(heartSyncTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.track?.id, player.track?.liked]);

  // Tray transport controls (Electron): map tray commands onto the player and
  // report state back so the tray label/tooltip stay in sync. usePlayer stays
  // the single source of truth — no duplicate playback logic in main. We route
  // through a ref so the IPC listener is registered once (not re-subscribed on
  // every currentTime tick).
  const trayHandlersRef = useRef({
    playpause: player.handlePlayPause,
    next: player.handleSkip,
    prev: player.handlePrev,
  });
  trayHandlersRef.current = {
    playpause: player.handlePlayPause,
    next: player.handleSkip,
    prev: player.handlePrev,
  };
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onTrayCommand) return;
    return api.onTrayCommand((command) => trayHandlersRef.current[command]?.());
  }, []);

  useEffect(() => {
    window.electronAPI?.reportPlaybackState?.({
      isPlaying: player.playing,
      title: player.track?.title,
      artist: player.track?.artist,
    });
  }, [player.playing, player.track?.title, player.track?.artist]);

  // audio 元素 src 变时强制 load() 一次 —— 解决暂停+长时间不碰后
  // 「歌换了但播不了」的场景：Chromium 在 MEDIA_ERR_NETWORK / aborted 状态
  // 下，src 属性更新不会自动 reload；下次 audio.play() 也卡在 readyState=0
  // （usePlayer 的 useEffect 看到 readyState<3 会跳过 play）。
  // 显式 audio.load() 强制清 error 状态、让新 src 真去 fetch。
  useEffect(() => {
    const audio = audioRef.current;
    const url = player.track?.audioUrl;
    if (!audio || !url) return;
    audio.load();
  }, [player.track?.audioUrl]);

  if (!player.provider) {
    return <SourceSelect onSelect={player.selectSource} />;
  }

  return (
    // search-open adds a class the CSS uses to freeze the cover animations
    // behind the search overlay's backdrop-filter (avoids flicker).
    <div className={`app${player.searchOpen ? ' search-open' : ''}`}>
      <Titlebar
        provider={player.provider}
        onSwitchProvider={player.switchToProvider}
        deezerEditorials={deezerEditorials}
        deezerPreset={player.deezerPreset}
        onChangeDeezerPreset={player.changeDeezerPreset}
        onOpenSearch={() => player.setSearchOpen(true)}
        recoStatus={reco.recoStatus}
        recoRunning={reco.recoRunning}
        onReco={() => void reco.handleReco()}
        qqQuality={player.qqQuality}
        onChangeQuality={player.changeQuality}
        loggedIn={auth.auth.loggedIn}
        loggingIn={auth.loggingIn}
        accountName={auth.auth.user?.nickname}
        onLogin={
          player.provider === 'netease'
            ? auth.handleNeteaseLogin
            : player.provider === 'spotify'
              ? auth.handleSpotifyLogin
              : auth.handleQqLogin
        }
        onAccount={
          player.provider === 'deezer' ? handleSwitchSource : auth.handleLogout
        }
        onReset={handleResetLocal}
        likedCount={likedCount}
        onOpenLiked={() => {
          void reloadLikedCount();
          setLikedOpen(true);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Full-window blurred cover layer — the backdrop the glass cards blur.
          background-image is set by useCoverArt via bgLayerRef. */}
      <div className="bg-layer" ref={player.bgLayerRef} aria-hidden="true" />

      <div className="app-grid">
        <CoverCard
          track={player.track}
          playing={player.playing}
          coverBackdropRef={player.coverBackdropRef}
          error={player.error}
          onCloseError={() => player.setError(null)}
        />
        <div className="side-column">
          <NowPlayingCard
            provider={player.provider}
            qqQuality={player.qqQuality}
            loading={player.loading}
            playing={player.playing}
            accountName={auth.auth.user?.nickname ?? 'Guest'}
            trialFellBack={player.trialFellBack}
          />
          <LyricsCard
            lyrics={lyrics.lyrics}
            currentTime={player.currentTime}
            loading={lyrics.loading}
            synced={lyrics.synced}
            source={lyrics.source}
            track={player.track}
            onSeek={player.seek}
            onRetryByName={lyrics.retryByName}
          />
        </div>
      </div>

      <ProgressBar
        currentTime={player.currentTime}
        duration={player.duration}
        onSeek={player.seek}
      >
        <VolumeControl
          volume={volume.volume}
          muted={volume.muted}
          onVolumeChange={volume.handleVolumeChange}
          onToggleMute={volume.toggleMute}
        />
      </ProgressBar>

      <TransportBar
        hasTrack={!!player.track}
        loading={player.loading}
        playing={player.playing}
        liked={player.track?.liked ?? false}
        fanOutCount={player.fanOutCount}
        onDislike={() => void player.handleDislike()}
        onLike={() => void player.handleLike()}
        onPlayPause={player.handlePlayPause}
        onSkip={player.handleSkip}
      />

      {/* Always mounted (never conditionally unmounted) so the Web Audio graph
          built on it stays valid for the whole session — createMediaElement-
          Source can only be called once per element. crossOrigin + the
          server's CORS header make the media CORS-clean for the analyser. */}
      <audio
        ref={audioRef}
        src={player.track?.audioUrl || undefined}
        crossOrigin="anonymous"
        preload="auto"
      />

      {auth.showCookieFallback && (
        <NeteaseCookieModal
          onClose={() => auth.setShowCookieFallback(false)}
          onSuccess={auth.handleCookieFallbackSuccess}
        />
      )}

      {player.searchOpen && (
        <SearchPanel
          onPlay={player.playSearch}
          onClose={() => player.setSearchOpen(false)}
        />
      )}

      {reco.recoKeyOpen && (
        <RecoKeyModal
          onSave={reco.handleSaveRecoKey}
          onClose={() => reco.setRecoKeyOpen(false)}
        />
      )}

      {likedOpen && (
        <LikedLibraryModal
          refreshSignal={likedVersion}
          onClose={() => {
            setLikedOpen(false);
            void reloadLikedCount();
          }}
          onPlay={(items, idx) => {
            setLikedOpen(false);
            player.playSearch(items, idx);
          }}
        />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

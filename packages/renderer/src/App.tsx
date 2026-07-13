import { useEffect, useRef, useState } from 'react';
import { usePlayer } from './hooks/usePlayer';
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

  const player = usePlayer(audioRef);
  const volume = useVolume(audioRef, player.track);
  const lyrics = useLyrics(player.track, player.provider);
  const auth = useAuth(player.provider, player.loadNextTrack, player.setError);
  const reco = useReco(player.playSearch, player.setError);
  const theme = useTheme();
  const deezerEditorials = useDeezerEditorials();

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
          />
          <LyricsCard
            lyrics={lyrics.lyrics}
            currentTime={player.currentTime}
            loading={lyrics.loading}
            onSeek={player.seek}
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
    </div>
  );
}

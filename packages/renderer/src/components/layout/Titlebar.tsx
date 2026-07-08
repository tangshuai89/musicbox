import type { DeezerEditorial, MusicProvider, QqQuality } from '../../api';
import SourceMenu from './SourceMenu';
import QualityMenu from './QualityMenu';
import DeezerPresetSelect from './DeezerPresetSelect';

interface Props {
  provider: MusicProvider;
  onSwitchProvider: (p: MusicProvider) => void;
  // Deezer preset
  deezerEditorials: DeezerEditorial[];
  deezerPreset: string;
  onChangeDeezerPreset: (p: string) => void;
  // Search
  onOpenSearch: () => void;
  // Reco
  recoStatus: { configured: boolean } | null;
  recoRunning: boolean;
  onReco: () => void;
  // Quality
  qqQuality: QqQuality;
  onChangeQuality: (q: QqQuality) => void;
  // Auth
  loggedIn: boolean;
  loggingIn: boolean;
  accountName: string | undefined;
  onLogin: () => void;
  onAccount: () => void;
  // Reset
  onReset: () => void;
}

/**
 * The top window bar. Left→right: source switch, provider-specific controls
 * (deezer preset / search / reco / quality), then auth + reset pushed right
 * (via margin-left:auto on .login-btn / .account-btn). The bar itself is the
 * macOS drag region.
 */
export default function Titlebar({
  provider,
  onSwitchProvider,
  deezerEditorials,
  deezerPreset,
  onChangeDeezerPreset,
  onOpenSearch,
  recoStatus,
  recoRunning,
  onReco,
  qqQuality,
  onChangeQuality,
  loggedIn,
  loggingIn,
  accountName,
  onLogin,
  onAccount,
  onReset,
}: Props) {
  const showQuality =
    (provider === 'qq' || provider === 'netease') && loggedIn;

  return (
    <div className="titlebar">
      <SourceMenu provider={provider} onSelect={onSwitchProvider} />

      {provider === 'deezer' && deezerEditorials.length > 0 && (
        <DeezerPresetSelect
          editorials={deezerEditorials}
          value={deezerPreset}
          onChange={onChangeDeezerPreset}
        />
      )}

      <button
        className="titlebar-btn search-btn"
        onClick={onOpenSearch}
        title="搜索歌手 / 歌名（跨平台统一搜索）"
      >
        🔍 搜索
      </button>

      <button
        className="titlebar-btn reco-btn"
        onClick={onReco}
        disabled={recoRunning}
        title={
          recoStatus?.configured
            ? '基于你的统一库推荐新歌'
            : '设置 DeepSeek API key 后基于你的统一库推荐新歌'
        }
      >
        {recoRunning ? '…' : '🎲 推荐'}
        {recoStatus && !recoStatus.configured && (
          <span className="reco-key-dot" aria-hidden="true" />
        )}
      </button>

      {showQuality && (
        <QualityMenu quality={qqQuality} onSelect={onChangeQuality} />
      )}

      {loggedIn ? null : (
        <button
          className="titlebar-btn login-btn"
          onClick={onLogin}
          disabled={loggingIn}
        >
          {loggingIn ? '登录中…' : '登录'}
        </button>
      )}

      {loggedIn && (
        <button
          className="titlebar-btn account-btn"
          onClick={onAccount}
          title={provider === 'deezer' ? '切换音源' : '退出登录'}
        >
          {accountName || 'User'}
        </button>
      )}

      <button
        className="titlebar-btn reset-btn"
        onClick={onReset}
        title="清空本地缓存（localStorage + sessionStorage + 当前曲目）"
      >
        ↺
      </button>
    </div>
  );
}

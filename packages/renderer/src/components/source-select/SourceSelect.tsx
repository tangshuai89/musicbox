import type { MusicProvider } from '../../api';

interface SourceSelectProps {
  onSelect: (provider: MusicProvider) => void;
}

const SOURCES: {
  provider: MusicProvider;
  name: string;
  desc: string;
  className: string;
  initial: string;
  /** Disabled sources still render but can't be clicked. */
  disabled?: boolean;
  disabledReason?: string;
}[] = [
  {
    provider: 'netease',
    name: '网易云音乐',
    desc: '私人 FM 电台 · 手机扫码登录',
    className: 'source-netease',
    initial: '云',
  },
  {
    provider: 'qq',
    name: 'QQ 音乐',
    desc: '登录后可搜索 + 播全曲（桌面扫码登录）',
    className: 'source-qq',
    initial: 'Q',
  },
  {
    provider: 'deezer',
    name: 'Deezer',
    desc: '国际公开电台 · 30s 预览 · 无需登录',
    className: 'source-deezer',
    initial: 'D',
  },
];

export default function SourceSelect({ onSelect }: SourceSelectProps) {
  return (
    <div className="source-select">
      <div className="source-titlebar" />
      <div className="source-heading">
        <div className="source-title">选择音乐来源</div>
        <div className="source-subtitle">挑一个音源，开始你的电台</div>
      </div>
      <div className="source-list">
        {SOURCES.map((s) => (
          <button
            key={s.provider}
            className={`source-card ${s.className}${s.disabled ? ' source-card-disabled' : ''}`}
            onClick={() => {
              if (s.disabled) return;
              onSelect(s.provider);
            }}
            disabled={s.disabled}
            title={s.disabledReason ?? ''}
          >
            <div className="source-logo">{s.initial}</div>
            <div className="source-meta">
              <div className="source-name">{s.name}</div>
              <div className="source-desc">{s.desc}</div>
            </div>
            <svg
              className="source-arrow"
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="currentColor"
            >
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

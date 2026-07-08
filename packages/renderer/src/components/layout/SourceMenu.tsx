import { useState } from 'react';
import { PROVIDER_LABELS } from '../../api';
import type { MusicProvider } from '../../api';

interface Props {
  provider: MusicProvider;
  onSelect: (next: MusicProvider) => void;
}

const SELECTABLE: MusicProvider[] = ['qq', 'netease', 'deezer'];

/** Source-switch pill + its dropdown. Owns its own open state; a transparent
 *  fixed backdrop catches outside clicks without interrupting playback. */
export default function SourceMenu({ provider, onSelect }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="source-switch-wrap">
      <button
        className="titlebar-btn source-switch"
        onClick={() => setOpen((v) => !v)}
        title="切换音源"
      >
        {PROVIDER_LABELS[provider]}
        <span className="source-switch-icon">⇄</span>
      </button>

      {open && (
        <>
          <div className="source-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="source-menu" role="menu">
            {SELECTABLE.map((p) => (
              <button
                key={p}
                className={`source-menu-item${
                  p === provider ? ' source-menu-item--active' : ''
                }`}
                onClick={() => {
                  onSelect(p);
                  setOpen(false);
                }}
                role="menuitem"
              >
                <span className="source-menu-check">{p === provider ? '✓' : ''}</span>
                <span className="source-menu-label">{PROVIDER_LABELS[p]}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

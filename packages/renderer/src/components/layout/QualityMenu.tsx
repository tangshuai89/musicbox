import { useState } from 'react';
import { QQ_QUALITY_LABELS } from '../../api';
import type { QqQuality } from '../../api';

interface Props {
  quality: QqQuality;
  onSelect: (q: QqQuality) => void;
}

const QUALITIES: QqQuality[] = ['standard', 'high', 'lossless'];

/** Stream-quality picker (QQ / NetEase). Right-aligned dropdown so it doesn't
 *  overflow the window edge. Owns its own open state. */
export default function QualityMenu({ quality, onSelect }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="quality-wrap">
      <button
        className="titlebar-btn"
        onClick={() => setOpen((v) => !v)}
        title="音质（无损需会员）"
      >
        {QQ_QUALITY_LABELS[quality]}
      </button>
      {open && (
        <>
          <div className="source-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="source-menu source-menu--right" role="menu">
            {QUALITIES.map((q) => (
              <button
                key={q}
                className={`source-menu-item${
                  q === quality ? ' source-menu-item--active' : ''
                }`}
                onClick={() => {
                  onSelect(q);
                  setOpen(false);
                }}
                role="menuitem"
              >
                <span className="source-menu-check">{q === quality ? '✓' : ''}</span>
                <span className="source-menu-label">{QQ_QUALITY_LABELS[q]}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

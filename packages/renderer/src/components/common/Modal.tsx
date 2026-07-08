import type { MouseEvent, ReactNode } from 'react';

interface Props {
  onClose: () => void;
  /** Extra class on the panel (e.g. width overrides for a specific modal). */
  panelClassName?: string;
  children: ReactNode;
}

/**
 * Shared overlay + panel shell for the search / reco-key dialogs. Clicking
 * the scrim closes; clicks inside the panel are stopped so they don't bubble
 * to the scrim. The frosted-dark look lives in components/_modal.scss.
 */
export default function Modal({ onClose, panelClassName, children }: Props) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-panel${panelClassName ? ` ${panelClassName}` : ''}`}
        onClick={stop}
      >
        {children}
      </div>
    </div>
  );
}

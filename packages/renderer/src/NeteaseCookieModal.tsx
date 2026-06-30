import { useState } from 'react';
import type { AuthUser } from './api';
import { loginNeteaseCookie } from './api';
import './NeteaseCookieModal.css';

interface Props {
  onSuccess: (user: AuthUser) => void;
  onClose: () => void;
}

/**
 * 网易云 Cookie 兜底登录弹窗——只在浏览器调试（非 Electron）时使用。
 * Electron 包走的是 main 进程的内嵌登录窗口，自动捕获 MUSIC_U，不需要
 * 这里。
 */
export default function NeteaseCookieModal({ onSuccess, onClose }: Props) {
  const [musicU, setMusicU] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!musicU.trim()) {
      setError('请粘贴 MUSIC_U');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const r = await loginNeteaseCookie(
        musicU.trim(),
        csrfToken.trim() || undefined,
      );
      if (r.success) {
        onSuccess(r.user);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="qr-modal-overlay" onClick={onClose}>
      <div className="qr-modal" onClick={(e) => e.stopPropagation()}>
        <button className="qr-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <h3 className="qr-title">网易云登录（浏览器模式）</h3>
        <p className="qr-help" style={{ marginTop: 0, marginBottom: 12 }}>
          在桌面 app 中本步骤是自动的。这里只是浏览器调试时的兜底。
        </p>

        {error && <div className="qr-error">{error}</div>}

        <div className="qr-cookie-form">
          <label className="qr-field-label">
            MUSIC_U <span className="qr-required">*</span>
          </label>
          <input
            className="qr-input"
            placeholder="从 music.163.com DevTools 复制"
            value={musicU}
            onChange={(e) => setMusicU(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <label className="qr-field-label">
            __csrf <span className="qr-optional">(可选)</span>
          </label>
          <input
            className="qr-input"
            placeholder="同一来源，可不填"
            value={csrfToken}
            onChange={(e) => setCsrfToken(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="qr-help">
            浏览器登录 <a href="https://music.163.com" target="_blank" rel="noreferrer">music.163.com</a> →
            DevTools → Application → Cookies → 复制 <code>MUSIC_U</code> 的值
          </div>
          <button
            className="qr-submit"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? '验证中…' : '登录'}
          </button>
        </div>
      </div>
    </div>
  );
}
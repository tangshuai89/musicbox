import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthUser } from './api';
import { checkNeteaseQr, loginNeteaseCookie, startNeteaseQr } from './api';
import './NeteaseCookieModal.css';

interface Props {
  onSuccess: (user: AuthUser) => void;
  onClose: () => void;
}

const POLL_MS = 1500;

/**
 * 网易云扫码登录弹窗。
 *
 * 服务端生成二维码（/auth/netease/qr/start），手机网易云 App 扫码确认后，
 * 轮询 /auth/netease/qr/check 拿到 803 即登录成功（cookie 已入服务端
 * session）。底部保留手动粘贴 MUSIC_U 的兜底入口。
 */
export default function NeteaseCookieModal({ onSuccess, onClose }: Props) {
  const [qrImg, setQrImg] = useState<string | null>(null);
  const [status, setStatus] = useState('生成二维码中…');
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 手动粘贴 cookie 的兜底
  const [showManual, setShowManual] = useState(false);
  const [musicU, setMusicU] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  // Keep the latest onSuccess in a ref so beginQrFlow doesn't depend on it.
  // onSuccess is a new function on every parent render; if it were a dep, the
  // mount effect would re-run each render, fetch a fresh unikey, and swap the
  // QR image — the code "flashed" constantly and the phone could never finish
  // scanning. With the ref, the QR is generated once and stays stable.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const beginQrFlow = useCallback(async () => {
    setExpired(false);
    setError(null);
    setQrImg(null);
    setStatus('生成二维码中…');
    try {
      const { key, qrImg } = await startNeteaseQr();
      setQrImg(qrImg);
      setStatus('打开手机网易云音乐 App 扫码');

      const poll = async () => {
        if (stoppedRef.current) return;
        try {
          const r = await checkNeteaseQr(key);
          if (r.code === 803 && r.user) {
            setStatus('登录成功');
            onSuccessRef.current(r.user);
            return;
          }
          if (r.code === 800) {
            setExpired(true);
            setStatus('二维码已过期');
            return;
          }
          if (r.code === 802) {
            setStatus('已扫码，请在手机上确认登录');
          }
        } catch (e) {
          setError((e as Error).message);
        }
        timerRef.current = setTimeout(poll, POLL_MS);
      };
      timerRef.current = setTimeout(poll, POLL_MS);
    } catch (e) {
      setError((e as Error).message);
      setStatus('二维码生成失败');
    }
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    void beginQrFlow();
    return () => {
      stoppedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [beginQrFlow]);

  const handleManualSubmit = async () => {
    if (!musicU.trim()) {
      setError('请粘贴 MUSIC_U');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const r = await loginNeteaseCookie(musicU.trim());
      if (r.success) onSuccess(r.user);
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
        <h3 className="qr-title">网易云扫码登录</h3>

        {error && <div className="qr-error">{error}</div>}

        <div className="qr-image-wrap">
          {qrImg ? (
            <img className="qr-image" src={qrImg} alt="网易云登录二维码" />
          ) : (
            <div className="qr-image qr-image--loading" />
          )}
          {expired && (
            <button className="qr-refresh" onClick={() => void beginQrFlow()}>
              刷新二维码
            </button>
          )}
        </div>
        <p className="qr-help">{status}</p>

        {!showManual ? (
          <button
            className="qr-manual-toggle"
            onClick={() => setShowManual(true)}
          >
            扫不了码？手动粘贴 Cookie
          </button>
        ) : (
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
            <div className="qr-help">
              浏览器登录{' '}
              <a href="https://music.163.com" target="_blank" rel="noreferrer">
                music.163.com
              </a>{' '}
              → DevTools → Application → Cookies → 复制 <code>MUSIC_U</code>
            </div>
            <button
              className="qr-submit"
              onClick={handleManualSubmit}
              disabled={submitting}
            >
              {submitting ? '验证中…' : '登录'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

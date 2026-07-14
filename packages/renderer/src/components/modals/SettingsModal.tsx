import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import {
  getStateSnapshot,
  importState,
  triggerBackup,
  getBackupInfo,
} from '../../api';
import {
  encryptBundle,
  decryptBundle,
  generatePassphrase,
  type BackupBundle,
} from '../../lib/backup-crypto';
import { collectLocalStorage, restoreLocalStorage } from '../../lib/storage';

interface Props {
  onClose: () => void;
}

type Status = { kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string };

const APP_VERSION = '1.0.0';

/**
 * 设置弹窗（本轮只做"会话快照 备份/导出/导入"骨架 —— #3.1）。
 * 三块：本地自动备份信息 / 口令加密导出 / 口令解密导入。
 * 敏感 cookie/token 走 AES-GCM，明文只在服务端本地 backups/ 里（用户自己机器）。
 */
export default function SettingsModal({ onClose }: Props) {
  // ── 备份信息 ──
  const [backupDir, setBackupDir] = useState<string>('…');
  const [backupCount, setBackupCount] = useState<number>(0);
  const [backupStatus, setBackupStatus] = useState<Status>({ kind: 'idle' });

  // ── 导出 ──
  const [exportPass, setExportPass] = useState(generatePassphrase());
  const [exportStatus, setExportStatus] = useState<Status>({ kind: 'idle' });

  // ── 导入 ──
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPass, setImportPass] = useState('');
  const [importStatus, setImportStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    void getBackupInfo()
      .then((info) => {
        setBackupDir(info.backupDir);
        setBackupCount(info.backupCount);
      })
      .catch(() => setBackupDir('（无法读取备份目录）'));
  }, []);

  const handleBackupNow = async () => {
    setBackupStatus({ kind: 'busy' });
    try {
      const r = await triggerBackup();
      setBackupCount(r.count);
      setBackupStatus({ kind: 'ok', msg: `已备份 · 共 ${r.count} 份` });
    } catch (e) {
      setBackupStatus({ kind: 'err', msg: (e as Error).message });
    }
  };

  const handleExport = async () => {
    if (!exportPass) {
      setExportStatus({ kind: 'err', msg: '请先设置导出口令' });
      return;
    }
    setExportStatus({ kind: 'busy' });
    try {
      const { stateJson } = await getStateSnapshot();
      const bundle: BackupBundle = {
        manifest: {
          version: 1,
          exportedAt: new Date().toISOString(),
          appVersion: APP_VERSION,
        },
        stateJson,
        localStorage: collectLocalStorage(),
      };
      const blob = await encryptBundle(bundle, exportPass);
      // 触发下载
      const file = new Blob([blob], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `maestro-${stamp}.maestro-backup`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportStatus({
        kind: 'ok',
        msg: '已导出 · 记住口令，导入时需要它',
      });
    } catch (e) {
      setExportStatus({ kind: 'err', msg: (e as Error).message });
    }
  };

  const handleImport = async () => {
    if (!importFile) {
      setImportStatus({ kind: 'err', msg: '请先选择备份文件' });
      return;
    }
    if (!importPass) {
      setImportStatus({ kind: 'err', msg: '请输入导出时设置的口令' });
      return;
    }
    setImportStatus({ kind: 'busy' });
    try {
      const text = await importFile.text();
      const bundle = await decryptBundle(text, importPass);
      const { merged } = await importState(bundle.stateJson);
      restoreLocalStorage(bundle.localStorage);
      setImportStatus({
        kind: 'ok',
        msg: `已合并 ${merged.length} 项 · 重启 App 生效`,
      });
    } catch (e) {
      setImportStatus({ kind: 'err', msg: (e as Error).message });
    }
  };

  return (
    <Modal onClose={onClose} panelClassName="settings-modal-panel">
      <div className="settings-modal-header">
        <span className="settings-modal-title">设置</span>
        <button
          className="settings-modal-close"
          onClick={onClose}
          aria-label="关闭"
        >
          ×
        </button>
      </div>

      <div className="settings-modal-body">
        {/* ── 本地自动备份 ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">本地自动备份</h3>
          <p className="settings-section-hint">
            每天自动把登录态与红心库备份到本地目录，保留最近 7 份。
          </p>
          <div className="settings-path" title={backupDir}>
            {backupDir}
          </div>
          <div className="settings-actions">
            <button
              className="settings-btn"
              onClick={() => void handleBackupNow()}
              disabled={backupStatus.kind === 'busy'}
            >
              {backupStatus.kind === 'busy' ? '备份中…' : '立即备份'}
            </button>
            <span className="settings-count">当前 {backupCount} 份</span>
          </div>
          <StatusLine status={backupStatus} />
        </section>

        {/* ── 导出 ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">导出会话快照</h3>
          <p className="settings-section-hint">
            导出登录态、红心库与偏好为一个加密文件（含各平台 cookie / token，
            务必设口令）。换电脑或重装后可导入恢复。
          </p>
          <label className="settings-label">口令</label>
          <div className="settings-pass-row">
            <input
              type="text"
              className="settings-input"
              value={exportPass}
              onChange={(e) => setExportPass(e.target.value)}
            />
            <button
              className="settings-btn-ghost"
              onClick={() => setExportPass(generatePassphrase())}
              title="重新生成"
            >
              ↻
            </button>
          </div>
          <div className="settings-actions">
            <button
              className="settings-btn settings-btn-primary"
              onClick={() => void handleExport()}
              disabled={exportStatus.kind === 'busy'}
            >
              {exportStatus.kind === 'busy' ? '导出中…' : '导出加密快照'}
            </button>
          </div>
          <StatusLine status={exportStatus} />
        </section>

        {/* ── 导入 ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">导入并合并</h3>
          <p className="settings-section-hint">
            导入不会覆盖当前已有的红心与登录态，只补充缺失的。导入后重启 App 生效。
          </p>
          <input
            type="file"
            accept=".maestro-backup,application/octet-stream"
            className="settings-file"
            onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
          />
          <label className="settings-label">口令</label>
          <input
            type="password"
            className="settings-input"
            placeholder="导出时设置的口令"
            value={importPass}
            onChange={(e) => setImportPass(e.target.value)}
          />
          <div className="settings-actions">
            <button
              className="settings-btn"
              onClick={() => void handleImport()}
              disabled={importStatus.kind === 'busy'}
            >
              {importStatus.kind === 'busy' ? '导入中…' : '导入并合并'}
            </button>
          </div>
          <StatusLine status={importStatus} />
        </section>
      </div>
    </Modal>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle' || status.kind === 'busy') return null;
  return (
    <div
      className={`settings-status settings-status--${status.kind}`}
      role="status"
    >
      {status.msg}
    </div>
  );
}

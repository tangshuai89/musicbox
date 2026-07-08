import { useState } from 'react';
import Modal from '../common/Modal';

interface Props {
  onSave: (key: string) => void;
  onClose: () => void;
}

/**
 * DeepSeek key 输入弹窗。用共享的 Modal 外壳 + 独立的 .reco-modal-* 类
 * （不再借用 .search-* 类名，也不再写内联样式）。留 DeepSeek 平台链接让用户
 * 去申请 key；key 存本地不外发。
 */
export default function RecoKeyModal({ onSave, onClose }: Props) {
  const [key, setKey] = useState('');

  return (
    <Modal onClose={onClose}>
      <div className="reco-modal-header">
        <span className="reco-modal-title">设置 DeepSeek API Key</span>
        <button className="reco-modal-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      <div className="reco-modal-body">
        <p className="reco-modal-hint">
          需要 DeepSeek API key 才能用 AI 推荐。没账号先去{' '}
          <a
            className="reco-modal-link"
            href="https://platform.deepseek.com"
            target="_blank"
            rel="noreferrer"
          >
            platform.deepseek.com
          </a>{' '}
          申请一个，存到本地不外发。
        </p>
        <input
          autoFocus
          type="password"
          className="reco-modal-input"
          placeholder="sk-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave(key);
          }}
        />
        <div className="reco-modal-actions">
          <button
            className="reco-modal-save"
            onClick={() => onSave(key)}
            disabled={!key || key.length < 8}
          >
            保存
          </button>
          <button className="reco-modal-cancel" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </Modal>
  );
}

import { useState } from 'react';

/**
 * 极简 DeepSeek key 输入弹窗。
 * 故意做成内联组件：只有"输入 + 保存"两步，单独抽文件不值。
 * 留 "DeepSeek 平台" 链接让用户去申请 key。
 *
 * ⚠️ 内联在 App.tsx 里时每次 App 渲染都会重建；React DevTools 看不到
 * displayName，且 React 没法 memoize。抽成独立文件后可以 React.memo。
 */
export default function RecoKeyModal({
  onSave,
  onClose,
}: {
  onSave: (key: string) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState('');
  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-bar">
          <span style={{ flex: 1, fontSize: 14, color: '#f2f2f5' }}>
            设置 DeepSeek API Key
          </span>
          <button className="search-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div style={{ padding: '16px 14px' }}>
          <p style={{ fontSize: 12, color: '#9a9aa2', margin: '0 0 10px' }}>
            需要 DeepSeek API key 才能用 AI 推荐。
            没账号先去{' '}
            <a
              href="https://platform.deepseek.com"
              target="_blank"
              rel="noreferrer"
              style={{ color: '#31c27c' }}
            >
              platform.deepseek.com
            </a>{' '}
            申请一个，存到本地不外发。
          </p>
          <input
            autoFocus
            type="password"
            className="search-input"
            placeholder="sk-..."
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave(key);
            }}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="search-go"
              onClick={() => onSave(key)}
              disabled={!key || key.length < 8}
            >
              保存
            </button>
            <button
              className="search-close"
              onClick={onClose}
              style={{ width: 'auto', padding: '0 14px' }}
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

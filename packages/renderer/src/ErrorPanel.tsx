import { useState } from 'react';
import './ErrorPanel.css';

interface Props {
  message: string;
  onClose: () => void;
}

/**
 * 可展开的错误面板——始终显示一行摘要，点击展开完整文本（等宽字体、
 * 自动换行），带复制按钮与关闭按钮。调试 NetEase 扫码登录 / OAuth 这种
 * 长错误信息必备。
 */
export default function ErrorPanel({ message, onClose }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const firstLine = message.split('\n')[0].slice(0, 120);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard 不可用时降级：什么都不做
    }
  };

  return (
    <div className={`error-panel ${expanded ? 'expanded' : ''}`}>
      <button
        className="error-summary"
        onClick={() => setExpanded((v) => !v)}
        title="点击查看完整错误"
      >
        <span className="error-icon">⚠</span>
        <span className="error-summary-text">{firstLine}</span>
        <span className="error-toggle">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="error-detail">
          <pre className="error-pre">{message}</pre>
          <div className="error-actions">
            <button
              className="error-action"
              onClick={handleCopy}
              title="复制完整错误信息"
            >
              {copied ? '已复制 ✓' : '复制'}
            </button>
            <button className="error-action" onClick={onClose} title="关闭">
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
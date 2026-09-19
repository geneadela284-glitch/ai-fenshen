import { healthMessageDisplay } from './healthMessage.js';
import { HEALTH_ENABLED } from './healthFeature.js';
import { diaryMessageDisplay } from './diaryMessage.js';
import { DIARY_ENABLED } from './diaryFeature.js';
import DocumentContent from './DocumentContent.jsx';
import { decodeDocumentMessage } from '../../../../../core/documentQa/contract.js';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import { attachmentContentUrl } from './attachmentClient.js';
import { parseSafeMarkdown } from './safeMarkdown.js';

function InlineContent({ inlines }) {
  return inlines.map((part, index) => {
    const key = `${part.type}-${index}`;
    if (part.type === 'strong') return <strong key={key}>{part.value}</strong>;
    if (part.type === 'emphasis') return <em key={key}>{part.value}</em>;
    if (part.type === 'code') return <code key={key}>{part.value}</code>;
    return <span key={key}>{part.value}</span>;
  });
}

function MessageContent({ content }) {
  const blocks = parseSafeMarkdown(content);
  return (
    <div className="af-message-content">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === 'heading') {
          const Heading = `h${block.level}`;
          return <Heading key={key}><InlineContent inlines={block.inlines} /></Heading>;
        }
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return <List key={key}>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}><InlineContent inlines={item} /></li>)}</List>;
        }
        if (block.type === 'codeBlock') return <pre key={key}><code data-language={block.language || undefined}>{block.content}</code></pre>;
        if (block.type === 'rule') return <hr key={key} />;
        return <p key={key}><InlineContent inlines={block.inlines} /></p>;
      })}
    </div>
  );
}

const ATTACHMENT_STATUS = Object.freeze({
  uploading: '上传中',
  ready_for_processing: '等待处理',
  processing_ocr: '正在读取文字',
  processing_vision: '正在理解画面',
  merging_evidence: '正在整理证据',
  processing: '处理中',
  processed: '处理完成',
  processed_partial: '部分完成',
  processing_failed: '处理失败',
  failed: '处理失败',
  expired: '已过期',
  deleted: '已删除'
});

function AttachmentGallery({ attachments, onDeleteAttachment }) {
  const [preview, setPreview] = useState(null);
  const touchStartRef = useRef(null);
  const requestPreviewClose = () => {
    if (!preview) return;
    if (window.history.state?.afAttachmentPreview === preview.historyKey) {
      window.history.back();
      return;
    }
    setPreview(null);
  };

  useEffect(() => {
    if (!preview) return undefined;
    const previousOverflow = document.body.style.overflow;
    let previewHistoryActive = true;
    document.body.style.overflow = 'hidden';
    window.history.pushState({
      ...(window.history.state || {}),
      afAttachmentPreview: preview.historyKey
    }, '');
    const closeFromNavigation = () => {
      previewHistoryActive = false;
      setPreview(null);
    };
    const closeFromKeyboard = (event) => {
      if (event.key === 'Escape') requestPreviewClose();
    };
    window.addEventListener('popstate', closeFromNavigation);
    window.addEventListener('keydown', closeFromKeyboard);
    return () => {
      window.removeEventListener('popstate', closeFromNavigation);
      window.removeEventListener('keydown', closeFromKeyboard);
      document.body.style.overflow = previousOverflow;
      if (previewHistoryActive &&
          window.history.state?.afAttachmentPreview === preview.historyKey) {
        window.history.back();
      }
    };
  }, [preview?.historyKey]);

  useEffect(() => {
    if (!preview) return;
    const current = attachments.find((attachment) =>
      (attachment.attachmentId || attachment.id) === preview.attachmentId
    );
    if (!current || ['deleted', 'expired'].includes(current.processingState)) {
      requestPreviewClose();
    }
  }, [attachments, preview?.attachmentId]);

  if (!attachments.length) return null;
  return (
    <>
      <div className={`af-message-attachments ${attachments.length === 1 ? 'is-single' : 'is-grid'}`} aria-label="消息图片">
        {attachments.map((attachment, index) => {
          const attachmentId = attachment.attachmentId || attachment.id;
          const unavailable = ['deleted', 'expired'].includes(attachment.processingState);
          const source = unavailable
            ? ''
            : attachment.previewUrl || (attachmentId ? attachmentContentUrl(attachmentId) : '');
          const name = attachment.originalFilename || attachment.name || `图片${index + 1}`;
          return (
            <div className="af-message-image-card" key={attachmentId || name}>
              <button
                className="af-message-image-open"
                type="button"
                disabled={!source}
                onClick={() => setPreview({
                  attachmentId,
                  source,
                  name,
                  historyKey: `${attachmentId || 'image'}-${Date.now()}`
                })}
                aria-label={`预览${name}`}
              >
                {source ? <img src={source} alt="" loading="lazy" /> : <Icon name="photo" size={24} />}
              </button>
              <div>
                <strong>图片{index + 1}</strong>
                <small>{ATTACHMENT_STATUS[attachment.processingState] || '已发送'}</small>
              </div>
              {attachmentId && !unavailable ? (
                <button
                  className="af-message-image-delete"
                  type="button"
                  onClick={() => {
                    if (preview?.attachmentId === attachmentId) requestPreviewClose();
                    onDeleteAttachment?.(attachmentId);
                  }}
                  aria-label={`删除${name}`}
                ><Icon name="trash" size={16} /></button>
              ) : null}
            </div>
          );
        })}
      </div>
      {preview && typeof document !== 'undefined' ? createPortal((
        <div
          className="af-image-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onClick={(event) => {
            if (event.target === event.currentTarget) requestPreviewClose();
          }}
          onTouchStart={(event) => {
            if (event.touches.length !== 1) {
              touchStartRef.current = null;
              return;
            }
            touchStartRef.current = {
              x: event.touches[0].clientX,
              y: event.touches[0].clientY
            };
          }}
          onTouchEnd={(event) => {
            const start = touchStartRef.current;
            touchStartRef.current = null;
            if (!start || event.changedTouches.length !== 1) return;
            const deltaX = event.changedTouches[0].clientX - start.x;
            const deltaY = event.changedTouches[0].clientY - start.y;
            if (deltaY >= 80 && Math.abs(deltaX) <= deltaY * 0.75) requestPreviewClose();
          }}
        >
          <button type="button" className="af-image-preview-close" onClick={requestPreviewClose} aria-label="关闭图片预览"><Icon name="x" size={22} /></button>
          <img src={preview.source} alt={preview.name} draggable="false" />
        </div>
      ), document.body) : null}
    </>
  );
}

function AttachmentEvidence({ result }) {
  if (!result) return null;
  const partial = result.status === 'processed_partial';
  const failed = result.status === 'processing_failed';
  const refs = Array.isArray(result.evidenceRefs) ? result.evidenceRefs : [];
  const limitations = Array.isArray(result.limitations) ? result.limitations : [];
  const safeLimitations = [...new Set(limitations.map((value) => {
    const code = String(value || '').toUpperCase();
    if (code.includes('WHITESPACE') || code.includes('LAYOUT') || code.includes('SPACING')) {
      return '空格或版式可能丢失';
    }
    if (code.includes('OCR') || code.includes('TEXT')) return '文字识别未完整完成';
    if (code.includes('VISION') || code.includes('IMAGE')) return '画面分析未完整完成';
    if (code.includes('LOW') || code.includes('QUALITY')) return '图片质量可能影响结果';
    return '部分证据存在限制';
  }))];
  return (
    <div className={`af-attachment-evidence ${partial ? 'is-partial' : ''} ${failed ? 'is-failed' : ''}`}>
      {partial ? <strong>部分识别完成</strong> : null}
      {failed ? <strong>图片处理失败，未生成未经证实的回答。</strong> : null}
      {refs.length ? (
        <div className="af-evidence-tags">
          {refs.map((ref, index) => (
            <span key={`${ref.type || 'image'}-${index}`}>
              {ref.type === 'ocr' ? 'OCR文字' : '画面分析'}
            </span>
          ))}
        </div>
      ) : null}
      {safeLimitations.length ? <small>限制：{safeLimitations.join('；')}</small> : null}
    </div>
  );
}

export default function ChatMessage({ message, onRetry, onDeleteAttachment }) {
  const diary = DIARY_ENABLED && message.role === 'assistant' ? diaryMessageDisplay(message.content) : null;
  const health = message.role === 'assistant' ? healthMessageDisplay(diary ? diary.text : message.content) : null;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return (
    <article className={`af-message is-${message.role} is-${message.status || 'complete'}`} data-message-status={message.status}>
      <div className="af-message-label">{message.role === 'user' ? '你' : 'AI分身'}</div>
      <AttachmentGallery attachments={attachments} onDeleteAttachment={onDeleteAttachment} />
      {decodeDocumentMessage(message.content) ? <DocumentContent content={message.content} /> : <MessageContent content={health ? health.text : diary ? diary.text : message.content} />}
      {diary?.ids.map((id,index) => <a key={id} className="af-diary-source-link" href={`/#diary=${id}`}>查看日记{diary.ids.length>1 ? ` ${index+1}` : ''} →</a>)}
      {health?.ids.map(id => <a key={id} className="af-diary-source-link" href={`/#health=${id}`}>查看健康记录 →</a>)}
      <AttachmentEvidence result={message.attachmentResult} />
      {message.status === 'streaming' ? <span className="af-streaming-caret" aria-label="正在生成" /> : null}
      {message.status === 'stopped' ? <small className="af-message-status">已停止生成</small> : null}
      {message.voiceDelivery?.status === 'interrupted' ? <small className="af-message-status">语音播报已中断，文字保留在这里</small> : null}
      {message.status === 'error' ? (
        <div className="af-message-error" role="alert">
          <span>回复中断，请重试。</span>
          <button type="button" onClick={() => onRetry?.(message.id)}><Icon name="refresh" size={16} />重试</button>
        </div>
      ) : null}
    </article>
  );
}

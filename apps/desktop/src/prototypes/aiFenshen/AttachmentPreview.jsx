import Icon from './Icon.jsx';

const STATUS_LABELS = Object.freeze({
  selected: '待上传',
  uploading: '上传中',
  uploaded: '已上传',
  validating: '校验中',
  ready_for_processing: '等待处理',
  processing: '识别中',
  processed: '已完成',
  processed_partial: '部分完成',
  rejected: '已拒绝',
  failed: '失败',
  expired: '已过期',
  deleted: '已删除'
});

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default function AttachmentPreview({ attachments, onRemove }) {
  if (!attachments.length) return null;
  return (
    <div className="af-attachments" aria-label="已选择的附件">
      {attachments.map((attachment) => (
        <div className="af-attachment-chip" key={attachment.id}>
          {attachment.previewUrl ? <span className="af-image-thumb" style={{ backgroundImage: `url(${attachment.previewUrl})` }} aria-hidden="true" /> : <Icon name="photo" size={18} />}
          <span className="af-attachment-chip-copy">
            <strong>{attachment.name}</strong>
            <small>{formatBytes(attachment.size)} · {STATUS_LABELS[attachment.status] || '待处理'}</small>
          </span>
          <button
            type="button"
            onClick={() => onRemove?.(attachment.id)}
            disabled={attachment.status === 'uploading'}
            aria-label={`移除${attachment.name}`}
          ><Icon name="x" size={16} /></button>
        </div>
      ))}
    </div>
  );
}

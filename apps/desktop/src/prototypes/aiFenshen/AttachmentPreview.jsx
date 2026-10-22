import { AttachmentGallery } from './ChatMessage.jsx';
import AttachmentProgress from './AttachmentProgress.jsx';

export default function AttachmentPreview({ attachments, onRemove }) {
  if (!attachments.length) return null;
  const uploading = attachments.some(attachment => attachment.status === 'uploading');
  return <div className="af-attachment-selection" aria-label="已选择的附件">
    <AttachmentGallery attachments={attachments} onDeleteAttachment={onRemove} variant="draft" />
    {uploading ? <AttachmentProgress progress={{ stage: 'uploading' }} /> : null}
  </div>;
}

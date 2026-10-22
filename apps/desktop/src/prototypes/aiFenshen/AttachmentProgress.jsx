import { attachmentProgressLabel } from './attachmentProgress.js';
export default function AttachmentProgress({ progress }) {
  if (!progress) return null;
  return <div className="af-image-progress" role="status" aria-live="polite" aria-atomic="true">
    <span className="af-image-progress-spinner" aria-hidden="true" />
    <span>{attachmentProgressLabel(progress)}</span>
  </div>;
}

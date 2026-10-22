const LABELS = Object.freeze({
  uploading: '正在上传图片',
  ready_for_processing: '图片已上传，等待处理',
  processing_ocr: '正在读取图片文字',
  processing_vision: '正在理解图片',
  merging_evidence: '正在整理回答'
});
export function isAttachmentStage(stage) {
  return Object.hasOwn(LABELS, stage);
}
export function attachmentProgressLabel(progress) {
  const label = LABELS[progress?.stage] || '正在处理图片';
  if (progress?.stage === 'processing_ocr' && Number.isInteger(progress.totalImages) && progress.totalImages > 1 &&
      Number.isInteger(progress.completedImages) && progress.completedImages >= 0 && progress.completedImages <= progress.totalImages) {
    return `${label} · 已处理 ${progress.completedImages}/${progress.totalImages} 张`;
  }
  return label;
}

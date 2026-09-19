export function submitComposerMessage({
  draft,
  attachments = [],
  isSending,
  input,
  activeElement,
  clearDraft,
  sendMessage
}) {
  const draftContent = String(draft || '').trim();
  const content = draftContent || (
    attachments.length === 1
      ? '请描述这张图片的主要内容。'
      : attachments.length > 1
        ? '请概括这些图片，并说明主要区别。'
        : ''
  );
  if ((!content && attachments.length === 0) || isSending) return false;

  clearDraft?.();
  input?.blur?.();
  activeElement?.blur?.();
  sendMessage?.(content, attachments);
  return true;
}

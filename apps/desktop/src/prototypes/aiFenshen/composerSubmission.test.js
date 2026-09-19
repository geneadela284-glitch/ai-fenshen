import assert from 'node:assert/strict';
import test from 'node:test';

async function loadSubmission() {
  try {
    return await import('./composerSubmission.js');
  } catch {
    return null;
  }
}

test('valid submit clears and blurs before handing the message to chat logic', async () => {
  const subject = await loadSubmission();
  assert.equal(typeof subject?.submitComposerMessage, 'function');

  const calls = [];
  const result = subject.submitComposerMessage({
    draft: '  今天的进度  ',
    attachments: [],
    isSending: false,
    input: { blur: () => calls.push('input.blur') },
    activeElement: { blur: () => calls.push('active.blur') },
    clearDraft: () => calls.push('clear'),
    sendMessage: (content) => calls.push(`send:${content}`)
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ['clear', 'input.blur', 'active.blur', 'send:今天的进度']);
});

test('invalid or streaming submit does not clear, blur, or send', async () => {
  const { submitComposerMessage } = await import('./composerSubmission.js');
  const calls = [];
  const dependencies = {
    attachments: [],
    input: { blur: () => calls.push('blur') },
    clearDraft: () => calls.push('clear'),
    sendMessage: () => calls.push('send')
  };

  assert.equal(submitComposerMessage({ ...dependencies, draft: '   ', isSending: false }), false);
  assert.equal(submitComposerMessage({ ...dependencies, draft: '内容', isSending: true }), false);
  assert.deepEqual(calls, []);
});

test('attachment-only submit shows the deterministic default question and preserves the queue for upload', async () => {
  const { submitComposerMessage } = await import('./composerSubmission.js');
  const sent = [];
  const attachments = [{ id: 'file-1', status: 'selected' }];

  const result = submitComposerMessage({
    draft: '',
    attachments,
    isSending: false,
    input: null,
    activeElement: null,
    clearDraft: () => {},
    sendMessage: (content, submittedAttachments) => sent.push({
      content,
      attachments: submittedAttachments
    })
  });

  assert.equal(result, true);
  assert.deepEqual(sent, [{
    content: '请描述这张图片的主要内容。',
    attachments
  }]);
});

test('multiple attachment-only submit uses the visible comparison question', async () => {
  const { submitComposerMessage } = await import('./composerSubmission.js');
  const sent = [];
  submitComposerMessage({
    draft: '',
    attachments: [{ id: 'one' }, { id: 'two' }],
    isSending: false,
    clearDraft: () => {},
    sendMessage: (content) => sent.push(content)
  });
  assert.deepEqual(sent, ['请概括这些图片，并说明主要区别。']);
});

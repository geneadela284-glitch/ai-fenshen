import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDictationDraft } from './dictationDraft.js';

test('dictation only updates the editable composer draft and never sends it', () => {
  assert.equal(mergeDictationDraft('', ' AI分身 '), 'AI分身');
  assert.equal(mergeDictationDraft('已有文字', '今天下午三点'), '已有文字\n今天下午三点');
  assert.equal(mergeDictationDraft('已有文字', '   '), '已有文字');
});

test('dictation appends without trimming away the existing draft spacing', () => {
  assert.equal(mergeDictationDraft('已有文字 ', '继续'), '已有文字 \n继续');
  assert.equal(mergeDictationDraft('已有文字\n', '继续'), '已有文字\n继续');
  assert.equal(mergeDictationDraft('  ', '继续'), '继续');
});

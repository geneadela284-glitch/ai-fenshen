import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentDirectory = new URL('./', import.meta.url);

async function source(name) {
  return readFile(new URL(name, componentDirectory), 'utf8');
}

async function optionalSource(name) {
  try {
    return await source(name);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return '';
  }
}

function visibleStaticSurface(componentSource) {
  const textNodes = [...componentSource.matchAll(/>([^<>{}]+)</g)].map((match) => match[1]);
  const labelledAttributes = [...componentSource.matchAll(/\b(?:aria-label|placeholder|title)=["']([^"']+)["']/g)]
    .map((match) => match[1]);
  return [...textNodes, ...labelledAttributes].join('\n');
}

function assertSafeVisibleVocabulary(componentSource) {
  const visibleSurface = visibleStaticSurface(componentSource);
  for (const forbidden of [
    'Provider',
    'CAS',
    'revision',
    'database',
    'db',
    'hash',
    'fingerprint',
    'ownerId',
    'owner',
    'key',
    '密钥',
    'API Key',
    'Manager',
    'Store',
    'Backend',
    '审计JSON',
    '原始JSON',
    '技术字段',
    '内部编号'
  ]) {
    const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const asciiWord = /^[A-Za-z][A-Za-z\s]*$/.test(forbidden);
    const pattern = asciiWord
      ? new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`, 'i')
      : new RegExp(escaped, 'i');
    assert.doesNotMatch(visibleSurface, pattern, `visible surface leaked ${forbidden}`);
  }
}

test('speaker management presentation keeps the approved safe and accessible surface', async () => {
  const [timeline, history, css] = await Promise.all([
    source('SpeakerTimeline.jsx'),
    source('SpeakerRevisionHistory.jsx'),
    source('SpeakerManagement.css')
  ]);

  assert.match(timeline, /segments\.map\(/);
  assert.match(timeline, /segment\.startMs/);
  assert.match(timeline, /segment\.endMs/);
  assert.match(timeline, /speakerLabel/);
  assert.match(timeline, /未识别说话人/);
  assert.match(timeline, /aria-pressed/);
  assert.match(history, /修改记录/);
  assert.match(history, /<time/);
  assert.match(history, /entry\.summary/);
  assert.doesNotMatch(`${timeline}\n${history}`, /<(?:table|thead|tbody|tr|td|th)\b/i);
  assert.doesNotMatch(`${timeline}\n${history}`, /\b(?:Manager|Store|Backend)\b/);
  assert.doesNotMatch(`${timeline}\n${history}`, /(?:审计JSON|原始JSON|技术字段|内部编号)/);

  for (const token of [
    '--af-surface',
    '--af-surface-strong',
    '--af-text-primary',
    '--af-text-secondary',
    '--af-border-subtle',
    '--af-primary',
    '--af-danger',
    '--af-focus-ring'
  ]) {
    assert.ok(css.includes(token), `missing semantic token ${token}`);
  }
  assert.match(css, /min-height:\s*(?:4[4-9]|[5-9]\d|[1-9]\d{2,})px/);
  assert.match(css, /@media\s*\(max-width:/);

  for (const line of css.split('\n')) {
    const selector = line.trim();
    if (selector.endsWith('{') && !selector.startsWith('@')) {
      assert.match(selector, /^\.meeting-speaker-[\w-]+(?:[\[:.][^{]*)?\s*\{$/);
    }
  }
});

test('speaker management sheet is a safe accessible portal with complete modal focus lifecycle', async () => {
  const sheet = await optionalSource('SpeakerManagementSheet.jsx');

  assert.match(sheet, /createPortal/);
  assert.match(sheet, /typeof document/);
  assert.match(sheet, /role="dialog"/);
  assert.match(sheet, /aria-modal="true"/);
  assert.match(sheet, /aria-labelledby=/);
  assert.match(sheet, /document\.body\.style\.overflow/);
  assert.match(sheet, /previouslyFocusedElement/);
  assert.match(sheet, /\.focus\(\)/);
  assert.match(sheet, /event\.key === 'Escape'/);
  assert.match(sheet, /event\.key\s*!==?\s*'Tab'/);
  assert.match(sheet, /event\.shiftKey/);
  assert.match(sheet, /event\.target === event\.currentTarget/);
  assert.match(sheet, /document\.addEventListener\('keydown',[^,]+, true\)/);
  assert.match(sheet, /document\.addEventListener\('focusin',[^,]+, true\)/);
  assertSafeVisibleVocabulary(sheet);
});

test('speaker operation flow exposes one confirmed operation at a time with complete selection validation', async () => {
  const operationPanel = await optionalSource('SpeakerOperationPanel.jsx');

  assert.match(operationPanel, /activeOperation/);
  assert.match(operationPanel, /type:\s*'rename'/);
  assert.match(operationPanel, /type:\s*'merge'/);
  assert.match(operationPanel, /type:\s*'split'/);
  assert.match(operationPanel, /type:\s*'reassign'/);
  assert.match(operationPanel, /trim\(\)/);
  assert.match(operationPanel, /\.length\s*>\s*80/);
  assert.match(operationPanel, /speakerIds\.length\s*<\s*2/);
  assert.match(operationPanel, /speakerIds\.includes\(targetSpeakerId\)/);
  assert.match(operationPanel, /sourceSegments\.length/);
  assert.match(operationPanel, /segmentIds\.length\s*>=\s*sourceSegments\.length/);
  assert.match(operationPanel, /canReceiveReassignment/);
  assert.match(operationPanel, /confirmed/);
  assert.match(operationPanel, /setConfirmed\(false\)/);
  assert.match(operationPanel, /disabled=\{[^}]*isSubmitting/);
  assertSafeVisibleVocabulary(operationPanel);
});

test('speaker management orchestration owns safe async state and user-only tabs without owning Manager lifetime', async () => {
  const panel = await optionalSource('SpeakerManagementPanel.jsx');

  assert.match(panel, /function SpeakerManagementPanel\(\{ speakerCorrectionManager, meetingId, transcriptId \}\)/);
  assert.match(panel, /createMeetingSpeakerManagementUiFacade\(\{ manager: speakerCorrectionManager \}\)/);
  assert.match(panel, /facade\.load\(\{ meetingId, transcriptId \}\)/);
  assert.match(panel, /facade\.apply\(snapshot, intent\)/);
  assert.match(panel, /bindingVersion/);
  assert.match(panel, /mountedRef/);
  assert.match(panel, /requiresRefresh/);
  assert.match(panel, /role="status"/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /aria-busy=/);
  assert.match(panel, /key=\{snapshotEpoch\}/);
  assert.match(panel, /role="tablist"/);
  assert.match(panel, /role="tab"/);
  assert.match(panel, /role="tabpanel"/);
  assert.doesNotMatch(panel, /speakerCorrectionManager\.(?:dispose|destroy|close)\s*\(/);
  assert.equal((panel.match(/>说话人</g) || []).length, 1);
  assert.equal((panel.match(/>修改记录</g) || []).length, 1);
  assertSafeVisibleVocabulary(panel);
});

test('speaker management layout is a safe-area mobile sheet and desktop drawer with accessible control sizing', async () => {
  const css = await source('SpeakerManagement.css');

  assert.match(css, /\.meeting-speaker-sheet\s*\{/);
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /@media\s*\(min-width:/);
  assert.match(css, /\.meeting-speaker-sheet-panel\s*\{[^}]*right:/s);
  assert.match(css, /min-height:\s*92dvh/);
  assert.doesNotMatch(css, /min-height:\s*min\(92dvh,\s*760px\)/);
  assert.match(css, /\.meeting-speaker-sheet-header\s*\{[^}]*padding-right:\s*max\([^}]*env\(safe-area-inset-right\)/s);
  assert.match(css, /\.meeting-speaker-input\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.meeting-speaker-(?:button|tab|operation-trigger)[^{]*\{[^}]*min-height:\s*(?:4[4-9]|[5-9]\d|[1-9]\d{2,})px/s);
});

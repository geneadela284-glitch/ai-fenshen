import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let operationModule;
let panelModule;
let sheetModule;
let timelineModule;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('../../../', import.meta.url)),
    configFile: fileURLToPath(new URL('../../../vite.config.js', import.meta.url)),
    appType: 'custom',
    logLevel: 'error',
    css: { postcss: { plugins: [] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, preTransformRequests: false }
  });
  [operationModule, panelModule, sheetModule, timelineModule] = await Promise.all([
    vite.ssrLoadModule('/src/components/meeting/SpeakerOperationPanel.jsx'),
    vite.ssrLoadModule('/src/components/meeting/SpeakerManagementPanel.jsx'),
    vite.ssrLoadModule('/src/components/meeting/SpeakerManagementSheet.jsx'),
    vite.ssrLoadModule('/src/components/meeting/SpeakerTimeline.jsx')
  ]);
});

after(async () => {
  await vite?.close();
});

function safeSnapshot() {
  return {
    speakers: [
      { id: 'speaker-1', label: '主持人', canRename: true, canMerge: true, canSplit: true, canReceiveReassignment: true },
      { id: 'speaker-2', label: '记录员', canRename: true, canMerge: true, canSplit: false, canReceiveReassignment: true },
      { id: 'unknown', label: '未识别说话人', canRename: false, canMerge: false, canSplit: false, canReceiveReassignment: true }
    ],
    segments: [
      { id: 'segment-1', startMs: 0, endMs: 1_000, text: '第一段', speakerId: 'speaker-1', speakerLabel: '主持人', canSelectForSplit: true, canSelectForReassignment: true },
      { id: 'segment-2', startMs: 1_000, endMs: 2_000, text: '第二段', speakerId: 'speaker-1', speakerLabel: '主持人', canSelectForSplit: true, canSelectForReassignment: true },
      { id: 'segment-3', startMs: 2_000, endMs: 3_000, text: '第三段', speakerId: 'unknown', speakerLabel: '未识别说话人', canSelectForSplit: false, canSelectForReassignment: true }
    ],
    history: []
  };
}

function requiredFunction(module, name) {
  assert.equal(typeof module[name], 'function', `${name} production behavior is not implemented`);
  return module[name];
}

test('authoritative snapshot replacement advances the form epoch while management remains locked', () => {
  const previous = { snapshot: safeSnapshot(), snapshotEpoch: 7, isSubmitting: true };
  const nextSnapshot = safeSnapshot();
  nextSnapshot.speakers = nextSnapshot.speakers.filter((speaker) => speaker.id !== 'speaker-1');

  const advanceAuthoritativeSnapshot = requiredFunction(panelModule, 'advanceAuthoritativeSnapshot');
  const next = advanceAuthoritativeSnapshot(previous, nextSnapshot);

  assert.equal(next.snapshot, nextSnapshot);
  assert.equal(next.snapshotEpoch, 8);
  assert.equal(next.isSubmitting, true);
  assert.equal(previous.snapshotEpoch, 7);
});

test('final intent validation rejects every stale capability-bound identifier', () => {
  const current = safeSnapshot();
  const buildRenameIntent = requiredFunction(operationModule, 'buildRenameIntent');
  const buildMergeIntent = requiredFunction(operationModule, 'buildMergeIntent');
  const buildSplitIntent = requiredFunction(operationModule, 'buildSplitIntent');
  const buildReassignIntent = requiredFunction(operationModule, 'buildReassignIntent');

  assert.deepEqual(buildRenameIntent(current, 'speaker-1', '  新主持人  '), {
    type: 'rename', speakerId: 'speaker-1', displayLabel: '新主持人'
  });
  assert.equal(buildRenameIntent(current, 'speaker-1', '  主持人  '), null);
  assert.equal(buildReassignIntent(current, ['segment-1', 'segment-2'], 'speaker-1'), null);
  assert.deepEqual(buildReassignIntent(current, ['segment-1', 'segment-3'], 'speaker-1'), {
    type: 'reassign', segmentIds: ['segment-1', 'segment-3'], targetSpeakerId: 'speaker-1'
  });
  current.speakers[0] = { ...current.speakers[0], canRename: false, canMerge: false, canSplit: false };
  assert.equal(buildRenameIntent(current, 'speaker-1', '仍旧名称'), null);
  assert.equal(buildMergeIntent(current, ['speaker-1', 'speaker-2'], 'speaker-2'), null);
  assert.equal(buildSplitIntent(current, 'speaker-1', ['segment-1']), null);

  current.speakers[0] = { ...current.speakers[0], canReceiveReassignment: true };
  assert.deepEqual(buildReassignIntent(current, ['segment-2'], 'unknown'), {
    type: 'reassign', segmentIds: ['segment-2'], targetSpeakerId: 'unknown'
  });
  current.segments = current.segments.filter((segment) => segment.id !== 'segment-3');
  assert.equal(buildReassignIntent(current, ['segment-3'], 'unknown'), null);
  assert.equal(buildReassignIntent(current, ['segment-2'], 'missing-speaker'), null);
});

test('read-only timeline renders semantic cards without actionless buttons', () => {
  const SpeakerTimeline = requiredFunction(timelineModule, 'SpeakerTimeline');
  const html = renderToStaticMarkup(React.createElement(SpeakerTimeline, {
    segments: safeSnapshot().segments,
    selectedSegmentIds: []
  }));

  assert.doesNotMatch(html, /<button\b/);
  assert.match(html, /<article\b[^>]*class="meeting-speaker-timeline-card"/);
  assert.doesNotMatch(html, /aria-pressed=/);
});

test('interactive timeline exposes buttons and disables every segment while busy', () => {
  const SpeakerTimeline = requiredFunction(timelineModule, 'SpeakerTimeline');
  const enabled = renderToStaticMarkup(React.createElement(SpeakerTimeline, {
    segments: safeSnapshot().segments,
    selectedSegmentIds: ['segment-1'],
    onSegmentSelect() {},
    disabled: false
  }));
  const busy = renderToStaticMarkup(React.createElement(SpeakerTimeline, {
    segments: safeSnapshot().segments,
    selectedSegmentIds: ['segment-1'],
    onSegmentSelect() {},
    disabled: true
  }));

  assert.equal((enabled.match(/<button\b/g) || []).length, 3);
  assert.match(enabled, /aria-pressed="true"/);
  assert.doesNotMatch(enabled, /<button\b[^>]*\bdisabled=/);
  assert.equal((busy.match(/<button\b[^>]*\bdisabled=""/g) || []).length, 3);
});

test('split and merge final validation reject improper or duplicated complete selections', () => {
  const current = safeSnapshot();
  const buildMergeIntent = requiredFunction(operationModule, 'buildMergeIntent');
  const buildSplitIntent = requiredFunction(operationModule, 'buildSplitIntent');

  assert.equal(buildMergeIntent(current, ['speaker-1', 'speaker-1'], 'speaker-1'), null);
  assert.deepEqual(buildMergeIntent(current, ['speaker-1', 'speaker-2'], 'speaker-2'), {
    type: 'merge', speakerIds: ['speaker-1', 'speaker-2'], targetSpeakerId: 'speaker-2'
  });
  assert.equal(buildSplitIntent(current, 'speaker-1', []), null);
  assert.equal(buildSplitIntent(current, 'speaker-1', ['segment-1', 'segment-2']), null);
  assert.deepEqual(buildSplitIntent(current, 'speaker-1', ['segment-1']), {
    type: 'split', speakerId: 'speaker-1', segmentIds: ['segment-1']
  });
});

test('busy transition and zero-control Tab keep focus on the dialog container', () => {
  let activeElement = null;
  let prevented = 0;
  const documentImpl = { get activeElement() { return activeElement; } };
  const dialog = {
    contains: (element) => element === dialog,
    focus: () => { activeElement = dialog; },
    querySelectorAll: () => []
  };
  const focusBusyDialog = requiredFunction(sheetModule, 'focusBusyDialog');
  const trapModalTabKey = requiredFunction(sheetModule, 'trapModalTabKey');
  const containModalFocus = requiredFunction(sheetModule, 'containModalFocus');

  focusBusyDialog(dialog);
  assert.equal(activeElement, dialog);

  activeElement = null;
  trapModalTabKey({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented += 1; } }, dialog, documentImpl);
  assert.equal(prevented, 1);
  assert.equal(activeElement, dialog);

  activeElement = { id: 'outside' };
  containModalFocus({ target: activeElement }, dialog);
  assert.equal(activeElement, dialog);
});

test('submit lock rejects a duplicate acquisition until explicitly released', () => {
  const lock = { current: false };
  const acquireSubmitLock = requiredFunction(panelModule, 'acquireSubmitLock');
  const releaseSubmitLock = requiredFunction(panelModule, 'releaseSubmitLock');

  assert.equal(acquireSubmitLock(lock), true);
  assert.equal(acquireSubmitLock(lock), false);
  releaseSubmitLock(lock);
  assert.equal(acquireSubmitLock(lock), true);
});

test('generation guard rejects late load, apply, and refresh outcomes', () => {
  const mountedRef = { current: true };
  const bindingVersion = { current: 12 };
  const isCurrentAsyncGeneration = requiredFunction(panelModule, 'isCurrentAsyncGeneration');

  for (const phase of ['load', 'apply', 'refresh']) {
    assert.equal(isCurrentAsyncGeneration(mountedRef, bindingVersion, 11), false, `${phase} accepted a stale binding`);
    assert.equal(isCurrentAsyncGeneration(mountedRef, bindingVersion, 12), true, `${phase} rejected the current binding`);
  }
  mountedRef.current = false;
  assert.equal(isCurrentAsyncGeneration(mountedRef, bindingVersion, 12), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTranscriptRevision,
  createTranscriptSegment,
  stableTranscriptSegmentId
} from '../../../../core/meeting/stage3a/transcriptContracts.js';
import { createMeetingActionItem } from '../../../../core/meeting/stage4/meetingActionItemContracts.js';
import { createEvidenceRef } from '../../../../core/meeting/stage4/meetingEvidenceRefContracts.js';
import { createMeetingDecision } from '../../../../core/meeting/stage4/meetingDecisionContracts.js';
import { createMeetingSummary } from '../../../../core/meeting/stage4/meetingSummaryContracts.js';
import { createMeetingAnalysisManager } from './meetingAnalysisManager.js';

const NOW = '2026-08-30T08:00:00.000Z';
const HASH = 'a'.repeat(64);

function owner(ownerId = 'owner-a') {
  return { trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' };
}

function source(overrides = {}) {
  return {
    sourceId: 'source-a',
    meetingId: 'meeting-a',
    ownerId: 'owner-a',
    scope: 'meeting',
    origin: 'recorded',
    importState: 'committed',
    revision: 2,
    checksum: HASH,
    durationMs: 10_000,
    ...overrides
  };
}

function transcriptRevision(revision = 1, text = '会议明确继续跟进报价。') {
  const segment = createTranscriptSegment({
    transcriptId: 'transcript-a',
    transcriptRevision: revision,
    segmentId: stableTranscriptSegmentId({ transcriptId: 'transcript-a', sequence: 0, startMs: 0, endMs: 2_000 }),
    sequence: 0,
    startMs: 0,
    endMs: 2_000,
    text,
    confidence: 0.95,
    speakerRef: null,
    sourceChunkRefs: ['chunk-0'],
    revision
  });
  return createTranscriptRevision({
    ownerContext: owner(),
    transcriptId: 'transcript-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 2,
    transcriptRevision: revision,
    segments: [segment],
    createdAt: NOW,
    createdBy: 'system'
  });
}

function phase2Result(transcript, sourceValue = source()) {
  const ref = createEvidenceRef({
    ownerContext: owner(),
    source: sourceValue,
    transcriptRevision: transcript,
    segmentId: transcript.segments[0].segmentId,
    textSpan: { startOffset: 0, endOffset: transcript.segments[0].text.length, quote: transcript.segments[0].text },
    createdAt: NOW
  });
  const summary = createMeetingSummary({
    ownerContext: owner(),
    source: sourceValue,
    transcriptRevision: transcript,
    now: NOW,
    value: {
      summaryId: `summary-${transcript.transcriptRevision}`,
      resultRevisionId: `summary-revision-${transcript.transcriptRevision}`,
      resultRevision: transcript.transcriptRevision,
      status: 'ready',
      topic: { value: '报价跟进', groundingStatus: 'grounded', evidenceRefs: [ref] },
      overview: { value: '会议明确继续跟进报价。', groundingStatus: 'grounded', evidenceRefs: [ref] },
      keyPoints: [{ keyPointId: `key-point-${transcript.transcriptRevision}`, category: 'fact', content: transcript.segments[0].text, evidenceRefs: [ref] }],
      conclusions: [],
      openQuestions: [],
      evidenceRefs: [ref]
    }
  });
  const decision = createMeetingDecision({
    ownerContext: owner(),
    source: sourceValue,
    transcriptRevision: transcript,
    now: NOW,
    value: {
      decisionId: `decision-${transcript.transcriptRevision}`,
      content: transcript.segments[0].text,
      status: 'confirmed',
      confidence: { level: 'high', basis: 'explicit_statement' },
      evidenceRefs: [ref]
    }
  });
  const actionItem = createMeetingActionItem({
    ownerContext: owner(),
    source: sourceValue,
    transcriptRevision: transcript,
    now: NOW,
    value: {
      actionId: `action-${transcript.transcriptRevision}`,
      content: '继续跟进报价。',
      owner: 'unresolved',
      ownerRef: null,
      dueDate: 'unresolved',
      amount: 'unresolved',
      quantity: 'unresolved',
      status: 'unresolved',
      unresolvedReasons: ['OWNER_NOT_STATED', 'DUE_DATE_NOT_STATED'],
      evidenceRefs: [ref]
    }
  });
  return {
    ok: true,
    code: 'MEETING_BRAIN_READY',
    status: 'ready',
    data: { summary, decisions: [decision], actionItems: [actionItem], evidenceRefs: [ref] },
    diagnostics: { modelCalls: 1 }
  };
}

function analysisStore() {
  const bundles = [];
  return {
    bundles,
    async list(_ownerContext, { meetingId } = {}) {
      return bundles.filter((bundle) => bundle.meetingId === meetingId).map((bundle) => structuredClone(bundle));
    },
    async save(_ownerContext, { bundle }) {
      const existing = bundles.find((value) => value.idempotencyKey === bundle.idempotencyKey);
      if (existing) return { idempotent: true, bundle: structuredClone(existing) };
      bundles.push(structuredClone(bundle));
      return { idempotent: false, bundle: structuredClone(bundle) };
    }
  };
}

test('analyzes a ready transcript, persists one grounded bundle, and makes repeated requests idempotent', async () => {
  const context = owner();
  const transcript = transcriptRevision();
  const store = analysisStore();
  let calls = 0;
  const manager = createMeetingAnalysisManager({
    ownerContext: context,
    analysisBundles: store,
    engine: { generate: async () => { calls += 1; return phase2Result(transcript); } },
    now: () => NOW
  });

  const first = await manager.analyze({
    source: source(),
    transcriptRevision: transcript,
    meetingMetadata: { title: '报价会议', startedAt: NOW, timeZone: 'Asia/Shanghai' }
  });
  const second = await manager.analyze({
    source: source(),
    transcriptRevision: transcript,
    meetingMetadata: { title: '报价会议', startedAt: NOW, timeZone: 'Asia/Shanghai' }
  });

  assert.equal(calls, 1);
  assert.equal(store.bundles.length, 1);
  assert.equal(first.bundle.status, 'CURRENT');
  assert.equal(first.bundle.groundingStatus, 'GROUNDING_SUPPORTED');
  assert.equal(second.idempotent, true);
  assert.equal(manager.getSnapshot().status, 'ready');
  assert.equal(manager.getSnapshot().bundle.analysisId, first.bundle.analysisId);
});

test('a transcript revision creates a new analysis revision without overwriting history', async () => {
  const context = owner();
  const firstTranscript = transcriptRevision(1);
  const secondTranscript = transcriptRevision(2, '会议最终决定继续跟进报价。');
  const store = analysisStore();
  const manager = createMeetingAnalysisManager({
    ownerContext: context,
    analysisBundles: store,
    engine: { generate: async ({ transcriptRevision: current }) => phase2Result(current) },
    now: () => NOW
  });

  const first = await manager.analyze({ source: source(), transcriptRevision: firstTranscript });
  const second = await manager.analyze({ source: source(), transcriptRevision: secondTranscript });

  assert.equal(first.bundle.analysisRevision, 1);
  assert.equal(second.bundle.analysisRevision, 2);
  assert.equal(second.bundle.parentAnalysisId, first.bundle.analysisId);
  assert.deepEqual(store.bundles.map((bundle) => bundle.analysisRevision), [1, 2]);
});

test('provider failure does not save an empty result or remove the previous successful bundle', async () => {
  const context = owner();
  const transcript = transcriptRevision();
  const nextTranscript = transcriptRevision(2, '会议内容需要再次确认。');
  const store = analysisStore();
  let fail = false;
  const manager = createMeetingAnalysisManager({
    ownerContext: context,
    analysisBundles: store,
    engine: {
      generate: async ({ transcriptRevision: current }) => {
        if (fail) return { ok: false, code: 'AI_ANALYSIS_UNAVAILABLE', status: 'failed', data: null };
        return phase2Result(current);
      }
    },
    now: () => NOW
  });

  const successful = await manager.analyze({ source: source(), transcriptRevision: transcript });
  fail = true;
  await assert.rejects(
    manager.analyze({ source: source(), transcriptRevision: nextTranscript }),
    (error) => error?.code === 'AI_ANALYSIS_UNAVAILABLE'
  );

  assert.equal(store.bundles.length, 1);
  assert.equal(store.bundles[0].analysisId, successful.bundle.analysisId);
  assert.equal(manager.getSnapshot().bundle.analysisId, successful.bundle.analysisId);
  assert.equal(manager.getSnapshot().status, 'failed');
});

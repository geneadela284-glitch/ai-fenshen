import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTranscriptRevision,
  createTranscriptSegment,
  stableTranscriptSegmentId
} from '../stage3a/transcriptContracts.js';
import { createEvidenceRef } from './meetingEvidenceRefContracts.js';
import { createMeetingActionItem } from './meetingActionItemContracts.js';
import { createMeetingDecision } from './meetingDecisionContracts.js';
import {
  createMeetingAnalysisBundle,
  revalidateMeetingAnalysisBundle
} from './meetingAnalysisBundleContracts.js';
import { createMeetingSummary } from './meetingSummaryContracts.js';

const NOW = '2026-08-16T10:00:00.000Z';
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
    durationMs: 20_000,
    ...overrides
  };
}

function transcriptRevision(revision = 1, text = '李总负责跟进报价，日期需要再次确认。') {
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

function evidenceRef({ context = owner(), sourceValue = source(), transcript = transcriptRevision() } = {}) {
  return createEvidenceRef({
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    segmentId: transcript.segments[0].segmentId,
    textSpan: {
      startOffset: 0,
      endOffset: transcript.segments[0].text.length,
      quote: transcript.segments[0].text
    },
    createdAt: NOW
  });
}

function phase2Result({ context = owner(), sourceValue = source(), transcript = transcriptRevision(), ref = evidenceRef() } = {}) {
  const summary = createMeetingSummary({
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    now: NOW,
    value: {
      summaryId: 'summary-a',
      resultRevisionId: 'summary-revision-a',
      resultRevision: 1,
      status: 'ready',
      topic: { value: '报价跟进', groundingStatus: 'grounded', evidenceRefs: [ref] },
      overview: { value: '会议明确了报价跟进事项。', groundingStatus: 'grounded', evidenceRefs: [ref] },
      keyPoints: [{ keyPointId: 'key-point-a', category: 'fact', content: '报价需要继续跟进。', evidenceRefs: [ref] }],
      conclusions: [],
      openQuestions: [],
      evidenceRefs: [ref]
    }
  });
  const decision = createMeetingDecision({
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    now: NOW,
    value: {
      decisionId: 'decision-a',
      content: '报价继续跟进。',
      status: 'confirmed',
      confidence: { level: 'high', basis: 'explicit_statement' },
      evidenceRefs: [ref]
    }
  });
  const actionItem = createMeetingActionItem({
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    now: NOW,
    value: {
      actionId: 'action-a',
      content: '跟进报价。',
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
    status: 'ready',
    data: { summary, decisions: [decision], actionItems: [actionItem], evidenceRefs: [ref] },
    diagnostics: { modelCalls: 1 }
  };
}

function bundleInput(overrides = {}) {
  const context = overrides.ownerContext || owner();
  const sourceValue = overrides.source || source();
  const transcript = overrides.transcriptRevision || transcriptRevision();
  const result = overrides.result || phase2Result({ context, sourceValue, transcript });
  return {
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    analysisId: 'analysis-a',
    analysisRevision: 1,
    idempotencyKey: 'analysis-request-a',
    groundingPolicyVersion: 'meeting-grounding-v1',
    analysisEngineVersion: 'stage4-phase2',
    provenance: { capability: 'MEETING_SUMMARY' },
    result,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

test('creates an immutable grounded Analysis Bundle without raw Meeting source duplication', () => {
  const bundle = createMeetingAnalysisBundle(bundleInput());

  assert.equal(bundle.analysisId, 'analysis-a');
  assert.equal(bundle.ownerId, 'owner-a');
  assert.equal(bundle.scope, 'meeting');
  assert.equal(bundle.meetingId, 'meeting-a');
  assert.equal(bundle.sourceTranscriptRevision, 1);
  assert.equal(bundle.analysisRevision, 1);
  assert.equal(bundle.status, 'CURRENT');
  assert.equal(bundle.groundingStatus, 'GROUNDING_SUPPORTED');
  assert.equal(bundle.decisions.length, 1);
  assert.equal(bundle.actionItems[0].owner, 'unresolved');
  assert.equal(bundle.evidenceRefs.length, 1);
  assert.equal(Object.hasOwn(bundle, 'audio'), false);
  assert.equal(Object.hasOwn(bundle, 'transcript'), false);
  assert.equal(Object.hasOwn(bundle, 'segments'), false);
  assert.equal(Object.hasOwn(bundle, 'diarization'), false);
  assert.equal(Object.hasOwn(bundle, 'speakerCorrection'), false);
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.summary), true);
});

test('rejects failed or rejected candidates, credentials, invalid binding, and raw source payloads', () => {
  assert.throws(
    () => createMeetingAnalysisBundle(bundleInput({ result: { ok: false, status: 'failed', data: null } })),
    /ANALYSIS_RESULT_NOT_GROUNDED/
  );

  const rawResult = phase2Result();
  rawResult.data.transcript = { segments: ['must-not-persist'] };
  assert.throws(
    () => createMeetingAnalysisBundle(bundleInput({ result: rawResult })),
    /ANALYSIS_RAW_SOURCE_FORBIDDEN/
  );

  assert.throws(
    () => createMeetingAnalysisBundle(bundleInput({ provenance: { apiKey: 'secret' } })),
    /ANALYSIS_CREDENTIAL_FORBIDDEN/
  );

  assert.throws(
    () => createMeetingAnalysisBundle(bundleInput({ ownerContext: owner('owner-b') })),
    /OWNER_SCOPE_MISMATCH/
  );
});

test('reopens as current only when every EvidenceRef resolves against the current source and transcript', () => {
  const input = bundleInput();
  const bundle = createMeetingAnalysisBundle(input);
  const reopened = revalidateMeetingAnalysisBundle(bundle, {
    ownerContext: input.ownerContext,
    source: input.source,
    currentTranscriptRevision: input.transcriptRevision
  });

  assert.equal(reopened.status, 'CURRENT');
  assert.equal(reopened.groundingStatus, 'GROUNDING_SUPPORTED');
  assert.deepEqual(reopened.evidenceRefResolutions.map((item) => item.status), ['VALID']);
  assert.equal(reopened.evidenceRefs[0].status, 'VALID');
});

test('marks old analysis stale on Transcript revision change without mutating stored EvidenceRef', () => {
  const input = bundleInput();
  const bundle = createMeetingAnalysisBundle(input);
  const reopened = revalidateMeetingAnalysisBundle(bundle, {
    ownerContext: input.ownerContext,
    source: input.source,
    currentTranscriptRevision: transcriptRevision(2)
  });

  assert.equal(reopened.status, 'STALE');
  assert.equal(reopened.groundingStatus, 'STALE');
  assert.equal(reopened.evidenceRefResolutions[0].status, 'STALE');
  assert.notEqual(reopened.groundingStatus, 'GROUNDING_SUPPORTED');
  assert.equal(reopened.evidenceRefs[0].status, 'VALID');
});

test('marks EvidenceRef invalid when the segment text no longer matches', () => {
  const input = bundleInput();
  const bundle = createMeetingAnalysisBundle(input);
  const reopened = revalidateMeetingAnalysisBundle(bundle, {
    ownerContext: input.ownerContext,
    source: input.source,
    currentTranscriptRevision: transcriptRevision(1, '这是另一段没有原始引用的文字。')
  });

  assert.equal(reopened.status, 'INVALID');
  assert.equal(reopened.groundingStatus, 'INVALID');
  assert.equal(reopened.evidenceRefResolutions[0].status, 'INVALID');
  assert.equal(reopened.evidenceRefs[0].status, 'VALID');
});

test('requires explicit revalidation context instead of presenting persisted facts as grounded', () => {
  const bundle = createMeetingAnalysisBundle(bundleInput());
  const reopened = revalidateMeetingAnalysisBundle(bundle, { ownerContext: owner() });

  assert.equal(reopened.status, 'REVALIDATION_REQUIRED');
  assert.equal(reopened.groundingStatus, 'REVALIDATION_REQUIRED');
  assert.equal(reopened.evidenceRefResolutions[0].status, 'REVALIDATION_REQUIRED');
});

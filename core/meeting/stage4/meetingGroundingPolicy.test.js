import assert from 'node:assert/strict';
import test from 'node:test';

import { createTranscriptRevision, createTranscriptSegment, stableTranscriptSegmentId } from '../stage3a/transcriptContracts.js';
import { createEvidenceRef } from './meetingEvidenceRefContracts.js';
import {
  GROUNDING_SUPPORTED,
  GROUNDING_UNRESOLVED,
  GROUNDING_REJECTED,
  groundCandidate
} from './meetingGroundingPolicy.js';

const OWNER = { trusted: true, ownerId: 'owner-a', sessionId: 'session-a', spaceId: 'meeting-space' };
const SOURCE = {
  sourceId: 'source-a', meetingId: 'meeting-a', ownerId: 'owner-a', scope: 'meeting', origin: 'recorded',
  importState: 'committed', revision: 2, checksum: 'a'.repeat(64), durationMs: 5_000
};
const NOW = '2026-08-16T10:00:00.000Z';

function transcript() {
  const segment = createTranscriptSegment({
    transcriptId: 'transcript-a',
    transcriptRevision: 1,
    segmentId: stableTranscriptSegmentId({ transcriptId: 'transcript-a', sequence: 0, startMs: 0, endMs: 2_000 }),
    sequence: 0,
    startMs: 0,
    endMs: 2_000,
    text: '李总负责跟进报价，金额暂未确定。',
    confidence: 0.95,
    speakerRef: null,
    sourceChunkRefs: ['chunk-0'],
    revision: 1
  });
  return createTranscriptRevision({
    ownerContext: OWNER,
    transcriptId: 'transcript-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 2,
    transcriptRevision: 1,
    segments: [segment],
    createdAt: NOW,
    createdBy: 'system'
  });
}

function evidence() {
  const revision = transcript();
  return createEvidenceRef({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: revision,
    segmentId: revision.segments[0].segmentId,
    textSpan: { startOffset: 0, endOffset: '李总负责跟进报价'.length, quote: '李总负责跟进报价' },
    createdAt: NOW
  });
}

function candidate(overrides = {}) {
  return {
    claimId: 'claim-a-1',
    kind: 'action_item',
    content: '李总负责跟进报价',
    fields: { owner: '李总' },
    evidenceRefs: [evidence()],
    ...overrides
  };
}

test('supports a claim only when its content and resolved fields are grounded', () => {
  const result = groundCandidate({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: transcript(),
    candidate: candidate()
  });
  assert.equal(result.status, GROUNDING_SUPPORTED);
  assert.deepEqual(result.evidenceRefs.map((item) => item.evidenceRefId), [candidate().evidenceRefs[0].evidenceRefId]);
});

test('returns unresolved when a claim has insufficient evidence', () => {
  const result = groundCandidate({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: transcript(),
    candidate: candidate({ evidenceRefs: [] })
  });
  assert.equal(result.status, GROUNDING_UNRESOLVED);
  assert.equal(result.unresolvedReasons[0].code, 'EVIDENCE_REQUIRED');
});

test('rejects an unsupported claim instead of promoting it from context', () => {
  const result = groundCandidate({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: transcript(),
    candidate: candidate({ content: '李总已经批准预算' })
  });
  assert.equal(result.status, GROUNDING_REJECTED);
  assert.equal(result.rejectionReasons[0].code, 'CLAIM_NOT_SUPPORTED');
});

test('allows a summary paraphrase only when valid transcript evidence is explicitly supplied', () => {
  const result = groundCandidate({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: transcript(),
    allowParaphrase: true,
    candidate: candidate({ content: '会议安排李总跟进报价', fields: {} })
  });
  assert.equal(result.status, GROUNDING_SUPPORTED);
  assert.equal(result.evidenceRefs[0].textSpan.quote, '李总负责跟进报价');
});

test('keeps an ambiguous owner unresolved', () => {
  const result = groundCandidate({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: transcript(),
    candidate: candidate({ fields: { owner: { value: 'unresolved', unresolvedReason: 'AMBIGUOUS' } } })
  });
  assert.equal(result.status, GROUNDING_UNRESOLVED);
  assert.equal(result.unresolvedReasons.some((item) => item.field === 'owner'), true);
});

test('keeps an ambiguous date unresolved', () => {
  const result = groundCandidate({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: transcript(),
    candidate: candidate({ fields: { dueDate: { value: 'unresolved', unresolvedReason: 'AMBIGUOUS' } } })
  });
  assert.equal(result.status, GROUNDING_UNRESOLVED);
  assert.equal(result.unresolvedReasons.some((item) => item.field === 'dueDate'), true);
});

test('keeps an ambiguous amount unresolved', () => {
  const result = groundCandidate({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: transcript(),
    candidate: candidate({ fields: { amount: { value: 'unresolved', unresolvedReason: 'NOT_STATED' } } })
  });
  assert.equal(result.status, GROUNDING_UNRESOLVED);
  assert.equal(result.unresolvedReasons.some((item) => item.field === 'amount'), true);
});

test('does not upgrade tentative language into a decision', () => {
  const revision = transcript();
  const ref = createEvidenceRef({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: revision,
    segmentId: revision.segments[0].segmentId,
    textSpan: { startOffset: 0, endOffset: 2, quote: '李总' },
    createdAt: NOW
  });
  const result = groundCandidate({
    ownerContext: OWNER,
    source: SOURCE,
    transcriptRevision: revision,
    candidate: {
      claimId: 'decision-a-1',
      kind: 'decision',
      content: '下周可能上线',
      certainty: 'tentative',
      fields: {},
      evidenceRefs: [ref]
    }
  });
  assert.equal(result.status, GROUNDING_UNRESOLVED);
  assert.equal(result.unresolvedReasons.some((item) => item.code === 'TENTATIVE_LANGUAGE'), true);
});

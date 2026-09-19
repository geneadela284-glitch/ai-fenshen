import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTranscriptRevision,
  createTranscriptSegment,
  stableTranscriptSegmentId
} from '../stage3a/transcriptContracts.js';
import {
  createMeetingActionItem,
  validateMeetingActionItem
} from './meetingActionItemContracts.js';
import {
  createMeetingDecision,
  validateMeetingDecision
} from './meetingDecisionContracts.js';
import { MeetingBrainEngine } from './meetingBrainEngine.js';
import {
  createMeetingSummary,
  validateMeetingSummary
} from './meetingSummaryContracts.js';

const NOW = '2026-08-17T09:00:00.000Z';
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

const TEXTS = [
  '主题是报价与交付。',
  '就这么定，周一正式上线。',
  '小王负责报价，2026-08-21之前发给客户。预算为人民币100000元，数量10份。',
  '要不考虑周一上线？',
  '尽快发给客户，预算大概十万左右。',
  '如果客户确认，我们周五发货。',
  '周三，等等，改成周四。',
  '不是李伟负责，是张强负责。',
  '会议结束时，交付日期尚未明确。'
];

function transcriptRevision(texts = TEXTS, revision = 1, segmentDurationMs = 2_000) {
  const segments = texts.map((text, index) => {
    const startMs = index * segmentDurationMs;
    const endMs = startMs + segmentDurationMs;
    return createTranscriptSegment({
      transcriptId: 'transcript-a',
      transcriptRevision: revision,
      segmentId: stableTranscriptSegmentId({ transcriptId: 'transcript-a', sequence: index, startMs, endMs }),
      sequence: index,
      startMs,
      endMs,
      text,
      confidence: 0.95,
      speakerRef: null,
      sourceChunkRefs: [`chunk-${index}`],
      revision
    });
  });
  return createTranscriptRevision({
    ownerContext: owner(),
    transcriptId: 'transcript-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 2,
    transcriptRevision: revision,
    segments,
    createdAt: NOW,
    createdBy: 'system'
  });
}

function hint(transcript, index, quote = transcript.segments[index].text, overrides = {}) {
  const segment = transcript.segments[index];
  const startOffset = segment.text.indexOf(quote);
  return {
    segmentId: segment.segmentId,
    startOffset,
    endOffset: startOffset + quote.length,
    quote,
    ...overrides
  };
}

function fixtureInput(overrides = {}) {
  const transcript = transcriptRevision();
  return {
    ownerContext: owner(),
    source: source(),
    transcriptRevision: transcript,
    meetingMetadata: {
      title: '报价与交付会议',
      startedAt: NOW,
      timeZone: 'Asia/Shanghai'
    },
    ...overrides
  };
}

function modelPayload(transcript, overrides = {}) {
  const first = transcript.segments[0];
  const fact = transcript.segments[2] || first;
  const final = transcript.segments[8] || transcript.segments.at(-1);
  return {
    summary: {
      topic: { content: first.text, evidenceHints: [hint(transcript, 0)] },
      overview: { content: first.text, evidenceHints: [hint(transcript, 0)] },
      keyPoints: [
        { category: 'fact', content: fact.text, evidenceHints: [hint(transcript, fact.sequence)] }
      ],
      conclusions: [
        { content: (transcript.segments[1] || first).text, evidenceHints: [hint(transcript, (transcript.segments[1] || first).sequence)] }
      ],
      openQuestions: [
        { content: final.text, evidenceHints: [hint(transcript, final.sequence)] }
      ]
    },
    decisions: [
      {
        content: (transcript.segments[1] || first).text,
        status: 'confirmed',
        confidence: { level: 'high', basis: 'explicit_statement' },
        evidenceHints: [hint(transcript, (transcript.segments[1] || first).sequence)]
      }
    ],
    actionItems: [
      {
        content: fact.text,
        owner: '小王',
        dueDate: '2026-08-21',
        amount: { value: '100000', currency: 'CNY' },
        quantity: { value: '10', unit: '份' },
        status: 'candidate',
        evidenceHints: [hint(transcript, fact.sequence)]
      }
    ],
    ...overrides
  };
}

function modelRunnerFor(transcript, payload = modelPayload(transcript), calls = []) {
  return async (task) => {
    calls.push(task);
    return { content: JSON.stringify(payload) };
  };
}

function engineFor(transcript, payload = modelPayload(transcript), options = {}) {
  const calls = [];
  return {
    calls,
    engine: new MeetingBrainEngine({
      modelRunner: modelRunnerFor(transcript, payload, calls),
      now: () => new Date(NOW),
      ...options
    })
  };
}

test('summary contract rejects a grounded field without an EvidenceRef', () => {
  const value = {
    schemaVersion: 1,
    summaryId: 'summary-a',
    resultRevisionId: 'summary-revision-a',
    resultRevision: 1,
    parentResultRevisionId: null,
    ownerId: 'owner-a',
    scope: 'meeting',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 2,
    transcriptId: 'transcript-a',
    transcriptRevision: 1,
    generatedAt: NOW,
    status: 'ready',
    topic: { value: '没有证据', groundingStatus: 'grounded', evidenceRefs: [] },
    overview: { value: 'unresolved', groundingStatus: 'unresolved', unresolvedReason: 'NOT_STATED', evidenceRefs: [] },
    keyPoints: [],
    conclusions: [],
    openQuestions: [],
    evidenceRefs: []
  };
  assert.equal(validateMeetingSummary(value, fixtureInput()).valid, false);
  assert.throws(() => createMeetingSummary({ ...fixtureInput(), value }), /EVIDENCE_REQUIRED/);
});

test('decision contract requires evidence for confirmed decisions', () => {
  const value = {
    schemaVersion: 1,
    decisionId: 'decision-a',
    ownerId: 'owner-a',
    scope: 'meeting',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 2,
    transcriptId: 'transcript-a',
    transcriptRevision: 1,
    content: '就这么定。',
    status: 'confirmed',
    confidence: { level: 'high', basis: 'explicit_statement' },
    evidenceRefs: [],
    createdAt: NOW
  };
  assert.equal(validateMeetingDecision(value, fixtureInput()).valid, false);
  assert.throws(() => createMeetingDecision({ ...fixtureInput(), value }), /EVIDENCE_REQUIRED/);
});

test('action contract preserves unresolved fields instead of empty values', () => {
  const value = {
    schemaVersion: 1,
    actionId: 'action-a',
    ownerId: 'owner-a',
    scope: 'meeting',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 2,
    transcriptId: 'transcript-a',
    transcriptRevision: 1,
    content: '尽快发给客户。',
    owner: 'unresolved',
    ownerRef: null,
    dueDate: 'unresolved',
    amount: 'unresolved',
    quantity: 'unresolved',
    status: 'unresolved',
    unresolvedReasons: ['OWNER_NOT_STATED', 'DUE_DATE_AMBIGUOUS'],
    evidenceRefs: [],
    createdAt: NOW
  };
  assert.equal(validateMeetingActionItem(value, fixtureInput()).valid, false);
  assert.throws(() => createMeetingActionItem({ ...fixtureInput(), value }), /EVIDENCE_REQUIRED/);
});

test('engine routes model understanding through the existing Meeting capability without provider selection', async () => {
  const input = fixtureInput();
  const { engine, calls } = engineFor(input.transcriptRevision);
  const result = await engine.generate(input);
  assert.equal(result.ok, true);
  assert.equal(calls[0].capability, 'MEETING_SUMMARY');
  assert.equal('provider' in calls[0], false);
  assert.equal('model' in calls[0], false);
  assert.equal(calls[0].metadata.memoryPolicy, 'disabled');
  assert.equal(calls[0].metadata.stage4Phase, 2);
});

test('engine returns a grounded summary with evidence on every supported field', async () => {
  const input = fixtureInput();
  const { engine } = engineFor(input.transcriptRevision);
  const result = await engine.generate(input);
  assert.equal(result.code, 'MEETING_BRAIN_READY');
  assert.equal(result.data.summary.status, 'ready');
  assert.equal(result.data.summary.topic.groundingStatus, 'grounded');
  assert.ok(result.data.summary.topic.evidenceRefs.length >= 1);
  assert.ok(result.data.summary.keyPoints[0].evidenceRefs.length >= 1);
  assert.ok(result.data.summary.evidenceRefs.length >= 4);
  assert.equal(result.data.summary.ownerId, 'owner-a');
  assert.equal(result.data.summary.meetingId, 'meeting-a');
});

test('engine derives evidence offsets when the model returns an exact quote without offsets', async () => {
  const transcript = transcriptRevision();
  const base = modelPayload(transcript);
  const quote = transcript.segments[0].text;
  const payload = {
    ...base,
    summary: {
      ...base.summary,
      topic: { content: quote, evidenceHints: [{ segmentId: transcript.segments[0].segmentId, quote }] }
    }
  };
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));

  assert.equal(result.data.summary.topic.groundingStatus, 'grounded');
  assert.deepEqual(result.data.summary.topic.evidenceRefs[0].textSpan, {
    startOffset: 0,
    endOffset: quote.length,
    quote
  });
});

test('engine preserves exact whitespace in a model evidence quote while validating the candidate content', async () => {
  const transcript = transcriptRevision(['  主题是报价与交付。  ']);
  const base = modelPayload(transcript);
  const quote = transcript.segments[0].text;
  const payload = {
    ...base,
    summary: {
      ...base.summary,
      topic: { content: quote.trim(), evidenceHints: [{ segmentId: transcript.segments[0].segmentId, quote }] }
    }
  };
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));

  assert.equal(result.data.summary.topic.groundingStatus, 'grounded');
  assert.equal(result.data.summary.topic.evidenceRefs[0].textSpan.quote, quote);
});

test('engine normalizes scalar model candidates and binds them only to exact transcript quotes', async () => {
  const transcript = transcriptRevision();
  const base = modelPayload(transcript);
  const quote = transcript.segments[0].text;
  const decisionQuote = transcript.segments[1].text;
  const actionQuote = transcript.segments[2].text;
  const payload = {
    ...base,
    summary: {
      ...base.summary,
      topic: quote,
      overview: quote,
      keyPoints: [quote],
      conclusions: [],
      openQuestions: []
    },
    decisions: [decisionQuote],
    actionItems: [actionQuote]
  };
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));

  assert.equal(result.data.summary.topic.groundingStatus, 'grounded');
  assert.equal(result.data.summary.topic.evidenceRefs[0].textSpan.quote, quote);
  assert.equal(result.data.summary.keyPoints[0].content, quote);
  assert.equal(result.data.decisions[0].content, decisionQuote);
  assert.equal(result.data.actionItems[0].content, actionQuote);
});

test('engine makes one bounded evidence repair request after parseable output has no grounded candidate', async () => {
  const transcript = transcriptRevision();
  const firstPayload = {
    summary: {
      topic: '会议围绕报价与交付进行讨论',
      overview: '本次会议已经形成完整结论',
      keyPoints: [],
      conclusions: [],
      openQuestions: []
    },
    decisions: [],
    actionItems: []
  };
  const calls = [];
  const repairedPayload = modelPayload(transcript);
  const engine = new MeetingBrainEngine({
    now: () => new Date(NOW),
    modelRunner: async (task) => {
      calls.push(task);
      return { content: JSON.stringify(calls.length === 1 ? firstPayload : repairedPayload) };
    }
  });
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].metadata.attemptType, 'evidence_repair');
  assert.equal(result.data.summary.topic.groundingStatus, 'grounded');
  assert.ok(result.data.evidenceRefs.length >= 1);
});

test('engine does not treat evidence from rejected claims as an available analysis', async () => {
  const transcript = transcriptRevision(['会议只讨论了报价。']);
  const unsupportedField = '100000';
  const payload = {
    summary: {
      topic: { content: transcript.segments[0].text, fields: { amount: unsupportedField }, evidenceHints: [hint(transcript, 0)] },
      overview: { content: transcript.segments[0].text, fields: { amount: unsupportedField }, evidenceHints: [hint(transcript, 0)] },
      keyPoints: [{ content: transcript.segments[0].text, fields: { amount: unsupportedField }, evidenceHints: [hint(transcript, 0)] }],
      conclusions: [],
      openQuestions: []
    },
    decisions: [],
    actionItems: []
  };
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({
    transcriptRevision: transcript,
    source: source({ durationMs: transcript.segments.at(-1).endMs })
  }));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(result.status, 'failed');
  assert.equal(result.data, null);
  assert.equal(result.diagnostics.reason, 'EVIDENCE_UNAVAILABLE');
  assert.ok(result.diagnostics.rejectedCandidates.length >= 1);
});

test('engine accepts an AI summary paraphrase when its transcript quote is exact', async () => {
  const transcript = transcriptRevision(['我们先把报价和交付时间谈清楚。']);
  const quote = transcript.segments[0].text;
  const payload = {
    summary: {
      topic: { content: '会议聚焦报价与交付时间。', evidenceHints: [hint(transcript, 0, quote)] },
      overview: { content: '本次讨论围绕报价和交付时间展开。', evidenceHints: [hint(transcript, 0, quote)] },
      keyPoints: [{ category: 'fact', content: '报价与交付时间是本次讨论重点。', evidenceHints: [hint(transcript, 0, quote)] }],
      conclusions: [],
      openQuestions: []
    },
    decisions: [],
    actionItems: []
  };
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({
    transcriptRevision: transcript,
    source: source({ durationMs: transcript.segments.at(-1).endMs })
  }));

  assert.equal(result.ok, true);
  assert.equal(result.code, 'MEETING_BRAIN_READY');
  assert.equal(result.data.summary.status, 'ready');
  assert.equal(result.data.summary.topic.value, '会议聚焦报价与交付时间。');
  assert.equal(result.data.summary.overview.value, '本次讨论围绕报价和交付时间展开。');
  assert.equal(result.data.summary.keyPoints[0].content, '报价与交付时间是本次讨论重点。');
  assert.equal(result.data.evidenceRefs.length, 1);
  assert.equal(result.data.evidenceRefs[0].textSpan.quote, quote);
});

test('engine keeps decisions strict even when summary paraphrases are allowed', async () => {
  const transcript = transcriptRevision();
  const base = modelPayload(transcript, {
    decisions: [{
      content: '会议确定周一上线。',
      status: 'confirmed',
      confidence: { level: 'high', basis: 'explicit_statement' },
      evidenceHints: [hint(transcript, 1)]
    }],
    actionItems: []
  });
  const { engine } = engineFor(transcript, base);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));

  assert.equal(result.ok, true);
  assert.equal(result.data.decisions.length, 0);
  assert.ok(result.diagnostics.rejectedCandidates.some((item) => item.kind === 'decision'));
});

test('engine confirms an explicit decision and binds its transcript quote', async () => {
  const input = fixtureInput();
  const { engine } = engineFor(input.transcriptRevision);
  const result = await engine.generate(input);
  assert.equal(result.data.decisions.length, 1);
  assert.equal(result.data.decisions[0].status, 'confirmed');
  assert.equal(result.data.decisions[0].content, TEXTS[1]);
  assert.equal(result.data.decisions[0].evidenceRefs[0].textSpan.quote, TEXTS[1]);
});

test('engine never upgrades a tentative suggestion into a confirmed decision', async () => {
  const transcript = transcriptRevision();
  const payload = modelPayload(transcript, {
    decisions: [{
      content: TEXTS[3],
      status: 'confirmed',
      confidence: { level: 'high', basis: 'model_claim' },
      evidenceHints: [hint(transcript, 3)]
    }]
  });
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  assert.equal(result.data.decisions.length, 1);
  assert.equal(result.data.decisions[0].status, 'unresolved');
  assert.equal(result.data.decisions[0].unresolvedReason, 'TENTATIVE_OR_AMBIGUOUS');
});

test('engine keeps conditional statements unresolved rather than treating them as final decisions', async () => {
  const transcript = transcriptRevision();
  const payload = modelPayload(transcript, {
    decisions: [{
      content: TEXTS[5],
      status: 'confirmed',
      confidence: { level: 'high', basis: 'model_claim' },
      evidenceHints: [hint(transcript, 5)]
    }]
  });
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  assert.equal(result.data.decisions[0].status, 'unresolved');
});

test('engine keeps opinion and discussion language out of confirmed decisions', async () => {
  const transcript = transcriptRevision(['我觉得这个方案可能更好。']);
  const payload = modelPayload(transcript, {
    decisions: [{
      content: transcript.segments[0].text,
      status: 'confirmed',
      confidence: { level: 'high', basis: 'model_claim' },
      evidenceHints: [hint(transcript, 0)]
    }]
  });
  const result = await engineFor(transcript, payload).engine.generate(fixtureInput({
    transcriptRevision: transcript,
    source: source({ durationMs: transcript.segments.at(-1).endMs })
  }));
  assert.equal(result.data.decisions[0].status, 'unresolved');
  assert.equal(result.data.decisions[0].unresolvedReason, 'TENTATIVE_OR_AMBIGUOUS');
});

test('engine resolves explicit owner, date, amount, and quantity independently', async () => {
  const input = fixtureInput();
  const { engine } = engineFor(input.transcriptRevision);
  const result = await engine.generate(input);
  const action = result.data.actionItems[0];
  assert.equal(action.owner, '小王');
  assert.equal(action.dueDate, '2026-08-21');
  assert.deepEqual(action.amount, { value: '100000', currency: 'CNY' });
  assert.deepEqual(action.quantity, { value: '10', unit: '份' });
  assert.equal(action.status, 'candidate');
});

test('engine accepts explicit Chinese amount units but does not infer a currency from a bare number', async () => {
  const transcript = transcriptRevision(['预算就定十万元。']);
  const payload = modelPayload(transcript, {
    actionItems: [{
      content: transcript.segments[0].text,
      owner: 'unresolved',
      dueDate: 'unresolved',
      amount: { value: '100000', currency: 'CNY' },
      quantity: 'unresolved',
      status: 'candidate',
      evidenceHints: [hint(transcript, 0)]
    }]
  });
  const result = await engineFor(transcript, payload).engine.generate(fixtureInput({
    transcriptRevision: transcript,
    source: source({ durationMs: transcript.segments.at(-1).endMs })
  }));
  assert.deepEqual(result.data.actionItems[0].amount, { value: '100000', currency: 'CNY' });

  const bareTranscript = transcriptRevision(['预算是100000。']);
  const barePayload = modelPayload(bareTranscript, {
    actionItems: [{
      content: bareTranscript.segments[0].text,
      owner: 'unresolved',
      dueDate: 'unresolved',
      amount: { value: '100000', currency: 'CNY' },
      quantity: 'unresolved',
      status: 'candidate',
      evidenceHints: [hint(bareTranscript, 0)]
    }]
  });
  const bareResult = await engineFor(bareTranscript, barePayload).engine.generate(fixtureInput({
    transcriptRevision: bareTranscript,
    source: source({ durationMs: bareTranscript.segments.at(-1).endMs })
  }));
  assert.equal(bareResult.data.actionItems[0].amount, 'unresolved');
});

test('engine keeps missing owner, vague date, approximate amount, and missing quantity unresolved', async () => {
  const transcript = transcriptRevision();
  const payload = modelPayload(transcript, {
    actionItems: [{
      content: TEXTS[4],
      owner: '销售团队',
      dueDate: '2026-08-18',
      amount: { value: '100000', currency: 'CNY' },
      quantity: { value: '1', unit: '项' },
      status: 'candidate',
      evidenceHints: [hint(transcript, 4)]
    }]
  });
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  const action = result.data.actionItems[0];
  assert.equal(action.owner, 'unresolved');
  assert.equal(action.dueDate, 'unresolved');
  assert.equal(action.amount, 'unresolved');
  assert.equal(action.quantity, 'unresolved');
  assert.equal(action.status, 'unresolved');
});

test('engine applies explicit correction language for owner without using speaker identity inference', async () => {
  const transcript = transcriptRevision();
  const payload = modelPayload(transcript, {
    actionItems: [{
      content: TEXTS[7],
      owner: '张强',
      ownerRef: 'speaker-1',
      dueDate: 'unresolved',
      amount: 'unresolved',
      quantity: 'unresolved',
      status: 'candidate',
      evidenceHints: [hint(transcript, 7)]
    }]
  });
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  const action = result.data.actionItems[0];
  assert.equal(action.owner, '张强');
  assert.equal(action.ownerRef, null);
  assert.equal(action.dueDate, 'unresolved');
});

test('engine normalizes corrected weekday dates from meeting metadata', async () => {
  const transcript = transcriptRevision();
  const payload = modelPayload(transcript, {
    actionItems: [{
      content: TEXTS[6],
      owner: 'unresolved',
      dueDate: '2026-08-20',
      amount: 'unresolved',
      quantity: 'unresolved',
      status: 'candidate',
      evidenceHints: [hint(transcript, 6)]
    }]
  });
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  assert.equal(result.data.actionItems[0].dueDate, '2026-08-20');
});

test('engine keeps a conditional action candidate unresolved while preserving explicit evidence', async () => {
  const transcript = transcriptRevision();
  const payload = modelPayload(transcript, {
    actionItems: [{
      content: TEXTS[5],
      owner: 'unresolved',
      dueDate: '2026-08-21',
      amount: 'unresolved',
      quantity: 'unresolved',
      status: 'candidate',
      evidenceHints: [hint(transcript, 5)]
    }]
  });
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  const action = result.data.actionItems[0];
  assert.equal(action.status, 'unresolved');
  assert.ok(action.evidenceRefs.length >= 1);
  assert.ok(action.unresolvedReasons.includes('CONDITIONAL_ACTION'));
});

test('engine excludes candidates that reference a nonexistent segment', async () => {
  const transcript = transcriptRevision();
  const payload = modelPayload(transcript, {
    summary: {
      ...modelPayload(transcript).summary,
      keyPoints: [{
        category: 'fact',
        content: '不存在的事实',
        evidenceHints: [{ segmentId: 'segment-does-not-exist', startOffset: 0, endOffset: 6, quote: '不存在的事实' }]
      }]
    }
  });
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  assert.equal(result.data.summary.keyPoints.length, 0);
  assert.ok(result.diagnostics.rejectedCandidates.some((item) => item.code === 'EVIDENCE_REJECTED'));
});

test('engine rejects evidence hints with invalid text spans or hashes instead of repairing them', async () => {
  const transcript = transcriptRevision();
  const payload = modelPayload(transcript, {
    summary: {
      ...modelPayload(transcript).summary,
      keyPoints: [{
        category: 'fact',
        content: TEXTS[2],
        evidenceHints: [hint(transcript, 2, TEXTS[2], { startOffset: 1 })]
      }]
    }
  });
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  assert.equal(result.data.summary.keyPoints.length, 0);
  assert.ok(result.diagnostics.rejectedCandidates.some((item) => item.code === 'EVIDENCE_REJECTED'));
});

test('engine fails closed on cross-owner input before invoking the model', async () => {
  const input = fixtureInput({ ownerContext: owner('owner-b') });
  const calls = [];
  const engine = new MeetingBrainEngine({ modelRunner: modelRunnerFor(input.transcriptRevision, modelPayload(input.transcriptRevision), calls) });
  await assert.rejects(engine.generate(input), (error) => error.code === 'OWNER_SCOPE_MISMATCH');
  assert.equal(calls.length, 0);
});

test('engine fails closed when the requested transcript revision is stale', async () => {
  const input = fixtureInput({ currentTranscriptRevision: transcriptRevision(TEXTS, 2) });
  const { engine, calls } = engineFor(input.transcriptRevision, modelPayload(input.transcriptRevision));
  const result = await engine.generate(input);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MEETING_TRANSCRIPT_REVISION_STALE');
  assert.equal(calls.length, 0);
});

test('engine maps provider timeout to AI_ANALYSIS_UNAVAILABLE without returning partial data', async () => {
  const engine = new MeetingBrainEngine({ modelRunner: async () => ({ error: { code: 'TIMEOUT' }, content: '' }) });
  const result = await engine.generate(fixtureInput());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(result.data, null);
});

test('engine maps invalid JSON to AI_ANALYSIS_UNAVAILABLE', async () => {
  const engine = new MeetingBrainEngine({ modelRunner: async () => ({ content: '{"summary":' }) });
  const result = await engine.generate(fixtureInput());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(result.diagnostics.reason, 'INVALID_JSON');
});

test('engine accepts a structured result wrapped in harmless model prose', async () => {
  const transcript = transcriptRevision();
  const payload = modelPayload(transcript);
  const engine = new MeetingBrainEngine({
    modelRunner: async () => ({
      content: `下面是会议整理结果：\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n以上。`
    })
  });
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  assert.equal(result.ok, true);
  assert.equal(result.code, 'MEETING_BRAIN_READY');
});

test('engine accepts common labeled fields from a valid model JSON response', async () => {
  const transcript = transcriptRevision();
  const payload = {
    summary: {
      topic: { topic: TEXTS[0], evidenceHints: [hint(transcript, 0)] },
      overview: { overview: TEXTS[0], evidenceHints: [hint(transcript, 0)] },
      keyPoints: [{ point: TEXTS[2], evidenceHints: [hint(transcript, 2)] }],
      conclusions: [{ conclusion: TEXTS[1], evidenceHints: [hint(transcript, 1)] }],
      openQuestions: [{ question: TEXTS[8], evidenceHints: [hint(transcript, 8)] }]
    },
    decisions: [],
    actionItems: []
  };
  const { engine } = engineFor(transcript, payload);
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));

  assert.equal(result.ok, true);
  assert.equal(result.code, 'MEETING_BRAIN_READY');
  assert.equal(result.data.summary.topic.value, TEXTS[0]);
  assert.equal(result.data.summary.overview.value, TEXTS[0]);
  assert.equal(result.data.summary.keyPoints[0].content, TEXTS[2]);
  assert.ok(result.data.evidenceRefs.length >= 1);
});

test('engine maps partial JSON to AI_ANALYSIS_UNAVAILABLE instead of saving an empty meeting result', async () => {
  const engine = new MeetingBrainEngine({ modelRunner: async () => ({ content: JSON.stringify({ summary: {} }) }) });
  const result = await engine.generate(fixtureInput());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(result.diagnostics.reason, 'PARTIAL_JSON');
});

test('engine maps provider rate limits and unavailable responses to one bounded failure contract', async () => {
  for (const response of [
    { error: { code: 'RATE_LIMITED' } },
    { error: { code: 'PROVIDER_UNAVAILABLE' } },
    { content: '' }
  ]) {
    const engine = new MeetingBrainEngine({ modelRunner: async () => response });
    const result = await engine.generate(fixtureInput());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AI_ANALYSIS_UNAVAILABLE');
    assert.equal(result.data, null);
  }
});

test('engine retries transient model failures with the same idempotency key and never returns the first partial result', async () => {
  const transcript = transcriptRevision();
  const calls = [];
  let attempt = 0;
  const payload = modelPayload(transcript);
  const engine = new MeetingBrainEngine({
    now: () => new Date(NOW),
    maxAttempts: 2,
    modelRunner: async (task) => {
      calls.push(task);
      attempt += 1;
      if (attempt === 1) return { error: { code: 'TIMEOUT' } };
      return { content: JSON.stringify(payload) };
    }
  });
  const result = await engine.generate(fixtureInput({ transcriptRevision: transcript }));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].metadata.idempotencyKey, calls[1].metadata.idempotencyKey);
  assert.equal(result.diagnostics.retries, 1);
});

test('bounded transcript analysis sends every complete segment and retains distant evidence references', async () => {
  const texts = Array.from({ length: 18 }, (_, index) => `远端结论${index}：这是完整的第${index}段会议文字。`);
  const transcript = transcriptRevision(texts);
  const calls = [];
  const modelRunner = async (task) => {
    calls.push(task);
    const index = task.metadata.batchSegmentIds.indexOf(transcript.segments.at(-1).segmentId) >= 0 ? texts.length - 1 : 0;
    const segment = transcript.segments[index];
    return {
      content: JSON.stringify({
        summary: {
          topic: { content: segment.text, evidenceHints: [hint(transcript, index)] },
          overview: { content: segment.text, evidenceHints: [hint(transcript, index)] },
          keyPoints: [{ category: 'fact', content: segment.text, evidenceHints: [hint(transcript, index)] }],
          conclusions: [],
          openQuestions: []
        },
        decisions: [],
        actionItems: []
      })
    };
  };
  const { engine } = engineFor(transcript, {}, { modelRunner, maxBatchChars: 40 });
  const result = await engine.generate(fixtureInput({
    transcriptRevision: transcript,
    source: source({ durationMs: transcript.segments.at(-1).endMs })
  }));
  const seenIds = new Set(calls.flatMap((task) => task.metadata.batchSegmentIds));
  assert.equal(seenIds.size, texts.length);
  assert.ok(calls.every((task) => task.metadata.batchSegmentIds.length >= 1));
  assert.ok(texts.every((text) => calls.some((task) => task.input.includes(text))));
  assert.ok(calls.some((task) => task.metadata.batchSegmentIds.includes(transcript.segments.at(-1).segmentId)));
  assert.ok(result.data.summary.keyPoints.some((item) => item.content === texts.at(-1)));
});

test('engine analyzes a 60-plus-minute transcript in complete bounded segments without truncation', async () => {
  const texts = Array.from({ length: 90 }, (_, index) => `六十分钟远端段落${index}：保留完整原文。`);
  const transcript = transcriptRevision(texts, 1, 40_000);
  const calls = [];
  const modelRunner = async (task) => {
    calls.push(task);
    const segmentId = task.metadata.batchSegmentIds.at(-1);
    const index = transcript.segments.findIndex((segment) => segment.segmentId === segmentId);
    const segment = transcript.segments[index];
    return {
      content: JSON.stringify({
        summary: {
          topic: { content: segment.text, evidenceHints: [hint(transcript, index)] },
          overview: { content: segment.text, evidenceHints: [hint(transcript, index)] },
          keyPoints: [{ category: 'fact', content: segment.text, evidenceHints: [hint(transcript, index)] }],
          conclusions: [],
          openQuestions: []
        },
        decisions: [],
        actionItems: []
      })
    };
  };
  const { engine } = engineFor(transcript, {}, { modelRunner, maxBatchChars: 160 });
  const result = await engine.generate(fixtureInput({
    transcriptRevision: transcript,
    source: source({ durationMs: transcript.segments.at(-1).endMs })
  }));
  assert.equal(result.ok, true);
  assert.equal(new Set(calls.flatMap((task) => task.metadata.batchSegmentIds)).size, texts.length);
  assert.ok(calls.every((task) => {
    const sequence = Number(task.metadata.batchSegmentIds[0].match(/%3A(\d+)%3A/)[1]);
    return task.input.includes(texts[sequence]);
  }));
  assert.ok(result.data.summary.keyPoints.some((item) => item.content === texts.at(-1)));
});

test('engine deduplicates repeated candidates and produces stable ids for identical input', async () => {
  const transcript = transcriptRevision();
  const repeated = modelPayload(transcript);
  const payload = {
    ...repeated,
    summary: {
      ...repeated.summary,
      keyPoints: [repeated.summary.keyPoints[0], repeated.summary.keyPoints[0]]
    },
    decisions: [repeated.decisions[0], repeated.decisions[0]],
    actionItems: [repeated.actionItems[0], repeated.actionItems[0]]
  };
  const first = engineFor(transcript, payload).engine;
  const second = engineFor(transcript, payload).engine;
  const input = fixtureInput({ transcriptRevision: transcript });
  const one = await first.generate(input);
  const two = await second.generate(input);
  assert.deepEqual(one.data.summary, two.data.summary);
  assert.deepEqual(one.data.decisions, two.data.decisions);
  assert.deepEqual(one.data.actionItems, two.data.actionItems);
  assert.equal(one.data.summary.keyPoints.length, 1);
  assert.equal(one.data.decisions.length, 1);
  assert.equal(one.data.actionItems.length, 1);
});

test('engine returns only pure derived data and never exposes a persistence or task write result', async () => {
  const input = fixtureInput();
  const { engine } = engineFor(input.transcriptRevision);
  const result = await engine.generate(input);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.data, 'memoryId'), false);
  assert.equal(Object.hasOwn(result.data, 'taskId'), false);
  assert.equal(Object.hasOwn(result.data, 'calendarEventId'), false);
  assert.equal(Object.hasOwn(result.data, 'persisted'), false);
});

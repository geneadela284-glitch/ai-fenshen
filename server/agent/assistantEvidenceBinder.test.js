import assert from 'node:assert/strict';
import test from 'node:test';

import { bindAssistantToolEvidence } from './assistantEvidenceBinder.js';

const plan = {
  domain: 'tool', action: 'convert_calendar_date', tool: 'calendar.convert', arguments: {},
  required_evidence: [{ entity_relation: 'mother', predicate: 'birthday', required_qualifiers: ['month', 'day'] }],
  source_message_id: 'provider-forged'
};

function bundle(ownerId = 'owner-a') {
  return {
    source: 'memory_database', owner_id: ownerId,
    evidence: [{
      evidence_id: 'evidence-1', owner_id: ownerId, entity_id: 'mother-1', predicate: 'birthday',
      value: { kind: 'calendar_date', calendar_type: 'lunar', date: { year: null, month: 7, day: 16 }, lunar_leap_month: 'unknown' },
      qualifiers: { calendar_type: 'lunar', month: 7, day: 16, lunar_leap_month: 'unknown', recurrence: 'yearly' },
      source_message_id: 'memory-source', version: 2, status: 'confirmed'
    }]
  };
}

test('Evidence Binder uses authenticated owner and binds the server source message', async () => {
  const calls = [];
  const result = await bindAssistantToolEvidence(plan, {
    ownerId: 'owner-a', conversationId: 'conversation-a', sourceMessageId: 'server-source',
    memoryIntegration: { async resolveToolEvidence(input) { calls.push(input); return bundle(); } }
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.source_message_id, 'server-source');
  assert.equal(calls[0].ownerId, 'owner-a');
  assert.equal(JSON.stringify(result.plan).includes('owner-a'), false);
});

test('Evidence Binder treats Provider qualifier labels as hints and leaves canonical field authority to Tool Contract', async () => {
  const hinted = {
    ...plan,
    required_evidence: [{ entity_relation: 'mother', predicate: 'birthday', required_qualifiers: ['lunar_month', 'lunar_day'] }]
  };
  const result = await bindAssistantToolEvidence(hinted, {
    ownerId: 'owner-a', conversationId: 'conversation-a', sourceMessageId: 'server-source',
    memoryIntegration: { async resolveToolEvidence() { return bundle(); } }
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceBundle.evidence[0].qualifiers.month, 7);
});

test('Evidence Binder rejects absent and cross-owner Memory Evidence', async () => {
  const absent = await bindAssistantToolEvidence(plan, {
    ownerId: 'owner-a', conversationId: 'conversation-a', sourceMessageId: 'source',
    memoryIntegration: { async resolveToolEvidence() { return bundle('owner-a').evidence.splice(0, 0) && { owner_id: 'owner-a', evidence: [] }; } }
  });
  assert.equal(absent.ok, false);
  assert.equal(absent.code, 'TOOL_EVIDENCE_NOT_FOUND');
  const crossed = await bindAssistantToolEvidence(plan, {
    ownerId: 'owner-a', conversationId: 'conversation-a', sourceMessageId: 'source',
    memoryIntegration: { async resolveToolEvidence() { return bundle('owner-b'); } }
  });
  assert.equal(crossed.ok, false);
  assert.equal(crossed.code, 'TOOL_EVIDENCE_OWNER_MISMATCH');
});

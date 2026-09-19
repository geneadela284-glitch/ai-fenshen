import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryEvidenceBundle } from './memoryEvidenceBundle.js';
import { validateGroundedMemoryResponse } from './groundedMemoryResponder.js';

function birthdayRecord(ownerUserId = 'owner-a') {
  return {
    memoryId: 'memory-1', ownerUserId, subjectEntityId: 'ent_11111111111111111111111111111111',
    predicate: 'birthday', structuredValue: {
      date: '2000-07-16', calendarType: 'lunar', year: null, month: 7, day: 16,
      lunarLeapMonth: 'unknown', recurrence: 'yearly'
    }, confidence: 0.98, source: { type: 'conversation_message', id: 'message-1' }, version: 1,
    status: 'confirmed', metadata: { sourceMessageId: 'message-1' }
  };
}

test('Evidence Bundle binds current owner and required source/version/qualifiers fields', () => {
  const bundle = buildMemoryEvidenceBundle({ ownerId: 'owner-a', records: [birthdayRecord()] });
  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.evidence[0].source_message_id, 'message-1');
  assert.equal(bundle.evidence[0].qualifiers.calendar_type, 'lunar');
  assert.equal(bundle.evidence[0].version, 1);
  assert.throws(() => buildMemoryEvidenceBundle({ ownerId: 'owner-b', records: [birthdayRecord('owner-a')] }), /OWNER_SCOPE/);
});

test('coverage accepts cited evidence and rejects an invented personal fact', () => {
  const bundle = buildMemoryEvidenceBundle({ ownerId: 'owner-a', records: [birthdayRecord()] });
  const accepted = validateGroundedMemoryResponse({
    answer: '你妈妈是农历七月十六生日。',
    citations: [bundle.evidence[0].evidence_id],
    claims: [{ evidence_id: bundle.evidence[0].evidence_id, predicate: 'birthday', value: bundle.evidence[0].value }]
  }, { bundle, subjectLabel: '妈妈' });
  assert.equal(accepted.valid, true);
  const invented = validateGroundedMemoryResponse({
    answer: '你妈妈还喜欢蓝莓。', citations: [bundle.evidence[0].evidence_id],
    claims: [{ evidence_id: bundle.evidence[0].evidence_id, predicate: 'likes_food', value: ['蓝莓'] }]
  }, { bundle, subjectLabel: '妈妈' });
  assert.equal(invented.valid, false);
  assert.equal(invented.code, 'EVIDENCE_COVERAGE_FAILED');
});

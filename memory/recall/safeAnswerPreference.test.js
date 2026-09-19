import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSafeAnswerV2 } from './safeAnswerV2.js';

test('preference Safe Answer formats grounded evidence without Provider invention', () => {
  const answer = buildSafeAnswerV2({
    type: 'fact',
    groundingResult: {
      grounded: true,
      ownerUserId: 'owner-a',
      subjectEntityId: 'ent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      predicate: 'preference_statement',
      structuredValue: { value: '草莓' },
      evidenceMemoryIds: ['memory-preference']
    }
  });
  assert.equal(answer.safeUserMessage, '草莓。');
  assert.deepEqual(answer.immutableFact, { value: '草莓' });
});

test('multi-value preferences and favorite preferences use separate deterministic formatters', () => {
  const likes = buildSafeAnswerV2({
    type: 'fact',
    groundingResult: {
      grounded: true,
      ownerUserId: 'owner-a',
      subjectEntityId: 'ent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      predicate: 'preference_statement',
      structuredValue: { value: '苹果、草莓', values: ['苹果', '草莓'] },
      evidenceMemoryIds: ['memory-likes']
    }
  });
  assert.equal(likes.safeUserMessage, '苹果、草莓。');
  const favorite = buildSafeAnswerV2({
    type: 'fact',
    groundingResult: {
      grounded: true,
      ownerUserId: 'owner-a',
      subjectEntityId: 'ent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      predicate: 'favorite_preference_statement',
      structuredValue: { value: '芒果' },
      evidenceMemoryIds: ['memory-favorite']
    }
  });
  assert.equal(favorite.safeUserMessage, '芒果。');
});

import { createFoundationState, memoryScopeKey, memoryKey } from '../entity/inMemoryFoundationState.js';
import { validateEntity, validateEntityAlias, validateEntityRelation, validateMemoryRecordV2 } from '../entity/validation.js';

const fail = () => { throw Object.assign(new Error('Local memory snapshot failed validation.'), { code: 'LOCAL_MEMORY_CORRUPT' }); };
export function encodeSnapshot(ownerUserId, state, requests) {
  return JSON.stringify({ schemaVersion: 'mobile-memory-v2:1', ownerUserId,
    state: Object.fromEntries(Object.entries(state).map(([key, map]) => [key,
      [...map.entries()].map(([k, v]) => [k, v instanceof Set ? [...v] : v])])), requests });
}
export function decodeSnapshot(ownerUserId, data) {
  if (data === null) return { state: createFoundationState(), requests: {} };
  try {
    const parsed = JSON.parse(data);
    if (parsed.schemaVersion !== 'mobile-memory-v2:1' || parsed.ownerUserId !== ownerUserId || !parsed.requests || Array.isArray(parsed.requests)) fail();
    const state = createFoundationState();
    if (Object.keys(parsed.state).length !== Object.keys(state).length) fail();
    for (const key of Object.keys(state)) {
      if (!Array.isArray(parsed.state[key])) fail();
      state[key] = new Map(parsed.state[key]);
      if (state[key].size !== parsed.state[key].length) fail();
    }
    for (const [kind, validate] of Object.entries({ entities: validateEntity, aliases: validateEntityAlias,
      relations: validateEntityRelation, memories: validateMemoryRecordV2 })) {
      for (const record of state[kind].values()) {
        if (record.ownerUserId !== ownerUserId || !validate(record, { trustedOwnerUserId: ownerUserId }).valid) fail();
      }
    }
    // Derived indexes are checked against the records; never trust serialized index membership.
    const expected = new Map();
    for (const [key, record] of state.memories) {
      if (key !== memoryKey(ownerUserId, record.memoryId)) fail();
      const scope = memoryScopeKey(ownerUserId, record.subjectEntityId, record.predicate);
      if (!expected.has(scope)) expected.set(scope, new Set());
      expected.get(scope).add(key);
    }
    for (const [key, members] of state.memoryScopeIndex) {
      if (!Array.isArray(members) || !expected.has(key) || members.length !== expected.get(key).size || members.some(x => !expected.get(key).has(x))) fail();
    }
    if (state.memoryScopeIndex.size !== expected.size) fail();
    state.memoryScopeIndex = expected;
    return { state, requests: parsed.requests };
  } catch { return fail(); }
}

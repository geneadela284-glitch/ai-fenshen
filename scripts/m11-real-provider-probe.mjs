import { createCoreAiService } from '../server/coreAiService.js';
import { createGroundedMemoryResponder } from '../server/memory/groundedMemoryResponder.js';
import { buildMemoryEvidenceBundle } from '../server/memory/memoryEvidenceBundle.js';
import { createSemanticMemoryPlanner } from '../server/memory/semanticMemoryPlanner.js';

const configPath = process.env.AI_SECRETARY_AI_CONFIG;
if (!configPath) throw new Error('AI_SECRETARY_AI_CONFIG is required.');

const aiService = createCoreAiService({ configPath });
const planner = createSemanticMemoryPlanner({ aiService, timeoutMs: 12000 });
const allCases = [
  {
    id: 'lunar-capture', message: '请记录我妈妈是阴历7月16日生日',
    expected: { intent: 'memory_candidate', relation: 'mother', predicate: 'birthday', calendar: 'lunar' }
  },
  {
    id: 'unknown-calendar-capture', message: '我妈妈7月16日生日',
    expected: { intent: 'memory_candidate', relation: 'mother', predicate: 'birthday' }
  },
  {
    id: 'context-calendar-correction', message: '刚才那个日期是阴历的',
    contextPack: {
      recent_messages: [{ role: 'user', content: '我妈妈7月16日生日' }],
      inherited_context: { previous_entity: 'mother', previous_predicate: 'birthday', previously_returned_values: [] }
    },
    expected: { intent: 'memory_correction', relation: 'mother', predicate: 'birthday', calendar: 'lunar' }
  },
  {
    id: 'multi-value-like', message: '她也喜欢草莓',
    contextPack: {
      recent_messages: [{ role: 'user', content: '我女儿喜欢苹果' }],
      inherited_context: { previous_entity: 'daughter', previous_predicate: 'likes_food', previously_returned_values: [] }
    },
    expected: { intent: 'memory_candidate', relation: 'daughter', predicate: 'likes_food' }
  },
  {
    id: 'birthday-query', message: '我妈妈什么时候生日？',
    expected: { intent: 'memory_query', relation: 'mother', predicate: 'birthday' }
  },
  {
    id: 'ordinary-chat', message: '今天心情不错',
    expected: { intent: 'ordinary_chat' }
  }
];
const limit = Math.max(1, Math.min(allCases.length, Number(process.env.M11_PROBE_LIMIT || allCases.length)));
const cases = process.env.M11_GROUNDED_ONLY === 'true' ? [] : allCases.slice(0, limit);

let passed = 0;
for (const entry of cases) {
  const result = await planner.plan({ message: entry.message, contextPack: entry.contextPack || { recent_messages: [] } });
  const plan = result.plan || {};
  const ok = result.ok === true &&
    plan.intent === entry.expected.intent &&
    (!entry.expected.relation || plan.subject?.relation_to_owner === entry.expected.relation) &&
    (!entry.expected.predicate || plan.predicate === entry.expected.predicate) &&
    (!entry.expected.calendar || plan.qualifiers?.calendar_type === entry.expected.calendar);
  if (ok) passed += 1;
  const diagnostic = Array.isArray(result.errors) ? `:${result.errors.join('|')}` : '';
  const semanticShape = result.ok && !ok
    ? `:intent=${String(plan.intent)}:relation=${String(plan.subject?.relation_to_owner)}:predicate=${String(plan.predicate)}:calendar=${String(plan.qualifiers?.calendar_type)}`
    : '';
  console.log(`CASE_${entry.id}=${ok ? 'PASS' : `FAIL:${result.code || 'SEMANTIC_MISMATCH'}${diagnostic}${semanticShape}`}`);
}

console.log(`PROVIDER_AVAILABLE=${aiService.getStatus().available ? 'YES' : 'NO'}`);
console.log(`REAL_PROVIDER_CASES=${cases.length}`);
console.log(`REAL_PROVIDER_PASSED=${passed}`);
if (passed !== cases.length) process.exitCode = 1;

if (process.env.M11_GROUNDED_ONLY === 'true') {
  const record = {
    memoryId: 'probe-memory-1', ownerUserId: 'probe-owner',
    subjectEntityId: 'ent_11111111111111111111111111111111', predicate: 'birthday',
    structuredValue: {
      date: '2000-07-16', calendarType: 'lunar', year: null, month: 7, day: 16,
      lunarLeapMonth: 'unknown', recurrence: 'yearly'
    },
    confidence: 0.98, source: { type: 'conversation_message', id: 'probe-message-1' },
    metadata: { sourceMessageId: 'probe-message-1' }, version: 1, status: 'confirmed', supersededById: null
  };
  const bundle = buildMemoryEvidenceBundle({ ownerId: 'probe-owner', records: [record] });
  const responder = createGroundedMemoryResponder({ aiService, timeoutMs: 12000 });
  const grounded = await responder.respond({ bundle, subjectLabel: '妈妈' });
  const ok = grounded.source === 'provider_covered';
  console.log(`GROUNDED_RESPONSE=${ok ? 'PASS' : `FAIL:${grounded.source}`}`);
  if (!ok) process.exitCode = 1;
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAssistantToolPlanner } from './assistantToolPlanner.js';
import { parseAssistantToolPlanResponse } from './assistantToolPlanSchema.js';

function toolPlan(overrides = {}) {
  return {
    domain: 'tool',
    action: 'convert_calendar_date',
    tool: 'calendar.convert',
    arguments: {
      source_calendar: 'lunar', target_calendar: 'gregorian',
      target_year_reference: 'this_year', occurrence: 'specified_year'
    },
    required_evidence: [{
      entity_relation: 'mother', predicate: 'birthday',
      required_qualifiers: ['calendar_type', 'month', 'day', 'lunar_leap_month']
    }],
    inherited_context: { previous_entity: 'mother', previous_predicate: 'birthday', previous_tool: null },
    confidence: 0.97,
    ambiguity: [],
    requires_confirmation: false,
    source_message_id: null,
    ...overrides
  };
}

test('Assistant Tool Plan schema is generic and accepts non-calendar registered tool shapes', () => {
  const plan = toolPlan({
    action: 'extract_document', tool: 'document.extract', arguments: { format: 'pdf' },
    required_evidence: []
  });
  const parsed = parseAssistantToolPlanResponse(JSON.stringify(plan));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.value.tool, 'document.extract');
});

test('Assistant Tool Plan rejects owner authority and malformed containers', () => {
  const owner = parseAssistantToolPlanResponse(JSON.stringify(toolPlan({ arguments: { owner_id: 'forged' } })));
  assert.equal(owner.valid, false);
  assert.match(owner.errors.join(','), /owner/i);
  const malformed = parseAssistantToolPlanResponse(JSON.stringify(toolPlan({ required_evidence: 'mother' })));
  assert.equal(malformed.valid, false);
  const extra = parseAssistantToolPlanResponse(JSON.stringify(toolPlan({ unreviewed_field: true })));
  assert.equal(extra.valid, false);
});

test('Assistant Tool Planner retries invalid structured output once and never forwards owner context', async () => {
  const calls = [];
  const planner = createAssistantToolPlanner({
    toolDescriptors: [{ id: 'calendar.convert', description: 'Convert a calendar date deterministically.' }],
    aiService: {
      async run(request) {
        calls.push(request);
        return calls.length === 1
          ? { ok: true, content: '{}' }
          : { ok: true, content: JSON.stringify(toolPlan()) };
      }
    }
  });
  const result = await planner.plan({
    message: '今年对应公历哪一天？', sourceMessageId: 'source-1',
    contextPack: { owner_id: 'must-not-leak', recent_messages: [] }
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.plan.source_message_id, 'source-1');
  assert.equal(JSON.stringify(calls).includes('must-not-leak'), false);
});

test('Assistant Tool Planner fails closed after the single structured retry', async () => {
  let calls = 0;
  const planner = createAssistantToolPlanner({
    toolDescriptors: [{ id: 'calendar.convert', description: 'Convert a calendar date deterministically.' }],
    aiService: { async run() { calls += 1; return { ok: true, content: '{}' }; } }
  });
  const result = await planner.plan({ message: '需要工具', sourceMessageId: 'source-2' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ASSISTANT_TOOL_PLAN_INVALID');
  assert.equal(calls, 2);
});

test('Assistant Tool Planner retries a structurally valid but unregistered tool-specific Plan', async () => {
  let calls = 0;
  const planner = createAssistantToolPlanner({
    toolDescriptors: [{ id: 'calendar.convert', description: 'Calendar', actions: ['convert_calendar_date'] }],
    validatePlan(id, value) {
      return value.action === 'convert_calendar_date'
        ? { ok: true, errors: [] }
        : { ok: false, errors: ['calendar.action: invalid'] };
    },
    aiService: { async run() {
      calls += 1;
      return { ok: true, content: JSON.stringify(calls === 1 ? toolPlan({ action: 'store_memory' }) : toolPlan()) };
    } }
  });
  const result = await planner.plan({ message: '需要工具', sourceMessageId: 'source-3' });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

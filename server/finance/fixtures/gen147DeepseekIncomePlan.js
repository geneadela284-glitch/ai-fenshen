// Captured from the isolated Generation 147 DeepSeek replay.
// Source evidence: /private/tmp/gen147-finance-repeat/income-01/evidence.json
// The fixture is intentionally complete; only conflict fields are mutated by tests.
export const GEN147_DEEPSEEK_INCOME_PLAN = Object.freeze({
  domain: 'finance',
  intent: 'create',
  action: 'create_transaction',
  entity: { type: 'transaction', reference: null, relation_to_owner: 'owner' },
  relation_to_owner: 'owner',
  predicate: 'income',
  value: '500',
  qualifiers: { currency: 'CNY', relative_day_offset: 0 },
  tool: null,
  arguments: {},
  required_evidence: [],
  explicit_fields: ['predicate', 'value'],
  inherited_fields: ['qualifiers.currency', 'qualifiers.relative_day_offset'],
  ambiguity_reasons: [],
  confidence: 0.95,
  requires_confirmation: false,
  source_spans: [
    { start: 0, end: 4, text: '记一笔' },
    { start: 4, end: 6, text: '收入' },
    { start: 6, end: 11, text: '500元' }
  ],
  source_message_id: null
});

export const GEN147_INCOME_MESSAGE = '记一笔收入500元';

export const TOOL_RISK_LEVELS = Object.freeze([
  'read_only',
  'draft',
  'confirm_required',
  'destructive',
  'external_side_effect'
]);

export const TOOL_PROPOSAL_FIELDS = Object.freeze([
  'proposalId', 'requestId', 'toolName', 'arguments', 'riskLevel',
  'confirmationRequired', 'idempotencyKey', 'reason', 'confidence', 'createdAt'
]);

export const TOOL_PROPOSAL_SCHEMA_V1 = Object.freeze({
  schemaVersion: 'v1',
  fields: TOOL_PROPOSAL_FIELDS,
  riskLevels: TOOL_RISK_LEVELS,
  executionPolicy: 'proposal-only'
});

export function inferToolRiskLevel(toolName = '', args = {}) {
  const name = String(toolName).toLowerCase();
  if (/(delete|remove|destroy|forget|purge)/.test(name)) return 'destructive';
  if (/(send|email\.send|invite|share|publish|upload_external|dispatch)/.test(name)) return 'external_side_effect';
  if (/(expense|income|balance|payment|finance|amount|transaction)/.test(name)
    && /(create|write|save|update|record|post)/.test(name)) return 'confirm_required';
  if (/(draft|preview|propose|prepare)/.test(name)) return 'draft';
  if (/^(get|read|list|query|search|lookup|find)|\.(get|read|list|query|search|lookup|find)$/.test(name)) return 'read_only';
  if (Object.prototype.hasOwnProperty.call(args || {}, 'amount')) return 'confirm_required';
  return 'confirm_required';
}

export function createToolProposal(input = {}) {
  const riskLevel = inferToolRiskLevel(input.toolName, input.arguments);
  const proposalId = input.proposalId || '';
  const requestId = input.requestId || '';
  return {
    proposalId,
    requestId,
    toolName: input.toolName || '',
    arguments: input.arguments === undefined ? {} : structuredClone(input.arguments),
    riskLevel,
    confirmationRequired: !['read_only', 'draft'].includes(riskLevel),
    idempotencyKey: input.idempotencyKey || `${requestId}:${input.toolName || 'tool'}:${proposalId}`,
    reason: input.reason || '',
    confidence: input.confidence ?? null,
    createdAt: input.createdAt || new Date().toISOString()
  };
}

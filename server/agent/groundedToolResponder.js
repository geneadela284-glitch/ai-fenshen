const UNSAFE = /(?:undefined|null|owner_id|ownerId|\.sqlite|\/opt\/)/;

export function finalizeGroundedToolResponse({ evidenceBundle, toolResult } = {}) {
  if (!Array.isArray(evidenceBundle?.evidence) || evidenceBundle.evidence.length === 0 || !toolResult?.ok || !toolResult.data) {
    return { ok: false, code: 'TOOL_RESULT_COVERAGE_FAILED' };
  }
  const available = new Set(evidenceBundle.evidence.map((item) => item.evidence_id));
  if (!Array.isArray(toolResult.evidence_ids) || toolResult.evidence_ids.length === 0 || toolResult.evidence_ids.some((id) => !available.has(id))) {
    return { ok: false, code: 'TOOL_RESULT_COVERAGE_FAILED' };
  }
  const content = String(toolResult.safe_user_message || '').trim();
  if (!content || UNSAFE.test(content)) return { ok: false, code: 'TOOL_RESULT_COVERAGE_FAILED' };
  const date = String(toolResult.data.gregorian_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!date || !content.includes(`${Number(date[1])}年`) || !content.includes(`${Number(date[2])}月${Number(date[3])}日`)) {
    return { ok: false, code: 'TOOL_RESULT_COVERAGE_FAILED' };
  }
  return { ok: true, content, coverage: 'memory_and_tool' };
}

export async function bindAssistantToolEvidence(plan, {
  ownerId, conversationId, sourceMessageId, memoryIntegration
} = {}) {
  const owner = String(ownerId || '').trim();
  if (!owner) return { ok: false, code: 'TOOL_EVIDENCE_OWNER_REQUIRED' };
  if (!memoryIntegration?.resolveToolEvidence) return { ok: false, code: 'TOOL_EVIDENCE_UNAVAILABLE' };
  let bundle;
  try {
    bundle = await memoryIntegration.resolveToolEvidence({
      ownerId: owner,
      conversationId: String(conversationId || ''),
      requirements: structuredClone(plan.required_evidence || [])
    });
  } catch {
    return { ok: false, code: 'TOOL_EVIDENCE_UNAVAILABLE' };
  }
  if (bundle?.owner_id !== owner || (bundle?.evidence || []).some((item) => item.owner_id !== owner)) {
    return { ok: false, code: 'TOOL_EVIDENCE_OWNER_MISMATCH' };
  }
  if (!Array.isArray(bundle?.evidence) || bundle.evidence.length === 0) return { ok: false, code: 'TOOL_EVIDENCE_NOT_FOUND' };
  for (const requirement of plan.required_evidence || []) {
    const matched = bundle.evidence.some((item) => item.predicate === requirement.predicate &&
      item.status === 'confirmed');
    if (!matched) return { ok: false, code: 'TOOL_EVIDENCE_INCOMPLETE' };
  }
  return {
    ok: true,
    plan: Object.freeze({ ...structuredClone(plan), source_message_id: sourceMessageId || null }),
    evidenceBundle: bundle
  };
}

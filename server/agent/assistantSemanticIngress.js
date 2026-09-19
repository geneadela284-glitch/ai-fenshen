import { bindAssistantSemanticEvidence } from './assistantSemanticEvidenceBinder.js';
import { canonicalizeUnifiedProviderPlan } from './unifiedProviderPlanCanonicalizer.js';

export function createAssistantSemanticIngress({
  planner,
  canonicalizer = canonicalizeUnifiedProviderPlan,
  evidenceBinder = bindAssistantSemanticEvidence
} = {}) {
  if (!planner?.plan) throw new TypeError('Unified Assistant Semantic Ingress requires a planner.');
  return Object.freeze({
    async interpret(input) {
      const planned = await planner.plan(input);
      if (!planned?.ok) return planned;
      const canonical = canonicalizer(planned.plan, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        trustedContext: input.trustedContext,
        message: input.message,
        timezone: input.timezone,
        now: input.now
      });
      if (!canonical?.ok) return canonical;
      const bound = evidenceBinder(canonical.plan, {
        message: input.message,
        sourceMessageId: input.sourceMessageId,
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        trustedContext: input.trustedContext
      });
      if (!bound?.ok) return bound;
      return {
        ok: true,
        plan: bound.plan,
        evidence: bound.evidence,
        evidenceAudit: bound.auditReasons,
        canonicalAudit: canonical.audit,
        attempts: planned.attempts,
        source: planned.source,
        ...(planned.repair ? { repair: planned.repair } : {}),
        route: planned.route || null
      };
    }
  });
}

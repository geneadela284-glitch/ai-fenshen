const FORBIDDEN_INTERPRETATION = /(?:personality|psycholog|mental[_ -]?diagnos|future[_ -]?prediction|人格|心理分析|人生预测)/i;
const FORBIDDEN_ADVICE = /(?:health|medical|diagnos|financial|finance|investment|健康|医疗|诊断|财务|投资)/i;

function text(value) {
  return [value?.subject, value?.predicate, value?.title, value?.metadata?.sourcePredicate].filter(Boolean).join(' ');
}

export class InsightPolicy {
  evaluateArtifact(artifact) {
    if (!artifact || FORBIDDEN_INTERPRETATION.test(text(artifact))) {
      return Object.freeze({ allowed: false, reasonCode: 'LIFE_INTELLIGENCE_INTERPRETATION_FORBIDDEN' });
    }
    return Object.freeze({ allowed: true, reasonCode: 'LIFE_INTELLIGENCE_ARTIFACT_ALLOWED' });
  }

  allowsSuggestion(insight) {
    if (!insight || FORBIDDEN_INTERPRETATION.test(text(insight)) || FORBIDDEN_ADVICE.test(text(insight))) {
      return Object.freeze({ allowed: false, reasonCode: 'LIFE_INTELLIGENCE_SUGGESTION_FORBIDDEN' });
    }
    return Object.freeze({ allowed: true, reasonCode: 'LIFE_INTELLIGENCE_SUGGESTION_ALLOWED' });
  }
}

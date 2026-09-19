function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalizeFinancePlan(value) {
  if (!object(value)) return value;
  const inheritedContext = value.inherited_context === null
    ? { previous_action: null, previous_metrics: [], previous_period_type: null }
    : object(value.inherited_context) && value.inherited_context.previous_metrics === null
      ? { ...value.inherited_context, previous_metrics: [] }
      : value.inherited_context;
  return {
    ...value,
    ...(value.metrics === null ? { metrics: [] } : {}),
    ...(value.transaction_candidate === null ? { transaction_candidate: {} } : {}),
    ...(value.changes === null ? { changes: {} } : {}),
    ...(!Object.hasOwn(value, 'source_spans') || value.source_spans === null ? { source_spans: [] } : {}),
    ...(inheritedContext === value.inherited_context ? {} : { inherited_context: inheritedContext })
  };
}

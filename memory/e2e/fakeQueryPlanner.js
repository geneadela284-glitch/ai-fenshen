function required(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} is required.`);
  }
  return value;
}

export function createFakeQueryPlanner({ questions = {}, now = () => new Date().toISOString() } = {}) {
  const configured = new Map(Object.entries(questions));
  const calls = [];
  return Object.freeze({
    calls,
    plan({ ownerUserId, question, entityResolution, readMode = 'current', effectiveAt } = {}) {
      required(ownerUserId, 'ownerUserId');
      required(question, 'question');
      if (entityResolution?.resolutionStatus !== 'exact' || entityResolution.ownerUserId !== ownerUserId) {
        throw new TypeError('Fake Query Planner requires exact owner-scoped Entity resolution.');
      }
      const predicate = configured.get(question);
      if (predicate !== 'birthday') throw new TypeError('Fake Query Planner has no registered birthday plan.');
      if (!['current', 'historical'].includes(readMode)) throw new TypeError('readMode is invalid.');
      if (readMode === 'historical' && (typeof effectiveAt !== 'string' || Number.isNaN(Date.parse(effectiveAt)))) {
        throw new TypeError('Historical fake plan requires effectiveAt.');
      }
      const plan = Object.freeze({
        schemaVersion: 'v2',
        ownerUserId,
        subjectEntityId: entityResolution.entityId,
        predicate,
        queryMode: 'exact_entity_predicate',
        readMode,
        effectiveAt: readMode === 'historical' ? effectiveAt : now(),
        historicalRequested: readMode === 'historical',
        clarificationRequired: false,
        queryPurpose: 'answer_exact_person_fact',
        plannedAt: now()
      });
      calls.push(structuredClone({ ownerUserId, question, entityResolution, readMode, effectiveAt, plan }));
      return plan;
    }
  });
}

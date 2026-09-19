export const FAKE_NOW = '2030-01-02T03:04:05.000Z';

export function fakeUserContext(overrides = {}) {
  return {
    authenticatedUserId: 'fake-user-a',
    actorType: 'user',
    actorId: 'fake-user-a',
    requestId: 'fake-capture-request-001',
    correlationId: 'fake-capture-correlation-001',
    timestamp: FAKE_NOW,
    policyVersion: 'memory-capture-policy-v1',
    transactionId: null,
    metadata: { fixture: true },
    ...overrides
  };
}

export function fakeConversation(text, overrides = {}) {
  return {
    text,
    sourceId: 'fake-conversation-message-001',
    sourceTimestamp: FAKE_NOW,
    ...overrides
  };
}

export function fakeRepository() {
  const created = [];
  return {
    created,
    async create(context, record, options) {
      created.push(structuredClone({ context, record, options }));
      return structuredClone(record);
    },
    getById() {},
    query() { return { items: [], nextCursor: null }; },
    count() { return 0; },
    getVersionChain() {},
    getConflictGroup() {},
    createMany() {},
    update() {},
    confirm() {},
    reject() {},
    dispute() {},
    archive() {},
    expire() {},
    supersede() {},
    moveToRecycleBin() {},
    restore() {},
    purge() {},
    withTransaction() {}
  };
}

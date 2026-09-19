import assert from 'node:assert/strict';
import test from 'node:test';

import { createFinanceClient } from './financeClient.js';

const stateSubject = await import('./financeF201State.js').catch(() => ({}));

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('Finance F2.0-1 routing accepts only an explicit boolean true and otherwise keeps Legacy View', () => {
  assert.equal(typeof stateSubject.resolveFinanceViewMode, 'function');
  assert.equal(stateSubject.resolveFinanceViewMode({ financeF201Enabled: true }), 'f201');
  assert.equal(stateSubject.resolveFinanceViewMode({ financeF201Enabled: false }), 'legacy');
  assert.equal(stateSubject.resolveFinanceViewMode({ financeF201Enabled: 'true' }), 'legacy');
  assert.equal(stateSubject.resolveFinanceViewMode(), 'legacy');
});

test('Finance View creates F2 page state only when the strict frontend flag is enabled', () => {
  assert.equal(typeof stateSubject.createFinanceViewState, 'function');
  const client = { getHistory: async () => ({ entries: [], nextCursor: null, hasMore: false }) };
  const legacy = stateSubject.createFinanceViewState({ financeF201Enabled: false, client });
  const f201 = stateSubject.createFinanceViewState({ financeF201Enabled: true, client });
  assert.deepEqual(legacy, { mode: 'legacy', page: null });
  assert.equal(f201.mode, 'f201');
  assert.equal(typeof f201.page.loadHistory, 'function');
  assert.equal(f201.page.getState().mode, 'f201');
});

test('Finance F2.0-1 client serializes only approved history filters and never sends ownerId', async () => {
  const calls = [];
  const client = createFinanceClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return jsonResponse(200, {
        ok: true,
        entries: [{ id: 'entry-1' }],
        nextCursor: 'opaque-next',
        hasMore: true
      });
    }
  });

  const result = await client.getHistory({
    period: 'custom',
    startAt: '2026-07-01T00:00:00.000Z',
    endAt: '2026-08-01T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    types: ['expense'],
    categories: ['餐饮', '交通'],
    statuses: ['active', 'archived'],
    keyword: '早餐',
    limit: 20,
    cursor: 'opaque-current',
    ownerId: 'forged-owner'
  });

  const requested = new URL(calls[0].url, 'http://local.test');
  assert.equal(requested.pathname, '/api/finance/entries');
  assert.equal(requested.searchParams.get('period'), 'custom');
  assert.deepEqual(requested.searchParams.getAll('categories'), ['餐饮', '交通']);
  assert.equal(requested.searchParams.get('cursor'), 'opaque-current');
  assert.equal(requested.searchParams.has('ownerId'), false);
  assert.deepEqual(result, {
    entries: [{ id: 'entry-1' }],
    nextCursor: 'opaque-next',
    hasMore: true
  });
});

test('Finance F2.0-1 client exposes Revision and lifecycle contracts with version and stable Idempotency-Key', async () => {
  const calls = [];
  const client = createFinanceClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/revisions')) {
        return jsonResponse(200, { ok: true, revisions: [{ id: 'revision-1' }] });
      }
      return jsonResponse(200, { ok: true, entry: { id: 'entry-1', version: 2 } });
    }
  });

  assert.deepEqual(await client.getRevisions('entry-1'), [{ id: 'revision-1' }]);
  await client.updateEntry(
    'entry-1',
    { amountMinor: 2200, category: '餐饮', ownerId: 'forged-owner' },
    { expectedVersion: 1, mutationRequestId: 'stable-update' }
  );
  await client.deleteEntry('entry-1', { expectedVersion: 2, mutationRequestId: 'stable-delete', ownerId: 'forged-owner' });
  await client.restoreEntry('entry-1', { expectedVersion: 3, mutationRequestId: 'stable-restore' });
  await client.archiveEntry('entry-1', { expectedVersion: 4, mutationRequestId: 'stable-archive' });
  await client.unarchiveEntry('entry-1', { expectedVersion: 5, mutationRequestId: 'stable-unarchive' });

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method || 'GET']), [
    ['/api/finance/entries/entry-1/revisions', 'GET'],
    ['/api/finance/entries/entry-1', 'PATCH'],
    ['/api/finance/entries/entry-1', 'DELETE'],
    ['/api/finance/entries/entry-1/restore', 'POST'],
    ['/api/finance/entries/entry-1/archive', 'POST'],
    ['/api/finance/entries/entry-1/unarchive', 'POST']
  ]);
  assert.deepEqual(calls.slice(1).map(({ options }) => options.headers['Idempotency-Key']), [
    'stable-update', 'stable-delete', 'stable-restore', 'stable-archive', 'stable-unarchive'
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    amountMinor: 2200,
    category: '餐饮',
    expectedVersion: 1
  });
  assert.equal(calls.slice(1).some(({ options }) => String(options.body).includes('ownerId')), false);
});

test('Finance F2.0-1 client maps 401, 404, version/idempotency 409, 503 and network failures', async () => {
  const cases = [
    [401, {}, 'AUTH_REQUIRED'],
    [404, {}, 'NOT_FOUND'],
    [409, { code: 'FINANCE_VERSION_CONFLICT' }, 'VERSION_CONFLICT'],
    [409, { code: 'FINANCE_IDEMPOTENCY_CONFLICT' }, 'IDEMPOTENCY_CONFLICT'],
    [503, {}, 'STORAGE_UNAVAILABLE']
  ];
  for (const [status, body, expectedCode] of cases) {
    const client = createFinanceClient({ fetchImpl: async () => jsonResponse(status, body) });
    await assert.rejects(client.getHistory(), (error) => error?.code === expectedCode);
  }
  const offline = createFinanceClient({ fetchImpl: async () => { throw new TypeError('offline'); } });
  await assert.rejects(offline.getHistory(), (error) => error?.code === 'NETWORK_ERROR');
});

test('Finance F2.0-1 state clears stale cursor and entries when filters change', () => {
  assert.equal(typeof stateSubject.createFinanceF201State, 'function');
  assert.equal(typeof stateSubject.reduceFinanceF201State, 'function');
  let state = stateSubject.createFinanceF201State();
  state = stateSubject.reduceFinanceF201State(state, {
    type: 'history/succeeded',
    append: false,
    payload: { entries: [{ id: 'entry-1' }], nextCursor: 'cursor-2', hasMore: true }
  });
  state = stateSubject.reduceFinanceF201State(state, {
    type: 'filters/changed',
    filters: { categories: ['餐饮'] }
  });
  assert.deepEqual(state.query.filters.categories, ['餐饮']);
  assert.deepEqual(state.query.entries, []);
  assert.equal(state.query.nextCursor, null);
  assert.equal(state.query.hasMore, false);
  assert.equal(state.query.status, 'idle');
});

test('Finance F2.0-1 state tracks Revisions, delete/restore lifecycle, conflicts and privacy amount visibility', () => {
  let state = stateSubject.createFinanceF201State();
  state = stateSubject.reduceFinanceF201State(state, {
    type: 'revisions/succeeded',
    entryId: 'entry-1',
    revisions: [{ id: 'revision-1' }]
  });
  assert.equal(state.revisions.status, 'success');
  assert.deepEqual(state.revisions.items, [{ id: 'revision-1' }]);

  state = stateSubject.reduceFinanceF201State(state, {
    type: 'mutation/failed',
    operation: 'delete',
    entryId: 'entry-1',
    error: { code: 'VERSION_CONFLICT' }
  });
  assert.equal(state.mutation.operation, 'delete');
  assert.equal(state.mutation.status, 'error');
  assert.equal(state.mutation.conflict, 'version');

  state = stateSubject.reduceFinanceF201State(state, { type: 'privacy/toggled' });
  assert.equal(state.privacy.amountsHidden, false);
  state = stateSubject.reduceFinanceF201State(state, { type: 'privacy/toggled' });
  assert.equal(state.privacy.amountsHidden, true);
});

test('Finance F2.0-1 failed update preserves draft and reuses its request ID without optimistic amount changes', async () => {
  assert.equal(typeof stateSubject.createFinanceF201PageState, 'function');
  const requests = [];
  let updateAttempt = 0;
  const client = createFinanceClient({
    fetchImpl: async (url, options = {}) => {
      if ((options.method || 'GET') === 'GET') {
        return jsonResponse(200, {
          ok: true,
          entries: [{ id: 'entry-1', amountMinor: 1000, category: '餐饮', note: '', version: 1 }],
          nextCursor: null,
          hasMore: false
        });
      }
      requests.push({ url, options });
      updateAttempt += 1;
      return updateAttempt === 1
        ? jsonResponse(503, { ok: false })
        : jsonResponse(200, {
            ok: true,
            entry: { id: 'entry-1', amountMinor: 2500, category: '餐饮', note: '', version: 2 }
          });
    }
  });
  const page = stateSubject.createFinanceF201PageState({
    client,
    createRequestId: () => 'stable-request-id'
  });
  await page.loadHistory();
  page.openDraft(page.getState().query.entries[0]);
  page.changeDraft({ amountMinor: 2500 });

  const firstAttempt = page.saveDraft();
  assert.equal(page.getState().query.entries[0].amountMinor, 1000);
  await assert.rejects(firstAttempt, (error) => error?.code === 'STORAGE_UNAVAILABLE');
  assert.equal(page.getState().draft.dirty, true);
  assert.equal(page.getState().draft.values.amountMinor, 2500);
  assert.equal(page.getState().mutation.errorState, 'storage_unavailable');
  assert.equal(page.shouldConfirmLeave(), true);

  await page.saveDraft();
  assert.equal(page.getState().query.entries[0].amountMinor, 2500);
  assert.equal(page.getState().draft.dirty, false);
  assert.equal(requests[0].options.headers['Idempotency-Key'], 'stable-request-id');
  assert.equal(requests[1].options.headers['Idempotency-Key'], 'stable-request-id');
});

test('Finance F2.0-1 page state loads next cursor once and lifecycle writes wait for confirmed server entries', async () => {
  const responses = [
    jsonResponse(200, { ok: true, entries: [{ id: 'entry-1', amountMinor: 1000, version: 1 }], nextCursor: 'cursor-2', hasMore: true }),
    jsonResponse(200, { ok: true, entries: [{ id: 'entry-2', amountMinor: 2000, version: 1 }], nextCursor: null, hasMore: false }),
    jsonResponse(200, { ok: true, entry: { id: 'entry-1', amountMinor: 1000, version: 2, deletedAt: '2026-08-02T00:00:00.000Z' } }),
    jsonResponse(200, { ok: true, entry: { id: 'entry-1', amountMinor: 1000, version: 3, deletedAt: null } }),
    jsonResponse(200, { ok: true, entry: { id: 'entry-1', amountMinor: 1000, version: 4, archivedAt: '2026-08-02T00:00:00.000Z' } })
  ];
  const client = createFinanceClient({ fetchImpl: async () => responses.shift() });
  const page = stateSubject.createFinanceF201PageState({
    client,
    createRequestId: (() => { let value = 0; return () => `request-${++value}`; })()
  });
  await page.loadHistory();
  await page.loadNextPage();
  assert.deepEqual(page.getState().query.entries.map((entry) => entry.id), ['entry-1', 'entry-2']);
  assert.equal(page.getState().query.hasMore, false);

  const deletion = page.deleteEntry(page.getState().query.entries[0]);
  assert.equal(page.getState().query.entries[0].deletedAt, undefined);
  await deletion;
  assert.ok(page.getState().query.entries[0].deletedAt);
  await page.restoreEntry(page.getState().query.entries[0]);
  assert.equal(page.getState().query.entries[0].deletedAt, null);
  await page.archiveEntry(page.getState().query.entries[0]);
  assert.ok(page.getState().query.entries[0].archivedAt);
});

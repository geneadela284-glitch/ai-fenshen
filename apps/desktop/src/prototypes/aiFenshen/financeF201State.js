const DEFAULT_FILTERS = Object.freeze({
  period: 'all_time',
  startAt: null,
  endAt: null,
  timezone: 'Asia/Shanghai',
  types: Object.freeze([]),
  categories: Object.freeze([]),
  statuses: Object.freeze(['active']),
  keyword: '',
  limit: 20
});

const DRAFT_FIELDS = ['amountMinor', 'category', 'note'];

function draftValues(entry = {}) {
  return Object.fromEntries(DRAFT_FIELDS.map((key) => [key, entry[key] ?? (key === 'note' ? '' : null)]));
}

function sameDraft(left = {}, right = {}) {
  return DRAFT_FIELDS.every((key) => left[key] === right[key]);
}

function mutationSignature(operation, entryId, payload) {
  return JSON.stringify([operation, entryId, Object.keys(payload || {}).sort().map((key) => [key, payload[key]])]);
}

function errorState(error) {
  if (error?.code === 'AUTH_REQUIRED') return 'auth_required';
  if (error?.code === 'NOT_FOUND') return 'not_found';
  if (error?.code === 'VERSION_CONFLICT') return 'version_conflict';
  if (error?.code === 'IDEMPOTENCY_CONFLICT') return 'idempotency_conflict';
  if (error?.code === 'STORAGE_UNAVAILABLE') return 'storage_unavailable';
  if (error?.code === 'NETWORK_ERROR') return 'network_error';
  return 'unknown';
}

function replaceEntry(entries, nextEntry) {
  return entries.map((entry) => entry.id === nextEntry?.id ? nextEntry : entry);
}

export function resolveFinanceViewMode({ financeF201Enabled } = {}) {
  return financeF201Enabled === true ? 'f201' : 'legacy';
}

export function createFinanceF201State() {
  return {
    mode: 'f201',
    query: {
      status: 'idle',
      filters: {
        ...DEFAULT_FILTERS,
        types: [],
        categories: [],
        statuses: ['active']
      },
      entries: [],
      nextCursor: null,
      hasMore: false,
      errorState: null
    },
    revisions: {
      status: 'idle',
      entryId: null,
      items: [],
      errorState: null
    },
    mutation: {
      status: 'idle',
      operation: null,
      entryId: null,
      requestId: null,
      signature: null,
      errorState: null,
      conflict: null
    },
    draft: {
      entryId: null,
      expectedVersion: null,
      originalValues: null,
      values: null,
      dirty: false
    },
    privacy: {
      amountsHidden: true
    }
  };
}

export function reduceFinanceF201State(state, action) {
  switch (action.type) {
    case 'filters/changed':
      return {
        ...state,
        query: {
          ...state.query,
          status: 'idle',
          filters: { ...state.query.filters, ...action.filters },
          entries: [],
          nextCursor: null,
          hasMore: false,
          errorState: null
        }
      };
    case 'history/loading':
      return { ...state, query: { ...state.query, status: 'loading', errorState: null } };
    case 'history/succeeded':
      return {
        ...state,
        query: {
          ...state.query,
          status: 'success',
          entries: action.append
            ? [...state.query.entries, ...(action.payload?.entries || [])]
            : [...(action.payload?.entries || [])],
          nextCursor: action.payload?.nextCursor || null,
          hasMore: action.payload?.hasMore === true,
          errorState: null
        }
      };
    case 'history/failed':
      return { ...state, query: { ...state.query, status: 'error', errorState: errorState(action.error) } };
    case 'revisions/loading':
      return {
        ...state,
        revisions: { status: 'loading', entryId: action.entryId, items: [], errorState: null }
      };
    case 'revisions/succeeded':
      return {
        ...state,
        revisions: {
          status: 'success',
          entryId: action.entryId,
          items: [...(action.revisions || [])],
          errorState: null
        }
      };
    case 'revisions/failed':
      return {
        ...state,
        revisions: {
          ...state.revisions,
          status: 'error',
          entryId: action.entryId,
          errorState: errorState(action.error)
        }
      };
    case 'draft/opened': {
      const values = draftValues(action.entry);
      return {
        ...state,
        draft: {
          entryId: action.entry?.id || null,
          expectedVersion: action.entry?.version ?? null,
          originalValues: values,
          values: { ...values },
          dirty: false
        }
      };
    }
    case 'draft/changed': {
      const values = { ...(state.draft.values || {}), ...(action.patch || {}) };
      return {
        ...state,
        draft: {
          ...state.draft,
          values,
          dirty: !sameDraft(values, state.draft.originalValues || {})
        }
      };
    }
    case 'draft/discarded':
      return { ...state, draft: createFinanceF201State().draft };
    case 'mutation/started':
      return {
        ...state,
        mutation: {
          status: 'loading',
          operation: action.operation,
          entryId: action.entryId,
          requestId: action.requestId,
          signature: action.signature,
          errorState: null,
          conflict: null
        }
      };
    case 'mutation/failed': {
      const mapped = errorState(action.error);
      return {
        ...state,
        mutation: {
          ...state.mutation,
          status: 'error',
          operation: action.operation || state.mutation.operation,
          entryId: action.entryId || state.mutation.entryId,
          errorState: mapped,
          conflict: mapped === 'version_conflict'
            ? 'version'
            : mapped === 'idempotency_conflict' ? 'idempotency' : null
        }
      };
    }
    case 'mutation/succeeded': {
      const entry = action.entry;
      const updateDraft = state.draft.entryId && state.draft.entryId === entry?.id;
      const values = updateDraft ? draftValues(entry) : state.draft.values;
      return {
        ...state,
        query: {
          ...state.query,
          entries: entry ? replaceEntry(state.query.entries, entry) : state.query.entries
        },
        mutation: {
          ...state.mutation,
          status: 'success',
          errorState: null,
          conflict: null
        },
        draft: updateDraft
          ? {
              entryId: entry.id,
              expectedVersion: entry.version ?? null,
              originalValues: values,
              values: { ...values },
              dirty: false
            }
          : state.draft
      };
    }
    case 'privacy/toggled':
      return { ...state, privacy: { amountsHidden: !state.privacy.amountsHidden } };
    default:
      return state;
  }
}

export function createFinanceF201PageState({ client, createRequestId = () => globalThis.crypto.randomUUID() } = {}) {
  if (!client || typeof client.getHistory !== 'function') throw new Error('Finance F2.0-1 client is required');
  if (typeof createRequestId !== 'function') throw new Error('createRequestId is required');
  let state = createFinanceF201State();

  const dispatch = (action) => {
    state = reduceFinanceF201State(state, action);
    return state;
  };

  const loadHistory = async ({ append = false } = {}) => {
    const cursor = append ? state.query.nextCursor : null;
    if (append && (!state.query.hasMore || !cursor)) return state;
    dispatch({ type: 'history/loading' });
    try {
      const result = await client.getHistory({
        ...state.query.filters,
        ...(cursor ? { cursor } : {})
      });
      dispatch({ type: 'history/succeeded', append, payload: result });
      return state;
    } catch (error) {
      dispatch({ type: 'history/failed', error });
      throw error;
    }
  };

  const loadRevisions = async (entryId) => {
    dispatch({ type: 'revisions/loading', entryId });
    try {
      const revisions = await client.getRevisions(entryId);
      dispatch({ type: 'revisions/succeeded', entryId, revisions });
      return revisions;
    } catch (error) {
      dispatch({ type: 'revisions/failed', entryId, error });
      throw error;
    }
  };

  const beginMutation = (operation, entryId, payload) => {
    const signature = mutationSignature(operation, entryId, payload);
    const retrying = state.mutation.status === 'error'
      && state.mutation.signature === signature
      && state.mutation.requestId;
    const requestId = retrying || String(createRequestId());
    dispatch({ type: 'mutation/started', operation, entryId, requestId, signature });
    return requestId;
  };

  const runMutation = async (operation, entry, payload, invoke) => {
    const requestId = beginMutation(operation, entry.id, payload);
    try {
      const nextEntry = await invoke({
        expectedVersion: entry.version,
        mutationRequestId: requestId
      });
      dispatch({ type: 'mutation/succeeded', entry: nextEntry });
      return nextEntry;
    } catch (error) {
      dispatch({ type: 'mutation/failed', operation, entryId: entry.id, error });
      throw error;
    }
  };

  const saveDraft = async () => {
    if (!state.draft.entryId || !state.draft.values) throw new Error('No Finance draft is open');
    const entry = {
      id: state.draft.entryId,
      version: state.draft.expectedVersion
    };
    const changes = { ...state.draft.values };
    return runMutation('update', entry, changes, (options) => (
      client.updateEntry(entry.id, changes, options)
    ));
  };

  const lifecycle = (operation, method) => async (entry) => runMutation(
    operation,
    entry,
    {},
    (options) => client[method](entry.id, options)
  );

  return {
    getState: () => state,
    setFilters(filters) {
      dispatch({ type: 'filters/changed', filters });
      return state;
    },
    loadHistory,
    loadNextPage: () => loadHistory({ append: true }),
    loadRevisions,
    openDraft(entry) {
      dispatch({ type: 'draft/opened', entry });
      return state;
    },
    changeDraft(patch) {
      dispatch({ type: 'draft/changed', patch });
      return state;
    },
    discardDraft() {
      dispatch({ type: 'draft/discarded' });
      return state;
    },
    shouldConfirmLeave: () => state.draft.dirty === true,
    saveDraft,
    deleteEntry: lifecycle('delete', 'deleteEntry'),
    restoreEntry: lifecycle('restore', 'restoreEntry'),
    archiveEntry: lifecycle('archive', 'archiveEntry'),
    unarchiveEntry: lifecycle('unarchive', 'unarchiveEntry'),
    togglePrivacyAmounts() {
      dispatch({ type: 'privacy/toggled' });
      return state;
    }
  };
}

export function createFinanceViewState({ financeF201Enabled = false, client, createRequestId } = {}) {
  const mode = resolveFinanceViewMode({ financeF201Enabled });
  return {
    mode,
    page: mode === 'f201'
      ? createFinanceF201PageState({ client, createRequestId })
      : null
  };
}

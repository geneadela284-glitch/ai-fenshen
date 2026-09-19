const SAFE_ERROR = '暂时无法读取账本，请稍后再试。';
const REPORT_ERROR = '报表暂时无法生成，请稍后再试。';
const REPORT_TYPES = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const CURRENT_MONTH_PDF_URL = '/api/finance/reports/current-month?format=pdf';

async function payload(response) {
  return response.json().catch(() => ({}));
}

function financeError(response, body = {}) {
  const status = Number(response?.status);
  const serverCode = String(body?.code || '');
  const error = new Error(status === 401 ? '请先登录。' : SAFE_ERROR);
  if (status === 401) error.code = 'AUTH_REQUIRED';
  else if (status === 404) error.code = 'NOT_FOUND';
  else if (status === 409 && serverCode === 'FINANCE_VERSION_CONFLICT') error.code = 'VERSION_CONFLICT';
  else if (status === 409 && serverCode === 'FINANCE_IDEMPOTENCY_CONFLICT') error.code = 'IDEMPOTENCY_CONFLICT';
  else if (status === 409) error.code = 'FINANCE_CONFLICT';
  else if (status === 503) error.code = 'STORAGE_UNAVAILABLE';
  else error.code = 'FINANCE_UNAVAILABLE';
  error.status = status;
  return error;
}

function mutationOptions(method, { expectedVersion, mutationRequestId } = {}, body = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (mutationRequestId !== undefined && mutationRequestId !== null && String(mutationRequestId).trim()) {
    headers['Idempotency-Key'] = String(mutationRequestId).trim();
  }
  const requestBody = { ...body };
  if (expectedVersion !== undefined) requestBody.expectedVersion = expectedVersion;
  return { method, headers, body: JSON.stringify(requestBody) };
}

function historyUrl(filters = {}) {
  const search = new URLSearchParams();
  for (const key of ['period', 'startAt', 'endAt', 'timezone', 'keyword', 'limit', 'cursor']) {
    if (filters[key] !== undefined && filters[key] !== null && String(filters[key]) !== '') {
      search.set(key, String(filters[key]));
    }
  }
  for (const key of ['types', 'categories', 'statuses']) {
    if (!Array.isArray(filters[key])) continue;
    for (const value of filters[key]) {
      if (String(value || '').trim()) search.append(key, String(value).trim());
    }
  }
  const query = search.toString();
  return `/api/finance/entries${query ? `?${query}` : ''}`;
}

function reportFilename(header, format) {
  const match = String(header || '').match(/filename\*=UTF-8''([^;]+)/i);
  if (!match) return `AI分身-本月收支报表.${format}`;
  try {
    const filename = decodeURIComponent(match[1]).split(/[\\/]/).pop();
    return filename && filename.endsWith(`.${format}`) ? filename : `AI分身-本月收支报表.${format}`;
  } catch {
    return `AI分身-本月收支报表.${format}`;
  }
}

export function openCurrentMonthPdf({ navigate = (url) => globalThis.location.assign(url) } = {}) {
  if (typeof navigate !== 'function') throw new Error(REPORT_ERROR);
  navigate(CURRENT_MONTH_PDF_URL);
  return CURRENT_MONTH_PDF_URL;
}

export function createFinanceClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  async function request(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, { credentials: 'include', ...options });
    } catch (cause) {
      const error = new Error(SAFE_ERROR, { cause });
      error.code = 'NETWORK_ERROR';
      throw error;
    }
    const body = await payload(response);
    if (!response.ok) throw financeError(response, body);
    return body;
  }
  return {
    async getOverview() {
      const body = await request('/api/finance/overview');
      return { summary: body.summary || {}, entries: body.entries || [], capabilities: body.capabilities || {} };
    },
    async downloadCurrentMonthReport(format) {
      const normalized = String(format || '').toLowerCase();
      const expectedType = REPORT_TYPES[normalized];
      if (!expectedType) throw new Error(REPORT_ERROR);
      const response = await fetchImpl(`/api/finance/reports/current-month?format=${normalized}`, { credentials: 'include' });
      if (!response.ok) {
        const error = new Error(response.status === 401 ? '请先登录。' : REPORT_ERROR);
        error.code = response.status === 401 ? 'AUTH_REQUIRED' : 'FINANCE_REPORT_UNAVAILABLE';
        throw error;
      }
      const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
      const blob = await response.blob();
      const expectedLength = Number(response.headers?.get?.('content-length'));
      if (contentType !== expectedType || blob.size <= 0 ||
          (Number.isFinite(expectedLength) && expectedLength >= 0 && expectedLength !== blob.size)) {
        const error = new Error(REPORT_ERROR);
        error.code = 'FINANCE_REPORT_INVALID';
        throw error;
      }
      return {
        blob,
        contentType,
        filename: reportFilename(response.headers?.get?.('content-disposition'), normalized)
      };
    },
    async getHistory(filters = {}) {
      const body = await request(historyUrl(filters));
      return {
        entries: Array.isArray(body.entries) ? body.entries : [],
        nextCursor: body.nextCursor || null,
        hasMore: body.hasMore === true
      };
    },
    async getRevisions(id) {
      const body = await request(`/api/finance/entries/${encodeURIComponent(id)}/revisions`);
      return Array.isArray(body.revisions) ? body.revisions : [];
    },
    async updateEntry(id, changes = {}, options = {}) {
      const { ownerId: _ownerId, expectedVersion: _expectedVersion, mutationRequestId: _mutationRequestId, ...safeChanges } = changes || {};
      return (await request(`/api/finance/entries/${encodeURIComponent(id)}`, {
        ...mutationOptions('PATCH', options, safeChanges)
      })).entry;
    },
    async deleteEntry(id, options = {}) {
      const configured = options.expectedVersion !== undefined || options.mutationRequestId !== undefined;
      const response = await request(
        `/api/finance/entries/${encodeURIComponent(id)}`,
        configured ? mutationOptions('DELETE', options) : { method: 'DELETE' }
      );
      return response.entry || response;
    },
    async restoreEntry(id, options = {}) {
      return (await request(`/api/finance/entries/${encodeURIComponent(id)}/restore`, mutationOptions('POST', options))).entry;
    },
    async archiveEntry(id, options = {}) {
      return (await request(`/api/finance/entries/${encodeURIComponent(id)}/archive`, mutationOptions('POST', options))).entry;
    },
    async unarchiveEntry(id, options = {}) {
      return (await request(`/api/finance/entries/${encodeURIComponent(id)}/unarchive`, mutationOptions('POST', options))).entry;
    }
  };
}

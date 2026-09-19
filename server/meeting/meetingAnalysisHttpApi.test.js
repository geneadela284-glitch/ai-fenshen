import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleMeetingAnalysisApi,
  MEETING_ANALYSIS_PATH
} from './meetingAnalysisHttpApi.js';

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(value) {
      this.body = value ? JSON.parse(value) : null;
    }
  };
}

function request(body, method = 'POST') {
  return { method, headers: {}, body };
}

function session(ownerId = 'owner-a') {
  return {
    user: { id: ownerId },
    subject: { accountId: ownerId, sessionId: 'session-a' }
  };
}

function accessControl({ beginError = null } = {}) {
  const released = [];
  return {
    released,
    beginRequest(input) {
      if (beginError) throw beginError;
      return { requestId: input.requestId, lease: true };
    },
    releaseRequest(lease) {
      released.push(lease);
      return true;
    }
  };
}

function invoke({ body, aiService, access = accessControl(), sessionValue = session() }) {
  const res = responseRecorder();
  return handleMeetingAnalysisApi({
    req: request(body),
    res,
    url: new URL(`http://localhost${MEETING_ANALYSIS_PATH}`),
    session: sessionValue,
    aiService,
    accessControl: access,
    readJson: async (req) => req.body,
    sendJson: (target, status, payload, headers = {}) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(payload));
    }
  }).then((handled) => ({ handled, res, access }));
}

test('meeting analysis API uses the authenticated subject and strips client identity claims', async () => {
  const calls = [];
  const access = accessControl();
  const result = await invoke({
    access,
    body: {
      input: '当前批次会议原文',
      messages: [{ role: 'system', content: '只输出 JSON' }, { role: 'user', content: '当前批次会议原文' }],
      clientRequestId: 'analysis-request-1',
      ownerId: 'owner-b',
      scope: 'other-space',
      meetingId: 'other-meeting',
      transcriptRevision: 99
    },
    aiService: {
      async run(task, invocation) {
        calls.push({ task, invocation });
        return { ok: true, content: '{"summary":{}}' };
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.status, 200);
  assert.deepEqual(result.res.body, { ok: true, content: '{"summary":{}}' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task.capability, 'MEETING_SUMMARY');
  assert.equal(calls[0].task.metadata.memoryPolicy, 'disabled');
  assert.equal(calls[0].task.metadata.idempotencyKey, 'analysis-request-1');
  assert.equal(calls[0].task.ownerId, undefined);
  assert.equal(calls[0].task.meetingId, undefined);
  assert.equal(calls[0].invocation.subject.accountId, 'owner-a');
  assert.equal(calls[0].invocation.meetingAnalysis, true);
  assert.equal(calls[0].task.options.timeoutMs, 90000);
  assert.equal(result.access.released.length, 1);
});

test('meeting analysis API fails closed for unauthenticated and unsupported requests', async () => {
  const unauthenticated = responseRecorder();
  const handledUnauthenticated = await handleMeetingAnalysisApi({
    req: request({}, 'POST'),
    res: unauthenticated,
    url: new URL(`http://localhost${MEETING_ANALYSIS_PATH}`),
    session: { user: null, subject: null },
    aiService: { async run() { throw new Error('must not run'); } },
    accessControl: accessControl(),
    readJson: async () => ({}),
    sendJson: (target, status, payload, headers = {}) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(payload));
    }
  });
  assert.equal(handledUnauthenticated, true);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.code, 'AUTH_REQUIRED');

  const unsupported = responseRecorder();
  const handledUnsupported = await handleMeetingAnalysisApi({
    req: request({}, 'GET'),
    res: unsupported,
    url: new URL(`http://localhost${MEETING_ANALYSIS_PATH}`),
    session: session(),
    aiService: { async run() { throw new Error('must not run'); } },
    accessControl: accessControl(),
    readJson: async () => ({}),
    sendJson: (target, status, payload, headers = {}) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(payload));
    }
  });
  assert.equal(handledUnsupported, true);
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.Allow, 'POST');
});

test('meeting analysis API sanitizes provider failure and releases the request lease', async () => {
  const access = accessControl();
  const result = await invoke({
    access,
    body: {
      input: '当前批次会议原文',
      messages: [{ role: 'user', content: '当前批次会议原文' }],
      clientRequestId: 'analysis-request-2'
    },
    aiService: {
      async run() {
        return { ok: false, code: 'PROVIDER_SECRET_LEAK', content: '', route: { selectedProvider: 'hidden' } };
      }
    }
  });

  assert.equal(result.res.status, 503);
  assert.deepEqual(result.res.body, {
    ok: false,
    code: 'AI_ANALYSIS_UNAVAILABLE',
    message: '会议整理暂时不可用，请稍后重试。'
  });
  assert.equal(result.access.released.length, 1);
});

test('meeting analysis API returns access-control rate limits without calling the model', async () => {
  const access = accessControl({ beginError: Object.assign(new Error('limited'), { code: 'ACCOUNT_REQUEST_RATE_LIMITED', status: 429 }) });
  let calls = 0;
  const result = await invoke({
    access,
    body: {
      input: '当前批次会议原文',
      messages: [{ role: 'user', content: '当前批次会议原文' }],
      clientRequestId: 'analysis-request-3'
    },
    aiService: { async run() { calls += 1; return { ok: true, content: '{}' }; } }
  });

  assert.equal(result.res.status, 429);
  assert.equal(result.res.body.code, 'ACCOUNT_REQUEST_RATE_LIMITED');
  assert.equal(calls, 0);
  assert.equal(result.access.released.length, 0);
});

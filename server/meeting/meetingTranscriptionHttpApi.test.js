import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeMeetingFileNameForHeader } from '../../apps/desktop/src/lib/meetingSpeechGatewayClient.js';
import {
  decodeMeetingFileNameHeader,
  handleMeetingTranscriptionApi
} from './meetingTranscriptionHttpApi.js';

class ResponseHarness {
  constructor() {
    this.status = null;
    this.headers = null;
    this.body = null;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  end(body = '') {
    this.body = body ? JSON.parse(body) : null;
  }

  once() {}

  off() {}
}

function request({ body = Buffer.from('normalized-audio'), headers = {} } = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'audio/wav',
      'x-meeting-id': 'meeting-a',
      'x-source-id': 'source-a',
      'x-source-revision': '4',
      'x-request-id': 'request-a',
      'x-transcription-attempt': '1',
      'x-chunk-sequence': '0',
      'x-chunk-start-ms': '0',
      'x-chunk-end-ms': '60000',
      'x-chunk-duration-ms': '60000',
      'x-chunk-file-name': 'meeting-a.wav',
      'x-chunk-mime-type': 'audio/wav',
      'x-chunk-format': 'wav',
      ...headers
    },
    async *[Symbol.asyncIterator]() {
      yield body;
    }
  };
}

function diagnosticRequest(body = {}, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-meeting-trace-id': 'diagnostic-trace-a',
      ...headers
    },
    async *[Symbol.asyncIterator]() {
      yield bytes;
    }
  };
}

function gatewayHarness() {
  const calls = [];
  const speechGateway = {
    describe: () => ({ available: true, realProvider: true, providerId: 'xfyun_asr_llm', model: 'recording_file_transcription_llm', status: 'available' }),
    async transcribeChunk(input) {
      calls.push(input);
      return {
        provider: 'xfyun_asr_llm',
        model: 'recording_file_transcription_llm',
        segments: [{ startMs: 0, endMs: 1_000, text: '云端测试。', confidence: null, speakerRef: null }],
        lease: { provider: 'xfyun_asr_llm', orderIdHash: 'a'.repeat(64), status: 'completed' },
        cursor: { status: 'completed' },
        cleanupStatus: 'not_required'
      };
    }
  };
  return { speechGateway, calls };
}

test('meeting transcription filename header decodes only ASCII percent-encoded UTF-8 safely', () => {
  const fileNames = [
    '现场录音',
    'meeting.webm',
    '项目 2026 English.webm',
    '会议-Project🚀.webm',
    '100%完成.webm'
  ];

  for (const fileName of fileNames) {
    const encoded = encodeMeetingFileNameForHeader(fileName);
    assert.match(encoded, /^[\x00-\x7f]*$/);
    assert.equal(decodeMeetingFileNameHeader(encoded), fileName);
  }
  for (const invalid of ['现场录音', '%E0%A4%A', '%0D%0AInjected: yes']) {
    assert.throws(
      () => decodeMeetingFileNameHeader(invalid),
      (error) => error.code === 'TRANSCRIPTION_FILE_NAME_INVALID'
    );
  }
});

test('meeting transcription HTTP bridge derives owner from Session and returns only standard Gateway output', async () => {
  const { speechGateway, calls } = gatewayHarness();
  const res = new ResponseHarness();
  const handled = await handleMeetingTranscriptionApi({
    req: request(),
    res,
    url: new URL('http://local/api/meeting/transcription/chunk'),
    session: { user: { id: 'owner-a' } },
    speechGateway,
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.segments, [{ startMs: 0, endMs: 1_000, text: '云端测试。', confidence: null, speakerRef: null }]);
  assert.equal(Object.hasOwn(res.body, 'ownerId'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ownerId, 'owner-a');
  assert.equal(calls[0].meetingId, 'meeting-a');
  assert.equal(calls[0].sourceId, 'source-a');
  assert.deepEqual(Buffer.from(calls[0].chunk.bytes), Buffer.from('normalized-audio'));
});

test('meeting transcription HTTP bridge rejects forged client owner before reading or invoking the Provider', async () => {
  const { speechGateway, calls } = gatewayHarness();
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: request({ headers: { 'x-owner-id': 'owner-forged' } }),
    res,
    url: new URL('http://local/api/meeting/transcription/chunk'),
    session: { user: { id: 'owner-a' } },
    speechGateway,
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CLIENT_OWNER_FORBIDDEN');
  assert.equal(calls.length, 0);
});

test('meeting transcription HTTP bridge requires an authenticated Session', async () => {
  const { speechGateway, calls } = gatewayHarness();
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: request(),
    res,
    url: new URL('http://local/api/meeting/transcription/chunk'),
    session: { user: null },
    speechGateway,
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'AUTH_REQUIRED');
  assert.equal(calls.length, 0);
});

test('meeting transcription HTTP bridge maps provider error codes without exposing credentials or raw audio', async () => {
  const secret = 'do-not-return-this-secret';
  const speechGateway = {
    describe: () => ({ available: true, realProvider: true, providerId: 'xfyun_asr_llm', model: 'recording_file_transcription_llm', status: 'available' }),
    async transcribeChunk() {
      throw Object.assign(new Error('private provider details'), {
        code: 'XFYUN_PROVIDER_ERROR',
        providerErrorCode: '100007',
        reason: `permission denied ${secret}`
      });
    }
  };
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: request({ body: Buffer.from('private audio body') }),
    res,
    url: new URL('http://local/api/meeting/transcription/chunk'),
    session: { user: { id: 'owner-a' } },
    speechGateway,
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'XFYUN_PROVIDER_ERROR');
  assert.equal(res.body.providerErrorCode, '100007');
  assert.doesNotMatch(JSON.stringify(res.body), /do-not-return-this-secret|private audio body|private provider details/);
});

test('meeting transcription status endpoint exposes safe Provider capability metadata only', async () => {
  const { speechGateway } = gatewayHarness();
  const res = new ResponseHarness();
  const handled = await handleMeetingTranscriptionApi({
    req: { method: 'GET', headers: {} },
    res,
    url: new URL('http://local/api/meeting/transcription/status'),
    session: { user: { id: 'owner-a' } },
    speechGateway,
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.providerId, 'xfyun_asr_llm');
  assert.equal(res.body.available, true);
  assert.equal(res.body.sourceAvailable, false);
  assert.equal(JSON.stringify(res.body).includes('secret'), false);
});

test('meeting transcription source bridge streams an authorized source chunk into the assembler', async () => {
  const calls = [];
  const events = [];
  const sourceAssembler = {
    async acceptChunk(input) {
      calls.push(input);
      return {
        acknowledged: true,
        sequence: 0,
        idempotent: false,
        completed: true,
        result: {
          provider: 'xfyun_asr_llm',
          model: 'recording_file_transcription_llm',
          effectiveDurationMs: 1_073,
          chunks: [{ sequence: 0, startMs: 0, endMs: 1_000, sourceChunkRefs: ['segment-0'], segments: [{ startMs: 0, endMs: 500, text: '连续流。' }] }],
          lease: { provider: 'xfyun_asr_llm', orderIdHash: 'd'.repeat(64), status: 'completed' },
          cursor: { status: 'completed' },
          cleanupStatus: 'completed'
        }
      };
    }
  };
  const res = new ResponseHarness();
  const handled = await handleMeetingTranscriptionApi({
    req: request({
      body: Buffer.from('webm-segment'),
      headers: {
        'x-source-assembly-id': 'assembly-a',
        'x-source-chunk-sequence': '0',
        'x-source-chunk-count': '1',
        'x-source-chunk-final': '1',
        'x-source-chunk-id': 'segment-0',
        'x-source-chunk-duration-ms': '1000',
        'x-source-chunk-byte-length': '12',
        'x-source-chunk-checksum': 'e'.repeat(64),
        'x-source-file-name': 'iphone-recording.webm',
        'x-source-mime-type': 'audio/webm;codecs=opus',
        'x-source-format': 'webm-opus',
        'x-source-container-layout': 'independent-mp4-segments-v1',
        'x-source-byte-length': '12',
        'x-source-duration-ms': '1000',
        'x-source-checksum': 'f'.repeat(64)
      }
    }),
    res,
    url: new URL('http://local/api/meeting/transcription/source'),
    session: { user: { id: 'owner-a' } },
    speechGateway: {
      ...gatewayHarness().speechGateway,
      async transcribeSource() {
        return { chunks: [] };
      }
    },
    sourceAssembler,
    recordingAttemptResolver: async ({ ownerId, meetingId, sourceId }) => ({
      recordingAttemptId: 'recording-attempt-a', ownerId, meetingId, sourceId
    }),
    diagnosticLogger: { async log(event) { events.push(event); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.effectiveDurationMs, 1_073);
  assert.deepEqual(res.body.chunks[0].segments, [{ startMs: 0, endMs: 500, text: '连续流。' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ownerId, 'owner-a');
  assert.equal(calls[0].assemblyId, 'assembly-a');
  assert.equal(calls[0].source.containerLayout, 'independent-mp4-segments-v1');
  assert.equal(calls[0].chunk.sequence, 0);
  assert.deepEqual(Buffer.from(await new Response(calls[0].body).arrayBuffer()), Buffer.from('webm-segment'));
  assert.equal(events.some((event) => event.phase === 'request_received' && event.recordingAttemptId === 'recording-attempt-a'), true);
  assert.equal(events.some((event) => event.phase === 'cleanup' && event.recordingAttemptId === 'recording-attempt-a'), true);
});

test('meeting transcription source bridge rejects an unknown container layout before assembly', async () => {
  let assemblerCalls = 0;
  const res = new ResponseHarness();
  const handled = await handleMeetingTranscriptionApi({
    req: request({
      body: Buffer.from('source-segment'),
      headers: {
        'x-source-assembly-id': 'assembly-unknown-layout',
        'x-source-chunk-sequence': '0',
        'x-source-chunk-count': '1',
        'x-source-chunk-final': '1',
        'x-source-chunk-id': 'segment-0',
        'x-source-chunk-duration-ms': '1000',
        'x-source-chunk-byte-length': '14',
        'x-source-chunk-checksum': 'e'.repeat(64),
        'x-source-file-name': 'iphone-recording.m4a',
        'x-source-mime-type': 'audio/mp4;codecs=mp4a.40.2',
        'x-source-format': 'm4a',
        'x-source-container-layout': 'unknown-layout-v1',
        'x-source-byte-length': '14',
        'x-source-duration-ms': '1000',
        'x-source-checksum': 'f'.repeat(64)
      }
    }),
    res,
    url: new URL('http://local/api/meeting/transcription/source'),
    session: { user: { id: 'owner-a' } },
    speechGateway: {
      ...gatewayHarness().speechGateway,
      async transcribeSource() { throw new Error('must not be called'); }
    },
    sourceAssembler: { async acceptChunk() { assemblerCalls += 1; } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TRANSCRIPTION_SOURCE_CONTAINER_LAYOUT_UNSUPPORTED');
  assert.equal(assemblerCalls, 0);
});

test('meeting transcription diagnostic endpoint receives binary Blob probe bytes without entering ASR', async () => {
  const bytes = Buffer.alloc(538_970, 7);
  const events = [];
  const res = new ResponseHarness();
  const handled = await handleMeetingTranscriptionApi({
    req: request({
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        'x-meeting-diagnostic-binary': '1',
        'x-meeting-trace-id': 'meeting-trace-binary',
        'x-meeting-id': 'meeting-a',
        'x-source-id': 'source-a'
      }
    }),
    res,
    url: new URL('http://local/api/meeting/transcription/diagnostic'),
    session: { user: { id: 'owner-a' } },
    speechGateway: gatewayHarness().speechGateway,
    resolveDiagnosticScope: async ({ ownerId, meetingId, sourceId }) => ({ ownerId, meetingId, sourceId }),
    diagnosticLogger: { async log(event) { events.push(event); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.receivedBytes, bytes.byteLength);
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'transport_probe');
  assert.equal(events[0].requestBodyType, 'Blob');
  assert.equal(events[0].requestBodyByteLength, bytes.byteLength);
});

test('diagnostic route fails closed instead of accepting a forged body owner', async () => {
  const events = [];
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: diagnosticRequest({ traceId: 'diagnostic-trace-a', phase: 'job_state', ownerId: 'owner-a', meetingId: 'meeting-a' }),
    res,
    url: new URL('http://local/api/meeting/transcription/diagnostic'),
    session: { user: { id: 'owner-b' } },
    speechGateway: gatewayHarness().speechGateway,
    diagnosticLogger: { async log(event) { events.push(event); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'DIAGNOSTIC_OWNER_MISMATCH');
  assert.equal(events.length, 0);
});

test('diagnostic route requires an authenticated session before reading diagnostic claims', async () => {
  const events = [];
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: diagnosticRequest({ traceId: 'diagnostic-trace-anonymous', phase: 'job_state', ownerId: 'owner-a', meetingId: 'meeting-a' }),
    res,
    url: new URL('http://local/api/meeting/transcription/diagnostic'),
    session: { user: null },
    speechGateway: gatewayHarness().speechGateway,
    diagnosticLogger: { async log(event) { events.push(event); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'AUTH_REQUIRED');
  assert.equal(events.length, 0);
});

test('diagnostic route rejects a claimed meeting scope when no trusted scope resolver is installed', async () => {
  const events = [];
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: diagnosticRequest({ traceId: 'diagnostic-trace-unverified-scope', phase: 'job_state', meetingId: 'meeting-a', sourceId: 'source-a' }),
    res,
    url: new URL('http://local/api/meeting/transcription/diagnostic'),
    session: { user: { id: 'owner-a' } },
    speechGateway: gatewayHarness().speechGateway,
    diagnosticLogger: { async log(event) { events.push(event); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'DIAGNOSTIC_SCOPE_UNVERIFIED');
  assert.equal(events.length, 0);
});

test('diagnostic route requires verified meeting scope before accepting a claimed meeting owner', async () => {
  const events = [];
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: diagnosticRequest({ traceId: 'diagnostic-trace-a', phase: 'job_state', meetingId: 'meeting-a', sourceId: 'source-a' }),
    res,
    url: new URL('http://local/api/meeting/transcription/diagnostic'),
    session: { user: { id: 'owner-b' } },
    speechGateway: gatewayHarness().speechGateway,
    resolveDiagnosticScope: async () => ({ ownerId: 'owner-a', meetingId: 'meeting-a', sourceId: 'source-a' }),
    diagnosticLogger: { async log(event) { events.push(event); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'DIAGNOSTIC_SCOPE_OWNER_MISMATCH');
  assert.equal(events.length, 0);
});

test('diagnostic route records only the authenticated owner after same-owner scope verification', async () => {
  const events = [];
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: diagnosticRequest({ traceId: 'diagnostic-trace-a', phase: 'job_state', ownerId: 'owner-b', meetingId: 'meeting-b', sourceId: 'source-b' }),
    res,
    url: new URL('http://local/api/meeting/transcription/diagnostic'),
    session: { user: { id: 'owner-b' } },
    speechGateway: gatewayHarness().speechGateway,
    resolveDiagnosticScope: async ({ ownerId, meetingId, sourceId }) => ({ ownerId, meetingId, sourceId }),
    recordingAttemptResolver: async ({ ownerId, meetingId, sourceId }) => ({
      recordingAttemptId: 'recording-attempt-b',
      ownerId,
      meetingId,
      sourceId
    }),
    diagnosticLogger: { async log(event) { events.push(event); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].ownerId, 'owner-b');
  assert.equal(events[0].meetingId, 'meeting-b');
  assert.equal(events[0].sourceId, 'source-b');
  assert.equal(events[0].recordingAttemptId, 'recording-attempt-b');
});

test('recording checkpoint diagnostic is authenticated, scope-verified, and audio-free', async () => {
  const events = [];
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: diagnosticRequest({
      traceId: 'checkpoint-trace-a',
      phase: 'recording_checkpoint',
      meetingId: 'meeting-a',
      sourceId: 'source-a',
      event: 'checkpoint_succeeded',
      checkpointId: 'checkpoint-a',
      blob: 'must-not-be-persisted',
      persistedBytes: 1234
    }),
    res,
    url: new URL('http://local/api/meeting/transcription/diagnostic'),
    session: { user: { id: 'owner-a' } },
    speechGateway: gatewayHarness().speechGateway,
    resolveDiagnosticScope: async ({ ownerId, meetingId, sourceId }) => ({ ownerId, meetingId, sourceId }),
    recordingAttemptResolver: async ({ ownerId, meetingId, sourceId }) => ({
      recordingAttemptId: 'recording-attempt-a', ownerId, meetingId, sourceId
    }),
    diagnosticLogger: { async log(event) { events.push(event); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });
  assert.equal(res.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'recording_checkpoint');
  assert.equal(events[0].ownerId, 'owner-a');
  assert.equal(events[0].recordingAttemptId, 'recording-attempt-a');
  assert.equal('blob' in events[0], false);
});

test('recording checkpoint diagnostic rejects an unbound attempt instead of accepting owner-only metadata', async () => {
  const res = new ResponseHarness();
  await handleMeetingTranscriptionApi({
    req: diagnosticRequest({
      phase: 'recording_checkpoint',
      event: 'checkpoint_succeeded',
      checkpointId: 'checkpoint-unbound'
    }),
    res,
    url: new URL('http://local/api/meeting/transcription/diagnostic'),
    session: { user: { id: 'owner-a' } },
    speechGateway: gatewayHarness().speechGateway,
    diagnosticLogger: { async logRecordingCheckpoint() { throw new Error('must not log'); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'DIAGNOSTIC_SCOPE_UNVERIFIED');
});

test('recording checkpoint backfill returns idempotent acceptance for the same attempt/checkpoint/event', async () => {
  const seen = new Set();
  const events = [];
  const diagnosticLogger = {
    enabled: true,
    async logRecordingCheckpoint(event) {
      const key = [event.ownerId, event.recordingAttemptId, event.checkpointId, event.event].join(':');
      if (seen.has(key)) return { accepted: true, duplicate: true };
      seen.add(key);
      events.push(event);
      return { accepted: true, duplicate: false };
    }
  };
  const input = {
    traceId: 'checkpoint-backfill-trace',
    phase: 'recording_checkpoint',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    recordingAttemptId: 'attempt-a',
    checkpointId: 'checkpoint-a',
    event: 'checkpoint_succeeded',
    committedDurationMs: 36_000,
    success: true
  };
  const post = async (traceId) => {
    const res = new ResponseHarness();
    await handleMeetingTranscriptionApi({
      req: diagnosticRequest({ ...input, traceId }),
      res,
      url: new URL('http://local/api/meeting/transcription/diagnostic'),
      session: { user: { id: 'owner-a' } },
      speechGateway: gatewayHarness().speechGateway,
      resolveDiagnosticScope: async ({ ownerId, meetingId, sourceId }) => ({ ownerId, meetingId, sourceId, scope: 'meeting-space' }),
      recordingAttemptResolver: async ({ ownerId, meetingId, sourceId }) => ({
        recordingAttemptId: 'attempt-a', ownerId, meetingId, sourceId, scope: 'meeting-space'
      }),
      diagnosticLogger,
      sendJson: (target, status, body, headers) => {
        target.writeHead(status, headers);
        target.end(JSON.stringify(body));
      }
    });
    return res;
  };
  const first = await post('checkpoint-backfill-trace-1');
  const duplicate = await post('checkpoint-backfill-trace-2');
  assert.equal(first.status, 200);
  assert.equal(first.body.code, 'TRACE_BACKFILL_ACCEPTED');
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.code, 'TRACE_ALREADY_PRESENT');
  assert.equal(events.length, 1);

  const wrongAttemptResponse = new ResponseHarness();
  const wrongAttemptHandled = await handleMeetingTranscriptionApi({
    req: diagnosticRequest({ ...input, traceId: 'checkpoint-backfill-trace-wrong-attempt', recordingAttemptId: 'attempt-forged' }),
    res: wrongAttemptResponse,
    url: new URL('http://local/api/meeting/transcription/diagnostic'),
    session: { user: { id: 'owner-a' } },
    speechGateway: gatewayHarness().speechGateway,
    resolveDiagnosticScope: async ({ ownerId, meetingId, sourceId }) => ({ ownerId, meetingId, sourceId, scope: 'meeting-space' }),
    recordingAttemptResolver: async ({ ownerId, meetingId, sourceId }) => ({
      recordingAttemptId: 'attempt-a', ownerId, meetingId, sourceId, scope: 'meeting-space'
    }),
    diagnosticLogger,
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });
  assert.equal(wrongAttemptHandled, true);
  assert.equal(wrongAttemptResponse.status, 403);
  assert.equal(wrongAttemptResponse.body.code, 'DIAGNOSTIC_SCOPE_MISMATCH');
});

test('source provider failure keeps the verified meeting/source/attempt identifiers in the durable failure trace', async () => {
  const events = [];
  const res = new ResponseHarness();
  const sourceAssembler = {
    async acceptChunk() {
      throw Object.assign(new Error('provider failure'), { code: 'XFYUN_PROVIDER_ERROR', providerErrorCode: '100007' });
    }
  };
  await handleMeetingTranscriptionApi({
    req: request({
      body: Buffer.from('aac-source'),
      headers: {
        'x-source-assembly-id': 'assembly-failure',
        'x-source-chunk-sequence': '0',
        'x-source-chunk-count': '1',
        'x-source-chunk-final': '1',
        'x-source-chunk-id': 'segment-0',
        'x-source-chunk-duration-ms': '1000',
        'x-source-chunk-byte-length': '11',
        'x-source-chunk-checksum': 'e'.repeat(64),
        'x-source-file-name': 'iphone-recording.m4a',
        'x-source-mime-type': 'audio/mp4;codecs=mp4a.40.2',
        'x-source-format': 'm4a',
        'x-source-byte-length': '11',
        'x-source-duration-ms': '1000',
        'x-source-checksum': 'f'.repeat(64)
      }
    }),
    res,
    url: new URL('http://local/api/meeting/transcription/source'),
    session: { user: { id: 'owner-a' } },
    speechGateway: {
      ...gatewayHarness().speechGateway,
      async transcribeSource() { throw new Error('should not be called'); }
    },
    sourceAssembler,
    recordingAttemptResolver: async ({ ownerId, meetingId, sourceId }) => ({
      recordingAttemptId: 'recording-attempt-a',
      ownerId,
      meetingId,
      sourceId
    }),
    diagnosticLogger: { async log(event) { events.push(event); } },
    sendJson: (target, status, body, headers) => {
      target.writeHead(status, headers);
      target.end(JSON.stringify(body));
    }
  });

  assert.equal(res.status, 502);
  const failure = events.find((event) => event.phase === 'failed');
  assert.equal(failure.meetingId, 'meeting-a');
  assert.equal(failure.sourceId, 'source-a');
  assert.equal(failure.recordingAttemptId, 'recording-attempt-a');
  assert.equal(failure.errorCode, 'XFYUN_PROVIDER_ERROR');
});

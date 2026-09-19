import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('beta server exposes authenticated Meeting analysis without persisting server-side meeting data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-analysis-beta-'));
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>meeting analysis</title>');
  const cookieSecret = randomBytes(32).toString('hex');
  const password = `MeetingAnalysisOwner-${randomUUID()}-Aa1!`;
  const calls = [];
  const instance = await createBetaServer({
    config: {
      publicDir,
      authDb: path.join(directory, 'auth.sqlite'),
      accessControlDb: path.join(directory, 'access-control.sqlite'),
      cookieSecret,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0,
      privacyRequired: false,
      financeDb: null,
      conversationDb: null,
      tasksDb: null,
      attachmentsDb: null
    },
    aiService: {
      getStatus: () => ({ available: true }),
      async run(task, invocation) {
        calls.push({ task, invocation });
        return { ok: true, content: '{"summary":{"topic":"已确认主题"}}' };
      }
    },
    memoryRuntime: {
      service: {},
      async initialize() { return { status: 'disabled' }; },
      async close() {}
    },
    voiceDictationRuntime: { async close() {} }
  });

  try {
    await instance.auth.createAccount({
      username: 'meeting_analysis_owner',
      displayName: 'Meeting Analysis Owner',
      password,
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    const login = await instance.auth.login({ username: 'meeting_analysis_owner', password });
    assert.equal(login.ok, true);
    await listen(instance.server);
    const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
    const response = await fetch(`${baseUrl}/api/meeting/analysis`, {
      method: 'POST',
      headers: { Cookie: login.setCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: '当前批次会议原文',
        messages: [{ role: 'system', content: '只输出 JSON' }, { role: 'user', content: '当前批次会议原文' }],
        clientRequestId: 'beta-analysis-request-1',
        ownerId: 'attacker',
        meetingId: 'attacker-meeting',
        scope: 'attacker-scope'
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, content: '{"summary":{"topic":"已确认主题"}}' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task.capability, 'MEETING_SUMMARY');
    assert.equal(calls[0].task.metadata.memoryPolicy, 'disabled');
    assert.equal(calls[0].task.ownerId, undefined);
    assert.equal(calls[0].task.meetingId, undefined);
    assert.equal(calls[0].invocation.subject.accountId, login.user.id);
  } finally {
    await closeServer(instance.server);
    instance.auth.close();
    await rm(directory, { recursive: true, force: true });
  }
});

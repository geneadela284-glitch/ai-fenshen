import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { createBetaServer } from '../../server/betaServer.js';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function requiredPath(name) {
  const value = argument(name);
  if (!value) throw new Error(`ATTACHMENT_A3_${name.toUpperCase().replaceAll('-', '_')}_REQUIRED`);
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) throw new Error(`ATTACHMENT_A3_${name.toUpperCase().replaceAll('-', '_')}_NOT_FOUND`);
  return resolved;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writePrivateJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function enableQwenSettings(filePath) {
  const state = readJson(filePath);
  const settings = state['ai-settings'] || state;
  assert.ok(settings?.providers?.qwen, 'QWEN_SETTINGS_NOT_FOUND');
  settings.providers.qwen.enabled = true;
  settings.providers.qwen.healthy = true;
  settings.providers.qwen.status = '可用';
  writePrivateJson(filePath, state);
}

function enableQwenRegistry(filePath) {
  const state = readJson(filePath);
  const provider = state.providers?.find?.((item) => item.provider_id === 'qwen');
  assert.ok(provider, 'QWEN_REGISTRY_ENTRY_NOT_FOUND');
  provider.enabled = true;
  writePrivateJson(filePath, state);
}

function cookieValue(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

function parseSse(text) {
  return String(text || '').trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const type = block.match(/^event:\s*(.+)$/m)?.[1] || 'message';
    const dataText = block.match(/^data:\s*(.+)$/m)?.[1] || '{}';
    return { type, data: JSON.parse(dataText) };
  });
}

function containsSensitiveLog(value) {
  const text = String(value || '');
  if (/data:image\/|base64,|authorization\s*[:=]|bearer\s+\S+|api[-_\s]?key\s*[:=]|password\s*[:=]|cookie\s*[:=]|set-cookie/i.test(text)) {
    return true;
  }
  const allowedKeys = new Set([
    'schema_version',
    'event',
    'provider_id',
    'purpose',
    'credential_revision',
    'result',
    'reason_code',
    'at',
    'configured',
    'config_digest'
  ]);
  return text.split(/\r?\n/).filter(Boolean).some((line) => {
    try {
      const event = JSON.parse(line);
      return Object.keys(event).some((key) => !allowedKeys.has(key));
    } catch {
      return true;
    }
  });
}

const aiConfigSource = requiredPath('ai-config');
const healthStoreSource = requiredPath('health-store');
const registrySource = requiredPath('registry');
const catalogSource = requiredPath('catalog');
const vaultSource = requiredPath('vault');
const kekCredentialPath = requiredPath('kek');
const imageOnePath = requiredPath('image-one');
const imageTwoPath = requiredPath('image-two');
const outputPath = path.resolve(argument('output', path.join(process.cwd(), 'attachment-a3-real-vps-result.json')));
const requestedPort = Number(argument('port', 18134));
const root = mkdtempSync(path.join(tmpdir(), 'attachment-a3-real-vps-'));
chmodSync(root, 0o700);

const copied = {
  aiConfig: path.join(root, 'ai-settings.json'),
  health: path.join(root, 'provider-health.json'),
  registry: path.join(root, 'provider-registry.json'),
  catalog: path.join(root, 'model-catalog.json'),
  vault: path.join(root, 'provider-vault.enc')
};
for (const [source, destination] of [
  [aiConfigSource, copied.aiConfig],
  [healthStoreSource, copied.health],
  [registrySource, copied.registry],
  [catalogSource, copied.catalog],
  [vaultSource, copied.vault]
]) {
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
}
enableQwenSettings(copied.aiConfig);
enableQwenRegistry(copied.registry);

mkdirSync(path.join(root, 'public'), { mode: 0o700 });
mkdirSync(path.join(root, 'privacy-exports'), { mode: 0o700 });
const auditLogPath = path.join(root, 'provider-audit.ndjson');
const username = `attachment_a3_${Date.now()}`;
const password = `A3${crypto.randomBytes(16).toString('hex')}z9`;
const cookieSecret = crypto.randomBytes(32).toString('hex');
let instance = null;
let finalOutput = null;

try {
  instance = await createBetaServer({
    config: {
      publicDir: path.join(root, 'public'),
      authDb: path.join(root, 'auth.sqlite'),
      accessControlDb: path.join(root, 'access.sqlite'),
      conversationDb: path.join(root, 'conversations.sqlite'),
      financeDb: path.join(root, 'finance.sqlite'),
      tasksDb: path.join(root, 'tasks.sqlite'),
      attachmentsDb: path.join(root, 'attachments.sqlite'),
      attachmentStorageRoot: path.join(root, 'attachment-storage'),
      attachmentImageUnderstandingEnabled: true,
      privacyDb: path.join(root, 'privacy.sqlite'),
      privacyExportDir: path.join(root, 'privacy-exports'),
      privacyRequired: true,
      aiConfig: copied.aiConfig,
      providerHealthStore: copied.health,
      providerRegistry: {
        enabled: true,
        registryPath: copied.registry,
        modelCatalogPath: copied.catalog,
        vaultPath: copied.vault,
        auditLogPath,
        kekCredentialPath
      },
      cookieSecret,
      secureCookie: false,
      financeTimezone: 'Asia/Shanghai',
      host: '127.0.0.1',
      port: requestedPort
    }
  });
  const account = await instance.auth.createAccount({
    username,
    displayName: 'Attachment A3 Isolated Acceptance',
    password,
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(requestedPort, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  const jsonRequest = async (pathname, { method = 'GET', cookie = '', body } = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json().catch(() => ({}))
    };
  };

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.equal(loginResponse.status, 200);
  const cookie = cookieValue(loginResponse);
  assert.ok(cookie);

  const notice = await jsonRequest('/api/privacy/notice');
  assert.equal(notice.status, 200);
  const consent = await jsonRequest('/api/privacy/consent', {
    method: 'POST',
    cookie,
    body: {
      accepted: true,
      privacyNoticeVersion: notice.body.privacyNoticeVersion,
      termsVersion: notice.body.termsVersion,
      locale: 'zh-CN',
      source: 'attachment_a3_isolated_acceptance'
    }
  });
  assert.equal(consent.status, 200);

  const conversation = await jsonRequest('/api/ai/conversations', {
    method: 'POST',
    cookie,
    body: { title: 'Attachment A3 Isolated Acceptance' }
  });
  assert.equal(conversation.status, 201);
  const conversationId = conversation.body.conversation.id;

  const form = new FormData();
  form.append('conversation_id', conversationId);
  form.append('files', new Blob([readFileSync(imageOnePath)], { type: 'image/png' }), 'shape-ai7.png');
  form.append('files', new Blob([readFileSync(imageTwoPath)], { type: 'image/png' }), 'table-amount.png');
  const uploadResponse = await fetch(`${baseUrl}/api/attachments`, {
    method: 'POST',
    headers: {
      cookie,
      'x-client-request-id': 'attachment-a3-real-upload'
    },
    body: form
  });
  const uploadBody = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201);
  assert.equal(uploadBody.attachments.length, 2);
  assert.equal(uploadBody.attachments.every((item) => item.processingState === 'ready_for_processing'), true);
  const attachmentIds = uploadBody.attachments.map((item) => item.attachmentId);

  const clientRequestId = 'attachment-a3-real-message';
  const startedAt = Date.now();
  const streamResponse = await fetch(`${baseUrl}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      message: '请描述画面，并读取图中文字、金额以及餐费和打车表格。',
      timezone: 'Asia/Shanghai',
      attachmentIds,
      clientRequestId
    })
  });
  assert.equal(streamResponse.status, 200);
  const events = parseSse(await streamResponse.text());
  const completed = events.findLast((event) => event.type === 'completed');
  assert.ok(completed, 'ATTACHMENT_PROCESSING_DID_NOT_COMPLETE');
  assert.equal(['processed', 'processed_partial'].includes(completed.data.status), true);
  const latencyMs = Date.now() - startedAt;

  const job = instance.attachmentRuntime.repository.findProcessingJob(account.id, clientRequestId);
  assert.ok(job?.processingId, 'ATTACHMENT_PROCESSING_JOB_NOT_PERSISTED');
  const processingId = job.processingId;
  const ocrRows = instance.attachmentRuntime.repository.listOcrResults(processingId);
  const ocrResults = ocrRows.map((row) => instance.attachmentRuntime.storage.readJson(row.resultReference));
  const visionRow = instance.attachmentRuntime.repository.getVisionResult(processingId);
  const vision = visionRow
    ? instance.attachmentRuntime.storage.readJson(visionRow.resultReference)
    : null;
  const evidence = instance.attachmentRuntime.storage.readJson(job.answerReference);

  const countProcessingSteps = () => Number(
    instance.attachmentRuntime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM attachment_processing_steps
      WHERE processing_id = ?
    `).get(processingId).count
  );
  const replayBefore = countProcessingSteps();
  const replayResponse = await fetch(`${baseUrl}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      message: '请描述画面，并读取图中文字、金额以及餐费和打车表格。',
      timezone: 'Asia/Shanghai',
      attachmentIds,
      clientRequestId
    })
  });
  assert.equal(replayResponse.status, 200);
  parseSse(await replayResponse.text());
  const replayAfter = countProcessingSteps();

  const history = await jsonRequest(`/api/ai/conversations/${encodeURIComponent(conversationId)}/messages`, {
    cookie
  });
  assert.equal(history.status, 200);
  const restoredUserMessage = history.body.messages.find((message) => message.role === 'user');
  const restoredAssistantMessage = history.body.messages.find((message) => message.role === 'assistant');
  assert.equal(restoredUserMessage.attachments.length, 2);
  assert.ok(restoredAssistantMessage?.content);

  const accessDb = new DatabaseSync(path.join(root, 'access.sqlite'), { readOnly: true });
  const attempts = accessDb.prepare(`
    SELECT attempt_type, status, settled_input_tokens, settled_output_tokens, cost_status
    FROM provider_attempts
    WHERE account_id = ?
    ORDER BY created_at ASC
  `).all(account.id);
  accessDb.close();

  const preview = await fetch(`${baseUrl}/api/attachments/${encodeURIComponent(attachmentIds[0])}/content`, {
    headers: { cookie }
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');
  await preview.arrayBuffer();

  const deleted = await jsonRequest(`/api/attachments/${encodeURIComponent(attachmentIds[0])}`, {
    method: 'DELETE',
    cookie
  });
  assert.equal(deleted.status, 200);
  const deletedPreview = await fetch(`${baseUrl}/api/attachments/${encodeURIComponent(attachmentIds[0])}/content`, {
    headers: { cookie }
  });
  assert.equal(deletedPreview.status, 410);
  await deletedPreview.text();

  const audit = existsSync(auditLogPath) ? readFileSync(auditLogPath, 'utf8') : '';
  const allOcr = ocrResults.map((result) => `${result.rawText}\n${result.normalizedText}`).join('\n');
  const allVision = JSON.stringify(vision || {});
  const tableRows = ocrResults.flatMap((result) =>
    (result.tableRegions || []).flatMap((region) => region.rows || [])
  );
  const recognitionChecks = {
    red_circle: /红/.test(allVision) && /圆/.test(allVision),
    blue_square: /蓝/.test(allVision) && /方/.test(allVision),
    left_right_relation: /左|右/.test(allVision),
    ai7_character_content: /AI\s*7/i.test(allOcr),
    amount_128_50: /128[.,]50/.test(allOcr),
    meal_86: /餐费/.test(allOcr) && /86/.test(allOcr) &&
      tableRows.some((row) => row.includes('餐费') && row.includes('86')),
    taxi_18: /打车/.test(allOcr) && /18/.test(allOcr) &&
      tableRows.some((row) => row.includes('打车') && row.includes('18')),
    table_rows_preserved: tableRows.length >= 3
  };
  const safeAudit = !containsSensitiveLog(audit);
  const acceptancePass = attempts.length === 3 &&
    replayAfter - replayBefore === 0 &&
    Object.values(recognitionChecks).every(Boolean) &&
    safeAudit;
  finalOutput = {
    task: 'ATTACHMENT-PHASE-A3-FRONTEND-MOBILE-INTEGRATION-AND-RELEASE-V1',
    environment: 'VPS isolated databases, storage, registry/config copies and independent port',
    public_data_accessed: false,
    real_provider: true,
    result: acceptancePass ? 'PASS' : 'FAIL',
    processing_state: completed.data.status,
    latency_ms: latencyMs,
    upload: {
      attachments: 2,
      ready_for_processing: true,
      bytes_from_server: uploadBody.attachments.map((item) => item.byteSize)
    },
    provider_calls: {
      diagnostic_calls_before_final_run: Number(argument('prior-diagnostic-calls', 0)),
      total: attempts.length,
      expected: 3,
      settled: attempts.filter((item) => item.status === 'settled').length,
      input_tokens: attempts.reduce((sum, item) => sum + Number(item.settled_input_tokens || 0), 0),
      output_tokens: attempts.reduce((sum, item) => sum + Number(item.settled_output_tokens || 0), 0),
      cost_unavailable: attempts.filter((item) => item.cost_status === 'unavailable').length,
      idempotent_replay_increment: replayAfter - replayBefore
    },
    recognition_checks: recognitionChecks,
    evidence: {
      answer_mode: evidence.answerMode,
      references: evidence.evidenceRefs?.length || 0,
      limitations_recorded: Array.isArray(evidence.limitations),
      restored_after_reload: restoredUserMessage.attachments.length === 2 &&
        Boolean(restoredAssistantMessage?.content)
    },
    lifecycle: {
      authenticated_preview_no_store: true,
      deleted_preview_gone: true,
      derived_results_invalidated: instance.attachmentRuntime.repository.getVisionResult(processingId) === null
    },
    security: {
      logs_contain_sensitive_payload: !safeAudit,
      isolated_user_only: true,
      production_paths_not_used_for_business_data: true
    }
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writePrivateJson(outputPath, finalOutput);
  assert.equal(attempts.length, 3);
  assert.equal(finalOutput.provider_calls.idempotent_replay_increment, 0);
  assert.equal(Object.values(finalOutput.recognition_checks).every(Boolean), true);
  assert.equal(finalOutput.security.logs_contain_sensitive_payload, false);
  process.stdout.write(`${JSON.stringify({
    result: finalOutput.result,
    processing_state: finalOutput.processing_state,
    provider_calls: finalOutput.provider_calls.total,
    idempotent_replay_increment: finalOutput.provider_calls.idempotent_replay_increment,
    isolated_cleanup_pending: true
  })}\n`);
} finally {
  if (instance?.server?.listening) {
    await new Promise((resolve) => instance.server.close(resolve));
  }
  try { instance?.auth?.close(); } catch {}
  try { instance?.memoryRuntime?.close?.(); } catch {}
  try { instance?.protectedMemoryRuntime?.close?.(); } catch {}
  try { instance?.financeRuntime?.close?.(); } catch {}
  try { instance?.tasksRuntime?.close?.(); } catch {}
  try { instance?.attachmentRuntime?.close?.(); } catch {}
  rmSync(root, { recursive: true, force: true });
  if (finalOutput && existsSync(outputPath)) {
    const verified = readJson(outputPath);
    verified.security.temporary_directory_cleaned = !existsSync(root);
    writePrivateJson(outputPath, verified);
  }
}

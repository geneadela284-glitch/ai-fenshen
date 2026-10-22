import crypto from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createBetaServer } from '../../server/betaServer.js';

const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-attachment-a3-mobile-'));
const username = `attachment_a3_${Date.now()}`;
const password = `A3Mobile${crypto.randomBytes(8).toString('hex')}7`;

const aiService = {
  async run() {
    return { ok: true, content: '这是隔离验收回复。' };
  },
  async stream(_task, { onDelta }) {
    await onDelta('这是隔离验收回复。');
    return { ok: true, content: '这是隔离验收回复。' };
  },
  async runExactCapability({ modelId }) {
    if (modelId === 'qwen3.5-ocr') {
      return {
        ok: true,
        model: modelId,
        content: JSON.stringify({
          raw_text: '今日支出128.50元\n项目|金额\n餐费|86\n打车|18',
          normalized_text: '今日支出128.50元\n项目|金额\n餐费|86\n打车|18',
          blocks: [],
          table_regions: [{ rows: [['项目', '金额'], ['餐费', '86'], ['打车', '18']] }],
          detected_language: 'zh-CN',
          limitations: []
        }),
        usage: { inputTokens: 8, outputTokens: 20 }
      };
    }
    if (modelId === 'qwen3-vl-plus') {
      return {
        ok: true,
        model: modelId,
        content: JSON.stringify({
          scene_summary: '图片包含深蓝色人物画面和界面布局。',
          objects: ['人物', '界面'],
          colors: ['深蓝色'],
          spatial_relations: ['人物位于画面中央'],
          layout_summary: '主体居中，文字区域清晰。',
          chart_or_diagram_summary: null,
          limitations: []
        }),
        usage: { inputTokens: 10, outputTokens: 18 }
      };
    }
    return { ok: false, code: 'NO_USABLE_RUNTIME_CONNECTION' };
  },
  getStatus() {
    return { available: true };
  }
};

const disabledMemoryRuntime = {
  service: {},
  async initialize() {
    return { status: 'disabled', pathSummary: 'isolated-attachment-a3-mobile' };
  },
  async close() {}
};

mkdirSync(path.join(directory, 'privacy-exports'), { recursive: true });
const instance = await createBetaServer({
  config: {
    publicDir: path.resolve('apps/desktop/dist'),
    authDb: path.join(directory, 'auth.sqlite'),
    accessControlDb: path.join(directory, 'access.sqlite'),
    conversationDb: path.join(directory, 'conversations.sqlite'),
    financeDb: path.join(directory, 'finance.sqlite'),
    tasksDb: path.join(directory, 'tasks.sqlite'),
    attachmentsDb: path.join(directory, 'attachments.sqlite'),
    attachmentStorageRoot: path.join(directory, 'attachment-storage'),
    attachmentImageUnderstandingEnabled: true,
    privacyDb: path.join(directory, 'privacy.sqlite'),
    privacyExportDir: path.join(directory, 'privacy-exports'),
    privacyRequired: true,
    cookieSecret: crypto.randomBytes(32).toString('hex'),
    secureCookie: false,
    financeTimezone: 'Asia/Shanghai',
    host: '127.0.0.1',
    port: 0
  },
  aiService,
  memoryRuntime: disabledMemoryRuntime,
  protectedMemoryRuntime: null
});

await instance.auth.createAccount({
  username,
  displayName: 'Attachment A3 Mobile Acceptance',
  password,
  role: 'beta_user',
  quotaProfileId: 'closed_beta_user_v1'
});
await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
const port = instance.server.address().port;
const credentialsPath = path.join(directory, 'credentials.json');
writeFileSync(credentialsPath, `${JSON.stringify({ username, password })}\n`, { mode: 0o600 });
chmodSync(credentialsPath, 0o600);

process.stdout.write(`${JSON.stringify({
  ready: true,
  baseUrl: `http://127.0.0.1:${port}`,
  credentialsPath,
  dataDirectory: directory
})}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => instance.server.close(resolve));
  instance.auth.close();
  rmSync(directory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
await new Promise(() => {});

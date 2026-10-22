import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStorage } from '../../core/storage/memoryStorage.js';
import { InvocationTraceRepository } from '../../core/router/InvocationTraceRepository.js';
import { ModelRegistry } from '../../core/router/ModelRegistry.js';
import { CoreAiService } from '../coreAiService.js';
import { AttachmentProviderExecutor } from './providerExecutor.js';

function exactHarness() {
  const calls = [];
  const reservations = [];
  const settings = {
    load() {
      return {
        providers: {
          qwen: {
            id: 'qwen',
            enabled: true,
            apiKey: 'test-only',
            apiKeyConfigured: true,
            healthy: true,
            status: '可用',
            baseUrl: 'https://qwen.invalid/v1',
            defaultModel: 'qwen-plus',
            modelOptions: [
              { value: 'qwen-plus' },
              { value: 'qwen3-vl-plus' },
              { value: 'qwen3.5-ocr' }
            ]
          }
        },
        router: { routes: {} }
      };
    },
    recordProviderHealth() {}
  };
  const accessControl = {
    reserveProviderAttempt({ subject, requestLease, attempt, request }) {
      assert.equal(subject.accountId, 'user-a');
      assert.equal(requestLease.requestId, 'request-a');
      reservations.push({ attempt: structuredClone(attempt), request: structuredClone(request) });
      return { request, attempt };
    },
    settleProviderAttempt({ reservation, usage, outcome }) {
      reservation.usage = usage;
      reservation.outcome = outcome;
    }
  };
  const providers = {
    async chat(request) {
      calls.push(structuredClone(request));
      return {
        provider: 'qwen',
        model: request.options.model,
        content: request.options.model === 'qwen3.5-ocr'
          ? JSON.stringify({ raw_text: 'AI7', normalized_text: 'AI7' })
          : JSON.stringify({ scene_summary: '红色圆形在蓝色方形左侧' }),
        usage: { input_tokens: 12, output_tokens: 4 }
      };
    }
  };
  const service = new CoreAiService({
    settings,
    providers,
    traces: new InvocationTraceRepository({ storage: createMemoryStorage() }),
    registry: new ModelRegistry(),
    accessControl
  });
  return { service, calls, reservations };
}

test('RED: exact OCR route preserves multimodal arrays and crosses the unique quota gate once', async () => {
  const h = exactHarness();
  const messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'extract' }
    ]
  }];
  const result = await h.service.runExactCapability({
    providerId: 'qwen',
    modelId: 'qwen3.5-ocr',
    capability: 'OCR',
    messages,
    requestId: 'request-a',
    executionId: 'execution-ocr',
    attemptId: 'attempt-ocr'
  }, {
    subject: { accountId: 'user-a', role: 'beta_user' },
    requestLease: { requestId: 'request-a' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.route.selectedProvider, 'qwen');
  assert.equal(result.route.selectedModel, 'qwen3.5-ocr');
  assert.equal(result.route.fallbackUsed, false);
  assert.deepEqual(h.calls[0].messages, messages);
  assert.equal(h.calls[0].options.model, 'qwen3.5-ocr');
  assert.equal(h.reservations.length, 1);
  assert.equal(h.reservations[0].attempt.attemptId, 'attempt-ocr');
  assert.equal(h.reservations[0].attempt.attemptType, 'attachment_processing');
});

test('RED: exact Vision route sends all images in one call and never selects another Provider', async () => {
  const h = exactHarness();
  const executor = new AttachmentProviderExecutor({ aiService: h.service });
  const attachment = (id) => ({ attachmentId: id, mimeType: 'image/png' });
  const result = await executor.runVision({
    attachments: [attachment('a'), attachment('b'), attachment('c')],
    buffers: [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')],
    userQuestion: '比较这些图片',
    trace: {
      requestId: 'request-a',
      executionId: 'execution-vision',
      attemptId: 'attempt-vision'
    },
    invocation: {
      subject: { accountId: 'user-a', role: 'beta_user' },
      requestLease: { requestId: 'request-a' }
    }
  });
  assert.match(result.sceneSummary, /红色圆形/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].provider, 'qwen');
  assert.equal(h.calls[0].options.model, 'qwen3-vl-plus');
  assert.equal(h.calls[0].messages[0].content.filter((part) => part.type === 'image_url').length, 3);
  assert.equal(h.reservations.length, 1);
});

test('RED: OCR parser keeps raw AI7 and records whitespace limitation without inserting a space', async () => {
  const h = exactHarness();
  const executor = new AttachmentProviderExecutor({ aiService: h.service });
  const result = await executor.runOcr({
    attachment: { attachmentId: 'a', mimeType: 'image/png' },
    buffer: Buffer.from('a'),
    trace: {
      requestId: 'request-a',
      executionId: 'execution-ocr',
      attemptId: 'attempt-ocr'
    },
    invocation: {
      subject: { accountId: 'user-a', role: 'beta_user' },
      requestLease: { requestId: 'request-a' }
    }
  });
  assert.equal(result.rawText, 'AI7');
  assert.equal(result.normalizedText, 'AI7');
  assert.equal(result.limitations.includes('whitespace_layout_may_be_lost'), true);
});

test('RED: Qwen coordinate OCR output is grouped into stable table rows without changing cell text', async () => {
  const executor = new AttachmentProviderExecutor({
    aiService: {
      async runExactCapability() {
        return {
          ok: true,
          content: JSON.stringify([
            { rotate_rect: [100, 100, 20, 40, 0], text: '项目' },
            { rotate_rect: [400, 100, 20, 40, 0], text: '金额' },
            { rotate_rect: [100, 200, 20, 40, 0], text: '餐费' },
            { rotate_rect: [400, 202, 20, 40, 0], text: '86' },
            { rotate_rect: [100, 300, 20, 40, 0], text: '打车' },
            { rotate_rect: [400, 300, 20, 40, 0], text: '18' }
          ]),
          usage: null
        };
      }
    }
  });
  const result = await executor.runOcr({
    attachment: { attachmentId: 'a', mimeType: 'image/png' },
    buffer: Buffer.from('a'),
    trace: {
      requestId: 'request-a',
      executionId: 'execution-ocr',
      attemptId: 'attempt-ocr'
    },
    invocation: {}
  });
  assert.deepEqual(result.tableRegions[0].rows, [
    ['项目', '金额'],
    ['餐费', '86'],
    ['打车', '18']
  ]);
  assert.match(result.rawText, /餐费/);
  assert.match(result.rawText, /打车/);
});

test('OCR uses the documented text-recognition task and preserves receipt evidence without repairing malformed coordinates', async () => {
  const raw='内部模拟票据\n茶杯 2件 单价 ¥12.50\n笔记本 1本 单价 ¥39.50\n合计 ¥64.50';
  const executor=new AttachmentProviderExecutor({aiService:{async runExactCapability(task){
    const instruction=task.messages[0].content.find(part=>part.type==='text').text;
    assert.equal(instruction,'Please output only the text content from the image without any additional descriptions or formatting.');
    return {ok:true,content:raw};
  }}});
  const result=await executor.runOcr({attachment:{attachmentId:'receipt',mimeType:'image/png'},buffer:Buffer.from('synthetic fixture'),trace:{}});
  assert.equal(result.rawText,raw);assert.equal(result.normalizedText,raw);assert.deepEqual(result.tableRegions,[]);
});

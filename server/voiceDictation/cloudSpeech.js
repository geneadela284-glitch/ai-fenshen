import {randomUUID} from 'node:crypto';
import {createRouterExecutionContext} from '../../core/router/RouterExecutionContext.js';
import {validateDictationRequest, voiceError} from './audioContract.js';

const MODEL = 'qwen3-asr-flash';
const CAPABILITY = 'DICTATION_ASR';
function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw voiceError('ASR_ENGINE_UNAVAILABLE'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      !(/^(dashscope|dashscope-intl)\.aliyuncs\.com$/.test(url.hostname) || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname))) {
    throw voiceError('ASR_ENGINE_UNAVAILABLE');
  }
  return url.origin;
}
async function readResult(response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw voiceError(response.status === 429 ? 'ASR_BUSY' : 'ASR_ENGINE_UNAVAILABLE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw voiceError('TRANSCRIPTION_FAILED');
  const parts = []; let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 128 * 1024) throw voiceError('TRANSCRIPTION_FAILED');
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  let result;
  try { result = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw voiceError('TRANSCRIPTION_FAILED'); }
  const text = result.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length > 8000) throw voiceError('TRANSCRIPTION_FAILED');
  if (!/[\p{L}\p{N}]/u.test(text)) throw voiceError('AUDIO_NO_SPEECH');
  return {transcript: text.trim(), usage: result.usage || null};
}

// Separate from learning and continuous-voice runtimes; no changes to their settings.
export function createDictationSpeechRuntime({aiService, fetchImpl = globalThis.fetch} = {}) {
  return Object.freeze({async run(task, invocation) {
    if (task?.capability !== CAPABILITY) throw voiceError('ASR_ENGINE_UNAVAILABLE');
    const request = validateDictationRequest(task.request);
    if (request.ownerId !== invocation?.ownerId || !invocation?.requestLease) throw voiceError('ACCOUNT_CONTEXT_MISMATCH');
    task.signal?.throwIfAborted();
    const config = aiService.settings.load().providers?.qwen;
    if (config?.enabled !== true) throw voiceError('ASR_ENGINE_UNAVAILABLE');
    const origin = originOf(config.baseUrl);
    const candidate = {providerId: 'qwen', modelId: MODEL};
    const execution = createRouterExecutionContext({requestId: invocation.requestLease.requestId, ownerId: request.ownerId, domain: 'dictation'});
    return aiService.router.invokeGuardedOperation({
      candidate, attempt: execution.attempt(1, candidate), invocation, pricing: null,
      request: {input: 'Chinese dictation', options: {maxTokens: 1200}, metadata: {purpose: 'dictation'}},
      operation: async () => {
        task.signal?.throwIfAborted();
        const withKey = async credentials => {
          if (!credentials?.api_key) throw voiceError('ASR_ENGINE_UNAVAILABLE');
          const response = await fetchImpl(origin + '/compatible-mode/v1/chat/completions', {
            method: 'POST', redirect: 'error', signal: task.signal,
            headers: {Authorization: `Bearer ${credentials.api_key}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({model: MODEL, messages: [{role: 'user', content: [{type: 'input_audio', input_audio: {data: `data:audio/wav;base64,${request.audioBytes.toString('base64')}`}}]}], stream: false, asr_options: {language: 'zh', enable_itn: false}})
          });
          const result = await readResult(response);
          task.signal?.throwIfAborted();
          return result;
        };
        return aiService.credentialResolver
          ? aiService.credentialResolver.withCredentials({providerId: 'qwen', purpose: 'invoke'}, withKey)
          : withKey({api_key: config.apiKey});
      }
    });
  }});
}

// Acquire the existing quota lease only when a deduplicated queued job actually runs.
export function createRoutedDictationTranscriber({aiService, accessControl} = {}) {
  return async ({request, invocation = {}, signal}) => {
    const actor = accessControl.assertAuthenticatedSubject(invocation.subject);
    if (actor.accountId !== request.ownerId) throw voiceError('ACCOUNT_CONTEXT_MISMATCH');
    if (signal?.aborted) throw voiceError('CANCELLED');
    const controller = new AbortController();
    const abort = () => controller.abort(voiceError('CANCELLED'));
    signal?.addEventListener('abort', abort, {once: true});
    const timeout = setTimeout(() => controller.abort(voiceError('TIMEOUT')), 40000);
    let lease;
    try {
      lease = accessControl.beginRequest({subject: invocation.subject, requestId: `dictation_${randomUUID()}`});
      const result = await aiService.router.run({capability: CAPABILITY, request, signal: controller.signal}, {
        subject: invocation.subject, ownerId: request.ownerId, requestLease: lease, signal: controller.signal
      });
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (lease) accessControl.releaseRequest(lease);
    }
  };
}

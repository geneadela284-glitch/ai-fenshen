import { learningError, requiredText } from '../../core/learning/contract.js';

// Learning owns its duration policy. Accepted dictation and Meeting contracts are unchanged.
export function validateLearningAudio(bytes, { allowSilence = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > 8 * 1024 * 1024) throw learningError('AUDIO_INVALID');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw learningError('AUDIO_INVALID');
  let fmt, data, offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > bytes.length) throw learningError('AUDIO_INVALID');
    if (id === 'fmt ') {
      if (fmt || length < 16) throw learningError('AUDIO_INVALID');
      fmt = bytes.subarray(start, start + length);
    }
    if (id === 'data') {
      if (data) throw learningError('AUDIO_INVALID');
      data = bytes.subarray(start, start + length);
    }
    offset = start + length + length % 2;
  }
  if (!fmt || !data?.length || data.length % 2 || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 ||
      fmt.readUInt32LE(4) !== 16000 || fmt.readUInt32LE(8) !== 32000 || fmt.readUInt16LE(12) !== 2 || fmt.readUInt16LE(14) !== 16) throw learningError('AUDIO_INVALID');
  const durationMs = data.length / 32;
  if (durationMs > 120000) throw learningError('AUDIO_TOO_LONG');
  if (durationMs < 100) throw learningError('AUDIO_INVALID');
  let energy = 0;
  for (let i = 0; i < data.length; i += 2) energy += (data.readInt16LE(i) / 32768) ** 2;
  const rms = Math.sqrt(energy / (data.length / 2));
  if (!allowSilence && rms < 0.00015) throw learningError('AUDIO_SILENT');
  return { durationMs, rms, sampleRate: 16000 };
}

export class SpeechGateway {
  constructor({ transcribe, synthesize, realtimeTranscribe, timeoutMs = 30000 } = {}) {
    this.realtimeTranscribe=realtimeTranscribe; this.transcribe = transcribe; this.synthesize = synthesize; this.timeoutMs = timeoutMs; this.active = false;
  }
  assertOwner(invocation) {
    if (typeof invocation?.ownerId !== 'string' || !invocation.ownerId.trim()) throw learningError('AUTH_REQUIRED', 401);
  }
  async waitForIdle(){await this.pendingOperation?.catch(()=>{});}
  get realtimeAvailable(){return typeof this.realtimeTranscribe==='function';}
  get available() { return typeof this.transcribe === 'function' && typeof this.synthesize === 'function'; }
  async run(task, invocation = {}) {
    this.assertOwner(invocation);
    if (!this.available) throw learningError('LEARNING_SPEECH_UNAVAILABLE', 503);
    if (this.active) throw learningError('LEARNING_SPEECH_BUSY', 429);
    if (invocation.signal?.aborted) throw learningError('CANCELLED', 499);
    if (task.language && task.language !== 'en') throw learningError('LANGUAGE_UNAVAILABLE');
    if (!['SPEECH_TO_TEXT', 'TEXT_TO_SPEECH'].includes(task.capability)) throw learningError('SPEECH_CAPABILITY_INVALID');
    const realtime=task.mode==='learning_realtime'&&task.capability==='SPEECH_TO_TEXT';
    if(realtime&&!this.realtimeAvailable)throw learningError('LEARNING_SPEECH_UNAVAILABLE',503);
    const audio = !realtime && task.capability === 'SPEECH_TO_TEXT' ? validateLearningAudio(task.input) : null;
    const input = realtime?task.audioSource:audio ? task.input : requiredText(task.input, 1200);
    const controller = new AbortController();
    const abort = () => controller.abort();
    invocation.signal?.addEventListener('abort', abort, { once: true });
    let rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const onAbort = () => rejectStop(learningError('CANCELLED', 499));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { rejectStop(learningError('SPEECH_TIMEOUT', 504)); controller.abort(); }, realtime?150000:this.timeoutMs);
    this.active = true;
    // Cancellation ends the user's wait, while the resource slot remains held until
    // the adapter actually stops. This prevents cancelled work overlapping a retry.
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw learningError('CANCELLED', 499);
      return realtime?this.realtimeTranscribe(input,{signal:controller.signal,invocation}):audio ? this.transcribe(input, { signal: controller.signal, language: 'en', invocation }) :
        this.synthesize(input, { signal: controller.signal, rate: task.rate === 'slow' ? 'slow' : 'normal', language: 'en', invocation });
    });
    this.pendingOperation=operation;
    operation.then(() => { this.active = false; }, () => { this.active = false; });
    try {
      const result = await Promise.race([operation, stopped]);
      if (controller.signal.aborted) throw learningError('CANCELLED', 499);
      if(realtime)return {transcript:requiredText(result?.transcript,6000)};
      if (audio) return { transcript: requiredText(result?.transcript, 6000), durationMs: audio.durationMs };
      validateLearningAudio(result);
      return { audio: result, contentType: 'audio/wav' };
    } catch(error){if(realtime)await operation.catch(()=>{});throw error;
    } finally {
      clearTimeout(timer);
      invocation.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
}

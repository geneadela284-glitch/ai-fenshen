import { createEvidenceRef } from './meetingEvidenceRefContracts.js';
import {
  GROUNDING_REJECTED,
  GROUNDING_SUPPORTED,
  GROUNDING_UNRESOLVED,
  groundCandidate
} from './meetingGroundingPolicy.js';
import { createMeetingActionItem } from './meetingActionItemContracts.js';
import { createMeetingDecision } from './meetingDecisionContracts.js';
import { createMeetingSummary } from './meetingSummaryContracts.js';
import {
  assertResultInput,
  codedError,
  deterministicId,
  dedupeEvidenceRefs,
  sha256,
  timestamp
} from './meetingBrainContractUtils.js';

const DEFAULT_MAX_BATCH_CHARS = 12_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const TRANSIENT_MODEL_ERRORS = new Set([
  'TIMEOUT',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'NO_CAPABLE_MODEL',
  'NETWORK_ERROR'
]);
const TENTATIVE_MARKERS = /要不|考虑一下|也许|可能|大概|应该|原则上|再看看|回头再确定|我觉得|建议|最好|愿望|希望/;
const CONDITIONAL_MARKERS = /如果|要是|除非|在.*情况下|等.*确认/;
const EXPLICIT_DECISION_MARKERS = /就这么定|定了|确定|确认|最终|那就|拍板|正式|决定|同意|敲定/;
const NEGATED_DECISION_MARKERS = /尚未|还没|没有形成|不确定|未确定|不是最终|暂不/;
const APPROXIMATE_MARKERS = /大概|大约|左右|约|差不多|预计|可能|尽快|尽量|之后再定|待定/;
const ACTION_MARKERS = /负责|跟进|处理|完成|提交|发送|发给|发货|上线|整理|确认|交付|报价|安排|准备|提供|联系|通知|制定|推进/;
const WEEKDAY_MAP = Object.freeze({
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0
});
const CURRENCY_MAP = Object.freeze({
  '人民币': 'CNY', '元': 'CNY', '块': 'CNY', 'CNY': 'CNY', 'RMB': 'CNY', '¥': 'CNY', '￥': 'CNY',
  '美元': 'USD', '美元': 'USD', 'USD': 'USD', '$': 'USD',
  '欧元': 'EUR', 'EUR': 'EUR', '港币': 'HKD', 'HKD': 'HKD'
});
const QUANTITY_UNITS = '份|个|件|台|人|套|箱|项|条|张|次|天|小时|名|家|包|页|套';
const CHINESE_DIGITS = Object.freeze({ 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
const CHINESE_SMALL_UNITS = Object.freeze({ 十: 10, 百: 100, 千: 1000 });
const CHINESE_LARGE_UNITS = Object.freeze({ 万: 10_000, 亿: 100_000_000 });
const CANDIDATE_CONTENT_FIELDS = Object.freeze([
  'content',
  'value',
  'text',
  'point',
  'keyPoint',
  'conclusion',
  'question',
  'openQuestion',
  'action',
  'actionItem',
  'decision',
  'topic',
  'overview',
  'summary',
  'description',
  'item'
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function textOf(value) {
  return String(value ?? '').trim();
}

function objectOf(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function contentOf(candidate) {
  if (typeof candidate === 'string' || typeof candidate === 'number') return textOf(candidate);
  if (!objectOf(candidate)) return '';
  for (const field of CANDIDATE_CONTENT_FIELDS) {
    const value = candidate[field];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const normalized = textOf(value);
    if (normalized) return normalized;
  }
  return '';
}

function stableTranscriptFingerprint(transcriptRevision) {
  return sha256(JSON.stringify(transcriptRevision.segments.map((segment) => ({
    segmentId: segment.segmentId,
    sequence: segment.sequence,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    revision: segment.revision
  }))));
}

function normalizeModelCode(value) {
  return textOf(value).toUpperCase().replace(/[^A-Z0-9_]+/g, '_') || 'PROVIDER_ERROR';
}

function modelErrorCode(response) {
  return normalizeModelCode(response?.error?.code || response?.code || response?.error?.message || 'PROVIDER_ERROR');
}

function resultContent(response) {
  return response?.content || response?.text || response?.output || response?.result?.content || response?.result?.text || '';
}

function stripJsonFence(content) {
  const value = textOf(content);
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : value;
}

function balancedJsonObjects(content) {
  const value = textOf(content);
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (start < 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character !== '}') continue;
    depth -= 1;
    if (depth !== 0) continue;
    candidates.push(value.slice(start, index + 1));
    start = -1;
  }
  return candidates;
}

function jsonCandidates(content) {
  const value = textOf(content);
  const candidates = [];
  for (const match of value.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    candidates.push(match[1].trim());
  }
  candidates.push(stripJsonFence(value));
  candidates.push(...balancedJsonObjects(value));
  return unique(candidates.filter(Boolean));
}

function parsePayload(response) {
  if (response?.error) return { ok: false, reason: modelErrorCode(response) };
  const raw = resultContent(response);
  if (!raw) return { ok: false, reason: 'EMPTY_RESPONSE' };
  if (objectOf(raw)) return validatePayload(raw);
  let lastReason = 'INVALID_JSON';
  for (const candidate of jsonCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate);
      const validation = validatePayload(parsed);
      if (validation.ok) return validation;
      lastReason = validation.reason;
    } catch {
      // Keep looking: model prose may contain an unrelated brace before the
      // actual structured result. The contract validation below remains the
      // final gate before any meeting data can be saved.
    }
  }
  return { ok: false, reason: lastReason };
}

function validatePayload(payload) {
  if (!objectOf(payload) || !objectOf(payload.summary) || !Array.isArray(payload.decisions) || !Array.isArray(payload.actionItems)) {
    return { ok: false, reason: 'PARTIAL_JSON' };
  }
  for (const field of ['topic', 'overview', 'keyPoints', 'conclusions', 'openQuestions']) {
    if (!Object.hasOwn(payload.summary, field)) return { ok: false, reason: 'PARTIAL_JSON' };
  }
  for (const field of ['keyPoints', 'conclusions', 'openQuestions']) {
    if (!Array.isArray(payload.summary[field])) return { ok: false, reason: 'PARTIAL_JSON' };
  }
  return { ok: true, payload };
}

function formatBatch(segments) {
  return segments.map((segment) => [
    `[TRANSCRIPT_SEGMENT segmentId="${segment.segmentId}" startMs="${segment.startMs}" endMs="${segment.endMs}"]`,
    segment.text,
    '[/TRANSCRIPT_SEGMENT]'
  ].join('\n')).join('\n');
}

function makeBatches(segments, maxBatchChars) {
  const limit = Math.max(1, Number(maxBatchChars || DEFAULT_MAX_BATCH_CHARS));
  const batches = [];
  let current = [];
  let currentLength = 0;
  for (const segment of segments) {
    const segmentLength = formatBatch([segment]).length;
    if (current.length > 0 && currentLength + segmentLength > limit) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(segment);
    currentLength += segmentLength;
    if (segmentLength > limit) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function systemInstruction() {
  return [
    '你是 Meeting V1 Stage4 的候选结构化分析器。',
    '只根据当前批次中的完整 Transcript segment 生成 JSON 候选，不要补充原文没有的事实。',
    '每一个候选如有事实内容，必须使用 evidenceHints；每条 evidenceHint 必须包含 segmentId 和从该 segment 原样复制的连续 quote。startOffset 和 endOffset 可以省略，系统会根据 quote 计算；如果输出这两个字段，必须与 quote 完全一致。',
    '如果无法从当前 Transcript segment 找到逐字连续引用，就不要编造候选，也不要输出无法核验的总结。',
    '不要输出 ownerId、meetingId、sourceId、transcriptRevision 或任何跨权限信息；这些字段由确定性系统绑定。',
    '不确定的负责人、日期、金额、数量、决定或承诺必须保留为 unresolved 或不要输出。',
    '输出 JSON：summary(topic, overview, keyPoints, conclusions, openQuestions)，decisions 数组，actionItems 数组。',
    'topic、overview、keyPoints、conclusions、openQuestions 可以用简洁中文概括，但只能表达所附原文 quote 明确支持的内容；decisions 和 actionItems 的 content 必须使用原文连续文字，不要自行改写事实。',
    'topic 和 overview 必须使用对象形式，并包含 content 与 evidenceHints；不能输出没有证据引用的裸字符串。数组中的每个候选对象必须使用 content 字段保存候选文字，不能使用 point、conclusion、question、action 或其他替代字段。',
    '每个候选对象的格式为 {"content":"基于原文的会议整理文字","evidenceHints":[{"segmentId":"当前批次中的 segmentId","quote":"该 segment 中连续且逐字一致的原文"}]}。摘要可以概括，但 quote 始终必须逐字一致；没有可靠 quote 就不要输出候选。'
  ].join('\n');
}

function taskForBatch({ batch, batchIndex, batchCount, binding, input, idempotencyKey }) {
  const transcript = formatBatch(batch);
  return {
    capability: 'MEETING_SUMMARY',
    method: 'generate',
    input: transcript,
    messages: [
      { role: 'system', content: systemInstruction() },
      { role: 'user', content: `会议标题：${textOf(input.meetingMetadata?.title) || '未提供'}\n当前批次：${batchIndex + 1}/${batchCount}\n${transcript}` }
    ],
    metadata: {
      stage4Phase: 2,
      meetingBrain: true,
      memoryPolicy: 'disabled',
      ownerId: binding.ownerId,
      meetingId: binding.meetingId,
      transcriptRevision: binding.transcriptRevision,
      batchIndex,
      batchCount,
      batchSegmentIds: batch.map((segment) => segment.segmentId),
      idempotencyKey
    }
  };
}

function evidenceRepairTask(task) {
  const userMessage = task.messages.find((message) => message.role === 'user')?.content || task.input;
  return {
    ...task,
    messages: [
      {
        role: 'system',
        content: `${systemInstruction()}\n上一版 JSON 没有产生可验证的原文证据。请重新生成；不要解释原因，只返回符合要求的 JSON。`
      },
      {
        role: 'user',
        content: `${userMessage}\n请优先保证每个输出候选都带有正确的 segmentId 和原文 quote；摘要可以概括，但不得超出 quote 明确支持的范围；decisions 和 actionItems 请直接使用原文连续文字；不要填写猜测内容。`
      }
    ],
    metadata: {
      ...task.metadata,
      attemptType: 'evidence_repair'
    }
  };
}

function isRetryable(code) {
  return TRANSIENT_MODEL_ERRORS.has(normalizeModelCode(code));
}

function dedupeByContent(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify({ content: item.content, evidenceRefIds: item.evidenceRefs.map((ref) => ref.evidenceRefId).sort() });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceText(evidenceRefs) {
  return evidenceRefs.map((ref) => ref.textSpan.quote).join('\n');
}

function datePartsInTimeZone(value, timeZone = 'UTC') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short'
    }).formatToParts(date);
    const result = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[result.weekday];
    return { year: Number(result.year), month: Number(result.month), day: Number(result.day), weekday };
  } catch {
    return null;
  }
}

function dateString(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(value.getTime()) || value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return value.toISOString().slice(0, 10);
}

function addDays(date, amount) {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function parseDate(text, meetingMetadata = {}) {
  const explicit = [];
  const explicitPattern = /(20\d{2})\s*(?:[-/.年])\s*(\d{1,2})\s*(?:[-/.月])\s*(\d{1,2})\s*日?/g;
  for (const match of text.matchAll(explicitPattern)) {
    const value = dateString(Number(match[1]), Number(match[2]), Number(match[3]));
    if (value) explicit.push({ index: match.index, value });
  }
  if (explicit.length) return explicit.at(-1).value;
  const weekdays = [];
  const weekdayPattern = /(下周|下星期|下礼拜|本周|本星期|这周|这个星期|周|星期|礼拜)\s*([一二三四五六日天])/g;
  for (const match of text.matchAll(weekdayPattern)) weekdays.push({ index: match.index, next: match[1].startsWith('下'), weekday: WEEKDAY_MAP[match[2]] });
  if (!weekdays.length) return 'unresolved';
  const base = datePartsInTimeZone(meetingMetadata.startedAt, meetingMetadata.timeZone || 'UTC');
  if (!base || base.weekday === undefined) return 'unresolved';
  const target = weekdays.at(-1);
  let delta = (target.weekday - base.weekday + 7) % 7;
  if (target.next) delta += 7;
  return addDays(base, delta);
}

function chineseNumber(value) {
  const text = textOf(value);
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return text.replace(/,/g, '');
  if (!/^[零一二两三四五六七八九十百千万亿]+$/.test(text)) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of text) {
    if (Object.hasOwn(CHINESE_DIGITS, char)) {
      number = CHINESE_DIGITS[char];
      continue;
    }
    if (Object.hasOwn(CHINESE_SMALL_UNITS, char)) {
      const unit = CHINESE_SMALL_UNITS[char];
      section += (number || 1) * unit;
      number = 0;
      continue;
    }
    if (Object.hasOwn(CHINESE_LARGE_UNITS, char)) {
      const unit = CHINESE_LARGE_UNITS[char];
      section = (section + number) || 1;
      total += section * unit;
      section = 0;
      number = 0;
    }
  }
  const result = total + section + number;
  return result > 0 ? String(result) : null;
}

function approximateAround(text, start, end) {
  return APPROXIMATE_MARKERS.test(text.slice(Math.max(0, start - 8), Math.min(text.length, end + 8)));
}

function parseAmount(text) {
  const numberPattern = '[0-9][0-9,]*(?:\\.[0-9]+)?|[零一二两三四五六七八九十百千万亿]+';
  const patterns = [
    {
      pattern: new RegExp(`(人民币|CNY|RMB|¥|￥|美元|USD|\\$|欧元|EUR|港币|HKD)\\s*(${numberPattern})\\s*(元|块)?`, 'gi'),
      currencyFirst: true
    },
    {
      pattern: new RegExp(`(${numberPattern})\\s*(人民币|CNY|RMB|¥|￥|美元|USD|\\$|欧元|EUR|港币|HKD|元|块)`, 'gi'),
      currencyFirst: false
    }
  ];
  const matches = [];
  for (const item of patterns) {
    for (const match of text.matchAll(item.pattern)) {
      const currencyToken = item.currencyFirst ? match[1] : match[2];
      const numericToken = item.currencyFirst ? match[2] : match[1];
      const suffix = item.currencyFirst ? match[3] : '';
      const currency = CURRENCY_MAP[currencyToken] || CURRENCY_MAP[suffix];
      const value = chineseNumber(numericToken);
      if (!currency || !value) continue;
      matches.push({
        index: match.index,
        end: match.index + match[0].length,
        value: { value, currency },
        approximate: approximateAround(text, match.index, match.index + match[0].length)
      });
    }
  }
  return matches.at(-1) || null;
}

function parseQuantity(text) {
  const pattern = new RegExp(`(${ '[0-9][0-9,]*(?:\\.[0-9]+)?|[零一二两三四五六七八九十百千万亿]+' })\\s*(${QUANTITY_UNITS})`, 'g');
  const matches = [];
  for (const match of text.matchAll(pattern)) {
    const value = chineseNumber(match[1]);
    if (!value) continue;
    matches.push({
      index: match.index,
      end: match.index + match[0].length,
      value: { value, unit: match[2] },
      approximate: approximateAround(text, match.index, match.index + match[0].length)
    });
  }
  return matches.at(-1) || null;
}

function cleanOwner(value) {
  const cleaned = textOf(value).replace(/^(?:不是|并非|是|由|让|请|叫|需要)/, '').trim();
  if (!cleaned || /^(?:有人|某人|团队|大家|客户|我们|你|我|他|她|对方|销售团队)$/.test(cleaned)) return null;
  if (cleaned.length > 8) return null;
  return cleaned;
}

function parseOwner(text) {
  const matches = [];
  const direct = /(?:^|[，,。；;、\s])((?:不是|并非|是|由|让|请|叫)?[\u4e00-\u9fffA-Za-z]{1,8})\s*负责/g;
  for (const match of text.matchAll(direct)) {
    const owner = cleanOwner(match[1]);
    if (owner) matches.push({ index: match.index, owner });
  }
  const contextual = /(?:报价的事情|报价|交付的事情|交付|项目|工作|任务|事情)(?:是|由|让|请)?([\u4e00-\u9fffA-Za-z]{1,8})\s*负责/g;
  for (const match of text.matchAll(contextual)) {
    const owner = cleanOwner(match[1]);
    if (owner) matches.push({ index: match.index, owner });
  }
  matches.sort((a, b) => a.index - b.index);
  return matches.at(-1)?.owner || null;
}

function unresolvedReasonFor(field, text, parsed) {
  const ambiguous = APPROXIMATE_MARKERS.test(text) || (parsed && parsed.approximate);
  const names = {
    owner: ambiguous ? 'OWNER_AMBIGUOUS' : 'OWNER_NOT_STATED',
    dueDate: ambiguous ? 'DUE_DATE_AMBIGUOUS' : 'DUE_DATE_NOT_STATED',
    amount: ambiguous ? 'AMOUNT_AMBIGUOUS' : 'AMOUNT_NOT_STATED',
    quantity: ambiguous ? 'QUANTITY_AMBIGUOUS' : 'QUANTITY_NOT_STATED'
  };
  return names[field];
}

function exactEvidenceHint(content, batch) {
  const normalized = textOf(content);
  if (!normalized) return null;
  const matches = [];
  for (const segment of batch) {
    let offset = segment.text.indexOf(normalized);
    while (offset >= 0) {
      matches.push({ segment, offset });
      offset = segment.text.indexOf(normalized, offset + normalized.length);
    }
  }
  if (matches.length !== 1) return null;
  const { segment, offset } = matches[0];
  return {
    segmentId: segment.segmentId,
    startOffset: offset,
    endOffset: offset + normalized.length,
    quote: normalized
  };
}

function normalizeEvidenceHint(rawHint, batch) {
  if (!objectOf(rawHint)) throw codedError('EVIDENCE_HINT_INVALID');
  const segment = batch.find((item) => item.segmentId === rawHint.segmentId);
  if (!segment) throw codedError('EVIDENCE_OUTSIDE_BATCH');
  const quote = typeof rawHint.quote === 'string' ? rawHint.quote : String(rawHint.quote ?? '');
  if (!quote) throw codedError('EVIDENCE_QUOTE_REQUIRED');
  const hasStartOffset = Object.hasOwn(rawHint, 'startOffset');
  const hasEndOffset = Object.hasOwn(rawHint, 'endOffset');
  if (!hasStartOffset && !hasEndOffset) {
    const startOffset = segment.text.indexOf(quote);
    if (startOffset < 0) throw codedError('EVIDENCE_QUOTE_NOT_FOUND');
    return {
      segmentId: rawHint.segmentId,
      startOffset,
      endOffset: startOffset + quote.length,
      quote
    };
  }
  return {
    segmentId: rawHint.segmentId,
    startOffset: rawHint.startOffset,
    endOffset: rawHint.endOffset,
    quote
  };
}

function prepareEvidence({ raw, kind, batch, context, diagnostics, evidenceById, generatedAt }) {
  const content = contentOf(raw);
  const suppliedHints = Array.isArray(raw?.evidenceHints) ? raw.evidenceHints : [];
  const fallbackHint = suppliedHints.length ? null : exactEvidenceHint(content, batch);
  const hints = suppliedHints.length ? suppliedHints : (fallbackHint ? [fallbackHint] : []);
  if (!hints.length) return { content, evidenceRefs: [], grounding: GROUNDING_UNRESOLVED };
  const refs = [];
  try {
    for (const hint of hints) {
      const normalizedHint = normalizeEvidenceHint(hint, batch);
      const ref = createEvidenceRef({
        ownerContext: context.ownerContext,
        source: context.source,
        transcriptRevision: context.transcriptRevision,
        segmentId: normalizedHint.segmentId,
        textSpan: {
          startOffset: normalizedHint.startOffset,
          endOffset: normalizedHint.endOffset,
          quote: normalizedHint.quote
        },
        diarizationRevision: context.diarizationRevision,
        speakerCorrectionRevision: context.speakerCorrectionRevision,
        createdAt: generatedAt
      });
      refs.push(ref);
    }
  } catch (error) {
    diagnostics.rejectedCandidates.push({ kind, content, code: 'EVIDENCE_REJECTED', reason: error.code });
    return { content, evidenceRefs: [], grounding: GROUNDING_REJECTED, rejectionReason: error.code };
  }
  const grounding = groundCandidate({
    ownerContext: context.ownerContext,
    source: context.source,
    transcriptRevision: context.transcriptRevision,
    allowParaphrase: kind.startsWith('summary.'),
    currentDiarizationRevision: context.diarizationRevision,
    currentSpeakerCorrectionRevision: context.speakerCorrectionRevision,
    candidate: { ...raw, content, status: 'candidate', evidenceRefs: refs }
  });
  if (grounding.status === GROUNDING_REJECTED) {
    diagnostics.rejectedCandidates.push({
      kind,
      content,
      code: 'EVIDENCE_REJECTED',
      reason: grounding.rejectionReasons?.[0]?.code || 'GROUNDING_REJECTED'
    });
  }
  if (grounding.status === GROUNDING_UNRESOLVED) diagnostics.unresolvedCandidates.push({ kind, content, reasons: grounding.unresolvedReasons || [] });
  const groundedRefs = grounding.evidenceRefs || refs;
  const canonicalRefs = grounding.status === GROUNDING_SUPPORTED
    ? groundedRefs.map((ref) => {
      const canonical = evidenceById.get(ref.evidenceRefId) || ref;
      evidenceById.set(ref.evidenceRefId, canonical);
      return canonical;
    })
    : groundedRefs;
  return { content, evidenceRefs: canonicalRefs, grounding: grounding.status, groundingResult: grounding };
}

function candidateSummaryField(raw, kind, batch, context, diagnostics, evidenceById, generatedAt) {
  const prepared = prepareEvidence({ raw, kind, batch, context, diagnostics, evidenceById, generatedAt });
  if (prepared.grounding === GROUNDING_SUPPORTED) {
    return { value: prepared.content, groundingStatus: 'grounded', evidenceRefs: prepared.evidenceRefs };
  }
  if (prepared.grounding === GROUNDING_UNRESOLVED && prepared.evidenceRefs.length) {
    return { value: 'unresolved', groundingStatus: 'unresolved', unresolvedReason: 'EVIDENCE_INSUFFICIENT', evidenceRefs: prepared.evidenceRefs };
  }
  return { value: 'unresolved', groundingStatus: 'unresolved', unresolvedReason: 'NOT_STATED', evidenceRefs: [] };
}

function decisionIsConfirmed(content) {
  return EXPLICIT_DECISION_MARKERS.test(content) && !TENTATIVE_MARKERS.test(content) && !CONDITIONAL_MARKERS.test(content) && !NEGATED_DECISION_MARKERS.test(content);
}

function decisionReason(content) {
  if (CONDITIONAL_MARKERS.test(content)) return 'CONDITIONAL_STATEMENT';
  if (TENTATIVE_MARKERS.test(content)) return 'TENTATIVE_OR_AMBIGUOUS';
  if (NEGATED_DECISION_MARKERS.test(content)) return 'NO_FINAL_DECISION';
  if (!EXPLICIT_DECISION_MARKERS.test(content)) return 'NO_EXPLICIT_DECISION';
  return 'UNRESOLVED';
}

function toDecision(raw, batch, context, diagnostics, evidenceById, generatedAt) {
  const prepared = prepareEvidence({ raw, kind: 'decision', batch, context, diagnostics, evidenceById, generatedAt });
  if (prepared.grounding !== GROUNDING_SUPPORTED || !prepared.evidenceRefs.length) return null;
  const confirmed = decisionIsConfirmed(prepared.content);
  return {
    content: prepared.content,
    status: confirmed ? 'confirmed' : 'unresolved',
    confidence: confirmed
      ? { level: 'high', basis: 'explicit_statement' }
      : { level: 'low', basis: decisionReason(prepared.content) },
    unresolvedReason: confirmed ? undefined : decisionReason(prepared.content),
    evidenceRefs: prepared.evidenceRefs
  };
}

function toAction(raw, batch, context, diagnostics, evidenceById, generatedAt) {
  const prepared = prepareEvidence({ raw, kind: 'action_item', batch, context, diagnostics, evidenceById, generatedAt });
  if (prepared.grounding !== GROUNDING_SUPPORTED || !prepared.evidenceRefs.length) return null;
  const text = sourceText(prepared.evidenceRefs) || prepared.content;
  const owner = parseOwner(text);
  const date = parseDate(text, context.meetingMetadata);
  const amount = parseAmount(text);
  const quantity = parseQuantity(text);
  const unresolvedReasons = [];
  if (!owner) unresolvedReasons.push(unresolvedReasonFor('owner', text));
  if (date === 'unresolved') unresolvedReasons.push(unresolvedReasonFor('dueDate', text));
  if (!amount || amount.approximate) unresolvedReasons.push(unresolvedReasonFor('amount', text, amount));
  if (!quantity || quantity.approximate) unresolvedReasons.push(unresolvedReasonFor('quantity', text, quantity));
  const conditional = CONDITIONAL_MARKERS.test(text);
  if (conditional) unresolvedReasons.push('CONDITIONAL_ACTION');
  if (!ACTION_MARKERS.test(text)) unresolvedReasons.push('ACTION_NOT_EXPLICIT');
  return {
    content: prepared.content,
    owner: owner || 'unresolved',
    ownerRef: null,
    dueDate: date,
    amount: amount && !amount.approximate ? amount.value : 'unresolved',
    quantity: quantity && !quantity.approximate ? quantity.value : 'unresolved',
    status: unresolvedReasons.length ? 'unresolved' : 'candidate',
    unresolvedReasons: unique(unresolvedReasons),
    evidenceRefs: prepared.evidenceRefs
  };
}

function normalizeCandidateList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string' || typeof item === 'number') return { content: String(item) };
    return item;
  }).filter((item) => objectOf(item));
}

function payloadHasCandidates(payload) {
  const summary = payload?.summary || {};
  return [
    summary.topic,
    summary.overview,
    ...normalizeCandidateList(summary.keyPoints),
    ...normalizeCandidateList(summary.conclusions),
    ...normalizeCandidateList(summary.openQuestions),
    ...normalizeCandidateList(payload?.decisions),
    ...normalizeCandidateList(payload?.actionItems)
  ].some((candidate) => Boolean(contentOf(candidate)));
}

export class MeetingBrainEngine {
  constructor({
    modelRunner = null,
    now = () => new Date(),
    maxBatchChars = DEFAULT_MAX_BATCH_CHARS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS
  } = {}) {
    this.modelRunner = modelRunner;
    this.now = now;
    this.maxBatchChars = Math.max(1, Number(maxBatchChars || DEFAULT_MAX_BATCH_CHARS));
    this.maxAttempts = Math.max(1, Math.min(3, Number(maxAttempts || DEFAULT_MAX_ATTEMPTS)));
  }

  async runModel(task, diagnostics, attemptLimit = this.maxAttempts) {
    const runner = typeof this.modelRunner === 'function'
      ? this.modelRunner
      : this.modelRunner?.run?.bind(this.modelRunner);
    if (!runner) return { ok: false, reason: 'MODEL_RUNNER_UNAVAILABLE' };
    let lastFailure = null;
    const maxAttempts = Math.max(1, Math.min(3, Number(attemptLimit || this.maxAttempts)));
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      diagnostics.modelCalls += 1;
      try {
        const response = await runner(task);
        const parsed = parsePayload(response);
        if (parsed.ok) return parsed;
        lastFailure = parsed.reason;
        if (!isRetryable(parsed.reason) || attempt >= maxAttempts) return parsed;
      } catch (error) {
        lastFailure = normalizeModelCode(error?.code || error?.message);
        if (!isRetryable(lastFailure) || attempt >= maxAttempts) return { ok: false, reason: lastFailure };
      }
      diagnostics.retries += 1;
    }
    return { ok: false, reason: lastFailure || 'PROVIDER_ERROR' };
  }

  async generate(input = {}) {
    const trusted = assertResultInput(input);
    if (input.currentTranscriptRevision) {
      const current = assertResultInput({
        ownerContext: input.ownerContext,
        source: input.source,
        transcriptRevision: input.currentTranscriptRevision,
        diarizationRevision: input.diarizationRevision,
        speakerCorrectionRevision: input.speakerCorrectionRevision
      });
      if (Number(current.transcriptRevision.transcriptRevision) !== Number(trusted.transcriptRevision.transcriptRevision) ||
          stableTranscriptFingerprint(current.transcriptRevision) !== stableTranscriptFingerprint(trusted.transcriptRevision)) {
        return {
          ok: false,
          code: 'MEETING_TRANSCRIPT_REVISION_STALE',
          status: 'stale',
          data: null,
          diagnostics: { reason: 'TRANSCRIPT_REVISION_NOT_CURRENT', modelCalls: 0, retries: 0, batchCount: 0, rejectedCandidates: [], unresolvedCandidates: [] }
        };
      }
    }

    const generatedAt = timestamp(this.now(), 'RESULT_GENERATED_AT_INVALID');
    const context = {
      ...input,
      ...trusted,
      ownerContext: trusted.ownerContext,
      source: trusted.source,
      transcriptRevision: trusted.transcriptRevision,
      meetingMetadata: objectOf(input.meetingMetadata) ? input.meetingMetadata : {}
    };
    const batches = makeBatches(trusted.transcriptRevision.segments, this.maxBatchChars);
    const binding = {
      ownerId: trusted.ownerContext.ownerId,
      meetingId: trusted.source.meetingId,
      sourceId: trusted.source.sourceId,
      sourceRevision: Number(trusted.source.revision),
      transcriptId: trusted.transcriptRevision.transcriptId,
      transcriptRevision: Number(trusted.transcriptRevision.transcriptRevision)
    };
    const diagnostics = {
      batchCount: batches.length,
      modelCalls: 0,
      retries: 0,
      rejectedCandidates: [],
      unresolvedCandidates: [],
      acceptedCandidates: []
    };
    const evidenceById = new Map();
    const topics = [];
    const overviews = [];
    const keyPoints = [];
    const conclusions = [];
    const openQuestions = [];
    const decisions = [];
    const actionItems = [];

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const idempotencyKey = `meeting-stage4-phase2-${sha256(JSON.stringify({ binding, batchSegmentIds: batch.map((segment) => segment.segmentId) }))}`;
      const task = taskForBatch({ batch, batchIndex: index, batchCount: batches.length, binding, input, idempotencyKey });
      const parsed = await this.runModel(task, diagnostics);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'AI_ANALYSIS_UNAVAILABLE',
          status: 'failed',
          data: null,
          diagnostics: { ...diagnostics, reason: parsed.reason }
        };
      }
      const payload = parsed.payload;
      const applyPayload = (value) => {
        const summary = value.summary;
        const evidenceCountBefore = evidenceById.size;
        const summaryCountBefore = topics.length + overviews.length;
        const addSummary = (candidate, kind, target) => {
          const field = candidateSummaryField(candidate, kind, batch, context, diagnostics, evidenceById, generatedAt);
          if (field.groundingStatus === 'grounded') target.push({ content: field.value, evidenceRefs: field.evidenceRefs, category: candidate.category || 'discussion' });
        };
        addSummary(summary.topic, 'summary.topic', topics);
        addSummary(summary.overview, 'summary.overview', overviews);
        for (const candidate of normalizeCandidateList(summary.keyPoints)) addSummary(candidate, 'summary.keyPoint', keyPoints);
        for (const candidate of normalizeCandidateList(summary.conclusions)) addSummary(candidate, 'summary.conclusion', conclusions);
        for (const candidate of normalizeCandidateList(summary.openQuestions)) addSummary(candidate, 'summary.openQuestion', openQuestions);
        for (const candidate of normalizeCandidateList(value.decisions)) {
          const decision = toDecision(candidate, batch, context, diagnostics, evidenceById, generatedAt);
          if (decision) decisions.push(decision);
        }
        for (const candidate of normalizeCandidateList(value.actionItems)) {
          const action = toAction(candidate, batch, context, diagnostics, evidenceById, generatedAt);
          if (action) actionItems.push(action);
        }
        return {
          evidenceAdded: evidenceById.size > evidenceCountBefore,
          summaryAdded: topics.length + overviews.length > summaryCountBefore
        };
      };
      const applied = applyPayload(payload);
      if (payloadHasCandidates(payload) && (!applied.evidenceAdded || !applied.summaryAdded)) {
        const repaired = await this.runModel(evidenceRepairTask(task), diagnostics, 1);
        if (repaired.ok) applyPayload(repaired.payload);
      }
    }

    const uniqueTopics = dedupeByContent(topics);
    const uniqueOverviews = dedupeByContent(overviews);
    const uniqueKeyPoints = dedupeByContent(keyPoints);
    const uniqueConclusions = dedupeByContent(conclusions);
    const uniqueOpenQuestions = dedupeByContent(openQuestions);
    const uniqueDecisions = dedupeByContent(decisions);
    const uniqueActionItems = dedupeByContent(actionItems);
    diagnostics.acceptedCandidates = [
      ...uniqueTopics.map(() => 'summary.topic'),
      ...uniqueOverviews.map(() => 'summary.overview'),
      ...uniqueKeyPoints.map(() => 'summary.keyPoint'),
      ...uniqueConclusions.map(() => 'summary.conclusion'),
      ...uniqueOpenQuestions.map(() => 'summary.openQuestion'),
      ...uniqueDecisions.map(() => 'decision'),
      ...uniqueActionItems.map(() => 'action_item')
    ];

    if (evidenceById.size === 0) {
      return {
        ok: false,
        code: 'AI_ANALYSIS_UNAVAILABLE',
        status: 'failed',
        data: null,
        diagnostics: { ...diagnostics, reason: 'EVIDENCE_UNAVAILABLE' }
      };
    }

    const summary = createMeetingSummary({
      ownerContext: trusted.ownerContext,
      source: trusted.source,
      transcriptRevision: trusted.transcriptRevision,
      diarizationRevision: input.diarizationRevision,
      speakerCorrectionRevision: input.speakerCorrectionRevision,
      now: generatedAt,
      value: {
        summaryId: deterministicId('summary', { binding }),
        resultRevisionId: deterministicId('summary-revision', { binding, resultRevision: 1 }),
        resultRevision: 1,
        parentResultRevisionId: null,
        status: uniqueTopics.length && uniqueOverviews.length ? 'ready' : 'partial',
        topic: uniqueTopics[0] || { value: 'unresolved', groundingStatus: 'unresolved', unresolvedReason: 'NOT_STATED', evidenceRefs: [] },
        overview: uniqueOverviews[0] || { value: 'unresolved', groundingStatus: 'unresolved', unresolvedReason: 'NOT_STATED', evidenceRefs: [] },
        keyPoints: uniqueKeyPoints,
        conclusions: uniqueConclusions,
        openQuestions: uniqueOpenQuestions,
        evidenceRefs: dedupeEvidenceRefs([
          ...uniqueTopics.flatMap((item) => item.evidenceRefs),
          ...uniqueOverviews.flatMap((item) => item.evidenceRefs),
          ...uniqueKeyPoints.flatMap((item) => item.evidenceRefs),
          ...uniqueConclusions.flatMap((item) => item.evidenceRefs),
          ...uniqueOpenQuestions.flatMap((item) => item.evidenceRefs)
        ])
      }
    });
    const finalDecisions = uniqueDecisions.map((value) => createMeetingDecision({
      ownerContext: trusted.ownerContext,
      source: trusted.source,
      transcriptRevision: trusted.transcriptRevision,
      diarizationRevision: input.diarizationRevision,
      speakerCorrectionRevision: input.speakerCorrectionRevision,
      now: generatedAt,
      value: {
        ...value,
        decisionId: deterministicId('decision', { binding, content: value.content, evidenceRefIds: value.evidenceRefs.map((ref) => ref.evidenceRefId) })
      }
    }));
    const finalActionItems = uniqueActionItems.map((value) => createMeetingActionItem({
      ownerContext: trusted.ownerContext,
      source: trusted.source,
      transcriptRevision: trusted.transcriptRevision,
      diarizationRevision: input.diarizationRevision,
      speakerCorrectionRevision: input.speakerCorrectionRevision,
      now: generatedAt,
      value: {
        ...value,
        actionId: deterministicId('action', { binding, content: value.content, evidenceRefIds: value.evidenceRefs.map((ref) => ref.evidenceRefId) })
      }
    }));
    const evidenceRefs = dedupeEvidenceRefs([
      ...summary.evidenceRefs,
      ...finalDecisions.flatMap((value) => value.evidenceRefs),
      ...finalActionItems.flatMap((value) => value.evidenceRefs)
    ]);
    return {
      ok: true,
      code: 'MEETING_BRAIN_READY',
      status: 'ready',
      data: {
        summary,
        decisions: finalDecisions,
        actionItems: finalActionItems,
        evidenceRefs
      },
      diagnostics
    };
  }
}

export function createMeetingBrainEngine(options = {}) {
  return new MeetingBrainEngine(options);
}

export async function generateMeetingBrainResult(input, options = {}) {
  return new MeetingBrainEngine(options).generate(input);
}

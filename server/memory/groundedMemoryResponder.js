import { CAPABILITIES } from '../../core/router/CapabilityMap.js';
import { providerEvidenceView } from './memoryEvidenceBundle.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

const SMALL = Object.freeze(['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九', '三十', '三十一']);

function birthdayText(value) {
  if (value?.kind !== 'calendar_date' || !Number.isInteger(value.date?.month) || !Number.isInteger(value.date?.day)) {
    return null;
  }
  const { year, month, day } = value.date;
  const calendar = value.calendar_type === 'lunar' ? '农历' : value.calendar_type === 'gregorian' ? '公历' : '';
  const date = value.calendar_type === 'lunar'
    ? `${SMALL[month]}月${day <= 10 ? `初${SMALL[day]}` : SMALL[day]}`
    : `${year ? `${year}年` : ''}${month}月${day}日`;
  return `${calendar}${date}`;
}

function safeUserText(value) {
  const text = String(value || '').trim();
  return text && !text.includes('undefined') && !text.includes('null') ? text : '我目前还不知道。';
}

export function deterministicGroundedAnswer(bundle, subjectLabel = '这位家人') {
  const first = bundle?.evidence?.[0];
  if (!first) return '我目前还不知道。';
  if (first.predicate === 'birthday') {
    const birthday = birthdayText(first.value);
    return birthday ? safeUserText(`你${subjectLabel}是${birthday}生日。`) : '我目前还不知道。';
  }
  if (first.predicate === 'favorite_preference_statement' && first.value?.kind === 'single_string') {
    return safeUserText(`你${subjectLabel}最喜欢${first.value.item}。`);
  }
  if (first.predicate === 'preference_statement' && first.value?.kind === 'string_set' && first.value.items?.length) {
    return safeUserText(`你${subjectLabel}喜欢${first.value.items.join('和')}。`);
  }
  return '我目前还不知道。';
}

export function validateGroundedMemoryResponse(value, { bundle, subjectLabel } = {}) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.citations) || !Array.isArray(value.claims)) {
    return Object.freeze({ valid: false, code: 'EVIDENCE_RESPONSE_INVALID' });
  }
  const byId = new Map((bundle?.evidence || []).map((item) => [item.evidence_id, item]));
  if (!value.citations.length || value.citations.some((id) => !byId.has(id))) {
    return Object.freeze({ valid: false, code: 'EVIDENCE_COVERAGE_FAILED' });
  }
  for (const claim of value.claims) {
    const evidence = byId.get(claim?.evidence_id);
    if (!evidence || claim.predicate !== evidence.predicate || !same(claim.value, evidence.value)) {
      return Object.freeze({ valid: false, code: 'EVIDENCE_COVERAGE_FAILED' });
    }
  }
  const safeAnswer = deterministicGroundedAnswer(bundle, subjectLabel);
  if (String(value.answer || '').trim() !== safeAnswer) {
    return Object.freeze({ valid: false, code: 'EVIDENCE_COVERAGE_FAILED' });
  }
  return Object.freeze({ valid: true, answer: safeAnswer });
}

export function createGroundedMemoryResponder({ aiService, timeoutMs = 8000 } = {}) {
  if (!aiService || typeof aiService.run !== 'function') throw new TypeError('Grounded responder requires aiService.run().');
  return Object.freeze({
    async respond({ bundle, subjectLabel = '这位家人', invocation = {} } = {}) {
      const safeAnswer = deterministicGroundedAnswer(bundle, subjectLabel);
      if (!bundle?.evidence?.length) return Object.freeze({ answer: safeAnswer, source: 'deterministic_empty' });
      let result;
      try {
        result = await aiService.run({
          input: '根据证据生成答案', capability: CAPABILITIES.CHAT,
          messages: [{ role: 'system', content: '只输出JSON：answer,citations,claims。不得加入证据外事实。answer必须逐字使用给定safe_answer。' },
            { role: 'user', content: JSON.stringify({ safe_answer: safeAnswer, bundle: providerEvidenceView(bundle) }) }],
          metadata: { purpose: 'grounded_memory_response_v1', memoryPolicy: 'disabled' },
          options: { timeoutMs }
        }, invocation);
      } catch {
        result = null;
      }
      if (!result?.ok) return Object.freeze({ answer: safeAnswer, source: 'deterministic_fallback' });
      let parsed;
      try { parsed = JSON.parse(String(result.content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { parsed = null; }
      const coverage = validateGroundedMemoryResponse(parsed, { bundle, subjectLabel });
      return coverage.valid
        ? Object.freeze({ answer: coverage.answer, source: 'provider_covered' })
        : Object.freeze({ answer: safeAnswer, source: 'deterministic_coverage_fallback', event: 'EVIDENCE_COVERAGE_FAILED' });
    }
  });
}

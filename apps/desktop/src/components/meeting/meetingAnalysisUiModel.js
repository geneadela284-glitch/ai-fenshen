export const unresolvedLabel = '未明确';

const ANALYSIS_STATUS_LABELS = Object.freeze({
  current: '已根据原文整理',
  stale: '原文已变化，请重新分析',
  superseded: '已有更新版本',
  revalidation_required: '证据待重新验证',
  invalid: '结果暂不可用',
  unavailable: '暂时没有会议分析'
});

const DECISION_STATUS_LABELS = Object.freeze({
  confirmed: '已确认',
  unresolved: '会议中尚未明确'
});

const ACTION_STATUS_LABELS = Object.freeze({
  candidate: '待确认',
  unresolved: '未明确',
  confirmed: '已确认',
  created: '已建立',
  completed: '已完成',
  dismissed: '已忽略'
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = unresolvedLabel) {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function contentOf(value, fallback = unresolvedLabel) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return text(value.value ?? value.content, fallback);
  }
  return text(value, fallback);
}

function displayUnresolved(value) {
  return value === 'unresolved' || value === '' || value === null || value === undefined
    ? unresolvedLabel
    : String(value);
}

export function formatEvidenceTime(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function normalizeEvidenceRef(value) {
  if (!value || typeof value !== 'object' || !String(value.evidenceRefId || '').trim()) return null;
  const startMs = Number.isFinite(Number(value.startMs)) ? Math.max(0, Number(value.startMs)) : 0;
  return {
    ...value,
    startMs,
    endMs: Number.isFinite(Number(value.endMs)) ? Math.max(startMs, Number(value.endMs)) : startMs,
    timeLabel: formatEvidenceTime(startMs),
    quote: text(value.textSpan?.quote, '')
  };
}

function createEvidenceActions(evidenceRef) {
  const normalized = normalizeEvidenceRef(evidenceRef);
  if (!normalized) return [];
  return [
    { label: '查看原话', mode: 'transcript', evidenceRef: normalized },
    { label: `回听 ${normalized.timeLabel}`, mode: 'playback', evidenceRef: normalized }
  ];
}

function fieldWithEvidence(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    value: contentOf(raw),
    evidenceRefs: asArray(raw.evidenceRefs).map(normalizeEvidenceRef).filter(Boolean),
    groundingStatus: raw.groundingStatus || 'grounded'
  };
}

function listWithEvidence(values) {
  return asArray(values).map((item) => ({
    ...item,
    content: contentOf(item?.content ?? item?.value),
    evidenceRefs: asArray(item?.evidenceRefs).map(normalizeEvidenceRef).filter(Boolean),
    groundingStatus: item?.groundingStatus || 'grounded'
  }));
}

function statusState(bundle) {
  if (!bundle) return 'unavailable';
  if (bundle.status === 'CURRENT' && bundle.groundingStatus === 'GROUNDING_SUPPORTED') return 'current';
  return String(bundle.status || bundle.groundingStatus || 'unavailable').toLowerCase();
}

export function buildMeetingAnalysisViewModel(bundle) {
  const state = statusState(bundle);
  const summary = bundle?.summary || {};
  const topic = fieldWithEvidence(summary.topic);
  const overview = fieldWithEvidence(summary.overview);
  const keyPoints = listWithEvidence(summary.keyPoints);
  const conclusions = listWithEvidence(summary.conclusions);
  const openQuestions = listWithEvidence(summary.openQuestions);
  const evidenceById = {};
  const registerEvidence = (value) => {
    const normalized = normalizeEvidenceRef(value);
    if (normalized && !evidenceById[normalized.evidenceRefId]) evidenceById[normalized.evidenceRefId] = {
      ...normalized,
      actions: createEvidenceActions(normalized)
    };
  };
  for (const evidenceRef of asArray(bundle?.evidenceRefs)) registerEvidence(evidenceRef);
  for (const field of [topic, overview, ...keyPoints, ...conclusions, ...openQuestions]) {
    for (const evidenceRef of field.evidenceRefs) registerEvidence(evidenceRef);
  }
  const decisions = asArray(bundle?.decisions).map((decision) => ({
    ...decision,
    content: contentOf(decision?.content),
    status: decision?.status || 'unresolved',
    statusLabel: DECISION_STATUS_LABELS[decision?.status] || DECISION_STATUS_LABELS.unresolved,
    evidenceRefs: asArray(decision?.evidenceRefs).map(normalizeEvidenceRef).filter(Boolean)
  }));
  const actionItems = asArray(bundle?.actionItems).map((actionItem) => ({
    ...actionItem,
    content: contentOf(actionItem?.content),
    ownerLabel: displayUnresolved(actionItem?.owner),
    dueDateLabel: displayUnresolved(actionItem?.dueDate),
    status: actionItem?.status || 'unresolved',
    statusLabel: ACTION_STATUS_LABELS[actionItem?.status] || ACTION_STATUS_LABELS.unresolved,
    evidenceRefs: asArray(actionItem?.evidenceRefs).map(normalizeEvidenceRef).filter(Boolean)
  }));
  for (const item of [...decisions, ...actionItems]) for (const evidenceRef of item.evidenceRefs) registerEvidence(evidenceRef);
  return Object.freeze({
    state,
    displayable: state === 'current',
    statusLabel: ANALYSIS_STATUS_LABELS[state] || ANALYSIS_STATUS_LABELS.unavailable,
    summary: Object.freeze({
      topic: topic.value,
      topicEvidenceRefs: topic.evidenceRefs,
      overview: overview.value,
      overviewEvidenceRefs: overview.evidenceRefs,
      keyPoints,
      conclusions,
      openQuestions
    }),
    decisions,
    actionItems,
    evidenceById
  });
}

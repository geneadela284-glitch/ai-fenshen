const OCR_QUESTION = /文字|金额|多少钱|日期|表格|截图.*说|主要说/;
const TABLE_QUESTION = /表格|餐费|打车|行列|单元格/;
const COMPARISON_QUESTION = /比较|区别|不同/;
const VISUAL_QUESTION = /有什么|画面|物体|颜色|左边|右边|位置|布局/;

function compact(values = []) {
  return values.flat().filter((value) => value !== null && value !== undefined && value !== '');
}

function tableAnswer(ocrEvidence) {
  const rows = compact(ocrEvidence.map((item) =>
    compact((item.tableRegions || []).map((region) => region.rows || []))
  ));
  const matches = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const label = String(row[0] || '').trim();
    const value = String(row[1] || '').trim();
    if (label && value && !/项目|金额/.test(label)) matches.push(`${label} ${value}`);
  }
  return matches.join('，');
}

function numberTokens(value) {
  return new Set(String(value || '').match(/\d+(?:\.\d+)?/g) || []);
}

function detectConflicts(ocrEvidence, visionEvidence) {
  if (!visionEvidence) return [];
  const ocrNumbers = numberTokens(ocrEvidence.map((item) => item.rawText).join('\n'));
  const visionNumbers = numberTokens([
    visionEvidence.sceneSummary,
    visionEvidence.chartOrDiagramSummary
  ].join('\n'));
  if (!ocrNumbers.size || !visionNumbers.size) return [];
  const visionOnly = [...visionNumbers].filter((value) => !ocrNumbers.has(value));
  return visionOnly.length
    ? [{
        type: 'ocr_vision_text_conflict',
        authoritativeForText: 'ocr',
        detail: '视觉语义中的数字与OCR原始证据不一致。'
      }]
    : [];
}

function evidenceReference(type, attachmentIds) {
  return {
    type,
    attachmentIds: [...attachmentIds]
  };
}

export class EvidenceMerger {
  merge({
    userQuestion = '',
    ocrEvidence = [],
    visionEvidence = null,
    attachments = [],
    partialErrors = []
  } = {}) {
    const question = String(userQuestion || '').trim();
    const attachmentIds = attachments.map((item) => item.attachmentId);
    const hasOcr = ocrEvidence.length > 0;
    const hasVision = Boolean(visionEvidence);
    const comparison = COMPARISON_QUESTION.test(question) && attachmentIds.length > 1;
    let answerMode = comparison
      ? 'comparison'
      : OCR_QUESTION.test(question)
        ? 'ocr'
        : VISUAL_QUESTION.test(question)
          ? 'visual'
          : hasOcr && hasVision
            ? 'combined'
            : hasOcr
              ? 'ocr'
              : 'visual';
    if (partialErrors.length) answerMode = 'partial';

    const rawTexts = ocrEvidence.map((item) => String(item.rawText || '').trim()).filter(Boolean);
    const visualText = String(visionEvidence?.sceneSummary || '').trim();
    const table = tableAnswer(ocrEvidence);
    let answer = '';
    if (OCR_QUESTION.test(question)) {
      answer = TABLE_QUESTION.test(question) && table ? table : rawTexts.join('\n');
      if (!answer && visualText) answer = `OCR未取得可靠文字；画面语义仅能说明：${visualText}`;
    } else if (comparison) {
      answer = visualText || '现有证据不足以可靠比较这些图片。';
    } else if (VISUAL_QUESTION.test(question)) {
      answer = visualText || rawTexts.join('\n');
    } else {
      answer = compact([visualText, rawTexts.join('\n')]).join('\n');
    }
    if (!answer) answer = '现有附件证据不足，无法确定。';

    const conflicts = detectConflicts(ocrEvidence, visionEvidence);
    const limitations = compact([
      partialErrors.map((item) => item.code || String(item)),
      ocrEvidence.map((item) => item.limitations || []),
      visionEvidence?.limitations || [],
      conflicts.length ? ['OCR与视觉证据存在冲突，文字与数字以OCR原始证据为准。'] : []
    ]);
    const contextParts = [
      '--- BEGIN UNTRUSTED_ATTACHMENT_EVIDENCE ---',
      ...ocrEvidence.map((item) =>
        `[OCR attachment=${item.attachmentId}]\n${String(item.rawText || '')}`
      ),
      ...(visionEvidence
        ? [`[VISION attachments=${attachmentIds.join(',')}]\n${visualText}`]
        : []),
      '--- END UNTRUSTED_ATTACHMENT_EVIDENCE ---'
    ];
    return {
      groundedAnswerContext: contextParts.join('\n'),
      evidenceRefs: compact([
        hasOcr ? evidenceReference('ocr', ocrEvidence.map((item) => item.attachmentId)) : null,
        hasVision ? evidenceReference('vision', attachmentIds) : null
      ]),
      limitations,
      conflicts,
      answerMode,
      answer,
      systemInstructionsChanged: false
    };
  }
}

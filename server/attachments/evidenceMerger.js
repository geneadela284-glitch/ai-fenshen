const EXACT_TEXT_QUESTION = /逐字|照抄|抄录|提取.{0,8}(?:文字|原文)|转(?:成|为)?文字/;
const NUMERIC_ANSWER = /[0-9０-９]|[零〇一二三四五六七八九十百千万亿两]{2,}|[零〇一二三四五六七八九十百千万亿两]+(?:元|块|角|分|年|月|日|号|点|时|秒|个|件|张|位|项|次|人|套|台|米|厘米|斤|公斤|克|%|％)|周[一二三四五六日天]|(?:^|[\s：:，,。；;])[零〇一二三四五六七八九十百千万亿两]+(?=$|[\s。，,、；;!?])/u;
const OCR_QUESTION = /文字|金额|多少钱|日期|表格|截图.*说|主要说/;
const TABLE_QUESTION = /表格|餐费|打车|行列|单元格/;
const COMPARISON_QUESTION = /比较|区别|不同/;
const VISUAL_QUESTION = /有什么|画面|物体|颜色|左边|右边|位置|布局/;
const VISUAL_COUNT_QUESTION = /描述|画面|物体|颜色|外观|比较|区别|不同|有什么/;
const PROTECTED_FACT_CONTEXT = /金额|价格|费用|总价|单价|报价|成本|预算|收入|支出|付款|估值|价值|日期|时间|期限|小时|分钟|秒钟|工作日|星期|季度|库存|订单|采购|销售|销量|数量|折扣|优惠|税|比率|比例|百分|账号|编号|总计|合计/;
const VISUAL_COUNT = /[0-9０-９零〇一二三四五六七八九十百千万亿两]+(?:个|根|张|件|种|款|条|组|只|位|台|套)(?!月|亿|万|千|百|元|角|分|小时|工作日|星期|季度)/gu;

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
    if (EXACT_TEXT_QUESTION.test(question)) {
      answer = rawTexts.join('\n') || '未取得可靠文字，无法逐字提取。';
    } else if (OCR_QUESTION.test(question)) {
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

    const questionAnswer = typeof visionEvidence?.questionAnswer === 'string' ? visionEvidence.questionAnswer.trim() : '';
    // Counts in scene descriptions are visual observations, not extracted business facts.
    // Only exempt count expressions; dates, currency and measurements remain guarded.
    const visualCountsAllowed = VISUAL_COUNT_QUESTION.test(question) &&
      !PROTECTED_FACT_CONTEXT.test([question, questionAnswer, ...rawTexts].join('\n'));
    let numericalContent = visualCountsAllowed ? questionAnswer.replace(VISUAL_COUNT, '') : questionAnswer;
    // The user's own object ordinal identifies a visual reference, not a new numeric fact.
    // Remove only that exact reference; all other numbers and business facts remain guarded.
    const requestedOrdinal = question.match(/第[一二三四五六七八九十1-9][0-9]?(?:个|张|幅)/)?.[0];
    if (requestedOrdinal && /形状|颜色|物体|外观/.test(question) &&
        !PROTECTED_FACT_CONTEXT.test([question, questionAnswer, ...rawTexts].join('\n'))) {
      numericalContent = numericalContent.replaceAll(requestedOrdinal, '');
    }
    const hasUnsupportedNumber = questionAnswer && !EXACT_TEXT_QUESTION.test(question) && NUMERIC_ANSWER.test(numericalContent);
    // Preserve literal extraction and never replace source numbers with unverified answer numbers.
    if (questionAnswer && !EXACT_TEXT_QUESTION.test(question)) {
      if (hasUnsupportedNumber) {
        // A failed text extraction must not discard an independently usable scene.
        // Never use this fallback for literal, numeric, or other factual questions.
        const safeScene = /描述|画面|主要内容|什么内容|有什么/.test(question) &&
          !OCR_QUESTION.test(question) && !PROTECTED_FACT_CONTEXT.test(question) &&
          !PROTECTED_FACT_CONTEXT.test(questionAnswer) &&
          !NUMERIC_ANSWER.test(visualText) && !PROTECTED_FACT_CONTEXT.test(visualText)
          ? visualText : '';
        answer = rawTexts.join('\n') || safeScene || '图片中的数字尚未核实，无法给出可靠结论。';
      }
      else if (!TABLE_QUESTION.test(question) &&
        (!/金额|多少钱|日期/.test(question) ||
          /不能确认|无法(?:确认|确定|辨认|看清|识别|准确)|看不清/.test(questionAnswer))) answer = questionAnswer;
    }
    const conflicts = detectConflicts(ocrEvidence, visionEvidence);
    const limitations = compact([
      hasUnsupportedNumber ? ['图片回答中的数字对应关系尚未核实，已保留原始识别证据。'] : [],
      partialErrors.map((item) => item.code || String(item)),
      ocrEvidence.flatMap((item) => item.limitations || []),
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

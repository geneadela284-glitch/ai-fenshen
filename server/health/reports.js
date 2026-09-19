import { createHash } from 'node:crypto';
import { parseDocument } from '../../core/documentQa/parser.js';
import { healthConstraint } from '../../core/health/constraints.js';
import { dateKey } from './planner.js';
export function publicRecord(record) {
  if (!record) return record;
  const copy = structuredClone(record);
  if (copy.kind === 'report') delete copy.payload.dataBase64;
  return copy;
}
export async function importReport({
  owner,
  input,
  service,
  clock = () => new Date()
}) {
  if (input.consent !== true) throw healthConstraint('HEALTH_REPORT_CONSENT_REQUIRED', '请先确认将所选文件用作本人健康报告。');
  if (typeof input.filename !== 'string' || !input.filename.toLowerCase().endsWith('.pdf') || input.filename.length > 200 || typeof input.dataBase64 !== 'string' || input.dataBase64.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.dataBase64)) throw healthConstraint('HEALTH_REPORT_INVALID', '请选择不超过8MB的PDF文件。');
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length > 8 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-') throw healthConstraint('HEALTH_REPORT_INVALID', '文件不是有效PDF或超过8MB。');
  let pages = [],
    status = 'review';
  try {
    const parsed = await parseDocument({
      bytes: new Uint8Array(bytes),
      filename: input.filename,
      ownerId: owner
    });
    pages = parsed.blocks.map(b => ({
      pageNumber: b.pageNumber,
      text: b.text
    }));
  } catch (error) {
    if (!['DOCUMENT_NO_TEXT', 'DOCUMENT_INVALID', 'DOCUMENT_ENCRYPTED'].includes(error.code)) throw error;
    status = 'unrecognized';
  }
  const items = [];
  for (const page of pages) {
    const matcher = /(体重|收缩压|舒张压|血糖|空腹血糖|体温|总胆固醇|甘油三酯|Weight|Glucose|Temperature|Cholesterol)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kg|mmHg|mmol\/L|mg\/dL|°C|℃)?/gi;
    for (const m of page.text.matchAll(matcher)) items.push({
      name: m[1],
      value: m[2],
      unit: m[3] || '',
      reference: '',
      flag: '',
      pageNumber: page.pageNumber
    });
  }
  const occurredOn = clock().toISOString().slice(0, 10);
  return service.create(owner, {
    kind: 'report',
    occurredOn,
    idempotencyKey: input.idempotencyKey,
    payload: {
      filename: input.filename,
      dataBase64: bytes.toString('base64'),
      checksum: createHash('sha256').update(bytes).digest('hex'),
      pages,
      status,
      items,
      note: status === 'unrecognized' ? '未完成文字识别，请查看原文件并手工核对。' : '自动提取是草稿，请逐项核对原报告；未提取项目可手工补充。'
    }
  });
}
export function confirmReport({
  service,
  owner,
  id,
  input
}) {
  const old = service.get(owner, id);
  if (old.kind !== 'report' || input.confirmedSelf !== true) throw healthConstraint('HEALTH_REPORT_CONFIRM_REQUIRED', '请确认这是本人报告并核对内容。');
  dateKey(input.examDate);
  if (typeof input.institution !== 'string' || input.institution.length > 200 || !Array.isArray(input.items) || input.items.length > 200) throw healthConstraint('HEALTH_REPORT_INVALID', '请核对报告日期、机构和项目。');
  const items = input.items.map(item => {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || !Number.isSafeInteger(item.pageNumber) || item.pageNumber < 1 || item.pageNumber > 200 || old.payload.pages.length && !old.payload.pages.some(p => p.pageNumber === item.pageNumber)) throw healthConstraint('HEALTH_REPORT_ITEM_INVALID', '项目名称或来源页码无效。');
    const result = {
      name: item.name,
      pageNumber: item.pageNumber
    };
    for (const k of ['value', 'unit', 'reference', 'flag']) {
      if (typeof item[k] !== 'string' || item[k].length > 150) throw healthConstraint('HEALTH_REPORT_ITEM_INVALID', '请核对项目数值、单位和参考范围。');
      result[k] = item[k];
    }
    return result;
  });
  return service.update(owner, id, {
    revision: input.revision,
    confirmed: true,
    occurredOn: input.examDate,
    payload: {
      ...old.payload,
      status: 'archived',
      examDate: input.examDate,
      institution: input.institution,
      items
    }
  });
}

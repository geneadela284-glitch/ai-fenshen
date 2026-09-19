import { buildMonthlyReportFilename } from './monthlyReportContract.js';
import { renderMonthlyFinanceExcel } from './monthlyReportExcel.js';
import { renderMonthlyFinancePdf } from './monthlyReportPdf.js';

const FORMATS = {
  pdf: {
    contentType: 'application/pdf',
    signature: (buffer) => buffer.subarray(0, 5).toString() === '%PDF-'
  },
  xlsx: {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    signature: (buffer) => buffer.subarray(0, 2).toString('binary') === 'PK'
  }
};

function requiredOwner(ownerId) {
  const value = String(ownerId || '').trim();
  if (!value) throw Object.assign(new Error('OWNER_REQUIRED'), { code: 'OWNER_REQUIRED' });
  return value;
}

export class MonthlyFinanceReportService {
  constructor({ repository, timezone = 'Asia/Shanghai', clock = () => new Date(), renderers = {} } = {}) {
    if (!repository) throw new Error('FINANCE_REPORT_REPOSITORY_REQUIRED');
    this.repository = repository;
    this.timezone = timezone;
    this.clock = clock;
    this.renderers = {
      pdf: renderers.pdf || renderMonthlyFinancePdf,
      xlsx: renderers.xlsx || renderMonthlyFinanceExcel
    };
  }

  async exportCurrentMonth({ ownerId, format } = {}) {
    const normalizedFormat = String(format || '').toLowerCase();
    const formatContract = FORMATS[normalizedFormat];
    if (!formatContract) throw Object.assign(new Error('FINANCE_REPORT_FORMAT_INVALID'), { code: 'FINANCE_REPORT_FORMAT_INVALID' });
    const snapshot = this.repository.buildMonthlyReportSnapshot({
      ownerId: requiredOwner(ownerId),
      timezone: this.timezone,
      now: this.clock()
    });
    const rendered = await this.renderers[normalizedFormat](snapshot);
    const buffer = Buffer.isBuffer(rendered) ? rendered : Buffer.from(rendered || []);
    if (buffer.length === 0 || !formatContract.signature(buffer)) {
      throw Object.assign(new Error('FINANCE_REPORT_FILE_INVALID'), { code: 'FINANCE_REPORT_FILE_INVALID' });
    }
    return {
      buffer,
      contentType: formatContract.contentType,
      filename: buildMonthlyReportFilename(snapshot, normalizedFormat),
      snapshot
    };
  }
}


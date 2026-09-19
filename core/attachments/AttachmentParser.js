const maxTextLength = 24000;
const maxWorkbookRows = 80;
const maxWorkbookCols = 24;

const supportedExtensions = new Set(['txt', 'md', 'markdown', 'docx', 'pdf', 'xlsx', 'png', 'jpg', 'jpeg', 'webp']);
const legacyUnsupportedExtensions = new Set(['doc', 'xls', 'ppt', 'pptx']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp']);

function fileExtension(file = {}) {
  return String(file.name || file.fileName || '').toLowerCase().split('.').pop() || '';
}

function fileType(file = {}) {
  return String(file.type || file.mimeType || 'application/octet-stream');
}

function baseResult(file = {}) {
  return {
    fileName: String(file.name || file.fileName || '未命名附件'),
    fileType: fileType(file),
    parsed: false,
    contentType: 'unknown',
    text: '',
    tables: [],
    metadata: {},
    warnings: [],
    error: ''
  };
}

function normalizeWhitespace(text = '') {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function truncateText(text, warnings) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxTextLength) return normalized;
  warnings.push(`内容超过 ${maxTextLength} 字，已安全截断后用于本次任务。`);
  return normalized.slice(0, maxTextLength);
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeXmlEntities(text = '') {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripXmlTags(xml = '') {
  return decodeXmlEntities(String(xml).replace(/<[^>]+>/g, ''));
}

function extractXmlText(xml = '') {
  const chunks = [];
  const pattern = /<(?:[^:>]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?t>/g;
  let match;
  while ((match = pattern.exec(xml))) chunks.push(decodeXmlEntities(match[1]));
  return normalizeWhitespace(chunks.join(''));
}

function extractTagBlocks(xml = '', tagName) {
  const blocks = [];
  const pattern = new RegExp(`<(?:[^:>]+:)?${tagName}\\b[^>]*>[\\s\\S]*?<\\/(?:[^:>]+:)?${tagName}>`, 'g');
  let match;
  while ((match = pattern.exec(xml))) blocks.push(match[0]);
  return blocks;
}

function parseParagraphs(xml = '') {
  return extractTagBlocks(xml, 'p')
    .map((paragraph) => {
      const text = extractXmlText(paragraph);
      if (!text) return null;
      const style = paragraph.match(/<(?:[^:>]+:)?pStyle\b[^>]*(?:[^:>]+:)?val="([^"]+)"/)?.[1] || '';
      const isHeading = /heading|title|标题/i.test(style);
      return { text, isHeading };
    })
    .filter(Boolean);
}

function parseDocxTables(xml = '') {
  return extractTagBlocks(xml, 'tbl')
    .map((table, tableIndex) => {
      const rows = extractTagBlocks(table, 'tr').map((row) =>
        extractTagBlocks(row, 'tc').map((cell) => extractXmlText(cell))
      ).filter((row) => row.some(Boolean));
      const headers = rows[0] || [];
      return {
        title: `表格 ${tableIndex + 1}`,
        headers,
        rows: rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header || `列${index + 1}`, row[index] || ''])))
      };
    })
    .filter((table) => table.headers.length || table.rows.length);
}

function findEndOfCentralDirectory(view) {
  const minOffset = Math.max(0, view.byteLength - 66000);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器暂不支持本地解压 DOCX / XLSX。');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) throw new Error('文件结构损坏，无法读取压缩内容。');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  let centralOffset = view.getUint32(eocdOffset + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder('utf-8');

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) break;
    const method = view.getUint16(centralOffset + 10, true);
    const compressedSize = view.getUint32(centralOffset + 20, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const nameBytes = new Uint8Array(arrayBuffer, centralOffset + 46, nameLength);
    const name = decoder.decode(nameBytes);

    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      centralOffset += 46 + nameLength + extraLength + commentLength;
      continue;
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = new Uint8Array(arrayBuffer, dataOffset, compressedSize);
    let bytes;
    if (method === 0) bytes = compressed;
    else if (method === 8) bytes = await inflateRaw(compressed);
    else throw new Error('压缩格式暂不支持，无法读取该文件。');
    entries.set(name, decoder.decode(bytes));
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function parseWorkbookRels(xml = '') {
  const rels = new Map();
  const pattern = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const target = match[2].startsWith('/') ? match[2].slice(1) : `xl/${match[2].replace(/^\/?xl\//, '')}`;
    rels.set(match[1], target.replace(/\\/g, '/'));
  }
  return rels;
}

function parseSharedStrings(xml = '') {
  return extractTagBlocks(xml, 'si').map((item) => extractXmlText(item));
}

function columnIndex(cellRef = '') {
  const letters = String(cellRef).match(/[A-Z]+/)?.[0] || '';
  return letters.split('').reduce((value, letter) => value * 26 + (letter.charCodeAt(0) - 64), 0) - 1;
}

function parseSheetXml(xml = '', sharedStrings = []) {
  return extractTagBlocks(xml, 'row').slice(0, maxWorkbookRows).map((rowXml) => {
    const row = [];
    const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let match;
    while ((match = cellPattern.exec(rowXml))) {
      const attrs = match[1];
      const body = match[2];
      const ref = attrs.match(/\br="([^"]+)"/)?.[1] || '';
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
      const index = Math.max(0, columnIndex(ref));
      if (index >= maxWorkbookCols) continue;
      const rawValue = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || '';
      row[index] = type === 's' ? sharedStrings[Number(rawValue)] || '' : decodeXmlEntities(rawValue);
    }
    return Array.from({ length: Math.min(maxWorkbookCols, Math.max(row.length, 0)) }, (_, index) => row[index] || '');
  }).filter((row) => row.some(Boolean));
}

function sheetRowsToTable(sheetName, rows = []) {
  const headers = rows[0]?.map((header, index) => header || `列${index + 1}`) || [];
  return {
    title: sheetName,
    headers,
    rows: rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])))
  };
}

function tableToText(table) {
  const header = `表格：${table.title || '未命名表格'}`;
  const columns = table.headers?.length ? `字段：${table.headers.join('、')}` : '';
  const rows = (table.rows || []).slice(0, 12).map((row, index) => {
    const values = Object.entries(row).map(([key, value]) => `${key}=${value}`).join('；');
    return `${index + 1}. ${values}`;
  });
  return [header, columns, ...rows].filter(Boolean).join('\n');
}

function parsePdfText(raw = '') {
  const textChunks = [];
  const tjPattern = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  const arrayPattern = /\[(?:\s*\((?:\\.|[^\\)])*\)\s*)+\]\s*TJ/g;
  const decodePdfString = (value = '') => value
    .replace(/^\(|\)$/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\\d{1,3}/g, ' ');

  let match;
  while ((match = tjPattern.exec(raw))) {
    textChunks.push(decodePdfString(match[0].replace(/\s*Tj$/, '')));
  }
  while ((match = arrayPattern.exec(raw))) {
    const parts = match[0].match(/\((?:\\.|[^\\)])*\)/g) || [];
    textChunks.push(parts.map(decodePdfString).join(''));
  }
  return normalizeWhitespace(textChunks.join('\n'));
}

function readabilityScore(text = '') {
  const value = String(text || '');
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const mojibake = (value.match(/[ÃÂåäç]/g) || []).length;
  const letters = (value.match(/[\p{L}\p{N}]/gu) || []).length;
  return cjk * 3 + letters - mojibake * 2;
}

export class AttachmentParser {
  supports(file) {
    const extension = fileExtension(file);
    return supportedExtensions.has(extension) || legacyUnsupportedExtensions.has(extension) || fileType(file).startsWith('text/') || fileType(file).startsWith('image/');
  }

  getStatus(result = {}) {
    if (result.error) {
      if (result.error.includes('视觉')) return '需要视觉模型';
      if (result.error.includes('暂不支持')) return '不支持';
      return '解析失败';
    }
    if (result.parsed && result.warnings?.length) return '部分读取';
    if (result.parsed) return '可读取';
    return '等待解析';
  }

  normalizeError(error) {
    const message = error?.message || String(error || '附件解析失败。');
    if (/encrypted|password|加密/i.test(message)) return '该文件可能已加密，当前无法读取内容。';
    if (/corrupt|invalid|损坏|结构/i.test(message)) return '文件可能已损坏，无法读取内容。';
    if (/too large|超大/i.test(message)) return '文件过大，当前版本暂不解析。';
    return message;
  }

  async parse(file, options = {}) {
    const extension = fileExtension(file);
    const result = baseResult(file);
    result.metadata = { extension, size: Number(file.size || 0) };

    try {
      if (!this.supports(file)) {
        return { ...result, error: '暂不支持该文件类型。' };
      }
      if (Number(file.size || 0) === 0) {
        return { ...result, error: '文件为空，无法读取内容。' };
      }
      if (legacyUnsupportedExtensions.has(extension)) {
        const messages = {
          doc: '旧版 DOC 暂不支持，请转换为 DOCX 后上传。',
          xls: '旧版 XLS 暂不支持，请转换为 XLSX 后上传。',
          ppt: 'PPT 暂不支持内容解析，请先导出为文本或 PDF。',
          pptx: 'PPTX 暂不支持内容解析，请先导出为文本或 PDF。'
        };
        return { ...result, error: messages[extension] || '暂不支持该文件类型。' };
      }
      if (extension === 'txt' || extension === 'md' || extension === 'markdown' || fileType(file).startsWith('text/')) {
        const text = truncateText(await file.text(), result.warnings);
        return { ...result, parsed: Boolean(text), contentType: extension === 'md' || extension === 'markdown' ? 'markdown' : 'text', text, error: text ? '' : '文件没有可读取的文本内容。' };
      }
      if (extension === 'docx') return this.parseDocx(file, result);
      if (extension === 'xlsx') return this.parseXlsx(file, result);
      if (extension === 'pdf') return this.parsePdf(file, result);
      if (imageExtensions.has(extension) || fileType(file).startsWith('image/')) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const mimeType = fileType(file).startsWith('image/') ? fileType(file) : `image/${extension === 'jpg' ? 'jpeg' : extension}`;
        return {
          ...result,
          parsed: true,
          contentType: 'image',
          imageDataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
          metadata: {
            ...result.metadata,
            imageBytes: bytes.length,
            mimeType,
            visionRequired: true
          },
          warnings: ['图片已准备通过支持视觉的模型识别，不会交给普通文本模型假装分析。']
        };
      }
      return { ...result, error: '暂不支持该文件类型。' };
    } catch (error) {
      return { ...result, error: this.normalizeError(error) };
    }
  }

  async parseDocx(file, result) {
    const entries = await readZipEntries(await file.arrayBuffer());
    const documentXml = entries.get('word/document.xml');
    if (!documentXml) return { ...result, contentType: 'docx', error: 'DOCX 文件缺少正文内容，无法读取。' };
    const paragraphs = parseParagraphs(documentXml);
    const headings = paragraphs.filter((item) => item.isHeading).map((item) => item.text);
    const tables = parseDocxTables(documentXml);
    const text = truncateText([...paragraphs.map((item) => item.text), ...tables.map(tableToText)].join('\n\n'), result.warnings);
    return {
      ...result,
      parsed: Boolean(text || tables.length),
      contentType: 'docx',
      text,
      tables,
      metadata: {
        ...result.metadata,
        headings,
        paragraphCount: paragraphs.length,
        tableCount: tables.length
      },
      error: text || tables.length ? '' : 'DOCX 没有可读取正文。'
    };
  }

  async parseXlsx(file, result) {
    const entries = await readZipEntries(await file.arrayBuffer());
    const workbookXml = entries.get('xl/workbook.xml');
    const relsXml = entries.get('xl/_rels/workbook.xml.rels');
    if (!workbookXml || !relsXml) return { ...result, contentType: 'spreadsheet', error: 'XLSX 文件结构不完整，无法读取工作表。' };
    const rels = parseWorkbookRels(relsXml);
    const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml') || '');
    const sheetPattern = /<sheet\b[^>]*name="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"[^>]*\/?>/g;
    const tables = [];
    const sheetNames = [];
    let match;
    while ((match = sheetPattern.exec(workbookXml))) {
      const sheetName = decodeXmlEntities(match[1]);
      const target = rels.get(match[2]);
      if (!target) continue;
      const rows = parseSheetXml(entries.get(target) || '', sharedStrings);
      sheetNames.push(sheetName);
      if (rows.length) tables.push(sheetRowsToTable(sheetName, rows));
    }
    const text = truncateText(tables.map(tableToText).join('\n\n'), result.warnings);
    if (tables.some((table) => table.rows.length >= maxWorkbookRows - 1 || table.headers.length >= maxWorkbookCols)) {
      result.warnings.push(`表格已限制为前 ${maxWorkbookRows} 行、${maxWorkbookCols} 列。`);
    }
    return {
      ...result,
      parsed: Boolean(tables.length),
      contentType: 'spreadsheet',
      text,
      tables,
      metadata: {
        ...result.metadata,
        sheetNames,
        sheetCount: sheetNames.length,
        maxRows: maxWorkbookRows,
        maxCols: maxWorkbookCols
      },
      error: tables.length ? '' : 'XLSX 没有可读取的工作表数据。'
    };
  }

  async parsePdf(file, result) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const utf8Raw = new TextDecoder('utf-8').decode(bytes);
    const latinRaw = new TextDecoder('latin1').decode(bytes);
    const raw = readabilityScore(parsePdfText(utf8Raw)) >= readabilityScore(parsePdfText(latinRaw)) ? utf8Raw : latinRaw;
    if (/\/Encrypt\b/.test(raw)) {
      return { ...result, contentType: 'pdf', metadata: { ...result.metadata, encrypted: true }, error: '该 PDF 可能已加密，当前无法读取内容。' };
    }
    const pageCount = Math.max((raw.match(/\/Type\s*\/Page\b/g) || []).length, 0);
    const text = truncateText(parsePdfText(raw), result.warnings);
    if (!text) {
      return {
        ...result,
        contentType: 'pdf',
        metadata: { ...result.metadata, pageCount },
        warnings: ['该 PDF 可能是扫描件，当前暂未进行 OCR'],
        error: '该 PDF 可能是扫描件，当前暂未进行 OCR'
      };
    }
    return {
      ...result,
      parsed: true,
      contentType: 'pdf',
      text,
      metadata: { ...result.metadata, pageCount },
      warnings: pageCount ? result.warnings : [...result.warnings, '未能可靠识别页数。']
    };
  }
}

export const attachmentParser = new AttachmentParser();
export default attachmentParser;

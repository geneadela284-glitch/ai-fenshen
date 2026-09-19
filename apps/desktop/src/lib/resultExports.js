function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text === '[object Object]') return '';
    try {
      return toText(JSON.parse(text));
    } catch {
      return text;
    }
  }
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join('\n');
  if (typeof value === 'object') return toText(value.content || value.text || value.result || value.summary || value.title);
  return String(value);
}

function stripInlineMarkdown(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}

export function parseResultMarkdown(value) {
  const text = toText(value);
  if (!text) return [];
  return text.split(/\r?\n/).map((rawLine) => {
    const line = rawLine.trim();
    if (!line) return { type: 'spacer', text: '' };
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) return { type: `heading${heading[1].length}`, text: stripInlineMarkdown(heading[2]) };
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) return { type: 'bullet', text: stripInlineMarkdown(bullet[1]) };
    const ordered = line.match(/^(\d+)[.)]\s+(.+)$/);
    if (ordered) return { type: 'ordered', marker: ordered[1], text: stripInlineMarkdown(ordered[2]) };
    return { type: 'paragraph', text: stripInlineMarkdown(line) };
  }).filter((block) => block.type === 'spacer' || block.text);
}

function sanitizeFilenamePart(value) {
  const text = stripInlineMarkdown(toText(value)).replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return text.slice(0, 80) || '未命名成果';
}

export function buildResultFilename(title, extension, date = new Date()) {
  const datePart = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  return `AI-Work-Center-${sanitizeFilenamePart(title)}-${datePart}.${extension}`;
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

function docxParagraph(block) {
  if (block.type === 'spacer') return '<w:p/>';
  const style = block.type.startsWith('heading') ? `<w:pPr><w:pStyle w:val="Heading${block.type.slice(-1)}"/></w:pPr>` : '';
  const prefix = block.type === 'bullet' ? '• ' : block.type === 'ordered' ? `${block.marker}. ` : '';
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(prefix + block.text)}</w:t></w:r></w:p>`;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeU16(view, offset, value) { view.setUint16(offset, value, true); }
function writeU32(view, offset, value) { view.setUint32(offset, value, true); }

function zipStore(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50); writeU16(localView, 4, 20); writeU16(localView, 6, 0x800); writeU16(localView, 8, 0); writeU16(localView, 10, 0); writeU16(localView, 12, 0);
    writeU32(localView, 14, crc32(data)); writeU32(localView, 18, data.length); writeU32(localView, 22, data.length); writeU16(localView, 26, nameBytes.length); writeU16(localView, 28, 0);
    local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length); chunks.push(local);
    const entry = new Uint8Array(46 + nameBytes.length); const entryView = new DataView(entry.buffer);
    writeU32(entryView, 0, 0x02014b50); writeU16(entryView, 4, 20); writeU16(entryView, 6, 20); writeU16(entryView, 8, 0x800); writeU16(entryView, 10, 0); writeU16(entryView, 12, 0); writeU16(entryView, 14, 0);
    writeU32(entryView, 16, crc32(data)); writeU32(entryView, 20, data.length); writeU32(entryView, 24, data.length); writeU16(entryView, 28, nameBytes.length); writeU16(entryView, 30, 0); writeU16(entryView, 32, 0); writeU16(entryView, 34, 0); writeU16(entryView, 36, 0); writeU32(entryView, 38, 0); writeU32(entryView, 42, offset);
    entry.set(nameBytes, 46); central.push(entry); offset += local.length;
  }
  const centralOffset = offset; const centralSize = central.reduce((sum, item) => sum + item.length, 0); chunks.push(...central);
  const end = new Uint8Array(22); const endView = new DataView(end.buffer); writeU32(endView, 0, 0x06054b50); writeU16(endView, 8, files.length); writeU16(endView, 10, files.length); writeU32(endView, 12, centralSize); writeU32(endView, 16, centralOffset); writeU16(endView, 20, 0);
  chunks.push(end);
  const output = new Uint8Array(chunks.reduce((sum, item) => sum + item.length, 0)); let cursor = 0; for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.length; }
  return output;
}

export function createDocxBlob(title, result) {
  const blocks = parseResultMarkdown(result);
  if (!blocks.length) throw new Error('成果内容为空，无法导出 Word。');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.map(docxParagraph).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const bytes = zipStore([['[Content_Types].xml', contentTypes], ['_rels/.rels', rootRels], ['word/document.xml', documentXml]]);
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function pdfTextHex(value) {
  let hex = 'FEFF';
  for (let index = 0; index < value.length; index += 1) hex += value.charCodeAt(index).toString(16).padStart(4, '0');
  return hex.toUpperCase();
}

function wrapPdfText(text, maxChars = 38) {
  const characters = Array.from(text); const lines = [];
  for (let index = 0; index < characters.length; index += maxChars) lines.push(characters.slice(index, index + maxChars).join(''));
  return lines.length ? lines : [''];
}

export function createPdfBlob(title, result) {
  const blocks = parseResultMarkdown(result);
  if (!blocks.length) throw new Error('成果内容为空，无法导出 PDF。');
  const lines = [];
  for (const block of blocks) {
    if (block.type === 'spacer') { lines.push({ text: '', size: 11 }); continue; }
    const prefix = block.type === 'bullet' ? '• ' : block.type === 'ordered' ? `${block.marker}. ` : '';
    const size = block.type === 'heading1' ? 18 : block.type === 'heading2' ? 15 : block.type === 'heading3' ? 13 : 11;
    wrapPdfText(prefix + block.text).forEach((text) => lines.push({ text, size }));
  }
  const pages = []; let page = []; let y = 790;
  for (const line of lines) { const leading = line.size + 8; if (y < 55 + leading) { pages.push(page); page = []; y = 790; } page.push({ ...line, y }); y -= leading; } if (page.length) pages.push(page);
  const objects = [];
  const add = (content) => { objects.push(content); return objects.length; };
  const pagesId = add('');
  const catalogId = add('');
  const fontId = add('');
  const descendantId = add('');
  const descriptorId = add('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>');
  objects[fontId - 1] = `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [${descendantId} 0 R] >>`;
  objects[descendantId - 1] = `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptorId} 0 R >>`;
  const contentIds = [];
  pages.forEach((pageLines) => { const commands = ['BT', `/F1 ${pageLines[0]?.size || 11} Tf`]; pageLines.forEach((line, index) => { if (index) commands.push(`/F1 ${line.size} Tf`); commands.push(`1 0 0 1 50 ${line.y} Tm <${pdfTextHex(line.text)}> Tj`); }); commands.push('ET'); const stream = commands.join('\n'); contentIds.push(add(`<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`)); });
  const pageIds = [];
  pages.forEach((_, index) => { pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`)); });
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  const encoder = new TextEncoder(); let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets = [0]; objects.forEach((object, index) => { offsets.push(encoder.encode(pdf).length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }); const xref = encoder.encode(pdf).length; pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: 'application/pdf' });
}

export function downloadBlob(blob, filename) {
  if (!blob || typeof URL === 'undefined' || typeof document === 'undefined') throw new Error('当前环境不支持文件下载。');
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.rel = 'noopener'; anchor.style.display = 'none'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportResultToWord(title, result) { const filename = buildResultFilename(title, 'docx'); downloadBlob(createDocxBlob(title, result), filename); return filename; }
export function exportResultToPdf(title, result) { const filename = buildResultFilename(title, 'pdf'); downloadBlob(createPdfBlob(title, result), filename); return filename; }

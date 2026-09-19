import assert from 'node:assert/strict';
import { AttachmentParser } from './AttachmentParser.js';

function makeFile(name, type, bytesOrText) {
  const bytes = typeof bytesOrText === 'string' ? new TextEncoder().encode(bytesOrText) : bytesOrText;
  return {
    name,
    type,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() {
      return new TextDecoder('utf-8').decode(bytes);
    }
  };
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function createStoreZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes
    ]);
    localParts.push(localHeader, data);
    centralParts.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes
    ]));
    offset += localHeader.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(centralParts.length),
    u16(centralParts.length),
    u32(central.length),
    u32(offset),
    u16(0)
  ]);
  return new Uint8Array(Buffer.concat([...localParts, central, end]));
}

const parser = new AttachmentParser();

const txt = await parser.parse(makeFile('说明.txt', 'text/plain', '客户喜欢浅色实木家具。'));
assert.equal(txt.parsed, true);
assert.equal(txt.contentType, 'text');
assert.match(txt.text, /浅色实木家具/);

const markdown = await parser.parse(makeFile('会议.md', 'text/markdown', '# 会议\n- 待办：跟进报价'));
assert.equal(markdown.parsed, true);
assert.equal(markdown.contentType, 'markdown');
assert.match(markdown.text, /待办/);

const docxXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>新品说明</w:t></w:r></w:p>
<w:p><w:r><w:t>实木餐桌环保耐用。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>说明</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>售后</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>三年质保</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;
const docx = await parser.parse(makeFile('新品.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', createStoreZip({ 'word/document.xml': docxXml })));
assert.equal(docx.parsed, true);
assert.match(docx.text, /实木餐桌环保耐用/);
assert.equal(docx.tables.length, 1);
assert.deepEqual(docx.metadata.headings, ['新品说明']);

const workbookXml = `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="销售" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const relsXml = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
const sharedXml = `<sst><si><t>门店</t></si><si><t>销售额</t></si><si><t>上海店</t></si></sst>`;
const sheetXml = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>18000</v></c></row></sheetData></worksheet>`;
const xlsx = await parser.parse(makeFile('销售.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createStoreZip({
  'xl/workbook.xml': workbookXml,
  'xl/_rels/workbook.xml.rels': relsXml,
  'xl/sharedStrings.xml': sharedXml,
  'xl/worksheets/sheet1.xml': sheetXml
})));
assert.equal(xlsx.parsed, true);
assert.equal(xlsx.contentType, 'spreadsheet');
assert.equal(xlsx.metadata.sheetNames[0], '销售');
assert.match(xlsx.text, /上海店/);

const pdf = await parser.parse(makeFile('文本.pdf', 'application/pdf', '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\nBT (家具产品介绍) Tj ET\n%%EOF'));
assert.equal(pdf.parsed, true);
assert.equal(pdf.contentType, 'pdf');
assert.match(pdf.text, /家具产品介绍/);

const scannedPdf = await parser.parse(makeFile('扫描件.pdf', 'application/pdf', '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF'));
assert.equal(scannedPdf.parsed, false);
assert.match(scannedPdf.error, /扫描件/);

const image = await parser.parse(makeFile('照片.jpg', 'image/jpeg', new Uint8Array([1, 2, 3])), { visionSupported: false });
assert.equal(image.parsed, true);
assert.equal(image.contentType, 'image');
assert.match(image.imageDataUrl, /^data:image\/jpeg;base64,/);
assert.equal(image.metadata.visionRequired, true);

const doc = await parser.parse(makeFile('旧文件.doc', 'application/msword', 'legacy'));
assert.equal(doc.parsed, false);
assert.match(doc.error, /旧版 DOC/);

console.log('Attachment parser tests PASS');

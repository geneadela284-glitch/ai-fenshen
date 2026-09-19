import { buildMeetingAnalysisViewModel } from '../components/meeting/meetingAnalysisUiModel.js';
import { buildResultFilename, downloadBlob } from './resultExports.js';

export const MEETING_ANALYSIS_PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;
const MAX_ENTRIES_PER_SLIDE = 6;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function text(value, fallback = '未明确') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function rawText(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return rawText(value.value ?? value.content ?? '');
  }
  return String(value ?? '').trim();
}

function hasMeaningfulText(value) {
  const normalized = rawText(value);
  return Boolean(normalized) && normalized !== '未明确' && normalized !== 'unresolved';
}

function hasExportableContent(bundle) {
  const summary = bundle?.summary || {};
  const lists = [
    summary.keyPoints,
    summary.conclusions,
    summary.openQuestions,
    bundle?.decisions,
    bundle?.actionItems
  ];
  return [summary.topic, summary.overview].some(hasMeaningfulText)
    || lists.some((items) => Array.isArray(items) && items.some((item) => hasMeaningfulText(item?.content ?? item?.value ?? item)));
}

function listEntries(items, emptyLabel = '未明确', render = (item) => item.content) {
  if (!Array.isArray(items) || !items.length) return [emptyLabel];
  return items.map((item) => text(render(item)));
}

function appendChunkedSlides(slides, title, entries) {
  const normalizedEntries = entries.map((entry) => text(entry)).filter(Boolean);
  const chunks = normalizedEntries.length
    ? Array.from({ length: Math.ceil(normalizedEntries.length / MAX_ENTRIES_PER_SLIDE) }, (_, index) => normalizedEntries.slice(index * MAX_ENTRIES_PER_SLIDE, (index + 1) * MAX_ENTRIES_PER_SLIDE))
    : [['未明确']];
  chunks.forEach((chunk, index) => {
    slides.push(Object.freeze({
      kind: 'content',
      title: index === 0 ? title : `${title}（续 ${index + 1}）`,
      subtitle: 'AI分身根据当前原文整理',
      entries: Object.freeze(chunk)
    }));
  });
}

export function buildMeetingAnalysisPptxSlides(title, analysis) {
  const model = buildMeetingAnalysisViewModel(analysis);
  if (!model.displayable || !hasExportableContent(analysis)) throw codedError('MEETING_ANALYSIS_EXPORT_UNAVAILABLE');

  const slides = [Object.freeze({
    kind: 'title',
    title: text(title, '会议整理'),
    subtitle: 'AI会议整理',
    entries: Object.freeze([])
  })];

  appendChunkedSlides(slides, '会议摘要', [
    `会议主题：${model.summary.topic}`,
    `核心讨论：${model.summary.overview}`
  ]);
  appendChunkedSlides(slides, '讨论重点', listEntries(model.summary.keyPoints, '未明确'));

  const outcomeEntries = [
    ...listEntries(model.summary.conclusions, '未明确', (item) => `结论：${item.content}`),
    ...listEntries(model.decisions, '未明确', (item) => `决定（${item.statusLabel}）：${item.content}`)
  ];
  appendChunkedSlides(slides, '结论与会议决定', outcomeEntries);
  appendChunkedSlides(slides, '未决问题', listEntries(model.summary.openQuestions, '未明确'));
  appendChunkedSlides(slides, '后续行动', listEntries(model.actionItems, '未明确', (item) => `${item.content}｜负责人：${item.ownerLabel}｜截止日期：${item.dueDateLabel}｜状态：${item.statusLabel}`));

  return Object.freeze(slides);
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  }[character]));
}

function runProperties({ fontSize = 2100, color = '1F2937', bold = false } = {}) {
  return `<a:rPr lang="zh-CN" sz="${fontSize}"${bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Aptos"/><a:ea typeface="Heiti SC"/><a:cs typeface="PingFang SC"/></a:rPr>`;
}

function paragraphXml(value, { bullet = false, fontSize = 2100, color = '1F2937', bold = false } = {}) {
  const paragraphProperties = bullet
    ? '<a:pPr marL="228600" indent="-114300"><a:buChar char="•"/></a:pPr>'
    : '<a:pPr algn="l"/>';
  const safeValue = escapeXml(value);
  return `<a:p>${paragraphProperties}<a:r>${runProperties({ fontSize, color, bold })}<a:t>${safeValue}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${fontSize}"/></a:p>`;
}

function shapeTransform(x, y, width, height) {
  return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>`;
}

function rectangleShape(id, name, x, y, width, height, fill, line = null) {
  const lineXml = line
    ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill><a:prstDash val="solid"/></a:ln>`
    : '<a:ln><a:noFill/></a:ln>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${shapeTransform(x, y, width, height)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>${lineXml}</p:spPr></p:sp>`;
}

function textShape(id, name, x, y, width, height, values, options = {}) {
  const {
    bullet = false,
    fontSize = 2100,
    color = '1F2937',
    bold = false,
    leftInset = 180000,
    rightInset = 180000,
    topInset = 120000,
    bottomInset = 120000
  } = options;
  const paragraphs = values.map((value) => paragraphXml(value, { bullet, fontSize, color, bold })).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${shapeTransform(x, y, width, height)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="${leftInset}" rIns="${rightInset}" tIns="${topInset}" bIns="${bottomInset}"><a:normAutofit fontScale="90000" lnSpcReduction="10000"/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function groupShapeTree(shapes) {
  return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree>`;
}

function slideXml(slide) {
  let nextId = 2;
  const shapes = [rectangleShape(nextId++, 'AI分身 accent', 0, 0, SLIDE_WIDTH, 120000, '5B5FEF')];
  if (slide.kind === 'title') {
    shapes.push(textShape(nextId++, 'Meeting title', 800000, 1550000, 10500000, 1250000, [slide.title], { fontSize: 3600, color: '0F172A', bold: true, topInset: 0, bottomInset: 0 }));
    shapes.push(textShape(nextId++, 'Meeting subtitle', 840000, 3150000, 10000000, 700000, [slide.subtitle], { fontSize: 2400, color: '5B5FEF', bold: true, topInset: 0, bottomInset: 0 }));
    shapes.push(textShape(nextId++, 'Meeting provenance', 840000, 5400000, 10000000, 500000, ['基于当前已确认的会议原文整理'], { fontSize: 1500, color: '64748B', topInset: 0, bottomInset: 0 }));
  } else {
    shapes.push(textShape(nextId++, 'Section title', 700000, 420000, 10600000, 700000, [slide.title], { fontSize: 2800, color: '0F172A', bold: true, topInset: 0, bottomInset: 0 }));
    shapes.push(rectangleShape(nextId++, 'Section card', 650000, 1350000, 10700000, 4650000, 'FFFFFF', 'DDE7F3'));
    shapes.push(textShape(nextId++, 'Section subtitle', 920000, 1520000, 10000000, 430000, [slide.subtitle], { fontSize: 1450, color: '64748B', topInset: 0, bottomInset: 0 }));
    shapes.push(textShape(nextId++, 'Section entries', 900000, 2020000, 10000000, 3450000, slide.entries, { bullet: true, fontSize: 2100, color: '1F2937', topInset: 0, bottomInset: 0 }));
    shapes.push(textShape(nextId++, 'Section footer', 700000, 6250000, 10600000, 250000, ['AI分身 · 会议整理'], { fontSize: 1200, color: '94A3B8', topInset: 0, bottomInset: 0 }));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="${escapeXml(slide.title)}"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${groupShapeTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function zipCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = zipCrc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034B50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x800);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, 0);
    writeU16(localView, 12, 0);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, data.length);
    writeU32(localView, 22, data.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    chunks.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014B50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x800);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, 0);
    writeU16(centralView, 14, 0);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, data.length);
    writeU32(centralView, 24, data.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, offset);
    central.set(nameBytes, 46);
    centralDirectory.push(central);
    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((sum, entry) => sum + entry.length, 0);
  chunks.push(...centralDirectory);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054B50);
  writeU16(endView, 8, files.length);
  writeU16(endView, 10, files.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, centralOffset);
  writeU16(endView, 20, 0);
  chunks.push(end);

  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

function contentTypesXml(slideCount) {
  const slideOverrides = Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}</Types>`;
}

function rootRelationshipsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
}

function presentationXml(slideCount) {
  const slideIds = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
}

function presentationRelationshipsXml(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides}</Relationships>`;
}

function slideMasterXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="AI分身会议整理"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="2800"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="2100"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>';
}

function slideMasterRelationshipsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>';
}

function slideLayoutXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
}

function slideLayoutRelationshipsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>';
}

function themeXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="AI分身"><a:themeElements><a:clrScheme name="AI分身"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="5B5FEF"/></a:accent1><a:accent2><a:srgbClr val="06B6D4"/></a:accent2><a:accent3><a:srgbClr val="8B5CF6"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="10B981"/></a:accent5><a:accent6><a:srgbClr val="EF4444"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="AI分身"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Heiti SC"/><a:cs typeface="PingFang SC"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Heiti SC"/><a:cs typeface="PingFang SC"/></a:minorFont></a:fontScheme><a:fmtScheme name="AI分身"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>';
}

function slideRelationshipsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>';
}

function corePropertiesXml(title) {
  const timestamp = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>AI分身</dc:creator><cp:lastModifiedBy>AI分身</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`;
}

function appPropertiesXml(slideCount) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>AI分身</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${slideCount}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop></Properties>`;
}

function buildPptxFiles(title, slides) {
  const files = [
    ['[Content_Types].xml', contentTypesXml(slides.length)],
    ['_rels/.rels', rootRelationshipsXml()],
    ['docProps/core.xml', corePropertiesXml(title)],
    ['docProps/app.xml', appPropertiesXml(slides.length)],
    ['ppt/presentation.xml', presentationXml(slides.length)],
    ['ppt/_rels/presentation.xml.rels', presentationRelationshipsXml(slides.length)],
    ['ppt/slideMasters/slideMaster1.xml', slideMasterXml()],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', slideMasterRelationshipsXml()],
    ['ppt/slideLayouts/slideLayout1.xml', slideLayoutXml()],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', slideLayoutRelationshipsXml()],
    ['ppt/theme/theme1.xml', themeXml()]
  ];
  slides.forEach((slide, index) => {
    files.push([`ppt/slides/slide${index + 1}.xml`, slideXml(slide)]);
    files.push([`ppt/slides/_rels/slide${index + 1}.xml.rels`, slideRelationshipsXml()]);
  });
  return files;
}

export function createMeetingAnalysisPptxBlob(title, analysis) {
  const slides = buildMeetingAnalysisPptxSlides(title, analysis);
  const bytes = zipStore(buildPptxFiles(text(title, '会议整理'), slides));
  return new Blob([bytes], { type: MEETING_ANALYSIS_PPTX_MIME });
}

export function exportMeetingAnalysisToPptx(title, analysis, { download = downloadBlob, date = new Date() } = {}) {
  const filename = buildResultFilename(title, 'pptx', date);
  download(createMeetingAnalysisPptxBlob(title, analysis), filename);
  return filename;
}

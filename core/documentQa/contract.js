export const DOCUMENT_SCHEMA = 'document-qa-v1';
export const PARSER_VERSION = 'document-text-v1';
export const LIMITS = Object.freeze({ fileBytes: 8*1024*1024, pages: 100, text: 24000, unpackedBytes: 32*1024*1024, savedBytes: 100*1024*1024, blocks: 1200 });
export function documentError(code) { return Object.assign(new Error(code), { code }); }
export function checkAbort(signal) { if (signal?.aborted) throw documentError('ABORTED'); }
export async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
}
export function makeProjection(document, { conversationId, question }) {
  return { schema: DOCUMENT_SCHEMA, ownerId: document.record.ownerId, conversationId, question,
    record: { ...document.record, storageRef: undefined }, blocks: document.blocks };
}
export function validateProjection(value, { ownerId, conversationId, question, hash }) {
  const fail = () => { throw documentError('DOCUMENT_CONTEXT_INVALID'); };
  if (!value || value.schema !== DOCUMENT_SCHEMA || value.ownerId !== ownerId || !conversationId || value.conversationId !== conversationId || value.question !== question) fail();
  const r=value.record;
  if (!r || r.ownerId !== ownerId || !/^[a-zA-Z0-9_-]{8,100}$/.test(r.documentId) || r.parserVersion !== PARSER_VERSION || !/^[a-f0-9]{64}$/.test(r.checksum) || r.revision !== `${r.checksum}:${PARSER_VERSION}` || !['pdf','docx'].includes(r.format) || typeof r.filename !== 'string' || !r.filename.trim() || r.filename.length>240 || !Number.isSafeInteger(r.byteSize) || r.byteSize<1 || r.byteSize>LIMITS.fileBytes) fail();
  if (!Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length>LIMITS.blocks) fail();
  let length=0;
  for (const [index,b] of value.blocks.entries()) {
    if (!b || b.order !== index || b.blockId !== `block-${index+1}` || b.documentId !== r.documentId || b.revision !== r.revision || typeof b.text !== 'string' || !b.text.trim() || !/^[a-f0-9]{64}$/.test(b.textChecksum) || (hash && hash(b.text)!==b.textChecksum)) fail();
    length+=b.text.length;
    const positive=v=>Number.isSafeInteger(v)&&v>0;
    if (r.format==='pdf') { if (b.kind!=='page' || !positive(b.pageNumber) || b.pageNumber>LIMITS.pages || b.pageNumber!==index+1 || b.paragraphIndex!=null || b.tableIndex!=null) fail(); }
    else if (b.pageNumber!=null || (b.kind==='paragraph' ? !positive(b.paragraphIndex) : b.kind!=='table_row' || !positive(b.tableIndex) || !positive(b.rowIndex))) fail();
  }
  if (length>LIMITS.text || (r.format==='pdf' && r.pageCount!==value.blocks.length)) fail();
  return value;
}
export function sourceLabel(citation) {
  return `${citation.filename} · ${citation.pageNumber ? `第${citation.pageNumber}页` : citation.tableIndex ? `表${citation.tableIndex}第${citation.rowIndex}行` : `第${citation.paragraphIndex}段`}`;
}
export function validateAnswer(value, document) {
  if (value?.found === false && Array.isArray(value.points) && !value.points.length) return { text:'这份文件中没有找到相关信息。', citations:[], documentId:document.record.documentId, revision:document.record.revision };
  if (value?.found!==true || !Array.isArray(value.points) || !value.points.length || value.points.length>12) throw documentError('DOCUMENT_ANSWER_INVALID');
  const citations=[]; const paragraphs=[];
  for (const point of value.points) {
    if (typeof point?.text!=='string' || !point.text.trim() || point.text.length>1600 || !Array.isArray(point.citations) || !point.citations.length || point.citations.length>5) throw documentError('DOCUMENT_CITATION_INVALID');
    const quotes=[]; const labels=[];
    for (const ref of point.citations) {
      const block=document.blocks.find(b=>b.blockId===ref?.blockId);
      if (!block || typeof ref.quote!=='string' || !ref.quote.trim() || ref.quote.length>1600 || !block.text.includes(ref.quote)) throw documentError('DOCUMENT_CITATION_INVALID');
      const startOffset=block.text.indexOf(ref.quote);
      const citation={documentId:document.record.documentId,revision:document.record.revision,filename:document.record.filename,
        blockId:block.blockId,order:block.order,kind:block.kind,...(block.pageNumber ? {pageNumber:block.pageNumber}:{}),...(block.paragraphIndex ? {paragraphIndex:block.paragraphIndex}:{}),...(block.tableIndex ? {tableIndex:block.tableIndex,rowIndex:block.rowIndex}:{}),startOffset,endOffset:startOffset+ref.quote.length,quote:ref.quote};
      let n=citations.findIndex(c=>c.blockId===citation.blockId && c.quote===citation.quote);
      if(n<0) { n=citations.length; citations.push(citation); }
      labels.push(`[${n+1}]`); quotes.push(ref.quote);
    }
    for (const number of point.text.match(/\d+(?:[.,]\d+)*/g)||[]) if(!quotes.some(q=>q.includes(number))) throw documentError('DOCUMENT_FACT_UNSUPPORTED');
    paragraphs.push(`${point.text.trim()} ${[...new Set(labels)].join('')}`);
  }
  return {text:paragraphs.join('\n\n'),citations,documentId:document.record.documentId,revision:document.record.revision};
}
const PREFIX='\u2063AF_DOCUMENT_QA_V1\n';
export function encodeDocumentMessage(kind,data) { return PREFIX+JSON.stringify({kind,data}); }
export function decodeDocumentMessage(content) {
  if(typeof content!=='string' || !content.startsWith(PREFIX)) return null;
  try { const value=JSON.parse(content.slice(PREFIX.length)); return ['question','answer'].includes(value.kind) && value.data && typeof value.data==='object' ? value:null; } catch { return null; }
}
export function documentMessageText(content) {
  const envelope=decodeDocumentMessage(content);
  if(!envelope) return content;
  if(envelope.kind==='question') return envelope.data.question || '';
  return `${envelope.data.text || ''}\n${(envelope.data.citations||[]).map((c,i)=>`[${i+1}] ${sourceLabel(c)}：${c.quote}`).join('\n')}`;
}

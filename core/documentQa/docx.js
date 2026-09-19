import { Inflate } from 'fflate';
import { LIMITS, documentError, checkAbort } from './contract.js';
const NS='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function fail(code='DOCUMENT_INVALID') { throw documentError(code); }
// Validate the directory before inflating; enforce actual byte bounds while inflating too.
function zipEntries(bytes,signal) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); const u16=i=>view.getUint16(i,true), u32=i=>view.getUint32(i,true);
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) if(u32(i)===0x06054b50) {end=i;break;}
  if(end<0 || u16(end+4) || u16(end+6) || u16(end+8)!==u16(end+10)) fail();
  const count=u16(end+10); let pos=u32(end+16); const size=u32(end+12);
  if(!count || count>2048 || pos+size>end) fail();
  const result=new Map(); let declared=0,actualTotal=0;
  for(let n=0;n<count;n++) {
    checkAbort(signal); if(pos+46>bytes.length || u32(pos)!==0x02014b50) fail();
    const flags=u16(pos+8),method=u16(pos+10),packed=u32(pos+20),unpacked=u32(pos+24),nameSize=u16(pos+28),extra=u16(pos+30),comment=u16(pos+32),local=u32(pos+42);
    if(flags&1) fail('DOCUMENT_ENCRYPTED'); if(![0,8].includes(method) || packed===0xffffffff || unpacked===0xffffffff) fail();
    declared+=unpacked; if(declared>LIMITS.unpackedBytes) fail('DOCUMENT_UNPACK_LIMIT');
    const name=new TextDecoder().decode(bytes.subarray(pos+46,pos+46+nameSize));
    if(result.has(name) || name.includes('..') || name.startsWith('/') || local+30>bytes.length || u32(local)!==0x04034b50 || u16(local+8)!==method || (u16(local+6)&1)) fail();
    const start=local+30+u16(local+26)+u16(local+28); if(start+packed>u32(end+16)) fail();
    if(new TextDecoder().decode(bytes.subarray(local+30,local+30+u16(local+26)))!==name) fail();
    const chunks=[];let actual=0;
    const receive=chunk=> {actual+=chunk.length;actualTotal+=chunk.length;if(actual>unpacked || actualTotal>LIMITS.unpackedBytes) fail('DOCUMENT_UNPACK_LIMIT'); chunks.push(chunk);};
    if(method===0) receive(bytes.slice(start,start+packed));
    else { const inflate=new Inflate(receive); for(let i=0;i<packed;i+=1024) {checkAbort(signal);inflate.push(bytes.subarray(start+i,start+Math.min(packed,i+1024)),i+1024>=packed);} }
    if(actual!==unpacked) fail();
    const output=new Uint8Array(actual);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}
    result.set(name,output); pos+=46+nameSize+extra+comment;
  }
  if(pos!==u32(end+16)+size) fail(); return result;
}
function xmlDocument(bytes,DOMParserImpl) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(/<!DOCTYPE|<!ENTITY/i.test(text)) fail();
  let invalid=false;
  const parser=new DOMParserImpl({onError:()=>{invalid=true;}});
  const doc=parser.parseFromString(text,'application/xml');
  if(invalid || !doc || doc.getElementsByTagName('parsererror').length) fail();
  return doc;
}
function children(node,name) { return Array.from(node.childNodes||[]).filter(n=>n.nodeType===1 && n.namespaceURI===NS && (!name || n.localName===name)); }
function plain(node) {
  if(node.nodeType===1 && node.namespaceURI===NS) {
    if(node.localName==='t') return node.textContent;
    if(['tab','br','cr'].includes(node.localName)) return node.localName==='tab'?'\t':'\n';
    if(['del','instrText'].includes(node.localName)) return '';
  }
  return Array.from(node.childNodes||[]).map(plain).join('');
}
export function parseDocx(bytes,{DOMParserImpl=globalThis.DOMParser,signal}={}) {
  try {
    const entries=zipEntries(bytes,signal);
    if(!entries.has('word/document.xml') || !entries.has('[Content_Types].xml')) fail();
    // V1 is text paragraphs/simple tables. Do not silently omit embedded content or side stories.
    for(const [name,data] of entries) {
      if(/vbaProject|embeddings\//i.test(name)) fail('DOCUMENT_LAYOUT_UNSUPPORTED');
      if(/^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(name) && /<w:t(?:\s|>)/.test(new TextDecoder().decode(data))) fail('DOCUMENT_LAYOUT_UNSUPPORTED');
    }
    const doc=xmlDocument(entries.get('word/document.xml'),DOMParserImpl);
    for(const tag of ['altChunk','txbxContent','object','drawing','pict','fldSimple','instrText','gridSpan','vMerge']) if(doc.getElementsByTagNameNS(NS,tag).length) fail('DOCUMENT_LAYOUT_UNSUPPORTED');
    const body=doc.getElementsByTagNameNS(NS,'body')[0]; if(!body) fail();
    const blocks=[];let paragraph=0,table=0;
    const add=(text,position)=>{if(text.trim()) blocks.push({...position,text:text.trim()});};
    for(const child of children(body)) {
      checkAbort(signal);
      if(child.localName==='p') {paragraph++;add(plain(child),{kind:'paragraph',paragraphIndex:paragraph});}
      else if(child.localName==='tbl') {table++;let row=0;for(const tr of children(child,'tr')) {row++;add(children(tr,'tc').map(tc=>children(tc,'p').map(plain).join('\n')).join(' | '),{kind:'table_row',tableIndex:table,rowIndex:row});}}
      else if(child.localName!=='sectPr') fail('DOCUMENT_LAYOUT_UNSUPPORTED');
    }
    return blocks;
  } catch(error) { if(error?.code?.startsWith('DOCUMENT_') || error?.code==='ABORTED') throw error; fail(); }
}

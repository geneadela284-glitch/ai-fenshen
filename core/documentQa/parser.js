import { LIMITS, PARSER_VERSION, sha256, documentError, checkAbort } from './contract.js';
import { parseDocx } from './docx.js';
export async function parseDocument({ bytes, filename, ownerId, signal, onProgress=()=>{}, DOMParserImpl, pdfOptions={} }) {
  checkAbort(signal);
  if(!ownerId) throw documentError('DOCUMENT_OWNER_REQUIRED');
  if(!(bytes instanceof Uint8Array) || !bytes.length) throw documentError('DOCUMENT_INVALID');
  if(bytes.length>LIMITS.fileBytes) throw documentError('DOCUMENT_FILE_LIMIT');
  if(typeof filename!=='string' || !filename.trim() || filename.length>240) throw documentError('DOCUMENT_INVALID');
  const format=filename.toLowerCase().endsWith('.pdf')?'pdf':filename.toLowerCase().endsWith('.docx')?'docx':null;
  if(!format) throw documentError('DOCUMENT_FORMAT_UNSUPPORTED');
  let blocks, pageCount;
  if(format==='docx') {
    blocks=parseDocx(bytes,{DOMParserImpl,signal}); onProgress({phase:'parsing',completed:1,total:1});
  } else {
    if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-') throw documentError('DOCUMENT_INVALID');
    const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');
    if(pdfOptions.workerSrc) pdf.GlobalWorkerOptions.workerSrc=pdfOptions.workerSrc;
    const loading=pdf.getDocument({data:bytes.slice(),verbosity:0,isEvalSupported:false,stopAtErrors:true,enableXfa:false,useSystemFonts:false,disableFontFace:true,useWasm:false,...pdfOptions});
    const abort=()=>{void loading.destroy();};signal?.addEventListener('abort',abort,{once:true});
    try {
      const document=await loading.promise;checkAbort(signal);
      if(await document.getPermissions()) throw documentError('DOCUMENT_ENCRYPTED');
      pageCount=document.numPages;if(pageCount>LIMITS.pages) throw documentError('DOCUMENT_PAGE_LIMIT');
      blocks=[];let total=0;
      for(let pageNumber=1;pageNumber<=pageCount;pageNumber++) {
        checkAbort(signal);const page=await document.getPage(pageNumber);const content=await page.getTextContent();
        const text=content.items.filter(x=>typeof x.str==='string').map(x=>x.str+(x.hasEOL?'\n':' ')).join('').trim();
        if(!text) throw documentError('DOCUMENT_NO_TEXT');
        total+=text.length;if(total>LIMITS.text) throw documentError('DOCUMENT_TEXT_LIMIT');
        blocks.push({kind:'page',pageNumber,text});page.cleanup();onProgress({phase:'parsing',completed:pageNumber,total:pageCount});
      }
    } catch(error) {checkAbort(signal);if(error.name==='PasswordException') throw documentError('DOCUMENT_ENCRYPTED');if(error.code?.startsWith('DOCUMENT_')) throw error;throw Object.assign(documentError('DOCUMENT_INVALID'),{cause:error});}
    finally {signal?.removeEventListener('abort',abort);await loading.destroy();}
  }
  checkAbort(signal);
  if(!blocks.length) throw documentError('DOCUMENT_NO_TEXT');
  if(blocks.length>LIMITS.blocks || blocks.reduce((sum,b)=>sum+b.text.length,0)>LIMITS.text) throw documentError('DOCUMENT_TEXT_LIMIT');
  const checksum=await sha256(bytes);const documentId=globalThis.crypto.randomUUID();const revision=`${checksum}:${PARSER_VERSION}`;
  blocks=await Promise.all(blocks.map(async (block,order)=>({...block,documentId,revision,order,blockId:`block-${order+1}`,textChecksum:await sha256(block.text)})));
  checkAbort(signal);
  return {record:{documentId,ownerId,deviceScope:'current-browser',filename,format,byteSize:bytes.length,checksum,parserVersion:PARSER_VERSION,revision,createdAt:new Date().toISOString(),state:'ready',...(pageCount?{pageCount}:{})},blocks,bytes};
}

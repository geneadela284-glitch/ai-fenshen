import { parseDocument } from '../../../../core/documentQa/parser.js';
import { DOMParser } from '@xmldom/xmldom';
const pdfWorkerSrc='/document-assets/pdf.worker.js';
self.onmessage=async({data})=>{
  if(data.channel!=='af-document-parser-v1')return;
  try{const document=await parseDocument({...data,DOMParserImpl:DOMParser,pdfOptions:{workerSrc:pdfWorkerSrc,cMapUrl:'/document-assets/cmaps/',cMapPacked:true,standardFontDataUrl:'/document-assets/standard_fonts/'},onProgress:progress=>self.postMessage({channel:'af-document-parser-v1',type:'progress',progress})});self.postMessage({channel:'af-document-parser-v1',type:'ready',document},[document.bytes.buffer]);}
  catch(error){self.postMessage({channel:'af-document-parser-v1',type:'failed',code:error?.code||'DOCUMENT_INVALID'});}
};

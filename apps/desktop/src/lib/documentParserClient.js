import { LIMITS, documentError } from '../../../../core/documentQa/contract.js';
export async function parseDocumentFile(file,{ownerId,signal,onProgress=()=>{}}={}){
  if(signal?.aborted)throw documentError('ABORTED');
  if(file.size>LIMITS.fileBytes)throw documentError('DOCUMENT_FILE_LIMIT');
  if(!/\.(pdf|docx)$/i.test(file.name))throw documentError('DOCUMENT_FORMAT_UNSUPPORTED');
  const bytes=new Uint8Array(await file.arrayBuffer());if(signal?.aborted)throw documentError('ABORTED');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./documentParser.worker.js',import.meta.url),{type:'module'});
    let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();error?reject(error):resolve(value);};
    const abort=()=>finish(documentError('ABORTED'));
    const timer=setTimeout(()=>finish(documentError('DOCUMENT_PARSE_TIMEOUT')),45000);
    signal?.addEventListener('abort',abort,{once:true});
    worker.onerror=()=>finish(documentError('DOCUMENT_INVALID'));
    worker.onmessage=({data})=>{if(settled||data.channel!=='af-document-parser-v1')return;if(data.type==='progress')onProgress(data.progress);else if(data.type==='ready')finish(null,data.document);else if(data.type==='failed')finish(documentError(data.code));};
    worker.postMessage({channel:'af-document-parser-v1',bytes,filename:file.name,ownerId},[bytes.buffer]);
  });
}

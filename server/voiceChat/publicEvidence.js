import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
const MAX_BYTES = 512 * 1024;
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, prefix, 'ipv4');
export const isPublicIPv4 = address => isIP(address) === 4 && !blocked.check(address, 'ipv4');
function publicURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || isIP(url.hostname) || !url.hostname.includes('.') || /\.(?:localhost|local|internal)$/.test(url.hostname)) throw new Error('PUBLIC_URL_REQUIRED');
  url.hash = ''; return url;
}
function decode(text) {
  const named = { amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? all;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2),16) : parseInt(code.slice(1),10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
  });
}
export function pageText(html) {
  let body=String(html).slice(0,MAX_BYTES).replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,' ').replace(/<!--[\s\S]*?(?:-->|$)/g,' ');
  const main=body.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
  if(main)body=main[1];
  body=body.replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
  return decode(body.replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,' ')).replace(/[\t \r]+/g,' ').replace(/\n\s*\n/g,'\n').trim().slice(0,12000);
}
// Passages are source substrings, never generated summaries. Their IDs allow a
// reviewer to select evidence without retyping or embellishing a quotation.
export function buildCitationPassages(extracts, query='') {
  const queryText=String(query).toLowerCase();
  // Overlapping character pairs preserve Chinese words at every offset.
  const terms=[...new Set([...(queryText.match(/[a-z]{3,}|\d{2,}/g)||[]),...[...queryText.matchAll(/(?=([\u4e00-\u9fff]{2}))/g)].map(m=>m[1])])].slice(0,100);
  const result=[];
  for(const extract of extracts||[]){
    if(extract.origin!=='https_source_text'||!extract.urls?.[0])continue;
    // Keep neighboring fields together: a title without its adjacent date is
    // not enough evidence. Windows remain exact bounded source substrings.
    const lines=[];const source=String(extract.text).slice(0,12000);
    for(let offset=0;offset<source.length;){
      let end=Math.min(offset+400,source.length);
      if(end<source.length){const boundary=source.lastIndexOf('\n',end);if(boundary>offset+200)end=boundary+1;}
      const text=source.slice(offset,end).trim();if(text.length>=12)lines.push(text);
      offset=end;
    }
    const unique=[...new Set(lines)], lowered=unique.map(text=>text.toLowerCase());
    // Repeated page titles/navigation must not crowd out the requested attribute.
    const weights=new Map(terms.map(term=>[term,1/(1+lowered.filter(text=>text.includes(term)).length)]));
    const selected=unique.map((text,index)=>({text,index,score:terms.reduce((sum,t)=>sum+(lowered[index].includes(t)?weights.get(t)*(/\d/.test(t)?3:1):0),0)})).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,12).sort((a,b)=>a.index-b.index);
    for(const item of selected)result.push({id:'p'+(result.length+1),url:extract.urls[0],text:item.text});
  }
  return result.slice(0,36);
}
function requestPage(url, address, signal) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method:'GET', agent:false, signal, maxHeaderSize:16384,
      headers:{Accept:'text/html,text/plain;q=0.9','Accept-Encoding':'gzip, deflate, br','User-Agent':'AI-Fenshen-Public-Reader/1.0'},
      // Pin the address validated above. TLS still verifies the original host.
      lookup:(_host, options, callback)=>options.all ? callback(null,[{address,family:4}]) : callback(null,address,4)
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) { const redirect=response.headers.location;response.destroy();resolve({redirect});return; }
      if (response.statusCode !== 200 || Number(response.headers['content-length']) > MAX_BYTES) {response.destroy();reject(new Error('PUBLIC_SOURCE_UNREADABLE'));return;}
      const contentType=String(response.headers['content-type']||'');
      if(!/^(?:text\/html|application\/xhtml\+xml|text\/plain)\b/i.test(contentType)){response.destroy();reject(new Error('PUBLIC_SOURCE_TYPE'));return;}
      const chunks=[];let bytes=0;
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_BYTES){response.destroy(new Error('PUBLIC_SOURCE_TOO_LARGE'));return;}chunks.push(chunk);});
      response.on('error',reject);
      response.on('end',()=>{try{
        let body=Buffer.concat(chunks), encoding=String(response.headers['content-encoding']||'identity').toLowerCase();
        if(encoding==='gzip')body=gunzipSync(body,{maxOutputLength:MAX_BYTES});
        else if(encoding==='deflate')body=inflateSync(body,{maxOutputLength:MAX_BYTES});
        else if(encoding==='br')body=brotliDecompressSync(body,{maxOutputLength:MAX_BYTES});
        else if(encoding!=='identity')throw new Error('PUBLIC_SOURCE_ENCODING');
        resolve({body:body.toString('utf8'),contentType});
      }catch(error){reject(error);}});
    });
    request.on('error',reject); request.end();
  });
}
// Retrieval order is not evidence quality. Prefer public institutions when they
// occur in returned results, but their text remains untrusted and quote-checked.
// This is a priority hint, not a claim that every page on these domains is true.
const publicInstitutions=['gov','gov.cn','gov.uk','gov.au','gc.ca','europa.eu','un.org','who.int'];
function sourcePriority(value){try{const host=new URL(value).hostname.toLowerCase();return publicInstitutions.some(domain=>host===domain||host.endsWith('.'+domain))?0:1;}catch{return 2;}}
export async function readPublicSources(sources, {signal, resolve = lookup, requestPage: fetchPage = requestPage} = {}) {
  if (signal?.aborted) return [];
  const urls = [...new Set((sources || []).map(s=>s.url))].sort((a,b)=>sourcePriority(a)-sourcePriority(b)).slice(0,6);
  const deadline=Date.now()+5000;
  const readOne = async original => {
    const controller=new AbortController(), abort=()=>controller.abort();
    const timer=setTimeout(abort,Math.max(1,deadline-Date.now()));signal?.addEventListener('abort',abort,{once:true});
    try {
      let url=publicURL(original);
      for(let redirects=0;redirects<=2;redirects++) {
        if(signal?.aborted||controller.signal.aborted)return null;
        // DNS can otherwise hang independently of the request; race its deadline.
        const addresses=await Promise.race([resolve(url.hostname,{family:4,all:true}),new Promise((_,reject)=>{if(controller.signal.aborted)reject(new Error('ABORTED'));else controller.signal.addEventListener('abort',()=>reject(new Error('ABORTED')),{once:true});})]);
        if(!addresses.length||addresses.some(a=>!isPublicIPv4(a.address)))return null;
        if(signal?.aborted||controller.signal.aborted)return null;
        const response=await fetchPage(url,addresses[0].address,controller.signal);
        if(response.redirect){url=publicURL(new URL(response.redirect,url).href);continue;}
        if(signal?.aborted||controller.signal.aborted)return null;
        const text=/text\/plain/i.test(response.contentType)?String(response.body).slice(0,12000):pageText(response.body);
        return text.length>=20?{urls:[...new Set([original,url.href])],text,origin:'https_source_text'}:null;
      }
      return null;
    } catch { return null; }
    finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  };
  // A failed top search hit is not the end of the evidence search. Replace it
  // using returned URLs only, without extending the shared five-second budget.
  const results=[];let cursor=0;
  while(results.length<3&&cursor<urls.length&&!signal?.aborted&&Date.now()<deadline){
    const batch=urls.slice(cursor,cursor+3-results.length);cursor+=batch.length;
    const rows=await Promise.all(batch.map(readOne));
    results.push(...rows.filter(Boolean));
  }
  return results;
}
// Server-only tool registry; intentionally contains no local/private or write tool.
export const publicEvidenceRegistry = Object.freeze({ read_public_sources: Object.freeze({ execute: readPublicSources }) });

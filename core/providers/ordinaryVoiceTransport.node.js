import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
const hosts=new Set(['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com']);
const error=code=>Object.assign(new Error(code),{code});
// Only explicitly opted-in checked ordinary voice uses this dispatcher.
// The URL, TLS hostname validation, credentials, and request audit stay intact.
export function createVoiceLookup({resolve,clock=Date.now}={}){
 const resolver=resolve?null:new Resolver({timeout:1500,tries:1});
 const resolveRecords=resolve||((host)=>resolver.resolve4(host,{ttl:true}));
 const cached=new Map(),pending=new Map();
 async function addresses(host){
  if(!hosts.has(host))throw error('VOICE_TRANSPORT_HOST_DENIED');
  const entry=cached.get(host);if(entry&&clock()<entry.expires)return entry.addresses;
  if(pending.has(host))return pending.get(host);
  const request=Promise.resolve().then(()=>resolveRecords(host)).then(records=>{
   if(!records.length||records.some(r=>isIP(r.address)!==4||!Number.isFinite(r.ttl)||r.ttl<0))throw error('ENOTFOUND');
   const values=records.map(r=>({address:r.address,family:4}));
   cached.set(host,{addresses:values,expires:clock()+Math.min(60,...records.map(r=>r.ttl))*1000});return values;
  }).finally(()=>pending.delete(host));pending.set(host,request);return request;
 }
 return(host,options,callback)=>{if(typeof options==='function'){callback=options;options={};}addresses(host).then(values=>options?.all?callback(null,values):callback(null,values[0].address,4),callback);};
}
let agent;
export function getOrdinaryVoiceDispatcher(){return agent??=new Agent({connect:{lookup:createVoiceLookup()},maxOrigins:3});}

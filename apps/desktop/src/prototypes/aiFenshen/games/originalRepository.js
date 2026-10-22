export const POKER_DATABASE='ai-fenshen-poker-original-v1';
export const POKER_RUNTIME='mame0289-wing90-web1';
export const POKER_CONTENT_HASH='44c10dd7cd97c8926248ca432d862ac966a01eeb2fc77e2d019b3930e8cc8048';
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
function validateSnapshot(s){
 if(!s||s.runtime!==POKER_RUNTIME||s.contentHash!==POKER_CONTENT_HASH||!(s.state instanceof Uint8Array)||s.state.length<128||s.state.length>16*1024*1024||new TextDecoder().decode(s.state.subarray(0,8))!=='MAMESAVE')throw Error('原机存档版本或内容无效，原记录已保留。');
}
function validateRow(r,owner){
 if(r.ownerId!==owner||r.schemaVersion!==1||!Number.isSafeInteger(r.revision)||r.revision<0)throw Error('扑克记录版本无效，原记录已保留。');
 if(r.snapshot){validateSnapshot(r.snapshot);if(!/^[a-f0-9]{64}$/.test(r.snapshot.sha256))throw Error('扑克存档校验信息无效。');}
 return r;
}
export class OriginalPokerRepository{
 constructor(ownerId,{indexedDBImpl=globalThis.indexedDB}={}){if(typeof ownerId!=='string'||!ownerId)throw Error('请先登录。');this.ownerId=ownerId;this.indexedDB=indexedDBImpl;this.closed=false;this.pending=null;}
 async db(){
  if(this.closed)throw Error('扑克已关闭。');if(!this.indexedDB)throw Error('本机存储暂不可用，请重试。');
  if(!this.pending)this.pending=new Promise((resolve,reject)=>{
   const req=this.indexedDB.open(POKER_DATABASE,1);req.onupgradeneeded=()=>req.result.createObjectStore('snapshots',{keyPath:'ownerId'});
   req.onerror=req.onblocked=()=>{this.pending=null;reject(Error('无法打开本机扑克存储。'));};
   req.onsuccess=()=>{const db=req.result;if(this.closed){db.close();reject(Error('扑克已关闭。'));return;}db.onversionchange=()=>{db.close();this.pending=null;};resolve(db);};
  });return this.pending;
 }
 async transact(apply){
  const db=await this.db();if(this.closed)throw Error('扑克已关闭。');
  return new Promise((resolve,reject)=>{const tx=db.transaction('snapshots','readwrite'),store=tx.objectStore('snapshots');let result,error;
   tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(error||Error('牌局未能保存，请重试。'));
   const req=store.get(this.ownerId);req.onsuccess=()=>{try{if(this.closed)throw Error('扑克已关闭。');const old=validateRow(req.result||{ownerId:this.ownerId,schemaVersion:1,revision:0,snapshot:null},this.ownerId);result=apply(old);if(result!==req.result)store.put(result);}catch(e){error=e;tx.abort();}};
  });
 }
 async read(){const r=await this.transact(v=>v);if(r.snapshot&&await digest(r.snapshot.state)!==r.snapshot.sha256)throw Error('扑克存档校验失败，原记录已保留。');return r;}
 async save(snapshot,revision){
  if(this.closed)throw Error('扑克已关闭。');validateSnapshot(snapshot);const copy={...snapshot,state:new Uint8Array(snapshot.state)};copy.sha256=await digest(copy.state);
  return this.transact(r=>{if(r.revision!==revision)throw Object.assign(Error('扑克已在另一个页面更新，请重新进入。'),{code:'GAME_CONFLICT'});return {...r,revision:r.revision+1,snapshot:copy,savedAt:new Date().toISOString()};});
 }
 close(){this.closed=true;this.pending?.then(db=>db.close()).catch(()=>{});}
}

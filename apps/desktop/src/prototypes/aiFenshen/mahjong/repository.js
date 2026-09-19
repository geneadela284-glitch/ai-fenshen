export const MAHJONG_DATABASE='ai-fenshen-mahjong-original-v1';
export const MAHJONG_RUNTIME='mame0274-lhzb2a-web1';
const conflict=()=>Object.assign(Error('麻将已在另一个页面更新，请重新进入。'),{code:'GAME_CONFLICT'});
const checksum=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
function validateSnapshot(s){
  if(!s||s.runtime!==MAHJONG_RUNTIME||!/^[a-f0-9]{64}$/.test(s.contentHash)||!(s.state instanceof Uint8Array)||s.state.length<128||s.state.length>16*1024*1024)throw Error('原版牌局存档无效，已有记录保持不变。');
}
function validateRow(row,ownerId){
  if(row.ownerId!==ownerId||row.schemaVersion!==1||!Number.isSafeInteger(row.revision)||row.revision<0)throw Error('麻将记录版本无效，原记录已保留。');
  if(row.snapshot){validateSnapshot(row.snapshot);if(!/^[a-f0-9]{64}$/.test(row.snapshot.sha256))throw Error('麻将存档校验信息无效。');}
  return row;
}
export class MahjongRepository{
  constructor(ownerId,{indexedDBImpl=globalThis.indexedDB}={}){if(typeof ownerId!=='string'||!ownerId)throw Error('请先登录。');this.ownerId=ownerId;this.indexedDB=indexedDBImpl;this.closed=false;this.pending=null;}
  async db(){
    if(this.closed)throw Error('麻将已关闭。');
    if(!this.indexedDB)throw Error('本机存储暂不可用，请重试。');
    if(!this.pending)this.pending=new Promise((resolve,reject)=>{
      const req=this.indexedDB.open(MAHJONG_DATABASE,1);req.onupgradeneeded=()=>req.result.createObjectStore('snapshots',{keyPath:'ownerId'});
      req.onerror=req.onblocked=()=>{this.pending=null;reject(Error('无法打开本机麻将存储。'));};
      req.onsuccess=()=>{const db=req.result;if(this.closed){db.close();reject(Error('麻将已关闭。'));return;}db.onversionchange=()=>{db.close();this.pending=null;};resolve(db);};
    });return this.pending;
  }
  async transact(apply){
    const db=await this.db();if(this.closed)throw Error('麻将已关闭。');
    return new Promise((resolve,reject)=>{const tx=db.transaction('snapshots','readwrite'),store=tx.objectStore('snapshots');let result,error;
      tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(error||Error('麻将记录未能保存，请重试。'));
      const req=store.get(this.ownerId);req.onsuccess=()=>{try{
        if(this.closed)throw Error('麻将已关闭。');
        const old=req.result||{ownerId:this.ownerId,schemaVersion:1,revision:0,snapshot:null};validateRow(old,this.ownerId);
        result=apply(old);if(result!==req.result)store.put(result);
      }catch(e){error=e;tx.abort();}};
    });
  }
  async read(){const row=await this.transact(g=>g);if(row.snapshot&&await checksum(row.snapshot.state)!==row.snapshot.sha256)throw Error('麻将存档校验未通过，原记录已保留。');return row;}
  async save(snapshot,expectedRevision){
    if(this.closed)throw Error('麻将已关闭。');validateSnapshot(snapshot);
    const copy={...snapshot,state:new Uint8Array(snapshot.state)};copy.sha256=await checksum(copy.state);
    return this.transact(g=>{if(g.revision!==expectedRevision)throw conflict();return {...g,revision:g.revision+1,snapshot:copy,savedAt:new Date().toISOString()};});
  }
  delete(expectedRevision){return this.transact(g=>{if(g.revision!==expectedRevision)throw conflict();return {...g,revision:g.revision+1,snapshot:null,savedAt:new Date().toISOString()};});}
  close(){this.closed=true;this.pending?.then(db=>db.close()).catch(()=>{});}
}

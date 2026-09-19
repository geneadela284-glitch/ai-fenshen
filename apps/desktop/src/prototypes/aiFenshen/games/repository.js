import { createGame, transition, validateGame } from '../../../../../../core/games/poker/engine.js';
export const GAME_DATABASE='ai-fenshen-games-v1';
const unavailable=()=>Error('本机游戏存储暂不可用，请重试。');
export class PokerRepository {
  constructor(ownerId,{indexedDBImpl=globalThis.indexedDB}={}) {
    if(typeof ownerId!=='string'||!ownerId)throw Error('请先登录。');
    this.ownerId=ownerId;this.indexedDB=indexedDBImpl;this.closed=false;this.dbPromise=null;
    this.listeners=new Set();
    this.channel=typeof window!=='undefined'&&typeof BroadcastChannel==='function'?new BroadcastChannel(GAME_DATABASE):null;
    if(this.channel)this.channel.onmessage=({data})=>{if(data?.ownerId===this.ownerId&&!this.closed)this.listeners.forEach(fn=>fn());};
  }
  async db() {
    if(this.closed)throw Error('游戏已关闭。');
    if(!this.indexedDB)throw unavailable();
    if(!this.dbPromise)this.dbPromise=new Promise((resolve,reject)=>{
      const r=this.indexedDB.open(GAME_DATABASE,1);
      r.onupgradeneeded=()=>r.result.createObjectStore('games',{keyPath:'ownerId'});
      r.onerror=r.onblocked=()=>{this.dbPromise=null;reject(unavailable());};
      r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>{db.close();this.dbPromise=null;};if(this.closed){db.close();reject(Error('游戏已关闭。'));}else resolve(db);};
    });
    return this.dbPromise;
  }
  async transaction(apply) {
    const db=await this.db();if(this.closed)throw Error('游戏已关闭。');
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('games','readwrite'),store=tx.objectStore('games');let value,failure;
      tx.oncomplete=()=>resolve(value);
      tx.onabort=tx.onerror=()=>reject(failure||Error('本次操作未保存，请重试。'));
      const r=store.get(this.ownerId);
      r.onsuccess=()=>{try{if(this.closed)throw Error('游戏已关闭。');const row=r.result;
        if(row?.deleted&&(!Number.isSafeInteger(row.revision)||row.revision<0))throw Error('游戏记录版本无效。');
        const g=row&&!row.deleted?validateGame(row,this.ownerId):createGame(this.ownerId,row?.revision||0);
        const next=apply(g);value=next;
        if(next!==row)store.put(next);
      }catch(error){failure=error;tx.abort();}};
    });
  }
  read(){return this.transaction(g=>g);}
  async command(command,expectedRevision) {
    const result=await this.transaction(g=>{if(g.revision!==expectedRevision)throw Object.assign(Error('游戏已在另一个页面更新，请按最新状态继续。'),{code:'GAME_CONFLICT'});return transition(g,command);});
    this.channel?.postMessage({ownerId:this.ownerId,revision:result.revision});return result;
  }
  async export(){const g=await this.read();return {...g,exportedAt:new Date().toISOString(),scope:'本机免费娱乐积分，无现金价值'};}
  async delete(expectedRevision) {
    const row=await this.transaction(g=>{if(g.revision!==expectedRevision)throw Object.assign(Error('游戏已在另一个页面更新，请按最新状态继续。'),{code:'GAME_CONFLICT'});return {ownerId:this.ownerId,deleted:true,revision:g.revision+1};});
    this.channel?.postMessage({ownerId:this.ownerId,revision:row.revision});
  }
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  close(){this.closed=true;this.listeners.clear();this.channel?.close();this.dbPromise?.then(db=>db.close()).catch(()=>{});}
}

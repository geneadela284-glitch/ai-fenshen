import { LIMITS, DOCUMENT_SCHEMA, documentError, sha256 } from '../../../../core/documentQa/contract.js';
export const DOCUMENT_DATABASE='ai-fenshen-document-qa-v1';
const encoder=new TextEncoder();const decoder=new TextDecoder();
const result=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error||documentError('DOCUMENT_STORAGE_FAILED'));});
export class DocumentRepository {
  constructor({ownerId,indexedDBImpl=globalThis.indexedDB,cryptoImpl=globalThis.crypto,maxSavedBytes=LIMITS.savedBytes}={}) {
    if(!ownerId) throw documentError('DOCUMENT_OWNER_REQUIRED');
    this.ownerId=String(ownerId);this.indexedDB=indexedDBImpl;this.crypto=cryptoImpl;this.maxSavedBytes=maxSavedBytes;this.dbPromise=null;this.closed=false;
  }
  async db() {
    if(this.closed) throw documentError('DOCUMENT_STORAGE_CLOSED');
    if(!this.indexedDB || !this.crypto?.subtle) throw documentError('DOCUMENT_STORAGE_UNAVAILABLE');
    if(!this.dbPromise) this.dbPromise=new Promise((resolve,reject)=>{
      const r=this.indexedDB.open(DOCUMENT_DATABASE,1);
      r.onupgradeneeded=()=>{const db=r.result;db.createObjectStore('keys',{keyPath:'ownerId'});db.createObjectStore('documents',{keyPath:'documentId'}).createIndex('owner','ownerId');};
      r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();if(this.closed) {db.close();reject(documentError('DOCUMENT_STORAGE_CLOSED'));}else resolve(db);};
      r.onerror=()=>reject(documentError('DOCUMENT_STORAGE_UNAVAILABLE'));r.onblocked=()=>reject(documentError('DOCUMENT_STORAGE_BUSY'));
    });
    return this.dbPromise;
  }
  async key(create=false) {
    const db=await this.db();const tx=db.transaction('keys');const existing=await result(tx.objectStore('keys').get(this.ownerId));
    if(existing) return existing.key;if(!create) throw documentError('DOCUMENT_KEY_MISSING');
    const candidate=await this.crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const write=db.transaction('keys','readwrite');const done=complete(write);const store=write.objectStore('keys');const r=store.get(this.ownerId);let selected;
    r.onsuccess=()=>{selected=r.result?.key||candidate;if(!r.result) store.add({ownerId:this.ownerId,purpose:DOCUMENT_SCHEMA,key:selected});};await done;return selected;
  }
  aad(id,kind) {return encoder.encode(`${DOCUMENT_SCHEMA}\0${this.ownerId}\0${id}\0${kind}`);}
  async encrypt(bytes,key,id,kind) { const iv=this.crypto.getRandomValues(new Uint8Array(12));return {iv,cipher:await this.crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad(id,kind)},key,bytes)}; }
  async decrypt(cipher,iv,key,id,kind) {try{return await this.crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:this.aad(id,kind)},key,cipher);}catch{throw documentError('DOCUMENT_INTEGRITY_FAILED');}}
  async save(document) {
    if(document.record.ownerId!==this.ownerId) throw documentError('DOCUMENT_OWNER_MISMATCH');
    if(!(document.bytes instanceof Uint8Array) || document.bytes.length!==document.record.byteSize || await sha256(document.bytes)!==document.record.checksum) throw documentError('DOCUMENT_INTEGRITY_FAILED');
    const id=document.record.documentId;const key=await this.key(true);const record={...document.record,state:'saved',storageRef:id};
    const raw=await this.encrypt(document.bytes,key,id,'raw');const index=await this.encrypt(encoder.encode(JSON.stringify({record,blocks:document.blocks})),key,id,'index');
    const row={documentId:id,ownerId:this.ownerId,totalBytes:raw.cipher.byteLength+index.cipher.byteLength,rawCipher:raw.cipher,rawIv:raw.iv,indexCipher:index.cipher,indexIv:index.iv};
    const db=await this.db();const tx=db.transaction('documents','readwrite');const done=complete(tx);const store=tx.objectStore('documents');let error;
    const read=store.getAll();
    read.onsuccess=()=>{
      const existing=read.result.find(r=>r.documentId===id);if(existing && existing.ownerId!==this.ownerId){error=documentError('DOCUMENT_OWNER_MISMATCH');tx.abort();return;}
      const used=read.result.filter(r=>r.ownerId===this.ownerId&&r.documentId!==id).reduce((sum,r)=>sum+r.totalBytes,0);
      if(used+row.totalBytes>this.maxSavedBytes){error=documentError('DOCUMENT_QUOTA_EXCEEDED');tx.abort();return;}
      store.put(row);
    };
    try{await done;}catch(caught){throw error||documentError(caught?.name==='QuotaExceededError'?'DOCUMENT_QUOTA_EXCEEDED':'DOCUMENT_STORAGE_FAILED');}
    return {...document,record};
  }
  async list(search='') {
    const db=await this.db();const rows=await result(db.transaction('documents').objectStore('documents').index('owner').getAll(this.ownerId));
    if(!rows.length)return[];const key=await this.key();const items=[];
    for(const row of rows){const {record}=JSON.parse(decoder.decode(await this.decrypt(row.indexCipher,row.indexIv,key,row.documentId,'index')));if(record.ownerId!==this.ownerId)throw documentError('DOCUMENT_OWNER_MISMATCH');if(record.filename.toLocaleLowerCase().includes(String(search).toLocaleLowerCase()))items.push(record);}
    return items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async get(id) {
    const db=await this.db();const row=await result(db.transaction('documents').objectStore('documents').get(id));
    if(!row || row.ownerId!==this.ownerId)return null;
    const key=await this.key();const index=JSON.parse(decoder.decode(await this.decrypt(row.indexCipher,row.indexIv,key,id,'index')));
    const bytes=new Uint8Array(await this.decrypt(row.rawCipher,row.rawIv,key,id,'raw'));
    if(index.record.ownerId!==this.ownerId || index.record.documentId!==id || await sha256(bytes)!==index.record.checksum)throw documentError('DOCUMENT_INTEGRITY_FAILED');
    return {...index,bytes};
  }
  async delete(id) {
    const db=await this.db();const tx=db.transaction('documents','readwrite');const done=complete(tx);const store=tx.objectStore('documents');let missing=false;const read=store.get(id);
    read.onsuccess=()=>{if(read.result?.ownerId!==this.ownerId){missing=true;tx.abort();}else store.delete(id);};
    try{await done;}catch{throw documentError(missing?'DOCUMENT_NOT_FOUND':'DOCUMENT_DELETE_FAILED');}
    if(typeof BroadcastChannel==='function'){const channel=new BroadcastChannel(DOCUMENT_DATABASE);channel.postMessage({type:'deleted',ownerId:this.ownerId,documentId:id});channel.close();}
    return true;
  }
  close(){this.closed=true;this.dbPromise?.then(db=>db.close()).catch(()=>{});}
}

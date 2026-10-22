import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAttachmentRuntime} from './runtime.js';
import {handleAttachmentsApi} from './httpApi.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
test('daily exemption only applies to named owner, retains usage, validation and identity checks',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'upload-exempt-'));const db=new DatabaseSync(':memory:');
 const r=createAttachmentRuntime({database:db,storageRoot:root,accessControl:{assertAuthenticatedSubject:subject=>subject},limits:{dailyUploadBytes:png.length},dailyUploadExemptAccountIds:['owner-a']});
 const upload=(owner,id,extra={})=>r.service.upload({userId:owner,subject:{accountId:owner},clientRequestId:id,files:[{name:'test.png',type:'image/png',buffer:png}],...extra});
 try{
  upload('owner-a','a1');
  assert.doesNotThrow(()=>r.service.preflight('owner-a','a2',png.length+200));
  upload('owner-a','a2');
  assert.equal(r.repository.currentDailyBytes('owner-a',r.service.dayKey()),png.length*2);
  upload('owner-b','b1');
  assert.throws(()=>r.service.preflight('owner-b','b2',png.length+200),{code:'DAILY_UPLOAD_LIMIT_EXCEEDED'});
  assert.throws(()=>upload('owner-b','b2'),{code:'DAILY_UPLOAD_LIMIT_EXCEEDED'});
  assert.throws(()=>upload('owner-a','spoof',{subject:{accountId:'owner-b'}}),{code:'ATTACHMENT_FORBIDDEN'});
  assert.throws(()=>upload('owner-a','many',{files:Array(4).fill({name:'t.png',type:'image/png',buffer:png})}),{code:'TOO_MANY_ATTACHMENTS'});
  assert.throws(()=>upload('owner-a','large',{files:[{name:'t.png',type:'image/png',buffer:Buffer.alloc(8*1024*1024+1)}]}),{code:'FILE_TOO_LARGE'});
 }finally{r.close();db.close();rmSync(root,{recursive:true,force:true});}
});

test('capability reports the authenticated owner daily exemption without changing file limits',async()=>{
 for(const [owner,expected] of [['owner-a',null],['owner-b',33554432]]){
  let reply;await handleAttachmentsApi({req:{method:'GET'},res:{},url:new URL('http://local/api/attachments/capabilities'),user:{id:owner},subject:{accountId:owner},enabled:true,runtime:{limits:{dailyUploadBytes:33554432,maxFileBytes:8388608,maxAttachmentsPerMessage:3},service:{dailyUploadLimit:id=>id==='owner-a'?Infinity:33554432}},sendJson:(_,status,payload)=>{assert.equal(status,200);reply=payload;}});
  assert.equal(reply.limits.dailyUploadBytes,expected);assert.equal(reply.limits.maxFileBytes,8388608);assert.equal(reply.limits.maxAttachmentsPerMessage,3);
 }
});

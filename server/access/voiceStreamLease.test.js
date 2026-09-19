import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccessControlService } from './accessControlService.js';
import { AccessControlStore } from './accessControlStore.js';

function fixture(t) {
 const directory=mkdtempSync(path.join(tmpdir(),'voice-lease-'));
 let now=Date.parse('2026-09-13T23:59:00Z');const clock=()=>new Date(now);
 const store=new AccessControlStore({dbPath:path.join(directory,'access.sqlite'),clock}).initialize();
 const access=new AccessControlService({store,clock,hmacSecret:'synthetic-voice-lease-test-secret'});
 access.bindAccountProfile({accountId:'a',profileId:'closed_beta_user_v1'});
 const subject=access.createAuthenticatedSubject({accountId:'a'});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const args={subject,voiceSessionId:'v1',generation:1};
 return {access,store,subject,args,advance:ms=>now+=ms,now:()=>now,
  begin:()=>access.beginVoiceStreamRequest({...args,requestId:'asr-1'}),
  renew:(requestLease,extra={})=>access.renewVoiceStreamRequest({...args,requestLease,...extra})};
}
test('renewal preserves a real concurrent slot beyond 120 seconds without new requests or usage',t=>{
 const h=fixture(t);let lease=h.begin();const original=lease;
 const other=h.access.beginRequest({subject:h.subject,requestId:'other'});
 const before=h.store.database.prepare('SELECT * FROM request_leases WHERE request_id=?').get('asr-1');
 for(let i=0;i<66;i++){h.advance(10000);lease=h.renew(lease);assert.equal(Date.parse(lease.leaseExpiresAt)-h.now(),120000);}
 assert.notEqual(lease,original);assert.ok(Object.isFrozen(lease));
 assert.equal(h.store.database.prepare('SELECT COUNT(*) n FROM request_leases').get().n,2);
 assert.equal(h.store.database.prepare('SELECT COUNT(*) n FROM provider_attempts').get().n,0);
 assert.equal(h.store.database.prepare('SELECT COUNT(*) n FROM usage_buckets').get().n,0);
 const after=h.store.database.prepare('SELECT * FROM request_leases WHERE request_id=?').get('asr-1');
 assert.equal(after.started_at,before.started_at);assert.equal(after.minute_bucket,before.minute_bucket);
 const another=h.access.beginRequest({subject:h.subject,requestId:'another'});
 assert.throws(()=>h.access.beginRequest({subject:h.subject,requestId:'over'}),{code:'ACCOUNT_CONCURRENCY_LIMITED'});
 h.access.releaseRequest(original);assert.throws(()=>h.renew(lease),{code:'REQUEST_LEASE_INVALID'});
 h.access.releaseRequest(other);h.access.releaseRequest(another);
});
test('completed voice lease cannot be resurrected by renewal or repeated begin',t=>{
 const h=fixture(t),lease=h.begin();h.access.releaseRequest(lease);
 assert.throws(()=>h.renew(lease),{code:'REQUEST_LEASE_INVALID'});
 assert.throws(()=>h.begin(),{code:'REQUEST_LEASE_INVALID'});
});
test('voice renewal rejects forged, nonvoice, owner, generation and session mismatches',t=>{
 const h=fixture(t),lease=h.begin();
 const b=h.access.createAuthenticatedSubject({accountId:'b'});
 for(const extra of [{subject:{accountId:'a'}},{subject:b},{generation:2},{voiceSessionId:'v2'},{requestLease:{...lease}}])assert.throws(()=>h.renew(lease,extra));
 const ordinary=h.access.beginRequest({subject:h.subject,requestId:'ordinary'});
 assert.throws(()=>h.renew(ordinary),{code:'REQUEST_LEASE_INVALID'});
 assert.throws(()=>h.access.beginVoiceStreamRequest({...h.args,requestId:'ordinary'}),{code:'REQUEST_LEASE_INVALID'});
 h.advance(10000);const fresh=h.renew(lease);
 assert.throws(()=>h.renew(lease),{code:'REQUEST_LEASE_INVALID'});
 assert.equal(h.renew(fresh).leaseExpiresAt,fresh.leaseExpiresAt);
});
test('expired and store-completed rows fail exact transactional renewal',t=>{
 const h=fixture(t),lease=h.begin();h.advance(120000);
 assert.throws(()=>h.renew(lease),{code:'REQUEST_LEASE_INVALID'});
 assert.equal(h.store.database.prepare('SELECT completed_at FROM request_leases').get().completed_at,null);
});
test('renewal does not re-admit or recharge an already reserved call with no remaining daily calls',t=>{
 const h=fixture(t);let lease=h.begin();
 h.store.database.prepare('UPDATE quota_profiles SET provider_calls_per_day=1 WHERE id=?').run('closed_beta_user_v1');
 const reservation=h.access.reserveProviderAttempt({subject:h.subject,requestLease:lease,attempt:{requestId:lease.requestId,executionId:'speech-1',attemptType:'planning',attemptNumber:1,providerId:'qwen',modelId:'synthetic'},request:{input:'synthetic',options:{maxTokens:512}}});
 const before=h.store.database.prepare('SELECT * FROM usage_buckets ORDER BY bucket_type').all();
 for(let i=0;i<66;i++){h.advance(10000);lease=h.renew(lease);}
 assert.deepEqual(h.store.database.prepare('SELECT * FROM usage_buckets ORDER BY bucket_type').all(),before);
 assert.equal(h.store.database.prepare('SELECT COUNT(*) n FROM provider_attempts').get().n,1);
 h.access.settleProviderAttempt({reservation,outcome:'success',usage:{inputTokens:10,outputTokens:0}});
 h.access.releaseRequest(lease);
 assert.equal(h.store.database.prepare('SELECT status FROM provider_attempts').get().status,'settled');
 assert.equal(h.store.database.prepare("SELECT COUNT(*) n FROM usage_buckets WHERE bucket_type='day'").get().n,1);
});
for(const change of ['account','profile','concurrency','completed','expiry'])test('renewal fails closed when '+change+' changes',t=>{
 const h=fixture(t),lease=h.begin();h.advance(10000);
 if(change==='account')h.access.setAccountEnabled({accountId:'a',enabled:false});
 if(change==='profile')h.store.database.prepare('UPDATE quota_profiles SET enabled=0 WHERE id=?').run('closed_beta_user_v1');
 if(change==='concurrency'){h.access.beginRequest({subject:h.subject,requestId:'second'});h.store.database.prepare('UPDATE quota_profiles SET max_concurrent_requests=1 WHERE id=?').run('closed_beta_user_v1');}
 if(change==='completed')h.store.releaseRequest({accountId:'a',requestId:lease.requestId});
 if(change==='expiry')h.store.database.prepare('UPDATE request_leases SET lease_expires_at=?').run('2026-09-14T01:00:00.000Z');
 assert.throws(()=>h.renew(lease));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccessControlStore } from '../access/accessControlStore.js';
import { AccessControlService } from '../access/accessControlService.js';
import { createConversationRuntime } from '../conversation/runtime.js';
import { createVoiceChatRuntime } from './runtime.js';
import { createAssistantSemanticPlanner } from '../agent/assistantSemanticPlanner.js';
import { createAssistantToolRegistry } from '../tools/assistantToolRegistry.js';
import { AIRouter } from '../../core/router/AIRouter.js';
import { draftPlan } from '../health/planner.js';
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
async function fixture(t,{validate,create=true,assistant,realPlanner=false}={}){
 let now=Date.parse('2026-09-13T23:59:00Z'),checks=0;
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const directory=mkdtempSync(path.join(tmpdir(),'voice-continuous-'));
 const store=new AccessControlStore({dbPath:path.join(directory,'access.sqlite'),clock:()=>new Date(now)}).initialize();
 const access=new AccessControlService({store,clock:()=>new Date(now),hmacSecret:'synthetic-voice-continuous-test-secret'});
 access.bindAccountProfile({accountId:'a',profileId:'closed_beta_user_v1'});const subject=access.createAuthenticatedSubject({accountId:'a'});
 const database=new DatabaseSync(':memory:'),streams=[],events=[],timings=[];
 const ai={settings:{load:()=>({})},router:{run(task,invocation){
  if(task.capability==='VOICE_CHAT_TTS')return (async()=>{for await(const text of task.text)if(!task.signal.aborted)task.onAudio(Buffer.alloc(480));return{};})();
  const reservation=access.reserveProviderAttempt({subject:invocation.subject,requestLease:invocation.requestLease,attempt:{requestId:invocation.requestLease.requestId,executionId:'asr-'+streams.length,attemptType:'planning',attemptNumber:1,providerId:'qwen',modelId:'synthetic'},request:{input:'synthetic',options:{maxTokens:512}}});
  return new Promise(resolve=>{
   const stream={task,invocation,received:[],finishCount:0,complete(){access.settleProviderAttempt({reservation,outcome:'success'});resolve({});}};
   stream.handle={append(bytes){stream.received.push(bytes[0]);return true;},finish(){stream.finishCount++;return true;}};
   task.signal.addEventListener('abort',()=>{access.settleProviderAttempt({reservation,outcome:'failed'});resolve({});},{once:true});
   streams.push(stream);task.onReady(stream.handle);
  });
 }},async stream(task,{onDelta}){await onDelta('可以。');return{ok:true,content:'可以。'};}};
 const base=createConversationRuntime({database,aiService:ai,applyMigrations:true});
 const runtime=createVoiceChatRuntime({enabled:true,clock:()=>now,coreOptions:{continuousLifecycle:true},conversationRuntime:base,aiService:ai,accessControl:access,onTiming:e=>timings.push(e),assistantOverride:realPlanner?undefined:assistant||{processUserMessage:()=>({handled:false})},...(realPlanner?{semanticPlanner:createAssistantSemanticPlanner({aiService:{run:(...args)=>ai.run(...args),repairSchema:(...args)=>ai.repairSchema(...args)}}),toolRegistry:createAssistantToolRegistry()}:{} )});
 const validateAuthorization=async()=>{checks++;return validate?validate(subject):subject;};
 const h={runtime,base,access,store,subject,streams,events,timings,ai,validateAuthorization,get checks(){return checks;},advance:async ms=>{now+=ms;t.mock.timers.tick(ms);await flush();},jump:ms=>now+=ms};
 t.after(async()=>{const closed=runtime.close();t.mock.timers.tick(10001);await flush();await closed;base.close();database.close();store.close();rmSync(directory,{recursive:true,force:true});});
 if(create){h.session=await runtime.create({user:{id:'a'},subject,validateAuthorization});h.detach=runtime.subscribe(h.session.id,'a',e=>events.push(e),()=>{});await flush();}
 return h;
}
test('authenticated continuous ASR stays on one reserved request for eleven minutes including midnight',async t=>{
 const h=await fixture(t);let sequence=0;
 for(let i=0;i<132;i++){
  h.runtime.control(h.session.id,'a',{type:'heartbeat'});h.streams[0].task.onSpeechStart();
  h.runtime.audio(h.session.id,'a',Buffer.alloc(3200,i%255),sequence++);
  if(i%6===0){h.streams[0].task.onTranscript('聊聊天气','item-'+i);await flush();}
  await h.advance(5000);
 }
 assert.equal(h.runtime.sessions.size,1);assert.equal(h.streams.length,1);assert.equal(h.streams[0].finishCount,0);
 assert.equal(h.streams[0].task.continuousLifecycle,true);assert.ok(h.checks>=66);
 assert.equal(h.store.database.prepare('SELECT COUNT(*) n FROM provider_attempts').get().n,1);
 const active=h.access.beginRequest({subject:h.subject,requestId:'other'});
 assert.throws(()=>h.access.beginRequest({subject:h.subject,requestId:'over'}),{code:'ACCOUNT_CONCURRENCY_LIMITED'});h.access.releaseRequest(active);
 assert.equal(h.events.some(e=>e.type==='ended'),false);
});
test('new mode rejects absent, untrusted and failing startup validators before creating conversations',async t=>{
 const h=await fixture(t,{create:false});
 for(const validateAuthorization of [undefined,async()=>({accountId:'a'}),async()=>{throw Error('revoked');}]){
  await assert.rejects(async()=>h.runtime.create({user:{id:'a'},subject:h.subject,validateAuthorization}));
  assert.equal(h.runtime.sessions.size,0);
 }
 assert.equal(h.streams.length,0);
});
test('revoke stops immediately when renewal rejects and ignores late ASR callbacks',async t=>{
 let revoked=false;const h=await fixture(t,{validate:subject=>{if(revoked)throw Object.assign(Error('revoked'),{code:'UNAUTHENTICATED'});return subject;}});
 revoked=true;await h.advance(10000);
 assert.equal(h.runtime.sessions.size,0);assert.equal(h.streams[0].task.signal.aborted,true);assert.equal(h.streams[0].finishCount,0);
 h.streams[0].task.onTranscript('不应保存','late');await flush();assert.equal(h.base.messages.listForConversationOwner(h.session.conversationId,'a').length,0);
});
test('event-loop jump past local permit blocks audio and pending text before timer renewal',async t=>{
 const h=await fixture(t);h.jump(20001);
 assert.throws(()=>h.runtime.audio(h.session.id,'a',Buffer.alloc(3200),0));
 assert.equal(h.runtime.sessions.size,0);assert.equal(h.streams[0].received.length,0);
 h.streams[0].task.onTranscript('迟到不能写入','late');await flush();assert.equal(h.base.messages.listForConversationOwner(h.session.conversationId,'a').length,0);
});
test('normal end closes client immediately but holds ASR lease until protocol finish; unsubscribe cannot cancel drain',async t=>{
 const h=await fixture(t);h.runtime.control(h.session.id,'a',{type:'end'});h.detach();
 assert.equal(h.runtime.sessions.size,0);assert.equal(h.streams[0].task.signal.aborted,false);assert.equal(h.streams[0].finishCount,1);
 assert.equal(h.store.database.prepare('SELECT completed_at FROM request_leases').get().completed_at,null);
 h.streams[0].task.onTranscript('退出后不保存','late');h.streams[0].complete();await flush();
 assert.notEqual(h.store.database.prepare('SELECT completed_at FROM request_leases').get().completed_at,null);
 assert.ok(h.timings.some(e=>e.stage==='asr_finished'));assert.equal(h.base.messages.listForConversationOwner(h.session.conversationId,'a').length,0);
});
test('graceful finish timeout is classified incomplete and releases lease',async t=>{
 const h=await fixture(t);h.runtime.control(h.session.id,'a',{type:'end'});await h.advance(10000);
 assert.equal(h.streams[0].task.signal.aborted,true);assert.ok(h.timings.some(e=>e.stage==='asr_finish_incomplete'));
 assert.notEqual(h.store.database.prepare('SELECT completed_at FROM request_leases').get().completed_at,null);
});
test('exit during pending startup validation never creates a session afterward',async t=>{
 const h=await fixture(t,{create:false});let release;
 const pending=h.runtime.create({user:{id:'a'},subject:h.subject,validateAuthorization:()=>new Promise(r=>release=r)});
 await flush();h.runtime.endForOwner('a');release(h.subject);await assert.rejects(async()=>pending);assert.equal(h.runtime.sessions.size,0);
});
test('pending renewal cannot resurrect closed stream or renew an unmuted newer generation',async t=>{
 let blocked=false,release;const h=await fixture(t,{validate:subject=>blocked?new Promise(r=>release=()=>r(subject)):subject});
 blocked=true;await h.advance(10000);assert.ok(release);
 h.runtime.control(h.session.id,'a',{type:'mute',muted:true});h.runtime.control(h.session.id,'a',{type:'mute',muted:false});
 blocked=false;release();await flush();assert.equal(h.streams.length,2);
 h.streams[0].task.onReady(h.streams[0].handle);h.streams[0].task.onTranscript('旧代数','old');
 h.runtime.audio(h.session.id,'a',Buffer.alloc(3200,9),0,2);assert.deepEqual(h.streams[0].received,[]);assert.deepEqual(h.streams[1].received,[9]);
 h.runtime.endForOwner('a');assert.equal(h.streams[1].task.signal.aborted,true);
});
test('revocation also immediately cancels a normally ending stream still draining',async t=>{
 const h=await fixture(t);h.runtime.control(h.session.id,'a',{type:'end'});
 h.runtime.endForOwner('a');assert.equal(h.streams[0].task.signal.aborted,true);await flush();
 assert.ok(h.timings.some(e=>e.stage==='asr_finish_incomplete'));
});
test('blocked renewal stops on the twenty-second permit even while heartbeats keep arriving',async t=>{
 let blocked=false,release;const h=await fixture(t,{validate:subject=>blocked?new Promise(r=>release=()=>r(subject)):subject});
 blocked=true;await h.advance(10000);const checks=h.checks;
 h.runtime.control(h.session.id,'a',{type:'heartbeat'});await h.advance(5000);assert.equal(h.checks,checks);
 h.runtime.control(h.session.id,'a',{type:'heartbeat'});await h.advance(5000);
 assert.equal(h.runtime.sessions.size,0);release();await flush();assert.equal(h.streams.length,1);
 assert.notEqual(h.store.database.prepare('SELECT completed_at FROM request_leases').get().completed_at,null);
});
test('local permit also blocks a stalled reply before it starts a text Provider',async t=>{
 let release;const h=await fixture(t,{assistant:{processUserMessage:()=>new Promise(r=>release=r)}});
 let textCalls=0;const voiceAi=h.base.service.aiService;
 // The same ai service is used by the voice-only proxy.
 voiceAi.stream=async()=>{textCalls++;return{ok:true,content:'不得调用'};};
 h.streams[0].task.onTranscript('聊聊天气','start');await flush();assert.ok(release);
 h.jump(20001);release({handled:false});await flush();
 assert.equal(textCalls,0);assert.equal(h.events.some(e=>e.type==='completed'),false);
});
test('permit expiry rejects handled answer persistence',async t=>{
 let release;const h=await fixture(t,{assistant:{processUserMessage:()=>new Promise(r=>release=r)}});
 h.streams[0].task.onTranscript('聊聊天气','start');await flush();h.jump(20001);release({handled:true,domain:'ordinary_chat',content:'不能保存成功'});await flush();
 assert.equal(h.base.messages.listForConversationOwner(h.session.conversationId,'a').some(m=>m.role==='assistant'&&m.status==='completed'),false);
 assert.equal(h.events.some(e=>e.type==='completed'),false);
});
test('confirmation rechecks permit at execution microtask and never performs expired write',async t=>{
 const h=await fixture(t);h.streams[0].task.onTranscript('安排事项','start');await flush();
 const s=h.runtime.sessions.get(h.session.id),turn=s.turn;let writes=0;
 const identity={ownerId:'a',conversationId:s.conversationId,turnId:turn.id};
 const proposed=await h.runtime.gate.inspect(identity,()=>h.runtime.gate.capture('test','save',[{}],()=>writes++));turn.proposal=proposed.proposal;
 const pending=h.runtime.confirm(s.id,'a',{turnId:turn.id,proposalId:turn.proposal.id});h.jump(20001);
 await assert.rejects(pending);assert.equal(writes,0);
});
test('ending event cannot reenter and accept another ASR item before logical cleanup',async t=>{
 const h=await fixture(t);const s=h.runtime.sessions.get(h.session.id);const listener=s.listener;
 s.listener=e=>{listener(e);if(e.type==='ended')h.streams[0].task.onTranscript('迟到识别','late-during-end');};
 h.runtime.control(h.session.id,'a',{type:'end'});assert.equal(s.seenItems.has('late-during-end'),false);
});
test('close settles even when initial stream revalidation never returns',async t=>{
 let checks=0,release;const h=await fixture(t,{validate:subject=>++checks===1?subject:new Promise(r=>release=()=>r(subject))});
 assert.equal(h.streams.length,0);let closed=false;
 const done=h.runtime.close().then(()=>closed=true);await flush();
 const settledBeforeAuthorization=closed;release();await done;assert.equal(settledBeforeAuthorization,true);
});
test('graceful drain cannot outlive the local permit while renewal is blocked',async t=>{
 let blocked=false,release;
 const h=await fixture(t,{validate:subject=>blocked?new Promise(r=>release=()=>r(subject)):subject});
 const s=h.runtime.sessions.get(h.session.id);
 blocked=true;await h.advance(10000);assert.ok(release);
 await h.advance(9000);h.runtime.control(h.session.id,'a',{type:'end'});
 assert.equal(s.validateAuthorization,null);assert.equal(h.streams[0].task.signal.aborted,false);
 await h.advance(999);assert.equal(h.streams[0].task.signal.aborted,false);
 await h.advance(1);assert.equal(h.streams[0].task.signal.aborted,true);
 assert.notEqual(h.store.database.prepare('SELECT completed_at FROM request_leases').get().completed_at,null);
 release();await flush();assert.equal(h.runtime.sessions.size,0);
 assert.equal(h.timings.some(e=>e.stage==='asr_finished'),false);
});
for(const outcome of ['reject','invalid subject'])test('in-flight '+outcome+' cancels a graceful drain without explicit owner revocation',async t=>{
 let blocked=false,revoke;
 const h=await fixture(t,{validate:subject=>blocked?new Promise((resolve,reject)=>{revoke=()=>outcome==='reject'?reject(Object.assign(Error('revoked'),{code:'UNAUTHENTICATED'})):resolve({accountId:'a'});}):subject});
 const s=h.runtime.sessions.get(h.session.id);
 blocked=true;await h.advance(10000);assert.ok(revoke);
 await h.advance(2000);h.runtime.control(h.session.id,'a',{type:'end'});
 assert.equal(s.validateAuthorization,null);assert.equal(h.streams[0].task.signal.aborted,false);
 await h.advance(1000);revoke();await flush();
 assert.equal(h.streams[0].task.signal.aborted,true);
 assert.notEqual(h.store.database.prepare('SELECT completed_at FROM request_leases').get().completed_at,null);
 assert.equal(h.timings.filter(e=>e.stage==='asr_finish_incomplete').length,1);
 assert.equal(h.timings.some(e=>e.stage==='asr_finished'),false);
});
for(const expires of [false,true])test('real semantic planner schema repair checks voice permit at guarded Provider entry: '+expires,async t=>{
 const h=await fixture(t,{realPlanner:true});let release;const entries=[],invocations=[];
 const plan={domain:'memory',intent:'state_fact',action:'add',entity:{type:'person',reference:'女儿',relation_to_owner:'daughter'},relation_to_owner:'daughter',predicate:'birth_date',value:{year:2012,month:6,day:8},qualifiers:{calendar_type:'unknown',recurrence:'one_time'},tool:null,arguments:{},required_evidence:[],explicit_fields:['entity.relation_to_owner','predicate','value.year','value.month','value.day'],inherited_fields:[],ambiguity_reasons:[],confidence:0.98,requires_confirmation:true,source_spans:null,source_message_id:null};
 const route={selectedProvider:'deepseek',selectedModel:'deepseek-v4-flash',routeTrace:[{success:true,attemptNumber:1}]};
 const invoke=(kind,invocation,operation)=>{invocations.push(invocation);return AIRouter.prototype.invokeGuardedOperation.call({accessControl:h.access},{candidate:{providerId:'deepseek',modelId:'deepseek-v4-flash'},invocation,attempt:{requestId:h.runtime.sessions.get(h.session.id)?.turn?.prepared?.requestId||'expired',executionId:'planner-multistage',attemptType:kind,attemptNumber:kind==='planning'?1:2,providerId:'deepseek',modelId:'deepseek-v4-flash'},request:{input:'synthetic',options:{maxTokens:512}},operation:()=>{entries.push(kind);return operation();}});};
 h.ai.run=(task,invocation)=>invoke('planning',invocation,()=>new Promise(r=>release=()=>r({ok:true,content:JSON.stringify({...plan,qualifiers:[plan.qualifiers]}),route})));
 h.ai.repairSchema=(task,invocation)=>invoke('schema_repair',invocation,async()=>({ok:true,content:JSON.stringify(plan),route}));
 h.streams[0].task.onTranscript('我女儿出生于2012年6月8日','multi-stage');await flush();assert.ok(release,'real planner must reach the first guarded Provider operation');
 const preparedInvocation=h.runtime.sessions.get(h.session.id).turn.prepared.invocation;
 if(expires)h.jump(20001);release();await flush();
 assert.deepEqual(entries,expires?['planning']:['planning','schema_repair']);
 assert.ok(invocations.every(value=>value===preparedInvocation),'planner run and schema repair preserve the original invocation object');
 assert.equal(h.store.database.prepare('SELECT COUNT(*) n FROM provider_attempts').get().n,expires?2:3);
});
for(const expires of [false,true])test('real health planner retains guarded voice invocation through AI admission: '+expires,async t=>{
 let release;const h=await fixture(t,{assistant:{processUserMessage:()=>new Promise(r=>release=()=>r({handled:false}))}});h.streams[0].task.onTranscript('聊聊天气','health-invocation');await flush();
 const invocation=h.runtime.sessions.get(h.session.id).turn.prepared.invocation;
 const requestId=invocation.requestLease.requestId;let entries=0,received;
 const profile={consentStorage:true,consentAI:true,adult:true,pregnant:false,medicalDiet:false,allergies:['花生'],dislikes:[],equipment:[],daysPerWeek:3,minutesPerSession:15,cookingMinutes:30,servings:1};
 const input={profile,profileRevision:1,startDate:'2026-09-14'};
 const template=await draftPlan({...input,mode:'rules'});
 const aiService={run(task,value){received=value;return AIRouter.prototype.invokeGuardedOperation.call({accessControl:h.access},{candidate:{providerId:'deepseek',modelId:'synthetic'},invocation:value,attempt:{requestId,executionId:'health-guard',attemptType:'planning',attemptNumber:1,providerId:'deepseek',modelId:'synthetic'},request:{input:'synthetic',options:{maxTokens:512}},operation:async()=>{entries++;return{ok:true,content:JSON.stringify(template)};}});}};
 if(expires)h.jump(20001);
 const result=await draftPlan({...input,mode:'ai',aiService,invocation}).catch(error=>error);release();await flush();
 if(expires)assert.equal(result.code,'VOICE_AUTHORIZATION_EXPIRED');else assert.equal(result.mode,'ai');
 assert.equal(received,invocation);assert.equal(entries,expires?0:1);
});

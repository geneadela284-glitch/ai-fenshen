import test from 'node:test';import assert from 'node:assert/strict';
import {createLearningHarness,request} from './testHarness.js';
import {AIRouter} from '../../core/router/AIRouter.js';
import {SpeechGateway} from './speech.js';
import {encodePcm16Wav} from '../../apps/desktop/src/prototypes/aiFenshen/dictationRecorder.js';
const audio=Buffer.from(encodePcm16Wav(Float32Array.from({length:16000},(_,i)=>.1*Math.sin(i/10))));
const ai={router:new AIRouter({speechRuntime:new SpeechGateway({transcribe:async()=>({transcript:'Hello'}),synthesize:async()=>audio})}),getStatus:()=>({available:true}),async run(){return {ok:true,content:JSON.stringify({replyEn:'Hi!',helpZh:'你好',feedback:[],goalReached:false})};},async stream(){return {ok:false};}};
test('authenticated learning survives resume, excludes ordinary chat and exports/deletes only its owner',async t=>{
 const h=await createLearningHarness({aiServiceOverride:ai});t.after(()=>h.close());const cookie=h.login.setCookie.split(';')[0];
 assert.equal((await request(h,'/api/learning')).status,401);
 const create=await request(h,'/api/learning/sessions',cookie,{method:'POST',body:{consentAI:true,persist:true,operationId:'op',lessonId:'hello'}});assert.equal(create.status,201,JSON.stringify(create.body));const id=create.body.session.id;
 const other=await h.accountSession('another_learning');assert.equal((await request(h,`/api/learning/sessions/${id}`,other.login.setCookie.split(';')[0])).status,404);
 const list=await request(h,'/api/ai/conversations',cookie);assert.equal(list.body.conversations.length,0);
 assert.equal((await request(h,`/api/ai/conversations/${create.body.session.conversationId}/messages`,cookie)).status,404);
 assert.throws(()=>h.instance.conversationRuntime.service.prepare({ownerId:h.account.id,conversationId:create.body.session.conversationId,message:'请记住我住伦敦',clientRequestId:'bypass'}),{code:'CONVERSATION_NOT_FOUND'});
 const turn=await request(h,`/api/learning/sessions/${id}/turn`,cookie,{method:'POST',body:{revision:1,clientTurnId:'first',transcript:'Hello',inputMode:'voice'}});assert.equal(turn.status,200,JSON.stringify(turn.body));assert.equal(turn.body.turns[0].inputMode,'text');
 const exported=h.instance.privacyLifecycle.buildExport(h.account.id);assert.equal(exported.learning.sessions.length,1);assert.equal(exported.conversations.length,0);
 const drop=await request(h,`/api/learning/sessions/${id}`,cookie,{method:'DELETE',body:{revision:2}});assert.equal(drop.status,200);assert.equal((await request(h,`/api/learning/sessions/${id}`,cookie)).status,404);
});
test('unsaved practice is separate from durable records; shutdown clears it; voice evidence cannot be forged',async t=>{
 const h=await createLearningHarness({aiServiceOverride:ai});t.after(()=>h.close());const cookie=h.login.setCookie.split(';')[0];
 const c=await request(h,'/api/learning/sessions',cookie,{method:'POST',body:{consentAI:true,persist:false,operationId:'temporary',lessonId:'hello'}});const id=c.body.session.id;assert.ok(id,JSON.stringify(c));
 assert.equal(h.instance.learningRuntime.repository.list(h.account.id).length,0);
 const speech=await fetch(h.baseUrl+`/api/learning/sessions/${id}/transcribe`,{method:'POST',headers:{cookie,'content-type':'audio/wav'},body:audio});const words=await speech.json();assert.equal(speech.status,200,JSON.stringify(words));
 const result=await request(h,`/api/learning/sessions/${id}/turn`,cookie,{method:'POST',body:{revision:1,clientTurnId:'voice1',transcript:words.transcript,voiceToken:words.voiceToken}});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.turns[0].inputMode,'voice');
 h.instance.learningRuntime.service.deleteAllForOwner(h.account.id);assert.equal((await request(h,`/api/learning/sessions/${id}`,cookie)).status,404);
});
test('a changed cookie cannot bind an old learning screen to the new account',async t=>{
 const h=await createLearningHarness();t.after(()=>h.close());const b=await h.accountSession('learning_context_b');
 const result=await fetch(h.baseUrl+'/api/learning',{headers:{cookie:b.login.setCookie,'X-AI-Expected-Account-Context':h.account.id}});
 assert.equal(result.status,403);assert.equal((await result.json()).code,'ACCOUNT_CONTEXT_MISMATCH');
});
test('one automatic spoken turn holds one request lease for recognition, teaching and speech; retries do not add turns',async t=>{
 const observed=[];const flowAi={...ai,router:new AIRouter({speechRuntime:new SpeechGateway({transcribe:async(_bytes,{invocation})=>{observed.push(invocation.requestLease);return{transcript:'A small coffee, please.'};},synthesize:async(_text,{invocation})=>{observed.push(invocation.requestLease);return audio;}})}),async run(_task,invocation){observed.push(invocation.requestLease);return{ok:true,content:JSON.stringify({replyEn:'Here you are.',helpZh:'给你。',feedback:[],goalReached:true})};}};
 const h=await createLearningHarness({aiServiceOverride:flowAi});t.after(()=>h.close());const cookie=h.login.setCookie.split(';')[0];
 const c=await request(h,'/api/learning/sessions',cookie,{method:'POST',body:{consentAI:true,persist:true,operationId:'automatic',lessonId:'coffee'}});const id=c.body.session.id;
 const control=h.instance.accessControl;assert.ok(control);let begins=0;const original=control.beginRequest.bind(control);control.beginRequest=(...args)=>{begins++;return original(...args);};
 const url=h.baseUrl+`/api/learning/sessions/${id}/voice-turn?revision=1&clientTurnId=auto-one`;
 let response=await fetch(url,{method:'POST',headers:{cookie,'content-type':'audio/wav'},body:audio});let body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(begins,1);assert.equal(body.result.session.turnCount,1);assert.equal(body.result.session.goalReached,true);assert.ok(Buffer.from(body.audioBase64,'base64').length>44);assert.equal(observed.length,4);assert.ok(observed[0]);assert.ok(observed.every(lease=>lease===observed[0]));
 response=await fetch(url,{method:'POST',headers:{cookie,'content-type':'audio/wav'},body:audio});body=await response.json();assert.equal(response.status,200);assert.equal(body.result.session.turnCount,1);
 const changed=Buffer.from(audio);changed[100]^=4;response=await fetch(url,{method:'POST',headers:{cookie,'content-type':'audio/wav'},body:changed});assert.equal(response.status,409);
});

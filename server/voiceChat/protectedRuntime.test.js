import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProtectedMemoryRuntime } from '../memory/protectedMemoryRuntime.js';
import { createConversationRuntime } from '../conversation/runtime.js';
import { createVoiceChatRuntime } from './runtime.js';
import { createAssistantToolRegistry } from '../tools/assistantToolRegistry.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { createTasksRuntime } from '../tasks/runtime.js';
import { createDiaryRuntime } from '../diary/runtime.js';
import { createHealthRuntime } from '../health/runtime.js';

test('real protected memory integration permits consecutive voice replies without premature pause',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'voice-protected-synthetic-'));
 const databasePath=path.join(root,'acceptance','memory.sqlite');mkdirSync(path.dirname(databasePath));
 const scope='voice-pause-synthetic',actionId='MAIN-VOICE-PAUSE-REPAIR';
 const memory=createProtectedMemoryRuntime({databasePath,scope,actionId,authorization:{
  scope,environment:scope,database_kind:'isolated_acceptance_memory',database_path:databasePath,
  owner_source:'authenticated_session',allowed_operations:['query'],
  original_memory_database:{path:path.join(root,'original','memory.sqlite'),access:'read_only'},
  cross_owner_access:'denied',migration_allowed:false,bulk_import_allowed:false,active_action_ids:[actionId]
 }});
 assert.ok(Object.isFrozen(memory));
 const finance=createFinanceRuntime({databasePath:path.join(root,'finance.sqlite'),applyMigrations:true});
 const tasks=createTasksRuntime({databasePath:path.join(root,'tasks.sqlite'),applyMigrations:true});
 const diary=createDiaryRuntime({database:tasks.database,tasksService:tasks.service,encryptionKey:Buffer.alloc(32,1),applyMigrations:true});
 const health=createHealthRuntime({database:tasks.database,tasksService:tasks.service,encryptionKey:Buffer.alloc(32,2),applyMigrations:true});
 let asr,streams=0,plans=0;const events=[];
 const ai={settings:{load:()=>({})},router:{async run(task){
  if(task.capability==='VOICE_CHAT_ASR'){asr=task;task.onReady({append(){},finish(){}});await new Promise(r=>task.signal.addEventListener('abort',r,{once:true}));return{};}
  assert.equal(task.capability,'VOICE_CHAT_TTS');for await(const text of task.text)if(!task.signal.aborted)task.onAudio(Buffer.alloc(480));return{};
 }},async stream(task,{onDelta}){streams++;await onDelta('你好，我在听。');return{ok:true,content:'你好，我在听。'};}};
 const base=createConversationRuntime({databasePath:path.join(root,'conversation.sqlite'),aiService:ai,applyMigrations:true,memoryPolicy:'protected_acceptance',memoryIntegration:memory});
 const runtime=createVoiceChatRuntime({enabled:true,conversationRuntime:base,aiService:ai,
  accessControl:{assertAuthenticatedSubject:s=>s,beginRequest:({requestId})=>({requestId}),releaseRequest(){}},
  protectedMemoryRuntime:memory,toolRegistry:createAssistantToolRegistry(),financeRuntime:finance,diaryRuntime:diary,healthRuntime:health,
  semanticPlanner:{async plan(){plans++;return{ok:true,plan:{
   domain:'ordinary_chat',intent:'ordinary_chat',action:'ordinary_chat',
   entity:{type:null,reference:null,relation_to_owner:null},relation_to_owner:null,
   predicate:null,value:null,qualifiers:{},tool:null,arguments:{},required_evidence:[],
   explicit_fields:[],inherited_fields:[],ambiguity_reasons:[],confidence:0.99,
   requires_confirmation:false,source_spans:[]
  }};}}
 });
 t.after(async()=>{await runtime.close();base.close();memory.close();diary.close();health.close();tasks.close();finance.close();});
 const session=runtime.create({user:{id:'synthetic-owner'},subject:{accountId:'synthetic-owner'}});
 runtime.subscribe(session.id,'synthetic-owner',event=>events.push(event),()=>{});
 for(let round=0;round<20;round++){
  asr.onTranscript(round?'继续聊聊。':'哈喽。','synthetic-'+round);
  for(let i=0;i<200&&!events.some(e=>e.type==='ended')&&events.filter(e=>e.type==='audio_end').length<=round;i++)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(events.filter(e=>['voice_error','ended'].includes(e.type)),[]);
  assert.equal(events.filter(e=>e.type==='audio_end').length,round+1);
 }
 assert.equal(plans,19,'greeting skips one planning call');assert.equal(streams,20);assert.equal(runtime.sessions.size,1);
 assert.equal(base.messages.listForConversationOwner(session.conversationId,'synthetic-owner').length,40);
 assert.equal(runtime.gate.pending.size,0);
});

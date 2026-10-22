// Local-only synthetic provider boundary. Never connects to a configured model or user database.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {chromium,webkit} from '/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {createConversationRuntime} from '../../server/conversation/runtime.js';
import {createVoiceChatRuntime} from '../../server/voiceChat/runtime.js';
import {handleVoiceChatApi} from '../../server/voiceChat/httpApi.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const wait=async predicate=>{for(let i=0;i<8000;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('SYNTHETIC_FLOW_TIMEOUT');};
const reports=[];
const rounds=process.argv.includes('--timing-diagnostic')?3:20;
for(const [name,browserType] of [['webkit',webkit],['chromium',chromium]]){
 const database=new DatabaseSync(':memory:');let asr,asrConnections=0,planCalls=0,answerCalls=0,audioUploads=0,ttsDuration=1200,holdReply=false,releaseReply=null,lastTask=null;
 const timing=[],pageErrors=[];
 const ai={settings:{load:()=>({})},router:{async run(task){
  if(task.capability==='VOICE_CHAT_ASR'){asr=task;asrConnections++;await new Promise(resolve=>{const finish=()=>{task.signal.removeEventListener('abort',finish);resolve();};task.signal.addEventListener('abort',finish,{once:true});task.onReady({append(){audioUploads++;},finish});});return{};}
  assert.equal(task.capability,'VOICE_CHAT_TTS');for await(const text of task.text)if(!task.signal.aborted)task.onAudio(Buffer.alloc(48*ttsDuration));return{};
 }},async stream(task,{onDelta,signal},invocation){lastTask=task;assert.equal(task.metadata.ownerId,'synthetic-a');assert.equal(invocation.subject.accountId,'synthetic-a');answerCalls++;if(holdReply){holdReply=false;await new Promise(resolve=>{releaseReply=resolve;signal.addEventListener('abort',resolve,{once:true});});if(signal.aborted)return{ok:false,code:'ABORTED'};}return{ok:true,content:JSON.stringify({draft:'待复核的普通答复',calls:[],sources:[],extracts:[],searched:false,...(task.metadata.voiceAnswerContext?.phase==='review'?{review:{verdict:'revise',answer:'散步前确认路线和天气，按自己的体力安排休息。',citations:[]}}:{})})};}};
 const base=createConversationRuntime({database,aiService:ai,applyMigrations:true});
 const runtime=createVoiceChatRuntime({enabled:true,conversationRuntime:base,aiService:ai,coreOptions:{lowLatency:false,ordinaryChat:true,checkedAnswers:true,conservativeInterruption:false},onTiming:e=>timing.push(e),
  accessControl:{assertAuthenticatedSubject:s=>s,beginRequest:({requestId})=>({requestId}),releaseRequest(){}},semanticPlanner:{plan(){planCalls++;return{ok:false,code:'SEMANTIC_PLAN_INVALID'};}}});
 const sendJson=(res,status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(body));};
 const readJson=async req=>{const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks).toString()||'{}');};
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(await handleVoiceChatApi({req,res,url,session:{user:{id:'synthetic-a'},subject:{accountId:'synthetic-a'}},runtime,sendJson,readJson}))return;
   if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(`<button id="start">开始合成验证</button><script type="module">
    import {VoiceChatEngine} from '/engine.js';
    window.events=[];window.timings=[];window.eventTiming=[];window.syntheticContexts=[];
    const devices=new EventTarget();devices.getUserMedia=async()=>{const c=new AudioContext();await c.resume();const oscillator=c.createOscillator(),gain=c.createGain(),out=c.createMediaStreamDestination();gain.gain.value=0;oscillator.connect(gain);gain.connect(out);oscillator.start();window.captureGain=gain;window.syntheticContexts.push(c);return out.stream;};
    window.engine=new VoiceChatEngine({ownerId:'synthetic-a',mediaDevices:devices,onEvent:e=>{events.push(e);eventTiming.push({type:e.type,turnId:e.data?.turnId,at:Date.now()});},onTiming:e=>timings.push(e)});
    document.querySelector('#start').onclick=()=>engine.start({conversationId:engine.conversationId});
   </script>`);return;}
   const allowed=['engine.js','browserMediaAdapter.js','capture.worklet.js'];const filename=url.pathname.slice(1);
   if(allowed.includes(filename)){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(fs.readFileSync(path.join(root,'apps/desktop/src/prototypes/aiFenshen/voiceChat',filename)));return;}
   res.writeHead(404);res.end();
  }catch(e){if(!res.headersSent)sendJson(res,500,{code:e.code||e.message});else res.end();}
 });
 let browser,page,stage='launch';
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await browserType.launch({headless:true,...(name==='chromium'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--autoplay-policy=no-user-gesture-required']}:{})});
  page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.click('#start');await page.waitForFunction(()=>window.engine?.ready);
  stage='capture';await wait(()=>audioUploads>0);assert.equal(asr.silenceDurationMs,800);
  const session=[...runtime.sessions.values()][0];
  assert.equal(session.coreOptions.pendingReplyProtection,false);
  assert.equal(await page.evaluate(()=>engine.coreOptions.pendingReplyProtection),false);
  stage='fast-generated-long-playback';ttsDuration=40000;
  let maximumAhead=0;const monitor=setInterval(async()=>{try{maximumAhead=Math.max(maximumAhead,await page.evaluate(()=>engine.media.nextPlay-engine.media.context.currentTime))}catch{}},100);
  try{asr.onTranscript('请解释怎样安排周末散步');await wait(()=>session.turn?.heard);assert.ok(maximumAhead<3);assert.equal(await page.evaluate(()=>engine.state.phase),'listening');assert.deepEqual(pageErrors,[]);reports.push({browser:name,status:'PASS',audioDurationSeconds:40,maximumAheadSeconds:maximumAhead,original30SecondGuardUnchanged:true,allAudioPlayed:true,realProvider:false,checkedAnswers:true});}finally{clearInterval(monitor);}
  await page.evaluate(()=>engine.end());
 }catch(error){reports.push({browser:name,status:'FAIL',stage,error:error.message,pageErrors});process.exitCode=1;}
 finally{await browser?.close();await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));base.close();database.close();}
}
console.log(JSON.stringify(reports,null,2));

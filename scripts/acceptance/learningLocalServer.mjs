import { createRemoteSyntheticModel } from './learningRemoteModel.mjs';
import { createLearningHarness } from '../../server/learning/testHarness.js';
import { createLocalSpeech } from '../../server/learning/localSpeech.js';
import { AIRouter } from '../../core/router/AIRouter.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const router=new AIRouter({speechRuntime:createLocalSpeech({python:'/private/tmp/ai-learning-speech-runtime-20260910/bin/python',model:'/private/tmp/ai-learning-speech-runtime-20260910/ggml-base.en.bin'})});
const teaching=process.env.LEARNING_REMOTE_MODEL_EVALUATION==='true'?createRemoteSyntheticModel():null;
const aiService={router,getStatus:()=>({available:!!teaching}),async run(...args){return teaching?teaching.run(...args):{ok:false,code:'LEARNING_TEACHER_UNAVAILABLE'};},async stream(){return {ok:false,code:'PROVIDER_UNAVAILABLE'};}};
const h=await createLearningHarness({publicDir:path.resolve('apps/desktop/dist'),aiServiceOverride:aiService});
writeFileSync('/private/tmp/ai-learning-evidence-20260910/local-session.json',JSON.stringify({url:h.baseUrl,username:h.username,password:h.password,cookie:h.login.setCookie,directory:h.directory,ownerId:h.account.id}),{mode:0o600});
const testSessions={};
for(const name of ['layout','automatic','manual','scenario']){const s=await h.accountSession(`learning_test_${name}`);testSessions[name]={url:h.baseUrl,cookie:s.login.setCookie,ownerId:s.account.id};}
writeFileSync('/private/tmp/ai-learning-evidence-20260910/local-test-sessions.json',JSON.stringify(testSessions),{mode:0o600});
console.log(JSON.stringify({url:h.baseUrl,mode:teaching?'synthetic-only evaluation: real remote teaching, local speech':'local real speech; foundation lessons; scenario teaching not configured'}));
process.on('SIGTERM',async()=>{await h.close();process.exit(0);});

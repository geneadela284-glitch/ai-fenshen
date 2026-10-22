// Historical oral evidence below is synthetic fixture data, not real learner proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from '/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {createLearningHarness} from '../../server/learning/testHarness.js';
const out='/private/tmp/ai-learning-evidence-20260910';
let sceneComplete=true;
const h=await createLearningHarness({publicDir:path.resolve('apps/desktop/dist'),aiServiceOverride:{getStatus:()=>({available:true}),async run(){return{ok:true,content:JSON.stringify({replyEn:'Certainly.',helpZh:'当然。',feedback:[],goalReached:sceneComplete})};}}});
const service=h.instance.learningRuntime.service,owner=h.account.id;
for(const [index,lessonId]of ['coffee','hotel','tickets'].entries()){
  sceneComplete=index<2;
  h.instance.learningRuntime.repository.now=()=>`2026-09-${['10','12','13'][index]}T10:00:00.000Z`;
  let v=service.start(owner,{lessonId,level:'beginner',consentAI:true,persist:true,operationId:'review-fixture-'+index});
  const token='synthetic-voice-'+index,text='Could you repeat that, please?';
  service.voiceEvidence.set(token,{owner,id:v.session.id,transcript:text,expires:Date.now()+100000,turnId:null});
  v=await service.turn(owner,v.session.id,{revision:v.session.revision,clientTurnId:'fixture-'+index,voiceToken:token,transcript:text});
  service.action(owner,v.session.id,{action:sceneComplete?'complete':'end',revision:v.session.revision});
}
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
  const context=await browser.newContext({viewport:{width:390,height:844}}),cookie=h.login.setCookie.split(';')[0],split=cookie.indexOf('=');
  await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:h.baseUrl}]);
  const page=await context.newPage();await page.goto(h.baseUrl,{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'展开AI分身大脑功能',exact:true}).click();await page.getByRole('button',{name:'打开学习入口',exact:true}).click();
  await page.locator('.al-expression-list summary').click();assert.match(await page.locator('.al-expression-list').innerText(),/已复习通过/);
  await page.getByRole('button',{name:'查看第 1 次口语依据',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.al-transcript-history')?.open===true);assert.match(await page.locator('.al-transcript-history').innerText(),/Could you repeat that, please/);
  await page.getByRole('button',{name:'删除本次练习',exact:true}).click();await page.getByRole('button',{name:'确认删除本次练习',exact:true}).click();
  await page.locator('.al-expression-list summary').click();assert.doesNotMatch(await page.locator('.al-expression-list').innerText(),/已复习通过/);assert.match(await page.locator('.al-expression-list').innerText(),/还在练习中/);
  await page.screenshot({path:out+'/chromium-review-source-deleted-220.png'});
  fs.writeFileSync(out+'/review-browser-report-220.json',JSON.stringify({status:'passed',checks:['cross-date-and-context-source-display','unfinished-scene-does-not-erase-correct-expression','open-original-utterance','delete-source-revokes-review-credit'],fixtures:'synthetic historical speech evidence and simulated teaching; not real learner validation'},null,2));console.log('REVIEW_SOURCE_UI_AND_DELETION_PASSED');
}finally{await browser.close();await h.close();}

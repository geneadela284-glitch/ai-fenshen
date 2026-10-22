import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from '/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const out='/private/tmp/ai-learning-evidence-20260910',info=JSON.parse(fs.readFileSync(out+'/local-test-sessions.json')).scenario;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${out}/automatic-coffee-padded.wav`]});
try{
  const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone']}),cookie=info.cookie.split(';')[0],split=cookie.indexOf('=');
  await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:info.url}]);
  const page=await context.newPage();page.setDefaultTimeout(45000);
  await page.addInitScript(()=>{window.testPlays=0;const original=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){return original.call(this).then(()=>{window.testPlays++;});};});
  await page.goto(info.url,{waitUntil:'networkidle'});await page.getByRole('button',{name:'展开AI分身大脑功能',exact:true}).click();await page.getByRole('button',{name:'打开学习入口',exact:true}).click();
  await page.locator('.al-courses button').filter({hasText:'街角咖啡店'}).click();await page.getByRole('checkbox',{name:'同意将本次练习文字和录音交给已配置的AI与语音服务处理'}).check();await page.getByRole('button',{name:'开始这一小步 →',exact:true}).click();
  const responses=[];page.on('response',async response=>{if(response.url().includes('/voice-turn?')){const body=await response.json();responses.push({status:response.status(),transcript:body.result?.turns?.at(-1)?.transcript,reply:body.result?.teacher?.replyEn,goalReached:body.result?.session?.goalReached,error:body.code});}});
  await page.getByRole('button',{name:'🎙 开始说',exact:true}).click();await page.waitForFunction(()=>/正在听 · [3-9] 秒/.test(document.querySelector('.al-speak').textContent));
  const started=Date.now();await page.getByRole('button',{name:'■ 说完了',exact:true}).click();await page.waitForFunction(()=>window.testPlays>=1);const elapsed=Date.now()-started;
  await page.getByText('回看刚才的对话（1 轮）',{exact:true}).waitFor();assert.equal(await page.locator('.al-error').count(),0);
  await page.screenshot({path:out+'/chromium-automatic-real-coffee.png'});
  await page.getByRole('button',{name:'完成这次练习 ✓',exact:true}).click();await page.getByRole('heading',{name:'又迈出了一小步'}).waitFor();assert.match(await page.locator('.al-stats').innerText(),/1\s*独立口语尝试/);
  assert.equal(responses.length,1);assert.equal(responses[0].status,200);assert.match(responses[0].transcript,/small coffee/i);assert.equal(responses[0].goalReached,true);
  await page.getByRole('button',{name:'删除本次练习',exact:true}).click();await page.getByRole('button',{name:'确认删除本次练习',exact:true}).click();await page.getByRole('heading',{name:'选一个想去的情境'}).waitFor();
  fs.writeFileSync(out+'/automatic-scenario-browser-report.json',JSON.stringify({status:'passed',source:'synthetic microphone, real local ASR/TTS and user-authorized remote teaching, one spoken-turn request',elapsedMs:elapsed,responses,realHumanOrPhone:false},null,2));console.log(JSON.stringify({status:'passed',elapsedMs:elapsed,responses}));
}finally{await browser.close();}

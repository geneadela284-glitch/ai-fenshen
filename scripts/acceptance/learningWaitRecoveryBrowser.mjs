import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from '/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const out='/private/tmp/ai-learning-evidence-20260910',info=JSON.parse(fs.readFileSync(out+'/local-test-sessions.json')).automatic;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${out}/automatic-hello-padded.wav`]});
let release;
try{
 const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone']});const cookie=info.cookie.split(';')[0],i=cookie.indexOf('=');
 await context.addCookies([{name:cookie.slice(0,i),value:cookie.slice(i+1),url:info.url}]);const page=await context.newPage();page.setDefaultTimeout(10000);
 await page.goto(info.url,{waitUntil:'networkidle'});await page.getByRole('button',{name:'展开AI分身大脑功能',exact:true}).click();await page.getByRole('button',{name:'打开学习入口',exact:true}).click();await page.getByRole('button',{name:'试着说声 Hello →',exact:true}).click();await page.getByRole('checkbox',{name:'同意将本次练习文字和录音交给已配置的AI与语音服务处理'}).check();await page.getByRole('button',{name:'开始这一小步 →',exact:true}).click();
 const intercepted=new Promise(resolve=>{release=resolve;});let captured=false;const pattern='**/api/learning/sessions/*/voice-turn?*';
 await page.route(pattern,async route=>{captured=true;await intercepted;await route.abort().catch(()=>{});});
 await page.getByRole('button',{name:'🎙 开始说',exact:true}).click();await page.waitForFunction(()=>/正在听 · [3-9] 秒/.test(document.querySelector('.al-speak').textContent));await page.clock.install();await page.getByRole('button',{name:'■ 说完了',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.al-status'));assert.equal(captured,true);await page.clock.fastForward(10050);
 await page.getByText('等待较久，你可以取消后重试。',{exact:true}).waitFor({timeout:2000});
 await page.clock.fastForward(20050);await page.locator('.al-status').waitFor({state:'hidden',timeout:2000});await page.locator('.al-error').filter({hasText:'等待已超过30秒，本次处理已停止。请重试，已录好的声音会保留。'}).waitFor({timeout:2000});
 await page.getByRole('button',{name:'重新处理这段录音',exact:true}).waitFor();assert.equal(await page.getByText('回看刚才的对话（1 轮）',{exact:true}).count(),0);
 release();await page.unroute(pattern);await page.clock.resume();await page.getByRole('button',{name:'重新处理这段录音',exact:true}).click();await page.getByText('回看刚才的对话（1 轮）',{exact:true}).waitFor({timeout:15000});
 await page.locator('.al-status').waitFor({state:'hidden'});assert.equal(await page.locator('.al-error').count(),0);await page.screenshot({path:out+'/wait-recovery.png'});
 await page.getByRole('button',{name:'删除本次练习',exact:true}).click();await page.getByRole('button',{name:'确认删除本次练习',exact:true}).click();
 fs.writeFileSync(out+'/wait-recovery-browser-report.json',JSON.stringify({status:'passed',synthetic:true,checks:['slow-notice-at-10s','stop-at-30s','recording-retained','no-fake-turn','same-recording-retry-succeeds']},null,2));console.log('WAIT_RECOVERY_PASSED');
}finally{release?.();await browser.close();}

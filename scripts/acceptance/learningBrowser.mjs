import assert from 'node:assert/strict';import fs from 'node:fs';
import {chromium,webkit} from '/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const root='/private/tmp/ai-learning-evidence-20260910',info=JSON.parse(fs.readFileSync(root+'/local-test-sessions.json')).layout;const reports=[];
for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true,...(name==='chromium'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 try{
 const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});const cookie=info.cookie.split(';')[0];await context.addCookies([{name:cookie.slice(0,cookie.indexOf('=')),value:cookie.slice(cookie.indexOf('=')+1),url:info.url}]);
 const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(info.url,{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'展开AI分身大脑功能',exact:true}).click();await page.getByRole('button',{name:'打开学习入口',exact:true}).click();await page.getByRole('heading',{name:'选一个想去的情境'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'打开对话入口',exact:true}).count(),0);
 await page.getByLabel('练习兴趣',{exact:true}).selectOption('旅行');assert.equal(await page.locator('.al-courses button').count(),4);await page.getByLabel('练习兴趣',{exact:true}).selectOption('全部');await page.getByLabel('建议练习时长',{exact:true}).selectOption('5');assert.ok(await page.locator('.al-courses button').count()>0);await page.getByLabel('建议练习时长',{exact:true}).selectOption('不限');
 for(const [width,height]of [[320,700],[390,844],[430,932],[768,1024],[1280,800]]){await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.querySelector('.al-scroll').scrollWidth<=document.querySelector('.al-scroll').clientWidth+1),'horizontal overflow');await page.screenshot({path:`${root}/${name}-home-${width}.png`});}
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'试着说声 Hello →',exact:true}).click();await page.getByRole('checkbox',{name:'同意将本次练习文字和录音交给已配置的AI与语音服务处理'}).check();await page.getByRole('button',{name:'开始这一小步 →',exact:true}).click();await page.getByRole('button',{name:'听目标表达',exact:true}).waitFor();await page.locator('.al-translation').waitFor();assert.equal(await page.getByRole('button',{name:'收起中文',exact:true}).getAttribute('aria-expanded'),'true');
 await page.screenshot({path:`${root}/${name}-hello.png`});
 await page.getByRole('button',{name:'现在不方便说，用文字练习',exact:true}).click();
 for(let i=0;i<3;i++){await page.getByRole('textbox',{name:'文字练习',exact:true}).fill('Hello');await page.getByRole('button',{name:'就这样说 →',exact:true}).click();await page.waitForFunction(i=>document.querySelector('.al-session-meta')?.textContent.includes(`${i+1} / 3`),i);}
 await page.getByRole('button',{name:'完成这次练习 ✓',exact:true}).click();await page.getByRole('heading',{name:'又迈出了一小步'}).waitFor();assert.match(await page.locator('.al-stats').innerText(),/0\s*独立口语尝试/);await page.screenshot({path:`${root}/${name}-finished.png`});
 await page.getByRole('button',{name:'删除本次练习',exact:true}).click();await page.getByRole('button',{name:'确认删除本次练习',exact:true}).click();await page.getByRole('heading',{name:'选一个想去的情境'}).waitFor();
 await page.getByRole('button',{name:'返回首页',exact:true}).click();await page.getByRole('button',{name:'展开AI分身大脑功能',exact:true}).waitFor();assert.deepEqual(errors,[]);reports.push({name,status:'passed',sizes:5,flows:['menu-renamed','foundation-text','completion-evidence','delete','back-home'],realMicrophone:false});
 }catch(error){reports.push({name,status:'failed',message:error.message});}finally{await browser.close();}
}
fs.writeFileSync(root+'/browser-report.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports,null,2));if(reports.some(x=>x.status==='failed'))process.exitCode=1;

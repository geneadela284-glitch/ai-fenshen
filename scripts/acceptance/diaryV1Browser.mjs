import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium,webkit} from '/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const root=process.cwd(),out=path.join(root,'evidence/diary-v1');
const info=JSON.parse(fs.readFileSync(path.join(out,'local-session.json')));
const reports=[];
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 let browser;
 try {browser=await engine.launch({headless:true,...(name==='chromium'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});}
 catch(e){reports.push({browser:name,status:'UNAVAILABLE',reason:e.message.split('\n')[0]});continue;}
 const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Shanghai',reducedMotion:'reduce',acceptDownloads:true});
 const cookie=info.cookie.split(';')[0];await context.addCookies([{name:cookie.slice(0,cookie.indexOf('=')),value:cookie.slice(cookie.indexOf('=')+1),url:info.url}]);
 const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto(info.url,{waitUntil:'networkidle'});
  await page.getByRole('link',{name:'查看原记录与提醒 →'}).first().click();
  const diary=page.getByTestId('feature-diary');await diary.waitFor();
  await page.getByRole('button',{name:/写一篇/}).click();
  const title=`${name} 浏览器验收日记 ${Date.now()}`;
  await page.getByRole('textbox',{name:'日记标题',exact:true}).fill(title);
  const original='今天和小明吃饭，聊起明年还想坐在同一张桌子旁。\n\n这是一篇由浏览器写入的真实测试日记。';
  await page.getByRole('textbox',{name:'日记原文',exact:true}).fill(original);
  await page.getByRole('button',{name:'保存日记',exact:true}).click();
  await page.getByRole('heading',{name:title,exact:true}).waitFor();
  assert.equal(await diary.locator('.af-diary-original').innerText(),original);
  await page.waitForFunction(()=>document.querySelector('.af-diary-page-heading').getBoundingClientRect().height<60);await page.screenshot({path:path.join(out,`${name}-phone-read.png`)});
  await page.getByRole('button',{name:'编辑原文',exact:true}).click();
  const long=original+'\n\n'+Array.from({length:35},(_,i)=>`第${i+1}段：记住一个普通的瞬间，长文应当完整保留，不能为了翻页而删掉内容。`).join('\n');
  await page.getByRole('textbox',{name:'日记原文',exact:true}).fill(long);
  await page.getByRole('button',{name:'保存日记',exact:true}).click();
  await page.getByRole('heading',{name:title,exact:true}).waitFor();assert.equal(await diary.locator('.af-diary-original').innerText(),long);
  await page.getByRole('button',{name:/下一篇/}).click();assert.notEqual(await diary.locator('.af-diary-entry-title').innerText(),title);
  await page.getByRole('button',{name:/上一篇/}).click();assert.equal(await diary.locator('.af-diary-entry-title').innerText(),title);
  await page.getByRole('button',{name:'日期与目录',exact:true}).click();
  await page.getByRole('searchbox',{name:'搜索日记',exact:true}).fill(title);
  await page.getByRole('button',{name:'查找日记',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.af-diary-index button').length===1);assert.equal(await page.locator('.af-diary-index button').count(),1);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出全部日记',exact:true}).click();const file=await download;const exportPath=path.join(out,`${name}-export.json`);await file.saveAs(exportPath);assert.ok(fs.readFileSync(exportPath,'utf8').includes('浏览器验收日记'));
  await page.locator('.af-diary-index button').first().click();
  await page.getByRole('button',{name:'编辑原文',exact:true}).click();await page.getByRole('textbox',{name:'日记原文',exact:true}).fill('未保存草稿');
  await page.getByRole('button',{name:/返回首页/}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'日记原文',exact:true}).inputValue(),'未保存草稿');
  await page.getByRole('button',{name:/返回首页/}).click();await page.getByRole('button',{name:'放弃草稿',exact:true}).click();
  await page.getByRole('button',{name:'展开AI分身大脑功能',exact:true}).click();await page.getByRole('button',{name:'打开日记入口',exact:true}).click();await diary.waitFor();
  await page.getByRole('button',{name:'日期与目录',exact:true}).click();await page.getByRole('searchbox',{name:'搜索日记',exact:true}).fill(title);await page.getByRole('button',{name:'查找日记',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.af-diary-index button').length===1);await page.locator('.af-diary-index button').first().click();
  assert.equal(await diary.locator('.af-diary-original').innerText(),long);
  await page.getByRole('button',{name:'删除这篇',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await diary.locator('.af-diary-original').innerText(),long);
  await page.getByRole('button',{name:'删除这篇',exact:true}).click();await page.getByRole('button',{name:'确认删除并取消提醒',exact:true}).click();
  await page.getByRole('button',{name:'日期与目录',exact:true}).click();await page.getByRole('button',{name:'查看全部',exact:true}).click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:1365,height:950});await page.waitForFunction(()=>document.querySelector('.af-diary-book').getBoundingClientRect().width>=800);assert.ok(await page.locator('.af-diary-paper').evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.waitForFunction(()=>document.querySelector('.af-diary-paper .af-diary-page-heading')?.getBoundingClientRect().height<60);await page.screenshot({path:path.join(out,`${name}-desktop.png`),fullPage:true});
  assert.deepEqual(errors,[]);reports.push({browser:name,status:'PASS',checks:['create','original','long-edit','flip','search','export','unsaved-guard','reopen','delete-confirm','mobile-width','desktop'],realPhone:false});
 }catch(e){await page.screenshot({path:path.join(out,`${name}-failed.png`),fullPage:true});fs.writeFileSync(path.join(out,`${name}-failed.txt`),e.stack+'\n'+await page.locator('body').innerText());reports.push({browser:name,status:'FAIL',reason:e.message});}
 finally{await context.close();await browser.close();}
}
fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(reports,null,2));console.log(JSON.stringify(reports));if(reports.some(r=>r.status==='FAIL'))process.exitCode=1;

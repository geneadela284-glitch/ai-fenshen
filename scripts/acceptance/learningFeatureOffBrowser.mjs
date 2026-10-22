import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { createLearningHarness } from '../../server/learning/testHarness.js';
const output='/private/tmp/ai-learning-evidence-20260910';
const harness=await createLearningHarness({enabled:false,publicDir:output+'/feature-off-dist'});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const cookie=harness.login.setCookie.split(';')[0], separator=cookie.indexOf('=');
  await context.addCookies([{name:cookie.slice(0,separator),value:cookie.slice(separator+1),url:harness.baseUrl}]);
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(harness.baseUrl,{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'展开AI分身大脑功能',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'打开学习入口',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'打开对话入口',exact:true}).count(),1);
  const capabilities=await page.evaluate(async()=>await(await fetch('/api/learning/capabilities')).json());
  assert.equal(capabilities.enabled,false);assert.deepEqual(errors,[]);
  await page.screenshot({path:output+'/feature-off-menu.png'});
  fs.writeFileSync(output+'/feature-off-browser-report.json',JSON.stringify({status:'passed',checks:['learning-hidden','original-chat-menu-present','server-disabled','no-page-errors'],syntheticDataOnly:true},null,2));
  console.log('FEATURE_OFF_BROWSER_PASSED');
} finally {await browser.close();await harness.close();}

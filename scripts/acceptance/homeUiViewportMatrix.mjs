import fs from 'node:fs';import {chromium,webkit} from '/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const url='http://127.0.0.1:55883',rows=[];
for(const [name,engine,launch] of [['chrome',chromium,{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}],['webkit',webkit,{}]]){
const b=await engine.launch({headless:true,...launch});
for(const mode of ['reserved','overlay','browser','resized-layout']){
const c=await b.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});await c.request.post(url+'/api/auth/login',{data:{username:'health_acceptance',password:'DiaryTestOnly2026!'}});
await c.addInitScript(({standalone})=>{window.__testInner=785;Object.defineProperty(navigator,'standalone',{value:standalone});Object.defineProperty(window,'innerHeight',{get:()=>window.__testInner});const v=new EventTarget();Object.assign(v,{height:785,width:390,offsetTop:0,scale:1});Object.defineProperty(window,'visualViewport',{value:v});},{standalone:mode!=='browser'});
const p=await c.newPage();await p.goto(url,{waitUntil:'networkidle'});await p.locator('.af-prototype-canvas').waitFor();if(mode==='overlay')await p.addStyleTag({content:'.af-prototype-canvas{--af-system-safe-top:59px}'});
for(const stage of ['closed','keyboard','recovery']){const vv=stage==='keyboard'?460:785;await p.evaluate(({h,both})=>{if(both)window.__testInner=h;window.visualViewport.height=h;window.visualViewport.dispatchEvent(new Event('resize'));window.dispatchEvent(new Event('resize'));},{h:vv,both:mode==='resized-layout'});const expected=stage==='keyboard'?460:mode==='overlay'||mode==='browser'?844:785;await p.waitForFunction(h=>Math.abs(document.querySelector('.af-prototype-canvas').getBoundingClientRect().height-h)<1,expected,{timeout:3000}).catch(()=>{});const actual=await p.locator('.af-prototype-canvas').evaluate(e=>e.getBoundingClientRect().height);rows.push({engine:name,mode,stage,expected,actual,pass:Math.abs(expected-actual)<1});}
await c.close();}
await b.close();}
fs.writeFileSync('/private/tmp/home-ui-fix-20260910/viewport-matrix.json',JSON.stringify(rows,null,2));console.log(JSON.stringify({checks:rows.length,failed:rows.filter(r=>!r.pass)}));if(rows.some(r=>!r.pass))process.exitCode=1;

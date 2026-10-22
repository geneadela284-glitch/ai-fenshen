import fs from 'node:fs';
import {chromium,webkit} from '/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const url=process.env.HOME_UI_URL||'http://127.0.0.1:55883',out=process.env.HOME_UI_EVIDENCE||'/private/tmp/home-ui-fix-20260910/browser';fs.mkdirSync(out,{recursive:true});const results=[];
for(const [engine,kind,options] of [['chrome',chromium,{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}],['webkit',webkit,{}]]){
 const browser=await kind.launch({headless:true,...options});
 for(const [width,height] of [[320,568],[360,800],[390,844],[430,932],[568,320],[844,390],[1024,768],[1440,900]]){
  const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',timezoneId:'Asia/Shanghai',hasTouch:width<1100});
  await context.request.post(url+'/api/auth/login',{data:{username:'health_acceptance',password:'DiaryTestOnly2026!'}});const p=await context.newPage();p.setDefaultTimeout(9000);const errors=[];p.on('pageerror',e=>errors.push(e.message));
  async function enter(name){await p.goto(url,{waitUntil:'networkidle'});await p.getByRole('button',{name:'展开AI分身大脑功能'}).click();await p.getByRole('button',{name:`打开${name}入口`}).click();}
  async function check(name,scrollSelector,backSelector){const scroll=p.locator(scrollSelector).first(),back=p.locator(backSelector).first();await scroll.waitFor();const before=await back.boundingBox();await scroll.evaluate(e=>e.scrollTop=e.scrollHeight);await p.waitForTimeout(100);const after=await back.boundingBox();const canvas=await p.locator('.af-prototype-canvas').boundingBox();const hit=await back.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});const layout=await scroll.evaluate(e=>({overflow:e.scrollWidth-e.clientWidth,scrollTop:e.scrollTop}));const css=await back.evaluate(e=>({position:getComputedStyle(e).position,background:getComputedStyle(e).backgroundColor}));
   const row={engine,width,height,page:name,before,after,canvas,hit,...layout,...css,pass:!!after&&after.x>=canvas.x&&after.y>=canvas.y&&after.x+after.width<=canvas.x+canvas.width+1&&after.y+after.height<=canvas.y+canvas.height+1&&after.width>=44&&after.height>=44&&Math.abs(after.y-before.y)<1&&hit&&layout.overflow<=1&&/^rgba\(.*0\.[1-9]/.test(css.background)};results.push(row);
   if(width===390||!row.pass)await p.screenshot({path:`${out}/${engine}-${width}x${height}-${name}.png`});if(!row.pass)console.log('FAIL',JSON.stringify(row));await back.click();await p.getByTestId('home-view').waitFor();
  }
  try{
   await enter('健康');await check('health','.health-shell','.health-back');
   await enter('日记');await check('diary','.af-diary','.af-diary-back');
   await enter('会议');await check('meeting','.meeting-v1-app-shell','.meeting-v1-top-action--back');
   await enter('设置');await check('settings','.af-settings-scroll','.af-settings-back');
   await enter('财务');await check('finance','.af-finance-view','.af-finance-back');
   await p.goto(url,{waitUntil:'networkidle'});await p.locator('textarea').first().click();await p.getByTestId('chat-view').waitFor();await check('chat','.af-message-list','.af-chat-top-control[aria-label="返回首页"]');
   for(const mode of ['day-sky','deep-blue']){
    await p.goto(url,{waitUntil:'networkidle'});await p.getByRole('button',{name:'展开AI分身大脑功能'}).click();await p.locator('[data-af-theme]').evaluate((e,m)=>e.setAttribute('data-af-theme',m),mode);const controls=await p.locator('.af-brain-function').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,shadow:getComputedStyle(e).boxShadow};}));const logo=await p.locator('.af-home-header .af-wordmark').boundingBox();const pass=controls.length===7&&controls.every(r=>r.x>=-1&&r.y>=-1&&r.x+r.w<=width+1&&r.y+r.h<=height+1&&r.shadow!=='none')&&logo.y>=0;results.push({engine,width,height,page:mode,pass,controls,logo});if(width===390||!pass)await p.screenshot({path:`${out}/${engine}-${width}x${height}-${mode}.png`});
   }
   results.push({engine,width,height,page:'pageerrors',pass:errors.length===0,errors});
  }catch(e){results.push({engine,width,height,page:'exception',pass:false,message:e.message});await p.screenshot({path:`${out}/${engine}-${width}x${height}-exception.png`});console.log(engine,width,height,e.message.slice(0,300));}
  await context.close();
 }
 await browser.close();
}
fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify({total:results.length,failed:results.filter(r=>!r.pass).length}));if(results.some(r=>!r.pass))process.exitCode=1;

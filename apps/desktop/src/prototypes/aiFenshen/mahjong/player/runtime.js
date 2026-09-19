import {createPresentation} from '/host/presentation.js';
import {createMahjongAudioEnhancement} from '/audio-enhancement.js';
const query=new URLSearchParams(new URL(import.meta.url).search||location.search),channel=query.get('channel'),parentOrigin=query.get('parentOrigin');
const validParent=(()=>{try{const u=new URL(parentOrigin);return u.origin===new URL(document.baseURI).origin||(u.hostname==='127.0.0.1'&&location.hostname==='127.0.0.1'&&u.protocol==='http:');}catch{return false;}})();
const status=document.querySelector('#status'),canvas=document.querySelector('#canvas');
const unlock=document.createElement('button');unlock.textContent='轻触开启声音';unlock.style.cssText='position:absolute;z-index:3;top:5px;left:50%;transform:translateX(-50%);border:1px solid #d8bd7a;border-radius:20px;background:#163225ee;color:#f4dfb3;padding:8px 14px;font:13px system-ui;display:none;cursor:pointer';document.body.append(unlock);
let originalAudio;
const refreshUnlock=()=>{unlock.style.display=originalAudio&&originalAudio.state!=='running'&&!muted&&!paused?'block':'none';};
unlock.onclick=()=>{originalAudio?.resume().then(refreshUnlock).catch(()=>{});};
document.addEventListener('pointerdown',()=>{if(!muted&&!paused)originalAudio?.resume().then(refreshUnlock).catch(()=>{});});
let started=false,running=false,paused=false,closed=false,loading=false,saving=false,pauseAfterSave=false,effect,presentation,muted=false,enhanced=true;
const activeKeys=new Set(),keyQueue=[],notes=[];let draining=false;
const send=(type,data={})=>{if(validParent&&channel)parent.postMessage({mahjong:channel,type,...data},parentOrigin);};
const fail=error=>{running=false;status.textContent='牌桌暂时无法运行，请返回后重试。';send('error',{message:String(error?.message||error)});};
const pause=()=>{if(!running||paused)return;keyQueue.length=0;for(const code of activeKeys)JSMAME.sdl_sendkeyboardkey(0,code);activeKeys.clear();Module.pauseMainLoop();paused=true;presentation?.setInputEnabled(false);window.jsmame_pause_audio?.(true);};
const resume=()=>{if(!running)return;if(paused){Module.resumeMainLoop();paused=false;}presentation?.setInputEnabled(!saving);window.jsmame_pause_audio?.(false);window.jsmame_web_audio?.get_context()?.resume().catch(()=>send('audioBlocked'));};
const log=message=>{notes.push(String(message));if(notes.length>24)notes.shift();};
async function save(thenPause=false){
 if(!running||closed)return;pauseAfterSave=pauseAfterSave||thenPause;if(saving)return;resume();saving=true;
 presentation?.setInputEnabled(false);const name='local-'+Date.now(),path='/sta/lhzb2a/'+name+'.sta';
 try{JSMAME.save(name);let bytes;for(let i=0;i<120&&!closed;i++){await new Promise(r=>setTimeout(r,50));try{bytes=Module.FS.readFile(path);break;}catch{}}
 if(!bytes)throw Error('本次牌局未能保存，已有存档仍保留。');
 Module.FS.unlink(path);if(pauseAfterSave)pause();send('snapshot',{state:bytes});
 }catch(error){send('saveError',{message:error.message});if(pauseAfterSave)pause();}finally{saving=false;pauseAfterSave=false;presentation?.setInputEnabled(running&&!paused);}
}
async function init(data){
 if(started||!validParent)return;started=true;muted=!!data.muted;enhanced=data.enhanced!==false;
 try{
 const result=await fetch('/rom/lhzb2a.zip');if(!result.ok)throw Error('原版资源未能读取。');const rom=new Uint8Array(await result.arrayBuffer());
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',rom)),b=>b.toString(16).padStart(2,'0')).join('');if(digest!=='f19ae4e5bec53c6e30e2c377c28d37e8b6387a6a23e464c261afe4f7755e1319')throw Error('原版资源校验未通过。');
 presentation=await createPresentation(canvas,{pressKey});
 const snapshot=data.state instanceof Uint8Array?data.state:null;
 if(snapshot&&(snapshot.length<128||snapshot.length>16*1024*1024))throw Error('牌局存档大小无效。');
 const audioContext=new AudioContext({sampleRate:44100,latencyHint:'interactive'});originalAudio=audioContext;audioContext.onstatechange=refreshUnlock;refreshUnlock();
 window.Module={canvas,originalAudioContext:audioContext,noInitialRun:true,beforeOriginalVideo:presentation.beforeOriginalVideo,onOriginalSprite:presentation.onOriginalSprite,onOriginalVideo:presentation.onOriginalVideo,locateFile:p=>'/runtime/'+p,print:log,printErr:log,onAbort:fail,
 onAudioOutput:(ctx,node)=>{effect=createMahjongAudioEnhancement(ctx,{enabled:enhanced,volume:muted?0:.9});node.connect(effect.input);effect.output.connect(ctx.destination);},
 preRun:[()=>{for(const path of ['/roms','/sta','/cfg','/nvram','/sta/lhzb2a'])Module.FS.mkdir(path);Module.FS.writeFile('/roms/lhzb2a.zip',rom);
 Module.FS.writeFile('/cfg/lhzb2a.cfg','<?xml version="1.0"?><mameconfig version="10"><system name="lhzb2a"><input><port tag=":DSW1" type="DIPSWITCH" mask="12" defvalue="12" value="8"/><port tag=":DSW1" type="DIPSWITCH" mask="32" defvalue="32" value="0"/><port tag=":DSW1" type="DIPSWITCH" mask="64" defvalue="64" value="0"/><port tag=":DSW2" type="DIPSWITCH" mask="3" defvalue="3" value="0"/></input></system></mameconfig>');
 if(snapshot)Module.FS.writeFile('/sta/lhzb2a/continue.sta',snapshot);}],
 onRuntimeInitialized:()=>{try{
 const args=['lhzb2a','-rompath','/roms','-cfg_directory','/cfg','-state_directory','/sta','-nvram_directory','/nvram','-skip_gameinfo','-video','soft','-sound','js','-samplerate',String(audioContext.sampleRate),'-resolution','960x720','-window','-throttle','-speed','1','-noreadconfig'];
 if(snapshot)args.push('-state','continue');Module.callMain(args);running=!!window.JSMAME?.running;if(!running)throw Error(notes.slice(-3).join('\n')||'原版启动失败。');status.textContent='';presentation?.setInputEnabled(true);send('running',{restored:!!snapshot});
 }catch(error){fail(error);}}};
 const script=document.createElement('script');script.src='/runtime/lhzb2.js';script.onerror=()=>fail(Error('运行文件未能加载。'));document.body.append(script);
 }catch(error){fail(error);}
}

function drainKeys(){
 if(draining||!keyQueue.length||closed)return;
 if(saving||paused){keyQueue.length=0;return;}
 draining=true;const code=keyQueue.shift();activeKeys.add(code);JSMAME.sdl_sendkeyboardkey(1,code);
 setTimeout(()=>{if(!closed)JSMAME.sdl_sendkeyboardkey(0,code);activeKeys.delete(code);setTimeout(()=>{draining=false;drainKeys();},40);},80);
}
function pressKey(code){
 if(!running||saving||closed||!Number.isInteger(code)||![...Array.from({length:14},(_,i)=>i+4),20,29,30,32,40,42,44,224,225,226,228,229,230].includes(code)||keyQueue.length>=8)return false;
 resume();keyQueue.push(code);drainKeys();return true;
}

addEventListener('error',event=>{if(started)fail(event.error||event.message);});
addEventListener('message',event=>{
 if(!validParent||event.source!==parent||event.origin!==parentOrigin||event.data?.mahjong!==channel)return;
 const data=event.data;
 if(data.type==='init'){init(data);return;}
 if(data.type==='visual'){presentation?.setEnabled(data.enabled);return;}
 if(data.type==='sound'){muted=!!data.muted;enhanced=data.enhanced!==false;effect?.setEnabled(enhanced);effect?.setVolume(muted?0:.9);if(!muted)resume();refreshUnlock();return;}
 if(data.type==='save'){save(!!data.pause);return;}
 if(data.type==='pause'){pause();return;}
 if(data.type==='resume'){pauseAfterSave=false;resume();return;}
 if(data.type==='close'){closed=true;pause();effect?.close();presentation?.close();window.jsmame_close_audio?.();return;}
 if(data.type==='key')pressKey(data.code);
});
addEventListener('pagehide',()=>{closed=true;window.jsmame_close_audio?.();});
if(validParent&&channel)send('ready');else status.textContent='请从游戏目录进入。';

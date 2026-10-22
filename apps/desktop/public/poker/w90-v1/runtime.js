import { OriginalHDView } from './hd-view.js';

const source = document.getElementById('canvas');
const screen = document.getElementById('hd-screen');
const status = document.getElementById('status');
const start = document.getElementById('start');
const game = document.getElementById('game');
const stage = document.getElementById('stage');
const clockStart=performance.now();
const params=new URL(import.meta.url).searchParams;
const channel=params.get('channel'),parentOrigin=params.get('parentOrigin');
const attached=window.parent!==window&&/^[a-z0-9-]{20,64}$/i.test(channel||'')&&parentOrigin===new URL(import.meta.url).origin;
let initialState=null,initialized=false,restored=false,paused=false,closed=false,saveSerial=0,savePromise=null,pauseGeneration=0,audioRecoveryPending=false;
const acknowledgements=new Map();
window.originalRuntimeObservation=()=>({paused,closed,initialized,saveSerial,pendingAcks:acknowledgements.size,mainLoopFrame:window.MainLoop?.currentFrameNumber,audioRecoveryPending});
function post(type,data={},transfer=[]){if(attached)parent.postMessage({poker:channel,type,...data},parentOrigin,transfer);}
function saveFailed(error){proof.saveError=String(error?.message||error);showStatus(proof.saveError+'。点返回可重试保存。','error');document.querySelectorAll('[data-key]').forEach(b=>b.disabled=true);}
function pause(){paused=true;window.MainLoop?.pause();audio?.suspend().catch(()=>{});}
async function resume(){
 if(closed||proof.aborted)return;const generation=++pauseGeneration;
 if(document.hidden){pause();return;}
 if(!await requestAudioResume())return;
 if(generation!==pauseGeneration||closed||document.hidden){if(document.hidden)pause();return;}
 if(paused)window.MainLoop?.resume();paused=false;
 if(proof.ready&&!proof.saveError)document.querySelectorAll('[data-key]').forEach(b=>b.disabled=false);
}
screen.addEventListener('pointerdown',()=>{if(!closed&&proof.ready&&(audioRecoveryPending||!paused&&audio?.state!=='running'))resume();});
document.getElementById('resume-audio').onclick=()=>resume();
async function originalSnapshot(){
 if(!JSMAME.running)throw Error('原机尚未启动，已有存档保留。');
 const path='/state/current.sta';if(Module.FS.analyzePath(path).exists)Module.FS.unlink(path);
 JSMAME.save(path);const deadline=performance.now()+5000;
 while(!Module.FS.analyzePath(path).exists){if(performance.now()>deadline)throw Error('原机保存超时，已有存档保留。');await new Promise(r=>setTimeout(r,12));}
 const bytes=new Uint8Array(Module.FS.readFile(path));
 if(bytes.length<128||new TextDecoder().decode(bytes.subarray(0,8))!=='MAMESAVE')throw Error('原机未生成完整存档。');
 return bytes;
}
function persist(stop=false,generation=pauseGeneration){
 if(savePromise)return savePromise.then(()=>{if(stop&&generation===pauseGeneration)pause();});
 savePromise=(async()=>{
  const wasPaused=paused;if(wasPaused){window.MainLoop?.resume();paused=false;}
  try{
   const state=await originalSnapshot(),requestId=String(++saveSerial);
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{acknowledgements.delete(requestId);reject(Error('牌局未得到本机保存确认'));},8000);acknowledgements.set(requestId,{resolve,reject,timer});post('snapshot',{requestId,state},[state.buffer]);});
   proof.savedOperations=saveSerial;proof.saveError=null;
  }finally{if((stop||wasPaused)&&generation===pauseGeneration)pause();}
 })().finally(()=>{savePromise=null;});return savePromise;
}
async function restoreOriginal(){
 if(!initialState)return;
 Module.FS.writeFile('/state/restore.sta',initialState);JSMAME.load('/state/restore.sta');
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
}
addEventListener('message',event=>{
 if(!attached||event.source!==parent||event.origin!==parentOrigin||event.data?.poker!==channel)return;
 const d=event.data;
 if(d.type==='init'&&!initialized){initialized=true;initialState=d.state||null;PokerStartup.markReady(!!initialState);}
 if(d.type==='viewport'&&Array.isArray(d.insets)&&d.insets.length===4){['t','r','b','l'].forEach((side,i)=>{const value=d.insets[i];if(Number.isFinite(value)&&value>=0&&value<160)game.style.setProperty('--safe-'+side,value+'px');});}
 if(d.type==='ack'){
  const a=acknowledgements.get(d.requestId);if(!a)return;acknowledgements.delete(d.requestId);clearTimeout(a.timer);d.error?a.reject(Error(d.error)):a.resolve();
 }
 if(d.type==='save'){const generation=pauseGeneration;inputQueue=inputQueue.then(()=>persist(!!d.pause,generation)).then(()=>post('saved',{requestId:d.requestId})).catch(error=>post('saveError',{requestId:d.requestId,message:error.message}));}
 if(d.type==='pause'){const generation=pauseGeneration;inputQueue=inputQueue.then(()=>persist(true,generation)).catch(error=>{saveFailed(error);if(generation===pauseGeneration)pause();});}
 if(d.type==='resume')resume();
 if(d.type==='close'){closed=true;pause();document.querySelectorAll('[data-key]').forEach(b=>b.disabled=true);try{JSMAME.exit();}catch{}}
});
for(const id of ['back','back-cover'])document.getElementById(id).onclick=()=>post('leave');
addEventListener('pagehide',()=>{closed=true;pause();audio?.close().catch(()=>{});});
if(!attached)PokerStartup.fail('请从AI分身游戏入口进入。');
window.proof = { lines: [], started: false };
let audio, nativeAudioResume, audioResumePromise, peak = 0, audioBuffers = 0, invalidAudioSamples = 0;
const log = value => { proof.lines.push(String(value)); document.getElementById('log').textContent = proof.lines.slice(-30).join('\n'); console.log(value); };
function showStatus(message, kind = 'progress') {
  status.textContent = message;
  status.dataset.kind = kind;
  status.classList.add('visible');
}
function startupStage(phase, message) {
  proof.startupStage = phase;
  window.PokerStartup?.stage(phase, message);
  showStatus(message);
}
// The deployed static host returns application/octet-stream. The generated
// loader retries that response through a second download and drops its error.
// Supply the unchanged binary through Emscripten's instantiation callback.
const originalWasm = {
  url: new URL('./wing90.wasm', import.meta.url).href,
  bytes: 27071008,
  sha256: '7ac6a0d96e206557cf6c5130646e9811f9c46b696cbca24a98d1078bda557cfd'
};
const compressedWasm = {
  url: new URL('./wing90.wasm.gz', import.meta.url).href,
  bytes: 5444009,
  sha256: '9b55066222c049215b538c3c97bab278f02280259db92e8de0fa028b6cf8875b'
};
async function loadOriginalWasm() {
  const compressed = typeof DecompressionStream === 'function';
  const transfer = compressed ? compressedWasm : originalWasm;
  proof.wasm = { url: transfer.url, expectedBytes: originalWasm.bytes, downloadBytes: transfer.bytes, compressed, attempts: [], verified: false };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const observation = { attempt, receivedBytes: 0 };
    proof.wasm.attempts.push(observation);
    const controller = new AbortController();
    let idleTimer, idleExpired = false, receiving = true, reader;
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleExpired = true; controller.abort(); }, 45000);
    };
    const showTransfer = () => {
      const percent = Math.floor(observation.receivedBytes / transfer.bytes * 100);
      if (observation.percent === percent) return;
      observation.percent = percent;
      startupStage('wasm', '正在读取游戏（' + percent + '%，' + (observation.receivedBytes / 1000000).toFixed(1) + ' / ' + (transfer.bytes / 1000000).toFixed(1) + ' MB）…');
    };
    startupStage('wasm', attempt === 1 ? '正在读取游戏运行文件…' : '上次传输中断，正在补试一次…');
    try {
      armIdleTimer();
      const response = await fetch(transfer.url, { credentials: 'same-origin', cache: 'force-cache', headers: location.protocol==='capacitor:'?{Range:'bytes=0-'}:{}, signal: controller.signal });
      observation.httpStatus = response.status;
      observation.contentType = response.headers.get('content-type');
      if (!response.ok) throw new Error('游戏文件下载失败（HTTP ' + response.status + '）');
      let bytes = new Uint8Array(transfer.bytes);
      if (response.body?.getReader) {
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (observation.receivedBytes + value.byteLength > bytes.byteLength) throw new Error('游戏文件长度不符，未启动原机');
          bytes.set(value, observation.receivedBytes);
          observation.receivedBytes += value.byteLength;
          armIdleTimer();
          showTransfer();
        }
      } else {
        const body = new Uint8Array(await response.arrayBuffer());
        observation.receivedBytes = body.byteLength;
        if (body.byteLength === bytes.byteLength) bytes.set(body);
        showTransfer();
      }
      clearTimeout(idleTimer);
      if (observation.receivedBytes !== bytes.byteLength) throw new Error('游戏文件不完整（' + observation.receivedBytes + ' / ' + bytes.byteLength + '字节），未启动原机');
      receiving = false;
      startupStage('verify', '游戏文件已读取，正在检查完整性…');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      let hash = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== transfer.sha256) throw new Error('游戏文件校验失败，未启动原机');
      if (compressed) {
        startupStage('decompress', '读取完成，正在还原原机文件…');
        const decoded = new Uint8Array(originalWasm.bytes);
        const decoder = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
        let received = 0;
        try {
          while (true) {
            const { done, value } = await decoder.read();
            if (done) break;
            if (received + value.byteLength > decoded.byteLength) throw new Error('还原后的游戏文件长度不符，未启动原机');
            decoded.set(value, received);
            received += value.byteLength;
          }
          if (received !== decoded.byteLength) throw new Error('还原后的游戏文件不完整，未启动原机');
        } finally {
          await decoder.cancel().catch(() => {});
          decoder.releaseLock();
        }
        bytes = decoded;
        startupStage('verify', '原机文件已还原，正在检查完整性…');
        const originalDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        hash = Array.from(originalDigest, value => value.toString(16).padStart(2, '0')).join('');
        if (hash !== originalWasm.sha256) throw new Error('还原后的游戏文件校验失败，未启动原机');
      }
      proof.wasm.verified = true;
      proof.wasm.sha256 = hash;
      return bytes;
    } catch (error) {
      observation.error = idleExpired ? '传输连续45秒没有收到数据' : String(error?.message || error);
      clearTimeout(idleTimer);
      if (reader) await reader.cancel().catch(() => {});
      controller.abort();
      log('WASM read ' + attempt + ': ' + observation.error);
      const transportFailure = idleExpired || receiving && (!observation.httpStatus || observation.httpStatus === 200) && error instanceof TypeError;
      if (attempt === 1 && transportFailure) {
        await new Promise(resolve => setTimeout(resolve, 800));
        continue;
      }
      if (transportFailure) throw new Error('游戏文件传输未完成：' + observation.error + '。可以点重新加载。');
      throw error;
    } finally {
      clearTimeout(idleTimer);
      reader?.releaseLock();
    }
  }
}
function fail(error) {
  proof.aborted = String(error?.message || error);
  showStatus('游戏中断：' + proof.aborted, 'error');
  post('error',{message:proof.aborted});
  window.PokerStartup?.fail('游戏中断（' + (proof.startupStage || '运行中') + '）：' + proof.aborted);
  document.querySelectorAll('[data-key]').forEach(button => button.disabled = true);
}
window.addEventListener('error', event => fail(event.error || event.message));
window.addEventListener('unhandledrejection', event => fail(event.reason || '启动请求未完成'));
screen.addEventListener('hd-error', event => fail(event.detail));

window.hdAudioObservation = () => ({ state: audio?.state || 'not-started', sampleRate: audio?.sampleRate, peak, audioBuffers, invalidAudioSamples, recoveryPending:audioRecoveryPending });
function audioFailed(error){
 proof.audioError=String(error?.message||error);audioRecoveryPending=true;
 if(proof.started){paused=true;window.MainLoop?.pause();document.querySelectorAll('[data-key]').forEach(b=>b.disabled=true);}
 log('Audio recovery: '+proof.audioError);
 showStatus('原机声音暂未恢复：'+proof.audioError,'audio');
 document.getElementById('resume-audio').hidden=!proof.started;
}
function requestAudioResume(){
 if(closed||document.hidden)return Promise.resolve(false);
 if(audioResumePromise)return audioResumePromise;
 audioResumePromise=(async()=>{
  try{
   await nativeAudioResume();
   if(audio.state!=='running')throw Error('声音仍被系统暂停，请点恢复声音。');
   audioRecoveryPending=false;proof.audioError=null;document.getElementById('resume-audio').hidden=true;
   if(status.dataset.kind==='audio')status.classList.remove('visible');return true;
  }catch(error){audioFailed(error);return false;}
 })().finally(()=>{audioResumePromise=null;});return audioResumePromise;
}
function startAudio() {
  if(audio)return requestAudioResume();
  const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
  audio = new OriginalAudioContext();
  nativeAudioResume=audio.resume.bind(audio);
  // The unchanged MAME mixer retries context.resume() from its watchdog.
  // A background game must remain paused; a rejected resume must be visible
  // and recoverable instead of becoming an unhandled, fatal game error.
  audio.resume=()=>paused||closed||document.hidden||audioRecoveryPending?Promise.resolve():requestAudioResume().then(()=>{});
  audio.addEventListener('statechange',()=>{if(proof.ready&&!paused&&!closed&&!document.hidden&&audio.state!=='running')audioFailed(Error('声音被系统暂停，请点恢复声音。'));});
  const createProcessor = audio.createScriptProcessor.bind(audio);
  audio.createScriptProcessor = (...args) => {
    const processor = createProcessor(...args);
    // Observe the original mixer's output buffer after it has filled it.
    // This adds no second audio connection and does not alter any samples.
    queueMicrotask(() => {
      const original = processor.onaudioprocess;
      if (!original) return;
      processor.onaudioprocess = event => {
        original.call(processor, event);
        audioBuffers++;
        const samples = event.outputBuffer.getChannelData(0);
        let sum = 0;
        for (const value of samples) {
          if (!Number.isFinite(value)) invalidAudioSamples++;
          else sum += value * value;
        }
        peak = Math.max(peak, Math.sqrt(sum / samples.length));
      };
    });
    return processor;
  };
  // Reuse the context unlocked by this click for the original MAME mixer.
  window.AudioContext = function() { return audio; };
  window.AudioContext.prototype = OriginalAudioContext.prototype;
  return requestAudioResume();
}

const codes = { c: ['KeyC',67], b: ['KeyB',66], s: ['KeyS',83], Enter: ['Enter',13], ' ': ['Space',32], ArrowLeft: ['ArrowLeft',37], ArrowRight: ['ArrowRight',39], Backspace: ['Backspace',8] };
for (let i = 1; i <= 5; i++) codes[String(i)] = ['Digit' + i, 48 + i];
const gold = document.getElementById('gold-holds');
const goldFrames = Array.from({ length: 5 }, (_, i) => {
  const frame = document.createElement('div');
  frame.className = 'gold-hold';
  frame.style.left = (6.25 + i * 18.75) + '%';
  frame.hidden = true;
  gold.append(frame);
  return frame;
});
// Read the original machine's visible HELD markers; never invent a selection.
function readHeld() {
  if (!window.hdView || !window.JSMAME?.running) return [false,false,false,false,false];
  const context = hdView.nativeContext;
  return goldFrames.map((_, i) => {
    const pixels = context.getImageData(16 + i * 48, 168, 32, 8).data;
    let cyan = 0;
    for (let p = 0; p < pixels.length; p += 4) if (pixels[p] < 40 && pixels[p+1] > 210 && pixels[p+2] > 210) cyan++;
    return cyan > 20;
  });
}
window.hdReadHeld = readHeld;
let inputQueue = Promise.resolve();
async function pulse(key) {
  if (!window.JSMAME?.running || proof.aborted || paused || closed) return;
  // Forward controls to the original SDL input canvas.
  source.focus({ preventScroll: true });
  const [code, number] = codes[key];
  const send = type => source.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode: number, which: number, bubbles: true }));
  send('keydown');
  await new Promise(resolve => setTimeout(resolve, 150));
  send('keyup');
  await new Promise(resolve => setTimeout(resolve, 100));
}
function enqueue(action) { inputQueue=inputQueue.then(async()=>{if(paused||closed||!proof.ready)return;await action();await persist();}).catch(error=>saveFailed(error)); }
function sendKey(key) { enqueue(()=>pulse(key)); }
function toggleCard(index) {
  enqueue(async () => {
    const held = readHeld();
    if (!held[index]) return pulse(String(index + 1));
    // The original program cancels all. Re-select the remaining cards in order.
    await pulse('Backspace');
    for (let i = 0; i < 5; i++) if (i !== index && held[i]) await pulse(String(i + 1));
  });
}
screen.addEventListener('pointerdown', event => {
  if (!window.JSMAME?.running) return;
  const rect = screen.getBoundingClientRect();
  const x=(event.clientX-rect.left)/rect.width*hdView.picture.width;
  const y=(event.clientY-rect.top)/rect.height*hdView.picture.height;
  for(let i=0;i<5;i++){const r=hdView.cardRects[i];if(x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height){toggleCard(i);event.preventDefault();break;}}
});
for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{
 if(!event.isTrusted||!codes[event.key]||!proof.ready)return;
 event.preventDefault();event.stopImmediatePropagation();
 if(type==='keydown'&&!event.repeat){if(/^[1-5]$/.test(event.key))toggleCard(Number(event.key)-1);else sendKey(event.key);}
},true);
document.querySelectorAll('[data-key]').forEach(button => button.onclick = () => {proof.inputClicks=(proof.inputClicks||0)+1;sendKey(button.dataset.key);});
let blue='';
window.hdLayoutObservation=()=>({layout:hdView?.layout,cardRects:hdView?.cardRects,background:blue});
function fitOriginalPicture(){
 const c=hdView.nativeContext.getImageData(8,8,1,1).data,next=`rgb(${c[0]}, ${c[1]}, ${c[2]})`;
 if(next!==blue){blue=next;game.style.backgroundColor=blue;game.style.setProperty('--arcade-blue',blue);}
 const w=hdView.picture.width,h=hdView.picture.height;
 hdView.cardRects.forEach((r,i)=>{const f=goldFrames[i];f.style.left=r.x/w*100+'%';f.style.top=r.y/h*100+'%';f.style.width=r.width/w*100+'%';f.style.height=r.height/h*100+'%';});
}
function realPictureReady(){
 const p=hdView.nativeContext.getImageData(16,16,224,60).data;let green=0,yellow=0;
 for(let i=0;i<p.length;i+=4){if(p[i]<80&&p[i+1]>180&&p[i+2]<100)green++;if(p[i]>180&&p[i+1]>180&&p[i+2]<100)yellow++;}
 if(green<=20||yellow<=40)return false;
 if(initialState)return true;
 // The machine paints its paytable before it accepts coins. Wait for the
 // real INSERT COIN prompt, rather than exposing controls during its boot.
 const footer=hdView.nativeContext.getImageData(16,176,224,20).data;let cyan=0;
 for(let i=0;i<footer.length;i+=4)if(footer[i]<40&&footer[i+1]>210&&footer[i+2]>210)cyan++;
 return cyan>30;
}
function draw() {
  if (proof.aborted || closed) return;
  try {
    hdView.layout=innerWidth<innerHeight?'portrait':'landscape';
    hdView.draw();
    fitOriginalPicture();
    const held = readHeld();
    hdView.held = held;
    goldFrames.forEach((frame, i) => frame.hidden = hdView.mode !== 'hd' || !held[i]);
    if (window.JSMAME?.running && !proof.ready && realPictureReady() && restored) {
      proof.ready = true;
      window.PokerStartup?.stage('running', '原机已启动');
      document.getElementById('start-panel').remove();
      status.textContent = '原机已启动';
      status.classList.remove('visible');
      document.getElementById('back-cover').hidden=true;
      proof.startupMs=performance.now()-clockStart;
      post('running',{restored:!!initialState,startupMs:proof.startupMs});
      document.querySelectorAll('[data-key]').forEach(button => button.disabled = false);
      screen.focus({ preventScroll: true });
    }
  } catch (error) { fail(error); return; }
  requestAnimationFrame(draw);
}
start.onclick = async () => {
  start.disabled = true;
  start.textContent = '启动中…';
  startupStage('audio', '正在启用原机声音…');
  try {
    if(!await startAudio()){start.disabled=false;start.textContent='重试开启声音';return;}
    startupStage('graphics', '正在准备原机画面…');
    window.hdView = new OriginalHDView(source, screen);
    startupStage('rom', '正在读取原机程序…');
    const [rom, keys] = await Promise.all([
      fetch(new URL('./wing90pkr.zip',import.meta.url)).then(response => { if (!response.ok) throw new Error('原机程序读取失败'); return response.arrayBuffer(); }),
      fetch(new URL('./tryout.cfg',import.meta.url)).then(response => { if (!response.ok) throw new Error('按键配置读取失败'); return response.text(); })
    ]);
    startupStage('core', '正在加载运行核心…');
    window.Module = {
      canvas: source, noInitialRun: true, print: log, printErr: log, onAbort: fail,
      instantiateWasm(imports, receiveInstance) {
        loadOriginalWasm().then(async bytes => {
          startupStage('compile', '游戏文件校验通过，正在初始化原机…');
          return WebAssembly.instantiate(bytes, imports);
        }).then(result => {
          receiveInstance(result.instance, result.module);
        }).catch(fail);
        return {};
      },
      monitorRunDependencies(count) {
        if (proof.aborted || proof.ready) return;
        startupStage('runtime', count ? '正在准备运行文件（' + count + '项待完成）…' : '运行文件已到齐，正在启动原机…');
      },
      onRuntimeInitialized() {
        startupStage('machine', '正在启动原机…');
        if(typeof window.MainLoop?.pause!=='function'||typeof window.MainLoop?.resume!=='function')throw Error('原机运行控制不可用，已有牌局保留。');
        const FS = Module.FS;
        for (const directory of ['/roms','/cfg','/nvram','/state','/ctrlr']) FS.mkdir(directory);
        FS.writeFile('/roms/wing90pkr.zip', new Uint8Array(rom));
        FS.writeFile('/ctrlr/tryout.cfg', keys);
        proof.started = true;
        Module.callMain(['wing90pkr','-rompath','/roms','-cfg_directory','/cfg','-nvram_directory','/nvram','-state_directory','/state','-ctrlrpath','/ctrlr','-ctrlr','tryout','-skip_gameinfo','-noplugins','-window','-resolution','256x232','-nokeepaspect','-nofilter','-video','soft','-sound','js','-volume','-12','-nomouse','-nojoystick']);
        restoreOriginal().then(()=>{restored=true;requestAnimationFrame(draw);}).catch(fail);
      }
    };
    const script = document.createElement('script');
    script.src = new URL('./wing90.js',import.meta.url).href;
    script.onerror = () => fail('原机运行核心未加载');
    document.body.append(script);
  } catch (error) { fail(error); }
};

post('ready');

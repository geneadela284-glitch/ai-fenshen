const FILES=new Set(['intro','shuffle','deal','deal1','deal2','deal3','deal4','deal5','hold','release','flip','even','pair','win','bigwin','jackpot','roll','double','loss','push','collect','cheer']);
export class PokerAudio {
  constructor({contextFactory=()=>new (globalThis.AudioContext||globalThis.webkitAudioContext)(),fetchImpl=(...args)=>globalThis.fetch(...args),documentImpl=globalThis.document,onUnavailable=()=>{}}={}) {
    this.factory=contextFactory;this.fetch=fetchImpl;this.document=documentImpl;this.onUnavailable=onUnavailable;this.enabled=true;this.volume=0.4;this.epoch=0;this.closed=false;this.sources=new Set();this.timers=new Set();this.buffers=new Map();
    this.visibility=()=>{if(this.document?.hidden)this.stop();};this.document?.addEventListener('visibilitychange',this.visibility);
  }
  async unlock() {
    if(this.closed||!this.enabled)return false;
    try{if(!this.ctx){this.ctx=this.factory();this.gain=this.ctx.createGain();this.gain.gain.value=this.volume;this.gain.connect(this.ctx.destination);}if(this.ctx.state!=='running')await this.ctx.resume();return !this.closed&&this.ctx.state==='running';}catch{this.onUnavailable();return false;}
  }
  configure({soundEnabled=this.enabled,volume=this.volume}) {this.enabled=soundEnabled;this.volume=Math.max(0,Math.min(1,volume));if(this.gain)this.gain.gain.value=this.volume;if(!this.enabled)this.stop();}
  async buffer(name) {
    if(!FILES.has(name))throw Error('未知音效');
    if(!this.buffers.has(name))this.buffers.set(name,(async()=>{const response=await this.fetch(`/audio/poker/${name}.wav?v=att-award-2`);if(!response.ok)throw Error('声音加载失败');return this.ctx.decodeAudioData(await response.arrayBuffer());})().catch(error=>{this.buffers.delete(name);throw error;}));
    return this.buffers.get(name);
  }
  async play(name,{when,loop=false,duration}={}) {
    if(!this.enabled||this.closed||this.document?.hidden)return false;
    const epoch=this.epoch;
    try{if(!await this.unlock())return false;const buffer=await this.buffer(name);if(this.closed||epoch!==this.epoch||!this.enabled||this.document?.hidden)return false;
      if(this.sources.size>=6)return false;
      if(when!==undefined&&this.ctx.currentTime-when>.06)return false;
      const source=this.ctx.createBufferSource();source.buffer=buffer;source.loop=loop;source.connect(this.gain);this.sources.add(source);source.onended=()=>{this.sources.delete(source);source.disconnect();};const start=Math.max(this.ctx.currentTime,when??this.ctx.currentTime);source.start(start);if(duration!==undefined)source.stop(start+duration/1000);return true;
    }catch{if(!this.closed&&epoch===this.epoch)this.onUnavailable();return false;}
  }
  async warm(){
    if(!this.ctx||this.warming||this.closed||!this.enabled)return;
    this.warming=true;
    try{
      // Active-round preparation takes priority; background requests stay below
      // the existing public endpoint rate limit instead of bursting all files.
      for(const name of ['pair','shuffle','deal1','deal2','deal3','deal4','deal5','roll','loss','push','collect','hold','release','even','cheer']){
        if(this.closed||!this.enabled||this.document?.hidden)return;
        await this.buffer(name).catch(()=>{});
        if(this.closed)return;
        await new Promise(resolve=>setTimeout(resolve,160));
      }
    }finally{this.warming=false;}
  }
  async prepare(names,timeout=700){
    if(!this.enabled||this.closed)return false;
    let timer;try{return await Promise.race([(async()=>{if(!await this.unlock())return false;await Promise.all(names.map(name=>this.buffer(name)));return !this.closed;})(),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeout);})]);}catch{if(!this.closed)this.onUnavailable();return false;}finally{clearTimeout(timer);}
  }
  sequence(events) {this.stop();const epoch=this.epoch,base=this.ctx?.currentTime;for(const event of events){const timer=setTimeout(()=>{this.timers.delete(timer);if(epoch===this.epoch)void this.play(event.name,{...event,when:base===undefined?undefined:base+(event.at||0)/1000});},event.at||0);this.timers.add(timer);}}
  stop(){this.epoch++;for(const timer of this.timers)clearTimeout(timer);this.timers.clear();for(const source of [...this.sources]){try{source.stop();}catch{}source.disconnect();}this.sources.clear();}
  close(){this.stop();this.closed=true;this.document?.removeEventListener('visibilitychange',this.visibility);this.ctx?.close().catch(()=>{});this.buffers.clear();}
}

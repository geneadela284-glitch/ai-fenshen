function stopped(){return Object.assign(new Error('PLAYBACK_MANAGER_DISPOSED'),{code:'PLAYBACK_MANAGER_DISPOSED'})}
// Coordinates only resource ownership; playback and recording implementations stay unchanged.
export function createMeetingRecordingPlaybackGate(){
 let blocked=false,generation=0,closed=false;const sessions=new Set(),waiters=new Set();
 const wake=()=>{for(const fn of [...waiters])fn()};
 return {
  async suspend(){if(closed)throw stopped();blocked=true;generation++;await Promise.all([...sessions].map(s=>s.quiesce()))},
  release(){if(closed)return;blocked=false;wake()},
  async dispose(){closed=true;blocked=true;generation++;wake();await Promise.all([...sessions].map(s=>s.dispose()))},
  createSession(factory){
   let disposed=false,raw=null,rawOpening=null,opening=null,args=null;
   const assertLive=()=>{if(disposed||closed)throw stopped()};
   async function allowed(){assertLive();if(!blocked)return;await new Promise((resolve,reject)=>{const fn=()=>{if(disposed||closed){waiters.delete(fn);reject(stopped())}else if(!blocked){waiters.delete(fn);resolve()}};waiters.add(fn);fn()});assertLive()}
   async function quiesce(){const current=raw;const pending=rawOpening;await current?.dispose();await pending?.catch(()=>{});await current?.dispose();if(raw===current)raw=null}
   async function prepare(){for(;;){await allowed();if(blocked)continue;const own=generation;const current=raw||(raw=factory());const task=current.open(args);rawOpening=task;let result;try{result=await task}catch(e){if(own===generation&&!disposed&&!closed)throw e}finally{if(rawOpening===task)rawOpening=null}assertLive();if(own!==generation||blocked)continue;return result}}
   function open(input){assertLive();args=input;if(!opening){opening=prepare().finally(()=>{opening=null})}return opening}
   const api={
    open,
    async play(){for(;;){await allowed();if(blocked)continue;if(!raw){if(!args)throw stopped();await open(args);continue}return raw.play()}},
    async pause(){return raw?.pause()},
    async seekTo(...values){for(;;){await allowed();if(blocked)continue;if(!raw){await open(args);continue}return raw.seekTo(...values)}},
    async skipBy(...values){for(;;){await allowed();if(blocked)continue;if(!raw){await open(args);continue}return raw.skipBy(...values)}},
    getSnapshot(){return raw?.getSnapshot()||{opened:false,resources:{activeResources:0,activeUrls:0,finalActiveResources:0}}},
    getAudioElement(){return raw?.getAudioElement?.()||null},
    async dispose(){if(disposed)return;disposed=true;wake();await quiesce();sessions.delete(internal)}
   };
   const internal={quiesce,dispose:api.dispose};sessions.add(internal);return Object.freeze(api);
  }
 };
}

export function coordinateMeetingRecordingPlayback(manager,gate){
 const capture=name=>async(...args)=>{await gate.suspend();try{return await manager[name](...args)}catch(error){if(['idle','paused'].includes(manager.getSnapshot().recorderStatus))gate.release();throw error}};
 const finish=name=>async(...args)=>{const result=await manager[name](...args);gate.release();return result};
 return Object.freeze({...manager,startRecording:capture('startRecording'),resumeRecording:capture('resumeRecording'),pauseRecording:finish('pauseRecording'),stopRecording:finish('stopRecording'),interruptRecording:finish('interruptRecording'),async dispose(){try{await gate.dispose()}finally{await manager.dispose()}}});
}

// Legacy delivery annotations are transport metadata, never assistant dialogue.
// Hold possible prefixes across deltas so no part is emitted before it is known.
const statements = [
 '这条语音未确认完整播放，用户可能没有听完。',
 '这条语音未确认完整播放,用户可能没有听完。',
 '这条语音未确认完整播放。', '用户可能没有听完。'
];
const notes = statements.flatMap(text => [text,text.slice(0,-1)]).flatMap(text => [text, `[${text}]`, `【${text}】`]);
export class PlaybackNoteFilter {
 constructor(){this.pending='';}
 push(delta,final=false){
  this.pending+=String(delta||'');let output='';
  while(this.pending){
   if(!final&&notes.some(note=>note.length>this.pending.length&&note.startsWith(this.pending)))break;
   const match=notes.find(note=>this.pending.startsWith(note));
   if(match){this.pending=this.pending.slice(match.length);continue;}
   if(!final&&notes.some(note=>note.startsWith(this.pending)))break;
   output+=this.pending[0];this.pending=this.pending.slice(1);
  }
  return output;
 }
 finish(){return this.push('',true);}
}
export function stripPlaybackNotes(value){const filter=new PlaybackNoteFilter();return filter.push(value)+filter.finish();}

import { PlaybackNoteFilter } from './playbackText.js';
// Keep incomplete markup in the parser so a hidden annotation split between
// streamed deltas cannot become spoken text in the next delta.
export class SpeechText {
 constructor(){this.playbackNotes=new PlaybackNoteFilter();this.raw='';this.sentence='';this.hidden=false;this.total=0;}
 push(delta){this.raw+=this.playbackNotes.push(delta);return this.drain(false);}
 finish(){this.raw+=this.playbackNotes.finish();return this.drain(true);}
 drain(final){const output=[];
  const emit=()=>{const text=this.sentence.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/g,'').replace(/[*#`_>|]/g,'').trim();this.sentence='';if(!text)return;this.total+=text.length;if(this.total>3000)throw Object.assign(new Error('VOICE_SPEECH_TEXT_LIMIT'),{code:'VOICE_SPEECH_TEXT_LIMIT'});output.push(text);};
  while(this.raw){
   if(this.hidden){const end=this.raw.indexOf('-->');if(end<0){this.raw=final?'':this.raw.slice(-2);break;}this.raw=this.raw.slice(end+3);this.hidden=false;continue;}
   if(this.raw[0]==='<'){
    if(this.raw.startsWith('<!--')){this.hidden=true;this.raw=this.raw.slice(4);continue;}
    if(!final&&'<!--'.startsWith(this.raw))break;
    const end=this.raw.indexOf('>');if(end<0){if(final)this.raw='';break;}this.raw=this.raw.slice(end+1);continue;
   }
   const char=this.raw[0];this.raw=this.raw.slice(1);this.sentence+=char;
   if(/[。！？!?\n]/.test(char)||(/[，,；;：:]/.test(char)&&this.sentence.length>=12))emit();
   if(this.sentence.length>6000)throw Object.assign(new Error('VOICE_SPEECH_TEXT_LIMIT'),{code:'VOICE_SPEECH_TEXT_LIMIT'});
  }
  if(final)emit();return output;
 }
}

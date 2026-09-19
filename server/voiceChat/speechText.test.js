import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechText } from './speechText.js';
test('a complete early clause can start synthesis before a long sentence finishes',()=>{
 const speech=new SpeechText();assert.deepEqual(speech.push('我们可以先把周末的行程分成两天，'),['我们可以先把周末的行程分成两天，']);
 assert.deepEqual([...speech.push('第一天去海边。'),...speech.finish()],['第一天去海边。']);
});
test('streamed hidden annotations stay hidden across every split and sentence boundary', () => {
 const input='你好。<!-- secret。\nDATA -->接着说！';
 for(let split=0;split<=input.length;split++){
  const text=new SpeechText();const result=[...text.push(input.slice(0,split)),...text.push(input.slice(split)),...text.finish()].join('');
  assert.equal(result,'你好。接着说！');
 }
});
test('unfinished hidden annotations are discarded; long answers fail instead of pretending full playback',()=>{
 const text=new SpeechText();assert.deepEqual(text.push('回答。<!--秘密'),['回答。']);assert.deepEqual(text.finish(),[]);
 assert.throws(()=>new SpeechText().push('很'.repeat(3001)+'。'),{code:'VOICE_SPEECH_TEXT_LIMIT'});
});

test('legacy playback notes cannot be read even when split across streamed deltas',()=>{
 for(const note of ['[这条语音未确认完整播放，用户可能没有听完。]','这条语音未确认完整播放，用户可能没有听完。','这条语音未确认完整播放，用户可能没有听完']){
 const input='你好。'+note+'我们继续聊。';for(let split=0;split<=input.length;split++){const parser=new SpeechText();assert.equal([...parser.push(input.slice(0,split)),...parser.push(input.slice(split)),...parser.finish()].join(''),'你好。我们继续聊。');}}
});

test('ordinary playback discussion and unmatched short prefixes remain audible',()=>{
 for(const input of ['我刚才没听清，你再说一遍。','这条语音','用户可能希望继续聊。']){const parser=new SpeechText();assert.equal([...parser.push(input),...parser.finish()].join(''),input);}
});

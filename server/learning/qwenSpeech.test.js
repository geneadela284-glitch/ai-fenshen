import test from 'node:test';import assert from 'node:assert/strict';
import {qwenSpeechTransport,normalizeSpeechWav,approvedAudioUrl}from'./qwenSpeech.js';
import{encodePcm16Wav}from'../../apps/desktop/src/prototypes/aiFenshen/dictationRecorder.js';
const audio=Buffer.from(encodePcm16Wav(Float32Array.from({length:16000},(_,i)=>.1*Math.sin(i/10))));
test('speech transport sends audio only to approved configured endpoint and never forwards credentials to returned audio URL',async()=>{
 const calls=[];const fetchImpl=async(url,options={})=>{calls.push({url:String(url),options});if(calls.length===1)return new Response(JSON.stringify({output:{audio:{url:'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/sample.wav'}},usage:{characters:6}}));return new Response(audio);};
 const result=await qwenSpeechTransport({kind:'synthesize',input:'Hello.',apiKey:'secret-test',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',fetchImpl});assert.equal(result.audio.length,audio.length);assert.equal(calls[0].options.headers.Authorization,'Bearer secret-test');assert.ok(!calls[1].options.headers?.Authorization);assert.ok(calls[1].url.startsWith('https:'));
 await assert.rejects(qwenSpeechTransport({kind:'transcribe',input:audio,apiKey:'secret-test',baseUrl:'https://evil.example/compatible-mode/v1',fetchImpl}),{code:'SPEECH_ENDPOINT_INVALID'});
 assert.throws(()=>approvedAudioUrl('https://127.0.0.1/private'),{code:'SPEECH_OUTPUT_INVALID'});
});
test('audio normalization rejects corrupt data instead of labeling it a successful utterance',()=>{assert.deepEqual(normalizeSpeechWav(audio),audio);assert.throws(()=>normalizeSpeechWav(Buffer.alloc(44)),{code:'AUDIO_INVALID'});});
test('only the observed provider streaming WAV framing is finalized, while arbitrary bad lengths remain rejected',()=>{
 const pcm=Buffer.from(audio);pcm.writeUInt32LE(0x7fffffbf,4);pcm.writeUInt32LE(0x7fffff9b,40);
 // This exact vendor framing is PCM16 mono 24kHz. Upload validation remains strictly 16kHz.
 pcm.writeUInt32LE(24000,24);pcm.writeUInt32LE(48000,28);
 const result=normalizeSpeechWav(pcm);assert.equal(result.readUInt32LE(24),16000);assert.equal(result.readUInt32LE(4)+8,result.length);
 const corrupt=Buffer.from(audio);corrupt.writeUInt32LE(audio.length+100,4);assert.throws(()=>normalizeSpeechWav(corrupt),{code:'AUDIO_INVALID'});
 const truncated=pcm.subarray(0,pcm.length-1);assert.throws(()=>normalizeSpeechWav(truncated),{code:'AUDIO_INVALID'});
});

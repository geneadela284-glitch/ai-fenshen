import test from 'node:test';import assert from 'node:assert/strict';
import {resolveBetaServerConfig} from '../betaServerConfig.js';
test('voice optimizations default off, can be enabled separately, and reject ambiguous config',()=>{
 const config=env=>resolveBetaServerConfig({env,projectRoot:'/tmp/voice-config-synthetic'}).voiceCoreOptions;
 assert.deepEqual(config({}),{lowLatency:false,ordinaryChat:false,conservativeInterruption:false});
 assert.deepEqual(config({AI_FENSHEN_VOICE_LOW_LATENCY:'true'}),{lowLatency:true,ordinaryChat:false,conservativeInterruption:false});
 assert.throws(()=>config({AI_FENSHEN_VOICE_CONSERVATIVE_INTERRUPTION:'yes'}));
});

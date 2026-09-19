import test from 'node:test';import assert from 'node:assert/strict';
import { gameIntent } from './intent.js';
test('only explicit game launching commands are captured',()=>{assert.equal(gameIntent('打开游戏'),'lobby');assert.equal(gameIntent('我想玩老虎扑克机'),'poker');assert.equal(gameIntent('玩扑克机。'),'poker');for(const text of ['解释扑克机规则','游戏行业分析','我不想玩扑克机','打开游戏文件','学英语'])assert.equal(gameIntent(text),null);});

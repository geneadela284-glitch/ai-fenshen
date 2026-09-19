import test from 'node:test';import assert from 'node:assert/strict';
import {deterministicIdentityAnswer} from './identityDeterministic.js';
const creator='我是由示例维护者创建的。';
const biography='示例维护者，身份信息已脱敏。';
test('natural creator questions share one deterministic identity across paraphrases',()=>{
 for(const q of ['你是由谁研发的？','你是哪个人创造出来的？','你是谁开发出来的呢？','请问一下，你到底是谁创造出来的呀？','谁把你设计出来的？','AI分身是谁研发出来的？','你是哪个团队开发的？','你的创始人是谁？','谁是你的开发者？','是谁创造了你？','你究竟是由哪家公司研发的？'])assert.equal(deterministicIdentityAnswer(q)?.content,creator,q);
});
test('maintainer followups use the same de-identified biography',()=>{
 for(const q of ['维护者是谁？','那维护者是什么人？','维护者的真名是什么？','维护者本名叫什么？','介绍一下维护者','能介绍一下维护者吗？','维护者是哪里人？','维护者属什么？'])assert.equal(deterministicIdentityAnswer(q)?.content,biography,q);
});
test('identity classification does not capture third parties, quotations, or mixed business requests',()=>{
 for(const q of ['谁开发了微信','牛顿是谁创造的','维护者是谁的同事','谁创造了他','谁开发了它','介绍一下维护者的公司','你是谁开发的，帮我记下明天见客户','请解释这句话：谁创造了你','将谁创造了你翻译成英文'])assert.equal(deterministicIdentityAnswer(q),null,q);
});

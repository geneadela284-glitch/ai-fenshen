import test from 'node:test';import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{applyConversationMigrations}from'../conversation/migrations.js';import{createLearningRuntime}from'./runtime.js';
test('disabling learning retains owner export and deletion without disturbing existing conversations',()=>{
 const db=new DatabaseSync(':memory:');applyConversationMigrations(db);const key=Buffer.alloc(32,42);let runtime=createLearningRuntime({database:db,encryptionKey:key,enabled:true});
 const s=runtime.service.start('a',{consentAI:true,persist:true,operationId:'keep',lessonId:'hello'});runtime.repository.conversations.createForOwner('b',{title:'untouched'});runtime.close();
 runtime=createLearningRuntime({database:db,encryptionKey:key,enabled:false});assert.equal(runtime.enabled,false);assert.equal(runtime.service.export('a').sessions[0].id,s.session.id);runtime.service.deleteAllForOwner('a');assert.equal(runtime.service.export('a').sessions.length,0);assert.equal(runtime.repository.conversations.listForOwner('b').length,1);runtime.close();db.close();
});
test('temporary practice is absent after shutdown and can be deleted after a lost response changed its revision',async()=>{
 const db=new DatabaseSync(':memory:');applyConversationMigrations(db);const key=Buffer.alloc(32,42);let runtime=createLearningRuntime({database:db,encryptionKey:key,enabled:true});
 const s=runtime.service.start('a',{consentAI:true,persist:false,operationId:'temp',lessonId:'hello'});await runtime.service.turn('a',s.session.id,{revision:1,clientTurnId:'lost',transcript:'Hello'});assert.deepEqual(runtime.service.action('a',s.session.id,{action:'delete',revision:1}),{deleted:true});
 const second=runtime.service.start('a',{consentAI:true,persist:false,operationId:'temp2',lessonId:'hello'});runtime.close();runtime=createLearningRuntime({database:db,encryptionKey:key,enabled:true});assert.throws(()=>runtime.service.view('a',second.session.id),{code:'LEARNING_NOT_FOUND'});assert.equal(runtime.service.export('a').sessions.length,0);runtime.close();db.close();
});

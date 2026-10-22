import test from 'node:test';
import assert from 'node:assert/strict';
import * as resources from './attachmentClient.js';

// Missing authenticated fetch must fail: local app img URLs cannot reach the server.
test('preview reads authenticated binary through fetch and releases its temporary URL', async () => {
  assert.equal(typeof resources.createAttachmentPreviewResource, 'function');
  const bytes = new Uint8Array([137,80,78,71]);
  let options; const revoked=[];
  const resource=resources.createAttachmentPreviewResource('/api/attachments/att_a/content', {
    fetchImpl: async (url, init) => { assert.equal(url,'/api/attachments/att_a/content?preview=1'); options=init; return new Response(bytes,{headers:{'content-type':'image/png'}}); },
    createObjectURL: blob => {assert.equal(blob.size,4); return 'blob:test';}, revokeObjectURL: url=>revoked.push(url)
  });
  assert.equal(await resource.ready,'blob:test');
  assert.equal(options.credentials,'include');
  resource.dispose();resource.dispose();assert.deepEqual(revoked,['blob:test']);
});

test('preview rejects unauthorized and non-image responses without creating a URL', async () => {
  assert.equal(typeof resources.createAttachmentPreviewResource,'function');
  for(const response of [new Response('{}',{status:401}),new Response('<html/>',{headers:{'content-type':'text/html'}})]){
    const resource=resources.createAttachmentPreviewResource('/api/attachments/att_a/content',{fetchImpl:async()=>response,createObjectURL:()=>assert.fail('must not render failed response')});
    await assert.rejects(resource.ready);resource.dispose();
  }
});

test('removal while image is loading aborts and never creates a late object URL', async()=>{
  assert.equal(typeof resources.createAttachmentPreviewResource,'function');
  let finish;let signal;
  const resource=resources.createAttachmentPreviewResource('/api/attachments/att_a/content',{fetchImpl:async(_,init)=>{signal=init.signal;return new Promise(resolve=>{finish=resolve;});},createObjectURL:()=>assert.fail('late image leaked')});
  resource.dispose();assert.equal(signal.aborted,true);finish(new Response('image',{headers:{'content-type':'image/png'}}));
  await assert.rejects(resource.ready,{name:'AbortError'});
});

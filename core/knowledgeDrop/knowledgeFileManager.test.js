import assert from 'node:assert/strict';
import { KnowledgeFileManager } from './knowledgeFileManager.js';

function createRepository() {
  return {
    items: [],
    create(item) { this.items.unshift(item); return item; },
    read(id) { return this.items.find((item) => item.id === id) || null; },
    readAll() { return [...this.items]; },
    delete(id) { this.items = this.items.filter((item) => item.id !== id); return true; }
  };
}

const repository = createRepository();
const events = [];
const manager = new KnowledgeFileManager({ repository, events: { createEvent(event) { events.push(event); return event; } } });

const textFile = manager.addFile({ name: '会议记录.txt', type: 'text/plain', size: 120, localPath: 'local-ref://会议记录.txt' });
assert.equal(textFile.status, 'ready');
assert.equal(textFile.name, '会议记录.txt');
assert.equal(manager.listFiles().length, 1);
assert.equal(events[0].title, 'knowledge_file_added');
assert.equal(events[0].metadata.fileId, textFile.id);

const unsupported = manager.addFile({ name: 'archive.zip', type: 'application/zip', size: 12 });
assert.equal(unsupported.status, 'failed');
assert.match(unsupported.error, /暂不支持/);

assert.equal(manager.deleteFile(textFile.id), true);
assert.equal(manager.listFiles().length, 1);

console.log('Knowledge file manager tests PASS');

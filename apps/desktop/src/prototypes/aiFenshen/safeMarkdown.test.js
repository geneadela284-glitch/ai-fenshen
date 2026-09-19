import assert from 'node:assert/strict';
import test from 'node:test';

async function subject() {
  try {
    return await import('./safeMarkdown.js');
  } catch {
    return null;
  }
}

test('restricted Markdown parses headings, paragraphs, lists and rules', async () => {
  const markdown = await subject();
  assert.equal(typeof markdown?.parseSafeMarkdown, 'function');
  const blocks = markdown.parseSafeMarkdown('# 标题\n\n正文\n\n1. 第一项\n2. 第二项\n\n- A\n- B\n\n---');
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'list', 'list', 'rule']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[2].ordered, true);
  assert.equal(blocks[3].ordered, false);
});

test('restricted Markdown parses bold, italic, inline code and fenced code', async () => {
  const markdown = await subject();
  const blocks = markdown.parseSafeMarkdown('**粗体**、*斜体*、`const x = 1`\n\n```js\nalert("x")\n```');
  assert.deepEqual(blocks[0].inlines.map((part) => part.type), ['strong', 'text', 'emphasis', 'text', 'code']);
  assert.deepEqual(blocks[1], { type: 'codeBlock', language: 'js', content: 'alert("x")' });
});

test('restricted Markdown treats raw HTML as inert text and tolerates unfinished streams', async () => {
  const markdown = await subject();
  const blocks = markdown.parseSafeMarkdown('<script>globalThis.hacked=true</script>\n\n```js\nconst partial =');
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].inlines[0].value, '<script>globalThis.hacked=true</script>');
  assert.equal(blocks[1].type, 'codeBlock');
  assert.equal(blocks[1].content, 'const partial =');
  assert.equal(JSON.stringify(blocks).includes('dangerouslySetInnerHTML'), false);
});


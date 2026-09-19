function inlineToken(type, value) {
  return { type, value };
}

export function parseInlineMarkdown(value = '') {
  const source = String(value);
  const tokens = [];
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) tokens.push(inlineToken('text', source.slice(cursor, match.index)));
    if (match[2] !== undefined) tokens.push(inlineToken('strong', match[2]));
    else if (match[3] !== undefined) tokens.push(inlineToken('code', match[3]));
    else tokens.push(inlineToken('emphasis', match[4] ?? match[5]));
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length || tokens.length === 0) tokens.push(inlineToken('text', source.slice(cursor)));
  return tokens;
}

function paragraph(lines) {
  return { type: 'paragraph', inlines: parseInlineMarkdown(lines.join('\n')) };
}

export function parseSafeMarkdown(value = '') {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^```([^`]*)$/);
    if (fence) {
      const content = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'codeBlock', language: fence[1].trim(), content: content.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, inlines: parseInlineMarkdown(heading[2]) });
      index += 1;
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }
    const listItem = line.match(/^\s*(?:(\d+)\.|([-+*]))\s+(.+)$/);
    if (listItem) {
      const ordered = Boolean(listItem[1]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:(\d+)\.|([-+*]))\s+(.+)$/);
        if (!item || Boolean(item[1]) !== ordered) break;
        items.push(parseInlineMarkdown(item[3]));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      if (/^```|^#{1,6}\s+|^\s*(?:\d+\.|[-+*])\s+|^\s*(?:---+|___+|\*\*\*+)\s*$/.test(lines[index])) break;
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(paragraph(paragraphLines));
  }
  return blocks;
}


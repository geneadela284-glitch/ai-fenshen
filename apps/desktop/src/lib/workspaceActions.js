export function buildMockResult(config, category, input) {
  const base = config.mockResults?.[category] || '';
  return `${base}\n\n---\n需求：${input || config.placeholder}`;
}

export async function copyText(text) {
  if (!text) return;
  await navigator.clipboard?.writeText(text);
}

export function exportMarkdown(config, category, result) {
  if (!result) return;
  const blob = new Blob([`# ${category}${config.title}\n\n${result}\n`], {
    type: 'text/markdown;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${config.exportFilePrefix || 'AI-Work-Center'}-${category}${config.title}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

export function diaryMessageDisplay(content) {
  const ids = [];
  const text = String(content || '')
    .replace(/<!-- diary-proposal-v1:[A-Za-z0-9_-]+ -->/g, '')
    .replace(/\[[^\]]*\]\(\/#diary=([A-Za-z0-9_-]+)\)/g, (_, id) => { ids.push(id); return ''; })
    .replace(/\/#diary=([A-Za-z0-9_-]+)/g, (_, id) => { ids.push(id); return ''; }).trim();
  return {text,ids:[...new Set(ids)]};
}

export function healthMessageDisplay(content) {
 const ids=[];const text=String(content||'').replace(/<!-- health-turn-v1 -->/g,'').replace(/<!-- health-proposal-v1:[A-Za-z0-9_-]+ -->/g,'').replace(/\[[^\]]*\]\(\/#health=([A-Za-z0-9_-]+)\)/g,(_,id)=>{ids.push(id);return '';}).trim();
 return {text,ids:[...new Set(ids)]};
}

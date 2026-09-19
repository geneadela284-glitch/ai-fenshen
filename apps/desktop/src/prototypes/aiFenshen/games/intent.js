export function gameIntent(text) {
  const value=String(text||'').trim().replace(/[。！!？?]$/,'');
  if(/^(?:我想|我要|帮我)?(?:打开|进入)(?:一下)?游戏$/.test(value))return 'lobby';
  if(/^(?:我想|我要|帮我)?(?:打开|进入|玩)(?:一下)?(?:老虎)?扑克机$/.test(value))return 'poker';
  if(import.meta.env?.VITE_AI_FENSHEN_MAHJONG_ENABLED==='true'&&/^(?:我想|我要|帮我)?(?:打开|进入|玩)(?:一下)?(?:龙虎争霸[2２Ⅱ]?|龙虎争霸麻将|麻将)$/.test(value))return 'mahjong';
  return null;
}

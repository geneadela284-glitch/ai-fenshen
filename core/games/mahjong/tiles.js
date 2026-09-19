export const STAKES = [1, 2, 5, 10, 20];
export const RULES_VERSION = 'mahjong-basic-1';
export const tileType = id => Math.floor(id / 4);
export const isFlower = id => id >= 136;
const honors = ['东', '南', '西', '北', '中', '發', '白'];
const flowers = ['春', '夏', '秋', '冬', '梅', '兰', '竹', '菊'];
export function tileName(id) {
  if (isFlower(id)) return flowers[id - 136];
  const type = tileType(id);
  return type < 27 ? `${type % 9 + 1}${['万', '筒', '条'][Math.floor(type / 9)]}` : honors[type - 27];
}
export const sortTiles = hand => [...hand].sort((a, b) => a - b);
export function assertTiles(hand, {flowers: allowFlowers = false} = {}) {
  if (!Array.isArray(hand) || new Set(hand).size !== hand.length || hand.some(id => !Number.isInteger(id) || id < 0 || id >= (allowFlowers ? 144 : 136))) throw Error('牌局记录无效，请保留记录后重试。');
}
export function shuffledWall() {
  const wall = Array.from({length:144}, (_, i) => i);
  const word = new Uint32Array(1);
  for (let i = wall.length - 1; i > 0; i--) {
    const size = i + 1, limit = Math.floor(4294967296 / size) * size;
    do { globalThis.crypto.getRandomValues(word); } while (word[0] >= limit);
    const j = word[0] % size;
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  return wall;
}

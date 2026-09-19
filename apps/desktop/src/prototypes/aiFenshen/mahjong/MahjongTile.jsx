import {tileName,tileType,isFlower} from '../../../../../../core/games/mahjong/tiles.js';
import './tiles.css';

const numerals=['一','二','三','四','五','六','七','八','九'];
const positions={1:[[50,50]],2:[[50,24],[50,76]],3:[[26,24],[50,50],[74,76]],4:[[28,24],[72,24],[28,76],[72,76]],5:[[28,24],[72,24],[50,50],[28,76],[72,76]],6:[[28,20],[72,20],[28,50],[72,50],[28,80],[72,80]],7:[[26,18],[50,32],[74,18],[28,55],[72,55],[28,82],[72,82]],8:[[28,14],[72,14],[28,38],[72,38],[28,62],[72,62],[28,86],[72,86]],9:[[24,18],[50,18],[76,18],[24,50],[50,50],[76,50],[24,82],[50,82],[76,82]]};
function Face({id}){
  const type=tileType(id),rank=type%9+1,suit=Math.floor(type/9);
  if(isFlower(id))return <><path d="M50 9 Q68 28 52 39 Q78 24 85 49 Q68 68 56 52 Q72 79 50 90 Q30 77 43 53 Q17 72 14 49 Q29 27 44 40 Q29 19 50 9" fill="none" stroke="#9b752e" strokeWidth="3"/><text x="50" y="61" className="mj-glyph mj-flower-glyph">{tileName(id)}</text></>;
  if(type>=27)return type===33?<rect x="24" y="14" width="52" height="72" rx="4" fill="none" stroke="#23597a" strokeWidth="5"/>:<text x="50" y="73" className={`mj-glyph ${type===31?'mj-red':type===32?'mj-green':''}`}>{tileName(id)}</text>;
  if(suit===0)return <><text x="50" y="43" className="mj-number">{numerals[rank-1]}</text><text x="50" y="89" className="mj-glyph mj-red mj-wan">萬</text></>;
  if(suit===1)return <>{positions[rank].map(([x,y],i)=><g key={i} stroke={rank===1?'#1f5b70':i===4?'#a4312d':i%3===0?'#176d52':'#245571'} fill="none"><circle cx={x} cy={y} r={rank===1?30:9.5} strokeWidth={rank===1?5:3.4}/><circle cx={x} cy={y} r={rank===1?19:4} strokeWidth="2"/>{rank===1&&<path d="M50 24V76M24 50H76M32 32L68 68M68 32L32 68" stroke="#a4312d" strokeWidth="3"/>}</g>)}</>;
  if(rank===1)return <g fill="none" stroke="#176d52" strokeWidth="3.5" strokeLinecap="round"><path d="M50 17 Q28 13 33 31 Q40 42 55 44 Q75 56 63 75 L40 87 M53 42 Q22 45 28 68 Q45 69 53 49 M39 23L25 26 M57 68L64 87 M54 68L51 90"/><path d="M37 42Q39 61 29 69M51 45L59 53M46 51L54 59"/><circle cx="41" cy="22" r="2" fill="#a4312d" stroke="none"/></g>;
  return <>{positions[rank].map(([x,y],i)=><g key={i} stroke={rank===7&&i<3?'#a4312d':'#176d52'} strokeWidth="5" strokeLinecap="round"><path d={`M${x-3} ${y-8}L${x+3} ${y+8}`}/><path d={`M${x-7} ${y-6}L${x+1} ${y-10}M${x-1} ${y+10}L${x+7} ${y+6}`} strokeWidth="2.5"/></g>)}</>;
}
export default function MahjongTile({id,back=false,selected=false,disabled=false,onClick,small=false,label}){
  const classes=`mj-tile ${back?'mj-tile-back':''} ${selected?'mj-tile-selected':''} ${small?'mj-tile-small':''}`;
  const name=label||(back?'暗牌':tileName(id));
  const content=back?<span className="mj-back-pattern" aria-hidden="true">龍</span>:<svg viewBox="0 0 100 108" aria-hidden="true" focusable="false"><Face id={id}/></svg>;
  return onClick?<button type="button" className={classes} disabled={disabled} aria-label={name} aria-pressed={selected} onClick={onClick}>{content}</button>:<span className={classes} role="img" aria-label={name}>{content}</span>;
}

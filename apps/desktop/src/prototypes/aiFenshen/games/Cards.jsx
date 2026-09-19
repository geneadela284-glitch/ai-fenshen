import { cardFace } from '../../../../../../core/games/poker/rules.js';
export function Card({card,held=false,hidden=false,disabled=true,highlight=false,onClick,index=0}) {
  const face=card==null?null:cardFace(card);
  return <button type="button" className={`pg-card ${face?.red?'is-red':''} ${face?.joker?'is-joker':''} ${face?.joker?'is-dragon':''} ${card===52?'is-black-dragon':''} ${held?'is-held':''} ${hidden||!face?'is-back':''} ${highlight?'is-winning':''}`} aria-label={hidden||!face?`第${index+1}张牌背面`:`第${index+1}张 ${face.suit}${face.rank}${held?' 已保留':''}`} aria-pressed={held} disabled={disabled||hidden} onClick={onClick}>
    {hidden||!face?<span className="pg-card-back"><i>♠</i><small>POKER</small></span>:face.joker?<><span className="pg-joker-name">{face.rank}</span>{face.joker?<span className="pg-dragon-art"><img src={card===52?'/images/poker/black-dragon-joker-v1.png':'/images/poker/dragon-joker-v1.png'} alt="" draggable="false"/><i className="pg-dragon-light"/>{Array.from({length:8},(_,i)=><i key={i} className="pg-dragon-ember" style={{'--ember-angle':`${i*45}deg`}}/>)}</span>:<span className="pg-joker-symbol">★</span>}<span className="pg-joker-wild">百变牌</span></>:<><span className="pg-card-corner"><b>{face.rank}</b><i>{face.suit}</i></span><span className="pg-card-suit">{face.suit}</span><span className="pg-card-corner is-bottom"><b>{face.rank}</b><i>{face.suit}</i></span></>}
    {held&&!hidden&&<span className="pg-held">保留</span>}
  </button>;
}

import { useEffect, useRef } from 'react';
import { paytableForRules } from '../../../../../../core/games/poker/rules.js';
export function Dialog({title,onClose,children}) {
  const ref=useRef(null);
  useEffect(()=>{const el=ref.current;const previous=document.activeElement;el.showModal();return()=>{el.close();previous?.focus?.();};},[]);
  return <dialog ref={ref} className="pg-dialog" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><header><h2>{title}</h2><button type="button" aria-label="关闭" onClick={onClose}>×</button></header><div className="pg-dialog-body">{children}</div></dialog>;
}
export function Rules({onClose,rulesVersion=5}) {return <Dialog title="玩法与奖励" onClose={onClose}><p>{rulesVersion>=3?'54 张牌，大小王都是百变牌，自动按最高得分牌型结算。':'52 张牌，无大小王。'}先发五张，点击想留下的牌，再换掉其余牌一次。只计算最高牌型。</p><div className="pg-rules-table">{paytableForRules(rulesVersion).filter(x=>x.multiplier).map(row=><div key={row.id}><span>{row.label}</span><b>×{row.multiplier}</b></div>)}</div><p>倍数为总返还，包含本局投入。例如投入 10，一对 {rulesVersion===1?'J':rulesVersion>=5?'10':'8'} 返还 10，本局持平。A 可组成 A2345 或 10JQKA 顺子。</p>{rulesVersion>=3&&<p>五条是最大牌型，四张同点数加任一鬼牌，或三张同点数加两鬼牌，返还500倍。</p>}<h3>自选比大小</h3><p>2–7 为小，9–A 为大，8 为平局。{rulesVersion>=3?'抽到大王或小王，不论选大选小都算猜中。':''}猜中奖励翻倍，猜错待领取奖励归零；不会再扣余额。平局不计次数，最多比三次，随时可以领取。</p><h3>个人奖池</h3><p>每次猜错，本次输掉待领奖励的20%计入本机个人奖池，不再扣余额。累计猜错一次亮一层彩虹，满10层自动发放全部彩金，中间猜中不清零；发放后奖池与计数归零重新累计。</p><h3>轻松玩，随时停</h3><p>仅使用免费娱乐积分，无现金价值。余额不足 10 且当前没有牌局时，可以免费补充至 1000。牌局自动保存在本机；换设备不会自动同步。</p></Dialog>;}

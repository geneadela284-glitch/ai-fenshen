const colors=['#9665ff','#6573ff','#348fff','#21b8ec','#24d5c0','#62d574','#b8de4d','#ffd34e','#ff9a44','#ff626e'];
const number=n=>new Intl.NumberFormat('zh-CN').format(n);
export default function PrizePool({pool,award=0,disabled,onLegacyClaim}){
  const steps=award?10:Math.min(10,pool.lossCount);
  return <section className={`pg-prize-pool ${award?'is-paid':''}`} aria-label="彩虹奖池">
    <div className="pg-rainbow" role="progressbar" aria-label={award?'本轮彩虹已满，彩金已到账':'彩虹累计进度'} aria-valuemin={0} aria-valuemax={10} aria-valuenow={steps}>
      {colors.map((color,i)=><i key={i} className={`pg-rainbow-band ${i<steps?'is-lit':''}`} style={{'--band-color':color,width:`${37+i*7}%`}}/>)}
    </div>
    <div className="pg-pool-details">
      <span className="pg-pool-title">{award?'彩虹满格 · 彩金到账':'彩虹奖池'}</span>
      <strong>{award?'+':''}{number(award||pool.balance)} <small>分</small></strong>
      <p>{award?'已加入我的积分，下轮重新累计':`${steps} / 10 层 · 满格自动发彩金`}</p>
      <small>猜错奖励的20%入池 · 猜中不清零</small>
      {pool.lossCount>=10&&pool.balance>0&&<button disabled={disabled} onClick={onLegacyClaim}>领取之前累计的彩金</button>}
    </div>
  </section>;
}

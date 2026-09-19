export default function AIFenshenWordmark({ size = 'small', subtitle = false, reducedMotion }) {
  return (
    <div className={`af-wordmark af-wordmark-${size}`} role="img" aria-label="AI分身">
      <img
        className="af-wordmark-asset"
        src="/prototype/ai-fenshen/ai-fenshen-logo-primary.png"
        alt=""
        aria-hidden="true"
      />
      {subtitle ? <span className="af-wordmark-subtitle">你的专属AI数字分身</span> : null}
    </div>
  );
}

import { useId } from 'react';

function AISecretaryLogo({ size = 32, className = '', showGlow = true }) {
  const gradientId = useId();
  const shadowId = useId();
  const pixelSize = Number(size) || 32;

  return (
    <svg
      className={`ai-secretary-logo ${className}`}
      width={pixelSize}
      height={pixelSize}
      viewBox="0 0 64 64"
      role="img"
      aria-label="AI秘书 Logo"
      style={{ '--logo-size': `${pixelSize}px` }}
    >
      <defs>
        <linearGradient id={gradientId} x1="8" y1="7" x2="58" y2="57" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--logo-highlight, #DCEBFF)" />
          <stop offset="0.38" stopColor="var(--logo-start, #4DA3FF)" />
          <stop offset="0.7" stopColor="var(--logo-mid, #7C5CFF)" />
          <stop offset="1" stopColor="var(--logo-end, #E0B168)" />
        </linearGradient>
        <filter id={shadowId} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="6" stdDeviation="5" floodColor="var(--logo-shadow, rgba(76,123,255,0.38))" floodOpacity="0.9" />
        </filter>
      </defs>
      {showGlow ? <ellipse cx="32" cy="34" rx="27" ry="24" fill="var(--logo-glow, rgba(124,92,255,0.18))" /> : null}
      <rect x="8" y="8" width="48" height="48" rx="15" fill="var(--logo-plate, rgba(255,255,255,0.08))" stroke="var(--logo-border, rgba(255,255,255,0.18))" />
      <g filter={`url(#${shadowId})`}>
        <path d="M14 47 27 17h9l13 30h-9l-2.3-6.1H25.1L22.8 47H14Zm13.9-13.4h7.2l-3.6-9.8-3.6 9.8Z" fill={`url(#${gradientId})`} />
        <path d="M47 17h8v30h-8V17Z" fill={`url(#${gradientId})`} />
      </g>
      <path d="M15 49h34" stroke="var(--logo-sheen, rgba(255,255,255,0.34))" strokeLinecap="round" strokeWidth="2" opacity="0.55" />
    </svg>
  );
}

export default AISecretaryLogo;

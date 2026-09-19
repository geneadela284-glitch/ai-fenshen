export default function Icon({ name, size = 22, className = '' }) {
  return (
    <img
      aria-hidden="true"
      className={`af-icon ${className}`}
      height={size}
      src={`/prototype/ai-fenshen/icons/${name}.svg`}
      width={size}
      alt=""
    />
  );
}

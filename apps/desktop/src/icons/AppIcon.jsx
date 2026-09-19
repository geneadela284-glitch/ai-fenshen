const iconMap = {
  copywriting: ['✍', 'from-[#fff4da] to-[#f0dfc4]'],
  ppt: ['▦', 'from-[#f4eadf] to-[#dfcab4]'],
  video: ['▶', 'from-[#f7eee8] to-[#e7d2c5]'],
  image: ['◐', 'from-[#f1eee7] to-[#d9d1c5]'],
  office: ['□', 'from-[#f7f1e7] to-[#e2d5c1]'],
  qa: ['?', 'from-[#f5efe6] to-[#d7cbbc]']
};

function AppIcon({ id, icon, label, size = 'md' }) {
  const [symbol, tone] = iconMap[id] || [icon || label?.slice(0, 1) || 'AI', 'from-[#f2eee8] to-[#ddd4c8]'];
  const sizeClass = size === 'lg' ? 'h-16 w-16 text-2xl' : 'h-14 w-14 text-xl';

  return (
    <span
      className={`grid ${sizeClass} place-items-center rounded-[22px] bg-gradient-to-br ${tone} font-semibold text-[#2f2b27] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]`}
      aria-hidden="true"
    >
      {icon || symbol}
    </span>
  );
}

export default AppIcon;

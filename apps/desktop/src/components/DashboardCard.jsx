import AppIcon from '../icons/AppIcon';

function formatDate(value) {
  if (!value) return '暂无';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function DashboardCard({ card, active, summary, onClick }) {
  const recentOpened = summary?.recentOpened?.title || '暂无';
  const recentEdited = summary?.recentEdited?.title || '暂无';
  const continueText = summary?.continueWorkspace ? '继续工作' : '开始使用';

  return (
    <button
      onClick={onClick}
      className={`group flex min-h-[306px] flex-col rounded-[30px] border bg-white/88 p-6 text-left shadow-[0_18px_55px_rgba(60,54,45,0.08)] transition duration-200 hover:-translate-y-1.5 hover:shadow-[0_28px_80px_rgba(60,54,45,0.14)] active:scale-[0.975] ${
        active ? 'border-[#1f1f1f]' : 'border-white/80'
      }`}
    >
      <div className="mb-7 flex items-start justify-between">
        <div className="transition duration-200 group-hover:scale-105 group-hover:-rotate-1">
          <AppIcon id={card.id} icon={card.icon} label={card.title || card.name} />
        </div>
        <span className="rounded-full bg-[#f6f1e9] px-3 py-1 text-xs text-[#7b7164]">{card.tag}</span>
      </div>
      <h3 className="text-[21px] font-semibold leading-tight tracking-tight">{card.title || card.name}</h3>
      <p className="mt-3 flex-1 text-sm leading-6 text-[#746d64]">{card.description}</p>
      <div className="mt-5 space-y-1.5 rounded-[20px] bg-[#fbfaf7] p-3 text-xs text-[#7b7164]">
        <div className="truncate">最近打开：{recentOpened}</div>
        <div className="truncate">最近编辑：{recentEdited}</div>
        <div>最后编辑时间：{formatDate(summary?.lastEditedAt)}</div>
      </div>
      <div className="mt-5 flex items-center gap-2 text-sm font-medium text-[#1f1f1f]">
        {continueText}
        <span className="transition group-hover:translate-x-1">→</span>
      </div>
    </button>
  );
}

export default DashboardCard;

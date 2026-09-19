import PrimaryButton from './PrimaryButton';
import { eventManager } from '../../../../core/events/index.js';

const overviewItems = [
  { label: '今日必须完成', value: 3, note: '合同确认、客户回访、报价更新' },
  { label: 'AI 建议', value: 5, note: '优先处理高价值客户跟进' },
  { label: '已完成', value: 2, note: '已整理昨日会议和产品资料' },
  { label: '待处理', value: 4, note: '需要人工确认后继续' }
];

const suggestions = [
  '优先查看今日到期事项，避免客户跟进遗漏。',
  '把昨日会议内容整理成客户下一步行动。',
  '检查最近 Workspace 中未完成的报价和文案。'
];

const sourceLabels = {
  manual: 'Manual',
  document: 'Document',
  meeting: 'Meeting',
  contract: 'Contract',
  email: 'Email',
  note: 'Note',
  todo: 'Todo',
  ai: 'AI'
};

function formatDateParts(date = new Date()) {
  return {
    date: date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }),
    weekday: date.toLocaleDateString('zh-CN', { weekday: 'long' }),
    greeting: date.getHours() < 12 ? '早上好' : date.getHours() < 18 ? '下午好' : '晚上好'
  };
}

function formatTime(value) {
  if (!value) return '--:--';
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatDateTime(value) {
  if (!value) return '暂无记录';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function HomeDashboard({ tools, selectedCard, visibleCards, workspaceSummaries, knowledgeCount, toolStats, onOpenTool }) {
  const today = formatDateParts();
  const recentWorkspaces = Object.values(workspaceSummaries)
    .map((summary) => summary?.continueWorkspace)
    .filter(Boolean)
    .sort((a, b) => new Date(b.lastEditedAt || b.updatedAt) - new Date(a.lastEditedAt || a.updatedAt))
    .slice(0, 3);
  const recentEvents = eventManager.listEvents().slice(0, 4);
  const featuredTools = visibleCards.slice(0, 6);

  return (
    <div className="space-y-7">
      <section className="rounded-[32px] border border-white/80 bg-white/82 p-8 shadow-[0_24px_80px_rgba(60,54,45,0.08)]">
        <div className="grid grid-cols-[1.2fr_0.8fr] gap-8">
          <div>
            <div className="text-sm text-[#8a8378]">{today.date} · {today.weekday}</div>
            <h2 className="mt-3 text-[38px] font-semibold leading-tight tracking-tight">
              {today.greeting}，老板
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-[#6f695f]">
              今天先看必须完成的事项，再继续最近的工作。AI Work Center 会把事件、工作空间和建议集中在这里。
            </p>
          </div>
          <div className="rounded-[26px] bg-[#f8f5ef] p-5">
            <div className="text-sm font-semibold text-[#4d473f]">今日工作入口</div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-2xl bg-white/75 p-4">
                <div className="text-2xl font-semibold">{knowledgeCount}</div>
                <div className="mt-1 text-[#746d64]">知识条目</div>
              </div>
              <div className="rounded-2xl bg-white/75 p-4">
                <div className="text-2xl font-semibold">{toolStats.enabled}</div>
                <div className="mt-1 text-[#746d64]">可用工具</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-4 gap-4">
        {overviewItems.map((item) => (
          <div key={item.label} className="rounded-[26px] border border-white/80 bg-white/78 p-5 shadow-[0_16px_45px_rgba(60,54,45,0.06)]">
            <div className="text-sm text-[#8a8378]">{item.label}</div>
            <div className="mt-3 text-3xl font-semibold text-[#2a2927]">{item.value}</div>
            <p className="mt-3 text-sm leading-6 text-[#746d64]">{item.note}</p>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-[1fr_0.9fr] gap-6">
        <div className="rounded-[30px] border border-white/80 bg-white/78 p-6 shadow-[0_20px_60px_rgba(60,54,45,0.07)]">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <div className="text-sm text-[#8a8378]">Continue Working</div>
              <h3 className="mt-1 text-2xl font-semibold">最近 Workspace</h3>
            </div>
          </div>
          <div className="space-y-3">
            {recentWorkspaces.length ? recentWorkspaces.map((workspace) => {
              const tool = tools.find((item) => item.id === workspace.toolId) || selectedCard;
              return (
                <button
                  key={workspace.id}
                  className="w-full rounded-[22px] bg-[#f8f5ef] p-4 text-left transition hover:bg-white"
                  onClick={() => onOpenTool(tool)}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-base font-semibold text-[#2a2927]">{workspace.title}</div>
                      <div className="mt-1 text-sm text-[#746d64]">{tool?.name || tool?.title || 'Workspace'}</div>
                    </div>
                    <div className="text-xs text-[#8a8378]">{formatDateTime(workspace.lastEditedAt || workspace.updatedAt)}</div>
                  </div>
                </button>
              );
            }) : (
              <div className="rounded-[22px] bg-[#f8f5ef] p-5 text-sm leading-6 text-[#746d64]">
                还没有最近 Workspace。选择底部工具后，会在这里显示继续工作入口。
              </div>
            )}
          </div>
        </div>

        <div className="rounded-[30px] border border-white/80 bg-white/78 p-6 shadow-[0_20px_60px_rgba(60,54,45,0.07)]">
          <div className="text-sm text-[#8a8378]">AI Suggestions</div>
          <h3 className="mt-1 text-2xl font-semibold">下一步建议</h3>
          <div className="mt-5 space-y-3">
            {suggestions.map((item) => (
              <div key={item} className="rounded-[20px] bg-[#f8f5ef] p-4 text-sm leading-6 text-[#5f594f]">
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-[30px] border border-white/80 bg-white/78 p-6 shadow-[0_20px_60px_rgba(60,54,45,0.07)]">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <div className="text-sm text-[#8a8378]">Recent Activity</div>
            <h3 className="mt-1 text-2xl font-semibold">最近事件</h3>
          </div>
          <div className="text-sm text-[#8a8378]">来自 Event Center</div>
        </div>
        <div className="space-y-3">
          {recentEvents.length ? recentEvents.map((event) => (
            <div key={event.id} className="grid grid-cols-[70px_1fr_120px] gap-4 rounded-[22px] bg-[#f8f5ef] p-4">
              <div className="text-base font-semibold text-[#2a2927]">{formatTime(event.createdAt)}</div>
              <div>
                <div className="font-semibold text-[#2a2927]">{event.title}</div>
                <div className="mt-1 text-sm text-[#746d64]">{event.content || '暂无内容'}</div>
              </div>
              <div className="text-right text-sm text-[#8a8378]">{sourceLabels[event.type] || event.source}</div>
            </div>
          )) : (
            <div className="rounded-[22px] bg-[#f8f5ef] p-5 text-sm leading-6 text-[#746d64]">
              还没有事件。后续 Workspace、Knowledge、Meeting 等模块产生 Event 后，会显示在这里。
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[30px] border border-white/80 bg-white/72 p-6 shadow-[0_16px_45px_rgba(60,54,45,0.05)]">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <div className="text-sm text-[#8a8378]">Tool Center</div>
            <h3 className="mt-1 text-xl font-semibold">常用工具</h3>
          </div>
          <div className="text-sm text-[#8a8378]">放在底部，按需进入</div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {featuredTools.map((tool) => (
            <button
              key={tool.id}
              className="rounded-[20px] bg-[#f8f5ef] p-4 text-left transition hover:bg-white"
              onClick={() => onOpenTool(tool)}
            >
              <div className="text-sm font-semibold text-[#2a2927]">{tool.name || tool.title}</div>
              <div className="mt-2 line-clamp-2 text-xs leading-5 text-[#746d64]">{tool.description}</div>
            </button>
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <PrimaryButton variant="light" onClick={() => onOpenTool(selectedCard)}>
            打开当前工具
          </PrimaryButton>
        </div>
      </section>
    </div>
  );
}

export default HomeDashboard;

import { useMemo, useState } from 'react';
import { dailyManager } from '../../../../core/daily/index.js';

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

function DailyPage() {
  const today = useMemo(() => dailyManager.today(), []);
  const yesterday = useMemo(() => dailyManager.yesterday(), []);
  const [selectedDate, setSelectedDate] = useState(today);
  const dates = useMemo(() => dailyManager.listDates(), [selectedDate]);
  const timeline = useMemo(() => dailyManager.getTimeline(selectedDate), [selectedDate]);

  return (
    <section className="grid grid-cols-[260px_1fr] gap-6">
      <aside className="rounded-[28px] bg-white/75 p-5 shadow-[0_18px_55px_rgba(60,54,45,0.07)]">
        <div className="text-sm font-semibold text-[#4d473f]">AI Daily</div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            className={`rounded-2xl px-4 py-3 text-sm transition ${selectedDate === today ? 'bg-[#1f1f1f] text-white' : 'bg-[#f8f5ef] text-[#4d473f]'}`}
            onClick={() => setSelectedDate(today)}
          >
            今天
          </button>
          <button
            className={`rounded-2xl px-4 py-3 text-sm transition ${selectedDate === yesterday ? 'bg-[#1f1f1f] text-white' : 'bg-[#f8f5ef] text-[#4d473f]'}`}
            onClick={() => setSelectedDate(yesterday)}
          >
            昨天
          </button>
        </div>
        <input
          type="date"
          value={selectedDate}
          onChange={(event) => setSelectedDate(event.target.value || today)}
          className="mt-4 h-11 w-full rounded-2xl border border-[#ede6d9] bg-white px-4 text-sm text-[#4d473f] outline-none"
        />
        <div className="mt-5 space-y-2">
          {dates.map((date) => (
            <button
              key={date}
              className={`w-full rounded-2xl px-4 py-3 text-left text-sm transition ${
                selectedDate === date ? 'bg-[#1f1f1f] text-white' : 'bg-[#f8f5ef] text-[#6f695f] hover:bg-white'
              }`}
              onClick={() => setSelectedDate(date)}
            >
              {date}
            </button>
          ))}
        </div>
      </aside>

      <main className="rounded-[32px] bg-white/78 p-7 shadow-[0_24px_80px_rgba(60,54,45,0.08)]">
        <div className="mb-8 flex items-start justify-between gap-5">
          <div>
            <div className="text-sm text-[#8a8378]">Daily Timeline</div>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">{timeline.date}</h2>
          </div>
          <div className="rounded-2xl bg-[#f8f5ef] px-4 py-2 text-sm text-[#6f695f]">
            {timeline.items.length} 个事件
          </div>
        </div>

        {timeline.items.length ? (
          <div className="space-y-5">
            {timeline.items.map((item) => (
              <article key={item.id} className="grid grid-cols-[72px_1fr] gap-5 border-b border-[#eee7dc] pb-5 last:border-b-0">
                <div className="text-lg font-semibold text-[#2a2927]">{item.time}</div>
                <div>
                  <h3 className="text-xl font-semibold text-[#2a2927]">{item.title}</h3>
                  <div className="mt-2 text-sm text-[#8a8378]">
                    来源：{sourceLabels[item.type] || item.source || item.type}
                  </div>
                  {item.content ? <p className="mt-3 text-sm leading-6 text-[#5f594f]">{item.content}</p> : null}
                  <div className="mt-4 rounded-2xl bg-[#f8f5ef] p-4">
                    <div className="text-xs font-semibold uppercase text-[#8a8378]">AI Summary</div>
                    <p className="mt-2 text-sm leading-6 text-[#6f695f]">{item.aiSummary || '待生成'}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-[24px] border border-dashed border-[#dfd6c9] bg-[#fbf8f2] p-8 text-sm leading-6 text-[#746d64]">
            当天暂无事件。AI Daily 只读取 Event Center 数据，不在 Daily 内保存业务数据。
          </div>
        )}

        <div className="mt-8 grid grid-cols-2 gap-4">
          {[
            ['AI Suggestion', timeline.aiSuggestion],
            ['Review', timeline.review],
            ['Reflection', timeline.reflection]
          ].map(([label, value]) => (
            <div key={label} className="rounded-[22px] bg-[#f8f5ef] p-4">
              <div className="text-xs font-semibold uppercase text-[#8a8378]">{label}</div>
              <p className="mt-2 text-sm text-[#6f695f]">{value || '预留'}</p>
            </div>
          ))}
        </div>
      </main>
    </section>
  );
}

export default DailyPage;

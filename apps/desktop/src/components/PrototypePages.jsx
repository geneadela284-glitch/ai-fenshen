import { useEffect, useMemo, useRef, useState } from 'react';
import PrimaryButton from './PrimaryButton';
import { settingsManager } from '../../../../core/settings/settingsManager.js';
import { knowledgeFileManager } from '../../../../core/knowledgeDrop/index.js';
import { quickNoteManager } from '../../../../core/quickNote/index.js';
import { workSecretaryManager } from '../../../../core/workSecretary/index.js';
import { eventManager } from '../../../../core/events/index.js';
import WorkSecretaryHomeRedesign from './WorkSecretaryHome.jsx';
import MeetingCenter from './MeetingCenter.jsx';
import { fetchAdminAiSettings } from '../lib/aiServiceClient.js';

const todayLabel = new Date().toLocaleDateString('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long'
});

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function isUsableTask(task) {
  return Boolean(task?.userInput && task.userInput !== '[object Object]');
}

const workspaces = [
  {
    id: 'contract-renewal',
    title: '华南客户续约',
    owner: '销售部',
    status: '今天推进',
    progress: 72,
    summary: '报价已更新，合同条款等待老板确认。',
    next: '确认折扣边界后发送新版报价。'
  },
  {
    id: 'meeting-ops',
    title: '运营周会整理',
    owner: '运营部',
    status: '待复核',
    progress: 48,
    summary: '会议纪要已生成，仍有 3 个行动项缺少负责人。',
    next: '补充分工并同步到 AI Inbox。'
  },
  {
    id: 'campaign-july',
    title: '7 月新品推广',
    owner: '市场部',
    status: '创作中',
    progress: 61,
    summary: '卖点资料已入库，宣传文案初稿已准备。',
    next: '选择公众号版本并生成销售话术。'
  }
];

const timeline = [
  {
    time: '09:30',
    title: '签订合同',
    source: 'Contract',
    summary: '客户接受基础报价，但要求把交付周期写入补充条款。',
    priority: '高'
  },
  {
    time: '11:10',
    title: '会议纪要',
    source: 'Meeting',
    summary: '销售和运营需要在今天 18:00 前确认交付负责人。',
    priority: '中'
  },
  {
    time: '15:40',
    title: '新增客户资料',
    source: 'Manual',
    summary: '新增客户来自展会线索，建议明天上午首次回访。',
    priority: '中'
  }
];

const inboxItems = [
  {
    id: 'approve-quote',
    title: '确认华南客户报价折扣',
    source: 'Workspace',
    status: '待确认',
    risk: '涉及合同金额',
    detail: 'AI 已根据历史价格生成 3 个报价方案，建议选择稳妥方案。'
  },
  {
    id: 'meeting-owner',
    title: '运营周会缺少行动负责人',
    source: 'Meeting',
    status: '待处理',
    risk: '可能遗漏交付',
    detail: '3 个行动项没有负责人，需要分配到销售、运营和行政。'
  },
  {
    id: 'archive-product',
    title: '新品资料可归档到资料库',
    source: 'Document',
    status: '待归档',
    risk: '低',
    detail: '本地解析完成，等待用户确认后写入企业资料。'
  }
];

const knowledgeItems = [
  { title: '产品价格表', type: '企业资料', updated: '今天 10:12', note: '报价、折扣、服务边界' },
  { title: '销售话术模板', type: '模板库', updated: '昨天 18:20', note: '客户回复、异议处理、跟进短信' },
  { title: '品牌表达规范', type: '品牌记忆', updated: '7 月 8 日', note: '语气、禁用词、常用短句' },
  { title: '合同条款 FAQ', type: '文件资料', updated: '7 月 6 日', note: '付款、交付、售后条款' }
];

const workflows = [
  { title: '客户报价流程', steps: 5, status: '可运行', outcome: '生成报价、邮件和待确认事项' },
  { title: '会议纪要流程', steps: 4, status: '可运行', outcome: '整理纪要、行动项和 Daily 事件' },
  { title: '合同检查流程', steps: 6, status: '需管理员复核', outcome: '标记风险、生成修改建议' },
  { title: '新品发布流程', steps: 7, status: '草稿', outcome: '生成方案、文案和销售话术' }
];

const teamMembers = [
  { name: '张总', role: '老板', team: '管理层', access: '审批、查看全局' },
  { name: '李娜', role: '销售', team: '销售部', access: '客户 Workspace' },
  { name: '陈明', role: '运营', team: '运营部', access: '会议、交付资料' },
  { name: '王悦', role: '行政', team: '行政部', access: '模板、通知、资料库' }
];

const auditLogs = [
  { time: '09:45', actor: 'Workflow', action: '生成报价草稿', status: '等待确认' },
  { time: '11:25', actor: 'Admin', action: '更新工具可见范围', status: '已生效' },
  { time: '14:10', actor: 'AI Inbox', action: '归档会议纪要', status: '已完成' }
];

const todayWorkItems = [
  { title: '确认华南客户报价', meta: '今天 11:30 前', status: '待确认' },
  { title: '整理运营周会行动项', meta: '3 个负责人待补充', status: '进行中' },
  { title: '更新新品介绍资料', meta: '资料库待归档', status: '待处理' }
];

const secretarySuggestions = [
  '把昨天会议整理成行动清单',
  '检查今天要跟进的客户',
  '生成季度汇报 PPT 大纲',
  '统计销售数据异常'
];

const recentFiles = [
  { name: '华南客户报价表.xlsx', type: 'Excel', time: '10:12' },
  { name: '运营周会纪要.docx', type: 'Word', time: '昨天' },
  { name: '新品卖点资料.pdf', type: 'PDF', time: '7 月 8 日' }
];

const recentGenerated = [
  { title: '客户跟进邮件草稿', time: '09:48' },
  { title: '新品介绍文案', time: '昨天 17:20' },
  { title: '会议纪要摘要', time: '昨天 15:05' }
];

function PageTitle({ label, title, description, action }) {
  return (
    <div className="mb-7 flex items-start justify-between gap-6">
      <div>
        <div className="text-sm text-[#8a8378]">{label}</div>
        <h2 className="mt-2 text-[34px] font-semibold leading-tight tracking-tight text-[#1f1f1f]">{title}</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#746d64]">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function Panel({ children, className = '' }) {
  return (
    <section className={`rounded-[30px] border border-white/80 bg-white/78 p-6 shadow-[0_20px_60px_rgba(60,54,45,0.07)] ${className}`}>
      {children}
    </section>
  );
}

function Metric({ label, value, note }) {
  return (
    <div className="rounded-[24px] bg-[#f8f5ef] p-5">
      <div className="text-sm text-[#8a8378]">{label}</div>
      <div className="mt-3 text-3xl font-semibold text-[#252422]">{value}</div>
      <p className="mt-2 text-sm leading-6 text-[#746d64]">{note}</p>
    </div>
  );
}

function QuietButton({ children, onClick, active = false }) {
  return (
    <button
      className={`rounded-full px-4 py-2 text-sm transition active:scale-[0.98] ${
        active ? 'bg-[#1f1f1f] text-white' : 'bg-[#f3eee7] text-[#5f594f] hover:bg-white'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function hasConfiguredAiService(settings = {}) {
  return Object.values(settings.providers || {}).some((provider) => provider.enabled && provider.apiKey);
}

function WorkSecretaryHome({ onNavigate }) {
  const [draft, setDraft] = useState('');
  const [tasks, setTasks] = useState(() => workSecretaryManager.listTasks());
  const [activeTask, setActiveTask] = useState(() => workSecretaryManager.listTasks()[0] || null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [serviceConnected, setServiceConnected] = useState(() => hasConfiguredAiService(settingsManager.load()));
  const [knowledgeFiles, setKnowledgeFiles] = useState(() => knowledgeFileManager.listFiles());
  const [quickNote, setQuickNote] = useState('');
  const [pendingNote, setPendingNote] = useState(null);
  const [isClassifyingNote, setIsClassifyingNote] = useState(false);
  const [savedNotes, setSavedNotes] = useState(() => quickNoteManager.listNotes());
  const activeTaskRef = useRef(null);

  const refreshTasks = () => {
    const next = workSecretaryManager.listTasks();
    setTasks(next);
    setServiceConnected(hasConfiguredAiService(settingsManager.load()));
    return next;
  };

  useEffect(() => {
    refreshTasks();
  }, []);

  const refreshKnowledge = () => setKnowledgeFiles(knowledgeFileManager.listFiles());
  const refreshNotes = () => setSavedNotes(quickNoteManager.listNotes());

  const addSelectedFiles = (fileList) => {
    Array.from(fileList || []).forEach((file) => {
      knowledgeFileManager.addFile({
        name: file.name,
        type: file.type,
        size: file.size,
        localPath: `local-ref://${file.name}-${file.lastModified || 'selected'}`
      });
    });
    refreshKnowledge();
  };

  const removeKnowledgeFile = (file) => {
    if (!window.confirm(`确定删除“${file.name}”的应用索引吗？原文件不会被删除。`)) return;
    knowledgeFileManager.deleteFile(file.id);
    refreshKnowledge();
  };

  const classifyQuickNote = (value) => {
    setQuickNote(value);
    setPendingNote(value.trim() ? quickNoteManager.classify(value) : null);
  };

  const updatePendingNote = (key, value) => {
    setPendingNote((current) => (current ? { ...current, [key]: value } : current));
  };

  const saveQuickNote = () => {
    if (!pendingNote || pendingNote.missing) return;
    quickNoteManager.save(pendingNote);
    refreshNotes();
    setQuickNote('');
    setPendingNote(null);
  };

  const assistQuickNote = async () => {
    if (!quickNote.trim() || !pendingNote) return;
    setIsClassifyingNote(true);
    const classified = await quickNoteManager.classifyWithAI(quickNote);
    setPendingNote(classified);
    setIsClassifyingNote(false);
  };

  const send = async (overrideInput = '') => {
    const input = String(overrideInput || draft).trim();
    if (!input || status === 'processing') return;

    const task = workSecretaryManager.createTask(input);
    activeTaskRef.current = task.taskId;
    setActiveTask(task);
    refreshTasks();
    setStatus('processing');
    setError('');

    try {
      const completed = await workSecretaryManager.executeTask(task.taskId);
      if (activeTaskRef.current !== task.taskId) {
        return;
      }
      setActiveTask(completed);
      setError(completed.error || '');
      setStatus(completed.status === 'completed' ? 'done' : 'error');
      refreshTasks();
    } catch (requestError) {
      setError(requestError.message || '任务处理失败，请稍后重试。');
      setStatus('error');
      refreshTasks();
    }
  };

  const cancel = () => {
    if (!activeTaskRef.current) return;
    const cancelled = workSecretaryManager.cancelTask(activeTaskRef.current);
    activeTaskRef.current = null;
    setActiveTask(cancelled);
    setStatus('cancelled');
    refreshTasks();
  };

  const copyResult = async () => {
    if (!activeTask?.result) return;
    await navigator.clipboard?.writeText(activeTask.result);
  };

  const regenerate = () => {
    if (!activeTask?.userInput) return;
    setDraft(activeTask.userInput);
    send(activeTask.userInput);
  };

  const continueWith = (instruction) => {
    const base = activeTask?.result || activeTask?.userInput || '';
    setDraft(`${instruction}：\n${base}`);
  };

  const openTask = (task) => {
    setActiveTask(task);
    setDraft(task.userInput);
    setStatus(task.status === 'completed' ? 'done' : task.status === 'failed' ? 'error' : task.status);
    setError(task.error || '');
  };

  const visibleTasks = tasks.filter(isUsableTask);
  const latestCompleted = visibleTasks.filter((task) => task.status === 'completed').slice(0, 3);
  const completedToday = visibleTasks.filter((task) => task.status === 'completed' && task.completedAt && new Date(task.completedAt).toDateString() === new Date().toDateString()).length;
  const recentTasks = visibleTasks.slice(0, 4);
  const isBusy = status === 'processing';

  const categoryLabels = {
    schedule: '日程',
    reminder: '提醒',
    todo: '待办',
    work_log: '工作日志',
    note: '笔记'
  };
  const noteCategory = pendingNote ? categoryLabels[pendingNote.category] : '';
  const latestNotes = savedNotes.slice(0, 3);
  const todayReminders = savedNotes.filter((note) => ['schedule', 'reminder', 'todo'].includes(note.category)).slice(0, 3);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-7 pb-8" data-page="work-secretary-home">
      <section className="mx-auto w-full max-w-4xl pt-2 text-center sm:pt-8">
        <div className="text-xs font-medium uppercase tracking-[0.16em] text-[#9b9286]">{todayLabel}</div>
        <h2 className="mt-5 text-4xl font-semibold leading-tight tracking-tight text-[#1f1f1f] sm:text-6xl">{getGreeting()}，老板。</h2>
        <p className="mt-3 text-lg text-[#625b51] sm:text-xl">把目标告诉工作秘书，剩下的交给它。</p>

        <div className="mt-7 rounded-[28px] border border-black/5 bg-white/88 p-3 text-left shadow-[0_24px_70px_rgba(60,54,45,0.10)] sm:mt-9 sm:rounded-[32px] sm:p-4">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            className="h-32 w-full resize-none rounded-[22px] border border-[#eee7dc] bg-[#fbfaf7] p-4 text-base leading-7 text-[#2a2927] outline-none transition focus:border-[#1f1f1f] focus:bg-white sm:h-36 sm:rounded-[26px] sm:p-5 sm:text-lg sm:leading-8"
            placeholder="例如：帮我写一篇产品介绍，或整理一份会议记录"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 sm:mt-4">
            <div className="flex items-center gap-2">
              <button
                className="grid h-11 w-11 place-items-center rounded-full bg-[#f3eee7] text-base transition hover:bg-white active:scale-[0.98]"
                title="语音输入"
                aria-label="语音输入"
              >
                🎤
              </button>
              <button
                className="grid h-11 w-11 place-items-center rounded-full bg-[#f3eee7] text-base transition hover:bg-white active:scale-[0.98]"
                title="添加文件"
                aria-label="添加文件"
              >
                📎
              </button>
            </div>
            <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
              <div className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs sm:hidden ${serviceConnected ? 'bg-[#edf7ef] text-[#3d6f47]' : 'bg-[#fff1ec] text-[#9a4b35]'}`}>
                <span className={`h-2 w-2 rounded-full ${serviceConnected ? 'bg-[#4e9a5d]' : 'bg-[#c86a50]'}`} />
                {serviceConnected ? '服务已连接' : '服务未配置'}
              </div>
              <PrimaryButton className="min-w-24" onClick={() => send()} disabled={!draft.trim() || isBusy}>
                {isBusy ? '处理中' : '发送'}
              </PrimaryButton>
            </div>
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
            {secretarySuggestions.map((item) => (
              <QuietButton key={item} onClick={() => setDraft(item)}>
                {item}
              </QuietButton>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-4xl gap-4 md:grid-cols-2">
        <div className="rounded-[24px] border border-dashed border-[#cfc4b5] bg-white/55 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Knowledge drop</div>
              <h3 className="mt-2 text-xl font-semibold text-[#252422]">投资料到知识库</h3>
            </div>
            <span className="rounded-full bg-[#f3eee7] px-3 py-1 text-xs text-[#746d64]">入口</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-[#746d64]">把合同、报表、会议记录等资料放进来，工作秘书会在后续任务中调用。</p>
          <label
            className="mt-5 flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-2xl bg-[#fbfaf7] px-4 py-4 text-center transition hover:bg-white"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              addSelectedFiles(event.dataTransfer.files);
            }}
          >
            <span className="text-sm font-medium text-[#4d473f]">拖拽资料到这里，或点击上传</span>
            <span className="mt-1 text-xs text-[#9b9286]">支持 PDF、Word、Excel、TXT、Markdown 和图片</span>
            <input
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.markdown,image/*"
              className="sr-only"
              multiple
              onChange={(event) => addSelectedFiles(event.target.files)}
            />
          </label>
          {knowledgeFiles.length ? (
            <div className="mt-4 space-y-2">
              {knowledgeFiles.slice(0, 3).map((file) => (
                <div key={file.id} className="flex items-start justify-between gap-3 rounded-2xl bg-[#f8f5ef] p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[#2a2927]">{file.name}</div>
                    <div className="mt-1 text-xs text-[#746d64]">{file.status === 'failed' ? '文件类型暂不支持，未加入资料库。' : '已加入资料库 · 资料已保存，内容解析将在后续版本开放。'}</div>
                  </div>
                  <button className="shrink-0 text-xs text-[#8a8378] hover:text-[#9a4b35]" onClick={() => removeKnowledgeFile(file)}>删除索引</button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-[24px] border border-black/5 bg-white/65 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Quick note</div>
              <h3 className="mt-2 text-xl font-semibold text-[#252422]">随手记</h3>
            </div>
            {noteCategory ? <span className="rounded-full bg-[#edf7ef] px-3 py-1 text-xs text-[#3d6f47]">{noteCategory}</span> : null}
          </div>
          <p className="mt-3 text-sm leading-6 text-[#746d64]">快速记下日程、待办、工作日志或提醒。</p>
          <input
            value={quickNote}
            onChange={(event) => classifyQuickNote(event.target.value)}
            className="mt-5 h-12 w-full rounded-2xl border border-[#eee7dc] bg-[#fbfaf7] px-4 text-sm text-[#2a2927] outline-none transition focus:border-[#1f1f1f] focus:bg-white"
            placeholder="例如：明天上午 9 点开例会"
          />
          {pendingNote ? (
            <div className="mt-3 space-y-3 rounded-2xl bg-[#f8f5ef] p-3">
              <div className="text-xs text-[#746d64]">识别结果</div>
              <div className="grid grid-cols-2 gap-2">
                <select value={pendingNote.category} onChange={(event) => updatePendingNote('category', event.target.value)} className="h-10 rounded-xl border border-[#eee7dc] bg-white px-3 text-sm text-[#4d473f] outline-none">
                  {Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <input value={pendingNote.timeText} onChange={(event) => updatePendingNote('timeText', event.target.value)} placeholder="日期或时间" className="h-10 rounded-xl border border-[#eee7dc] bg-white px-3 text-sm text-[#4d473f] outline-none" />
              </div>
              <input value={pendingNote.content} onChange={(event) => updatePendingNote('content', event.target.value)} className="h-10 w-full rounded-xl border border-[#eee7dc] bg-white px-3 text-sm text-[#4d473f] outline-none" />
              {pendingNote.missing ? <div className="text-xs leading-5 text-[#9a4b35]">{pendingNote.missing}</div> : null}
              <div className="flex items-center justify-end gap-2">
                {pendingNote.category === 'note' ? <button className="rounded-full px-3 py-1.5 text-xs text-[#746d64] disabled:opacity-40" disabled={isClassifyingNote} onClick={assistQuickNote}>{isClassifyingNote ? '识别中' : 'AI 辅助分类'}</button> : null}
                <button className="rounded-full px-3 py-1.5 text-xs text-[#746d64]" onClick={() => { setQuickNote(''); setPendingNote(null); }}>取消</button>
                <button className="rounded-full bg-[#1f1f1f] px-3 py-1.5 text-xs text-white disabled:opacity-40" disabled={Boolean(pendingNote.missing)} onClick={saveQuickNote}>确认保存</button>
              </div>
            </div>
          ) : null}
          {!pendingNote ? <div className="mt-3 text-xs text-[#9b9286]">输入后会显示识别结果</div> : null}
        </div>
      </section>

      {status === 'processing' ? (
        <section className="mx-auto w-full max-w-4xl rounded-[24px] border border-black/5 bg-white/78 p-5 shadow-[0_18px_50px_rgba(60,54,45,0.07)] sm:rounded-[28px] sm:p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#1f1f1f]" />
              <div>
                <div className="text-base font-semibold text-[#2a2927]">正在理解并处理任务</div>
                <div className="mt-1 text-sm text-[#746d64]">识别目标 · 整理相关资料 · 生成工作成果</div>
              </div>
            </div>
            <PrimaryButton variant="light" onClick={cancel}>取消</PrimaryButton>
          </div>
        </section>
      ) : null}

      {status === 'done' && activeTask?.result ? (
        <section className="mx-auto w-full max-w-4xl rounded-[24px] border border-black/5 bg-white/88 p-5 shadow-[0_20px_60px_rgba(60,54,45,0.08)] sm:rounded-[28px] sm:p-7">
          <div className="flex items-start justify-between gap-5">
            <div>
              <div className="text-sm text-[#8a8378]">任务结果</div>
              <h3 className="mt-2 text-2xl font-semibold text-[#2a2927]">工作成果</h3>
              <div className="mt-1 text-xs text-[#8a8378]">
                {activeTask.completedAt ? new Date(activeTask.completedAt).toLocaleString('zh-CN', { hour12: false }) : ''}
              </div>
            </div>
          </div>
          <div className="mt-5 whitespace-pre-wrap rounded-[20px] border border-[#eee7dc] bg-[#fbfaf7] p-5 text-base leading-8 text-[#4d473f] sm:rounded-[24px] sm:p-6">{activeTask.result}</div>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <PrimaryButton onClick={copyResult}>复制结果</PrimaryButton>
            <PrimaryButton variant="light" onClick={regenerate}>重新生成</PrimaryButton>
            <PrimaryButton variant="light" onClick={() => continueWith('更正式一些')}>更正式一些</PrimaryButton>
            <PrimaryButton variant="light" onClick={() => continueWith('缩短到 500 字')}>缩短到 500 字</PrimaryButton>
            <PrimaryButton variant="light" onClick={() => onNavigate('工作中心')}>保存到当前 Workspace</PrimaryButton>
          </div>
          {import.meta.env.DEV ? <WorkSecretaryDebugConsole task={activeTask} /> : null}
        </section>
      ) : null}

      {status === 'error' ? (
        <section className="mx-auto w-full max-w-4xl rounded-[24px] border border-[#eed6d1] bg-[#fff8f6] p-5 text-sm leading-6 text-[#8a3d32] sm:rounded-[28px] sm:p-6">
          <div className="text-base font-semibold">任务未完成</div>
          <div className="mt-2">{error || activeTask?.error || '任务处理失败，请稍后重试。'}</div>
          <div className="mt-4 flex gap-3">
            <PrimaryButton variant="light" onClick={regenerate}>重新尝试</PrimaryButton>
            <PrimaryButton variant="light" onClick={() => onNavigate('设置')}>联系管理员设置</PrimaryButton>
          </div>
          {import.meta.env.DEV ? <WorkSecretaryDebugConsole task={activeTask} /> : null}
        </section>
      ) : null}

      {status === 'cancelled' ? (
        <section className="mx-auto w-full max-w-4xl rounded-[24px] border border-black/5 bg-white/78 p-5 text-sm leading-6 text-[#746d64] sm:rounded-[28px] sm:p-6">
          任务已取消。你可以修改输入后重新发送。
        </section>
      ) : null}

      <section className="mx-auto w-full max-w-4xl rounded-[24px] border border-black/5 bg-white/72 p-5 shadow-[0_16px_45px_rgba(60,54,45,0.05)] sm:rounded-[28px] sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm text-[#8a8378]">History</div>
            <h3 className="mt-1 text-xl font-semibold">最近任务</h3>
          </div>
          <div className="text-sm text-[#8a8378]">{visibleTasks.length ? `${visibleTasks.length} 条` : '空记录'}</div>
        </div>
        {visibleTasks.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {visibleTasks.slice(0, 6).map((task) => (
              <button
                key={task.taskId}
                className="rounded-[20px] bg-[#f8f5ef] p-4 text-left transition hover:bg-white"
                onClick={() => openTask(task)}
              >
                <div className="line-clamp-1 text-sm font-semibold text-[#2a2927]">{task.userInput}</div>
                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[#746d64]">
                  <span>{new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                  <span>{task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : task.status === 'cancelled' ? '已取消' : '处理中'}</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-[20px] bg-[#f8f5ef] p-4 text-sm text-[#746d64]">还没有历史任务。提交一次工作后会自动保存在本地。</div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel className="p-5 sm:p-6">
          <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Today</div>
          <div className="mt-3 text-3xl font-semibold text-[#252422]">{completedToday}</div>
          <p className="mt-2 text-sm leading-6 text-[#746d64]">今日完成任务</p>
        </Panel>
        <Panel className="p-5 sm:p-6">
          <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Recent tasks</div>
          <div className="mt-3 text-3xl font-semibold text-[#252422]">{visibleTasks.length}</div>
          <p className="mt-2 text-sm leading-6 text-[#746d64]">本地工作记录</p>
        </Panel>
        <Panel className="p-5 sm:p-6">
          <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Service</div>
          <div className={`mt-3 text-xl font-semibold ${serviceConnected ? 'text-[#3d6f47]' : 'text-[#9a4b35]'}`}>{serviceConnected ? '已连接' : '未配置'}</div>
          <p className="mt-2 text-sm leading-6 text-[#746d64]">连接状态仅保存在本地</p>
        </Panel>
        <Panel className="p-5 sm:p-6">
          <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Reminders</div>
          <div className="mt-3 text-xl font-semibold text-[#252422]">{todayReminders.length ? `${todayReminders.length} 条` : '暂无'}</div>
          <p className="mt-2 text-sm leading-6 text-[#746d64]">今日提醒</p>
        </Panel>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Panel className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Recent work</div>
              <h3 className="mt-2 text-xl font-semibold text-[#252422]">最近任务</h3>
            </div>
            <button className="text-sm text-[#746d64] transition hover:text-[#1f1f1f]" onClick={() => onNavigate('AI Daily')}>查看 Daily</button>
          </div>
          {recentTasks.length ? (
            <div className="mt-5 space-y-2.5">
              {recentTasks.map((task) => (
                <button key={task.taskId} className="flex w-full items-center justify-between gap-4 rounded-2xl bg-[#f8f5ef] p-4 text-left transition hover:bg-white" onClick={() => openTask(task)}>
                  <span className="min-w-0 truncate text-sm font-medium text-[#2a2927]">{task.userInput}</span>
                  <span className="shrink-0 text-xs text-[#8a8378]">{task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : '处理中'}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-dashed border-[#ddd4c8] bg-[#fbfaf7] p-6 text-sm leading-6 text-[#746d64]">完成第一项工作后，这里会显示你的工作记录。</div>
          )}
        </Panel>

        <Panel className="p-5 sm:p-6">
          <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Recent generated</div>
          <h3 className="mt-2 text-xl font-semibold text-[#252422]">最近生成结果</h3>
          {latestCompleted.length ? (
            <div className="mt-5 space-y-2.5">
              {latestCompleted.map((task) => (
                <button key={task.taskId} className="w-full rounded-2xl bg-[#f8f5ef] p-4 text-left transition hover:bg-white" onClick={() => openTask(task)}>
                  <div className="truncate text-sm font-medium text-[#2a2927]">{task.userInput}</div>
                  <div className="mt-1 text-xs text-[#8a8378]">{task.completedAt ? new Date(task.completedAt).toLocaleString('zh-CN', { hour12: false }) : ''}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-dashed border-[#ddd4c8] bg-[#fbfaf7] p-6 text-sm leading-6 text-[#746d64]">完成第一项工作后，这里会显示生成结果。</div>
          )}
        </Panel>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Panel className="p-5 sm:p-6">
          <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Recent files</div>
          <h3 className="mt-2 text-xl font-semibold text-[#252422]">最近加入的资料</h3>
          {knowledgeFiles.length ? (
            <div className="mt-5 space-y-2.5">
              {knowledgeFiles.slice(0, 4).map((file) => (
                <div key={file.id} className="flex items-center justify-between gap-3 rounded-2xl bg-[#f8f5ef] p-4">
                  <span className="min-w-0 truncate text-sm font-medium text-[#2a2927]">{file.name}</span>
                  <span className={`shrink-0 text-xs ${file.status === 'failed' ? 'text-[#9a4b35]' : 'text-[#3d6f47]'}`}>{file.status === 'failed' ? '失败' : '已加入'}</span>
                </div>
              ))}
            </div>
          ) : <div className="mt-5 rounded-2xl border border-dashed border-[#ddd4c8] bg-[#fbfaf7] p-6 text-sm leading-6 text-[#746d64]">上传第一份资料后，这里会显示最近加入的文件。</div>}
        </Panel>

        <Panel className="p-5 sm:p-6">
          <div className="text-xs uppercase tracking-[0.14em] text-[#9b9286]">Today notes</div>
          <h3 className="mt-2 text-xl font-semibold text-[#252422]">今日提醒与记录</h3>
          {latestNotes.length ? (
            <div className="mt-5 space-y-2.5">
              {latestNotes.map((note) => (
                <div key={note.id} className="rounded-2xl bg-[#f8f5ef] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-[#2a2927]">{categoryLabels[note.category]}</span>
                    <span className="text-xs text-[#8a8378]">{note.timeText || '无明确时间'}</span>
                  </div>
                  <div className="mt-2 text-sm leading-6 text-[#5f594f]">{note.content}</div>
                </div>
              ))}
            </div>
          ) : <div className="mt-5 rounded-2xl border border-dashed border-[#ddd4c8] bg-[#fbfaf7] p-6 text-sm leading-6 text-[#746d64]">确认保存随手记后，这里会显示今天的安排和记录。</div>}
        </Panel>
      </section>
    </div>
  );
}

function WorkSecretaryDebugConsole({ task }) {
  if (!task?.debug && !task?.taskConfirmation) return null;
  const debug = task.debug || {};
  return (
    <details className="mt-5 rounded-[20px] bg-[#f1ece4] p-4 text-xs text-[#5f594f]">
      <summary className="cursor-pointer font-semibold">Debug Console</summary>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <DebugPill label="Task Type" value={debug.taskType || task.taskType || ''} />
        <DebugPill label="Memory / Knowledge" value={`${debug.injectedMemoryCount || 0} / ${debug.injectedKnowledgeCount || 0}`} />
        <DebugPill label="请求耗时" value={debug.latency ? `${debug.latency} ms` : `${task.latency || 0} ms`} />
        <DebugPill label="返回状态" value={debug.status || task.status || ''} />
        <DebugPill label="错误类型" value={debug.errorType || task.error || '无'} />
      </div>
      <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-[16px] bg-white/70 p-3 leading-5">
        {JSON.stringify(debug.taskConfirmation || task.taskConfirmation || null, null, 2)}
      </pre>
    </details>
  );
}

function DebugPill({ label, value }) {
  return (
    <div className="rounded-[14px] bg-white/70 p-3">
      <div className="text-[#8a8378]">{label}</div>
      <div className="mt-1 break-words font-semibold text-[#3d382f]">{String(value || '无')}</div>
    </div>
  );
}

function WorkCenterPage({ onNavigate }) {
  const [selectedId, setSelectedId] = useState(workspaces[0].id);
  const selected = workspaces.find((item) => item.id === selectedId) || workspaces[0];

  return (
    <div>
      <PageTitle
        label="Workspace"
        title="工作中心"
        description="每个客户、项目和文档都有独立 Workspace，保证工作可以恢复、追溯和继续。"
        action={<PrimaryButton onClick={() => onNavigate('工作秘书')}>回到工作秘书</PrimaryButton>}
      />
      <div className="grid grid-cols-[360px_1fr] gap-6">
        <Panel>
          <div className="mb-4 text-sm font-semibold text-[#4d473f]">最近 Workspace</div>
          <div className="space-y-3">
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                className={`w-full rounded-[22px] p-4 text-left transition ${
                  selectedId === workspace.id ? 'bg-[#1f1f1f] text-white' : 'bg-[#f8f5ef] text-[#2a2927] hover:bg-white'
                }`}
                onClick={() => setSelectedId(workspace.id)}
              >
                <div className="font-semibold">{workspace.title}</div>
                <div className={`mt-1 text-sm ${selectedId === workspace.id ? 'text-white/72' : 'text-[#746d64]'}`}>
                  {workspace.owner} · {workspace.status}
                </div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel>
          <div className="flex items-start justify-between gap-5">
            <div>
              <div className="text-sm text-[#8a8378]">Current Workspace</div>
              <h3 className="mt-2 text-3xl font-semibold">{selected.title}</h3>
              <p className="mt-3 text-sm leading-6 text-[#746d64]">{selected.summary}</p>
            </div>
            <div className="rounded-full bg-[#f3eee7] px-4 py-2 text-sm text-[#5f594f]">{selected.status}</div>
          </div>

          <div className="mt-7 rounded-[24px] bg-[#f8f5ef] p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-[#2a2927]">完成度</span>
              <span className="text-[#746d64]">{selected.progress}%</span>
            </div>
            <div className="mt-3 h-3 rounded-full bg-white">
              <div className="h-3 rounded-full bg-[#1f1f1f]" style={{ width: `${selected.progress}%` }} />
            </div>
          </div>

          <div className="mt-6 grid grid-cols-3 gap-4">
            <Metric label="关联事件" value="8" note="来自 Event Center" />
            <Metric label="相关资料" value="5" note="可从资料库引用" />
            <Metric label="待确认" value="2" note="进入 AI Inbox 处理" />
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <PrimaryButton onClick={() => onNavigate('AI Inbox')}>处理待确认</PrimaryButton>
            <PrimaryButton variant="light" onClick={() => onNavigate('资料库')}>查看相关资料</PrimaryButton>
            <PrimaryButton variant="light" onClick={() => onNavigate('AI Daily')}>查看时间线</PrimaryButton>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function DailyPrototypePage({ onNavigate }) {
  const [selectedDate, setSelectedDate] = useState('今天');
  const dates = ['今天', '昨天', '2026-07-08'];

  return (
    <div>
      <PageTitle
        label="AI Daily"
        title="每日工作时间线"
        description="Daily 不保存业务数据，只读取事件并把一天的工作整理成可回顾的时间线。"
        action={<PrimaryButton onClick={() => onNavigate('AI Inbox')}>处理待确认</PrimaryButton>}
      />
      <div className="grid grid-cols-[260px_1fr] gap-6">
        <Panel>
          <div className="text-sm font-semibold text-[#4d473f]">日期</div>
          <div className="mt-4 space-y-2">
            {dates.map((date) => (
              <QuietButton key={date} active={selectedDate === date} onClick={() => setSelectedDate(date)}>
                {date}
              </QuietButton>
            ))}
          </div>
          <div className="mt-6 rounded-[22px] bg-[#f8f5ef] p-4 text-sm leading-6 text-[#746d64]">
            今天重点：先处理合同确认，再补齐会议行动项。
          </div>
        </Panel>

        <Panel>
          <div className="mb-6 flex items-center justify-between">
            <div>
              <div className="text-sm text-[#8a8378]">Daily Timeline</div>
              <h3 className="mt-2 text-3xl font-semibold">{selectedDate}</h3>
            </div>
            <div className="rounded-full bg-[#f3eee7] px-4 py-2 text-sm text-[#5f594f]">{timeline.length} 个事件</div>
          </div>
          <div className="space-y-5">
            {timeline.map((item) => (
              <article key={item.time} className="grid grid-cols-[76px_1fr] gap-5 border-b border-[#eee7dc] pb-5 last:border-b-0">
                <div className="text-lg font-semibold text-[#2a2927]">{item.time}</div>
                <div>
                  <div className="flex items-center gap-3">
                    <h4 className="text-xl font-semibold text-[#2a2927]">{item.title}</h4>
                    <span className="rounded-full bg-[#f3eee7] px-3 py-1 text-xs text-[#5f594f]">{item.priority}</span>
                  </div>
                  <div className="mt-2 text-sm text-[#8a8378]">来源：{item.source}</div>
                  <div className="mt-3 rounded-[20px] bg-[#f8f5ef] p-4 text-sm leading-6 text-[#746d64]">
                    AI Summary：{item.summary}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function InboxPage({ onNavigate }) {
  const [selectedId, setSelectedId] = useState(inboxItems[0].id);
  const selected = inboxItems.find((item) => item.id === selectedId) || inboxItems[0];

  return (
    <div>
      <PageTitle
        label="AI Inbox"
        title="待处理与待确认"
        description="所有需要人判断的事项集中在这里，高风险动作不会自动执行。"
        action={<PrimaryButton onClick={() => onNavigate('AI Daily')}>查看 Daily</PrimaryButton>}
      />
      <div className="grid grid-cols-[380px_1fr] gap-6">
        <Panel>
          <div className="mb-4 flex gap-2">
            {['全部', '待确认', '待处理'].map((tab) => (
              <QuietButton key={tab}>{tab}</QuietButton>
            ))}
          </div>
          <div className="space-y-3">
            {inboxItems.map((item) => (
              <button
                key={item.id}
                className={`w-full rounded-[22px] p-4 text-left transition ${
                  selectedId === item.id ? 'bg-[#1f1f1f] text-white' : 'bg-[#f8f5ef] text-[#2a2927] hover:bg-white'
                }`}
                onClick={() => setSelectedId(item.id)}
              >
                <div className="font-semibold">{item.title}</div>
                <div className={`mt-2 text-sm ${selectedId === item.id ? 'text-white/70' : 'text-[#746d64]'}`}>
                  {item.source} · {item.status}
                </div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel>
          <div className="rounded-[24px] bg-[#f8f5ef] p-5">
            <div className="text-sm text-[#8a8378]">Selected Item</div>
            <h3 className="mt-2 text-3xl font-semibold">{selected.title}</h3>
            <p className="mt-4 text-sm leading-7 text-[#746d64]">{selected.detail}</p>
            <div className="mt-5 grid grid-cols-3 gap-3">
              <Metric label="来源" value={selected.source} note="可回到原工作区" />
              <Metric label="状态" value={selected.status} note="等待用户处理" />
              <Metric label="风险" value={selected.risk} note="需要明确确认" />
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <PrimaryButton>确认执行</PrimaryButton>
            <PrimaryButton variant="light">退回修改</PrimaryButton>
            <PrimaryButton variant="light">稍后处理</PrimaryButton>
            <PrimaryButton variant="light" onClick={() => onNavigate('工作中心')}>打开来源 Workspace</PrimaryButton>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function KnowledgePage({ onNavigate }) {
  return (
    <div>
      <PageTitle
        label="Knowledge"
        title="资料库"
        description="资料必须经过用户选择、本地解析和确认后入库，成为工作秘书和流程可引用的企业知识。"
        action={<PrimaryButton onClick={() => onNavigate('工作秘书')}>用资料生成任务</PrimaryButton>}
      />
      <div className="grid grid-cols-[1fr_360px] gap-6">
        <Panel>
          <div className="grid grid-cols-2 gap-4">
            {knowledgeItems.map((item) => (
              <button
                key={item.title}
                className="rounded-[24px] bg-[#f8f5ef] p-5 text-left transition hover:bg-white"
                onClick={() => onNavigate('工作中心')}
              >
                <div className="text-sm text-[#8a8378]">{item.type}</div>
                <div className="mt-2 text-xl font-semibold text-[#2a2927]">{item.title}</div>
                <p className="mt-3 text-sm leading-6 text-[#746d64]">{item.note}</p>
                <div className="mt-4 text-xs text-[#8a8378]">更新：{item.updated}</div>
              </button>
            ))}
          </div>
        </Panel>
        <Panel>
          <div className="text-sm text-[#8a8378]">Local First Import</div>
          <h3 className="mt-2 text-2xl font-semibold">文件入库流程</h3>
          <div className="mt-5 space-y-3">
            {['选择文件', '本地解析', '用户确认', '写入资料库'].map((step, index) => (
              <div key={step} className="flex items-center gap-3 rounded-[20px] bg-[#f8f5ef] p-4">
                <div className="grid h-8 w-8 place-items-center rounded-full bg-[#1f1f1f] text-xs font-semibold text-white">{index + 1}</div>
                <div className="text-sm font-medium text-[#2a2927]">{step}</div>
              </div>
            ))}
          </div>
          <div className="mt-6 rounded-[22px] bg-white p-4 text-sm leading-6 text-[#746d64]">
            原型说明：这里展示体验，不会读取真实文件。
          </div>
        </Panel>
      </div>
    </div>
  );
}

function WorkflowPage({ onNavigate }) {
  const [selected, setSelected] = useState(workflows[0]);

  return (
    <div>
      <PageTitle
        label="Workflow"
        title="企业流程模板"
        description="把可重复工作做成稳定流程。固定流程优先于完全自主 Agent，更适合企业落地。"
        action={<PrimaryButton onClick={() => onNavigate('管理员中心')}>管理模板</PrimaryButton>}
      />
      <div className="grid grid-cols-[1fr_420px] gap-6">
        <Panel>
          <div className="grid grid-cols-2 gap-4">
            {workflows.map((workflow) => (
              <button
                key={workflow.title}
                className={`rounded-[24px] p-5 text-left transition ${
                  selected.title === workflow.title ? 'bg-[#1f1f1f] text-white' : 'bg-[#f8f5ef] text-[#2a2927] hover:bg-white'
                }`}
                onClick={() => setSelected(workflow)}
              >
                <div className="text-sm opacity-70">{workflow.status}</div>
                <div className="mt-2 text-xl font-semibold">{workflow.title}</div>
                <div className="mt-3 text-sm opacity-75">{workflow.steps} 个步骤</div>
                <p className="mt-4 text-sm leading-6 opacity-80">{workflow.outcome}</p>
              </button>
            ))}
          </div>
        </Panel>
        <Panel>
          <div className="text-sm text-[#8a8378]">Flow Preview</div>
          <h3 className="mt-2 text-2xl font-semibold">{selected.title}</h3>
          <div className="mt-5 space-y-3">
            {['读取 Workspace 上下文', '引用资料库', '生成草稿', '进入 AI Inbox 确认', '写入 AI Daily'].map((step, index) => (
              <div key={step} className="rounded-[20px] bg-[#f8f5ef] p-4">
                <div className="text-sm font-semibold text-[#2a2927]">{index + 1}. {step}</div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex gap-3">
            <PrimaryButton onClick={() => onNavigate('AI Inbox')}>模拟运行</PrimaryButton>
            <PrimaryButton variant="light" onClick={() => onNavigate('工作中心')}>选择 Workspace</PrimaryButton>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function TeamPage({ onNavigate }) {
  return (
    <div>
      <PageTitle
        label="Team"
        title="团队与权限"
        description="团队版价值来自共享 Workspace、共享资料库、权限边界和审批流程。"
        action={<PrimaryButton onClick={() => onNavigate('管理员中心')}>进入管理员中心</PrimaryButton>}
      />
      <div className="grid grid-cols-[1fr_360px] gap-6">
        <Panel>
          <div className="grid grid-cols-2 gap-4">
            {teamMembers.map((member) => (
              <div key={member.name} className="rounded-[24px] bg-[#f8f5ef] p-5">
                <div className="text-sm text-[#8a8378]">{member.team}</div>
                <div className="mt-2 text-xl font-semibold text-[#2a2927]">{member.name}</div>
                <div className="mt-1 text-sm text-[#746d64]">{member.role}</div>
                <div className="mt-4 rounded-[18px] bg-white p-3 text-sm leading-6 text-[#746d64]">{member.access}</div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel>
          <div className="text-sm text-[#8a8378]">Shared Spaces</div>
          <h3 className="mt-2 text-2xl font-semibold">协作空间</h3>
          <div className="mt-5 space-y-3">
            {['销售客户空间', '运营交付空间', '企业资料库', '审批 Inbox'].map((space) => (
              <button
                key={space}
                className="w-full rounded-[20px] bg-[#f8f5ef] p-4 text-left text-sm font-medium text-[#2a2927] transition hover:bg-white"
                onClick={() => onNavigate(space === '审批 Inbox' ? 'AI Inbox' : '工作中心')}
              >
                {space}
              </button>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function AdminCenterPage({ onNavigate, isAdmin }) {
  const [providers, setProviders] = useState([]);
  const events = useMemo(() => eventManager.listEvents().slice(0, 6), []);

  useEffect(() => {
    if (!isAdmin) return;
    fetchAdminAiSettings().then((settings) => setProviders(settings.providers || [])).catch(() => setProviders([]));
  }, [isAdmin]);

  if (!isAdmin) return <div className="rounded-[14px] border border-[#E7E9EE] bg-white p-5 text-sm text-[#6B7280]">无权限。</div>;

  return (
    <div className="mx-auto w-full max-w-[1240px] space-y-4 pb-8">
      <PageTitle
        label="管理员中心"
        title="管理员中心"
        description="管理企业 AI 能力中心、Provider 健康状态和系统事件。普通用户不会看到模型配置。"
        action={<PrimaryButton onClick={() => onNavigate('设置', { mode: 'admin' })}>打开 AI Provider Center</PrimaryButton>}
      />
      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <Panel className="p-4 sm:p-6">
          <div className="flex items-start justify-between gap-3"><div><div className="text-xs font-medium tracking-[0.08em] text-[#6B7280]">Enterprise AI Capability Center</div><h3 className="mt-1 text-[20px] font-semibold text-[#16181D]">Provider 状态</h3></div><span className="text-xs text-[#6B7280]">{providers.length} 个已注册</span></div>
          <div className="mt-4 space-y-2">{providers.map((provider) => <button key={provider.id} className="flex min-h-12 w-full items-center justify-between gap-3 rounded-[10px] border border-[#E7E9EE] bg-[#FAFBFC] px-3 text-left hover:border-[#5B5CE2]" onClick={() => onNavigate('设置', { mode: 'admin' })}><div className="min-w-0"><div className="truncate text-sm font-medium text-[#16181D]">{provider.name || provider.displayName}</div><div className="mt-1 truncate text-xs text-[#6B7280]">{provider.enabled ? '已启用' : '未启用'} · {provider.apiKeyConfigured ? '已配置 Key' : '未配置 Key'} · Priority {provider.priority}</div></div><span className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${provider.status === '可用' ? 'bg-[#EAF6F0] text-[#1F8A5B]' : provider.status === '连接失败' ? 'bg-[#FFF0EE] text-[#C2413B]' : 'bg-[#F0F1F4] text-[#6B7280]'}`}>{provider.status}</span></button>)}</div>
        </Panel>
        <Panel className="p-4 sm:p-6">
          <div className="text-xs font-medium tracking-[0.08em] text-[#6B7280]">Event Center</div><h3 className="mt-1 text-[20px] font-semibold text-[#16181D]">系统事件</h3>
          {events.length ? <div className="mt-4 space-y-2">{events.map((event) => <div key={event.id} className="rounded-[10px] bg-[#FAFBFC] p-3"><div className="flex items-center justify-between gap-3"><span className="truncate text-sm font-medium text-[#16181D]">{event.title}</span><span className="shrink-0 text-xs text-[#6B7280]">{event.type}</span></div><div className="mt-1 text-xs text-[#6B7280]">{new Date(event.updatedAt).toLocaleString('zh-CN', { hour12: false })}</div></div>)}</div> : <div className="mt-4 rounded-[10px] border border-dashed border-[#D9DCE4] bg-[#FAFBFC] px-3 py-4 text-sm leading-6 text-[#6B7280]">暂无系统事件。</div>}
        </Panel>
      </div>
    </div>
  );
}

function PrototypePage({ page, onNavigate, currentUser }) {
  const isAdmin = currentUser?.role === 'admin';
  const rendered = useMemo(() => {
    switch (page) {
      case '工作秘书':
        return <WorkSecretaryHomeRedesign onNavigate={onNavigate} />;
      case '工作中心':
        return <WorkCenterPage onNavigate={onNavigate} />;
      case 'AI Daily':
        return <DailyPrototypePage onNavigate={onNavigate} />;
      case 'AI Inbox':
        return <InboxPage onNavigate={onNavigate} />;
      case '会议记录':
        return <MeetingCenter onNavigate={onNavigate} currentUser={currentUser} />;
      case '资料库':
        return <KnowledgePage onNavigate={onNavigate} />;
      case 'Workflow':
        return <WorkflowPage onNavigate={onNavigate} />;
      case '团队':
        return <TeamPage onNavigate={onNavigate} />;
      case '管理员中心':
        return <AdminCenterPage onNavigate={onNavigate} isAdmin={isAdmin} />;
      default:
        return <WorkSecretaryHomeRedesign onNavigate={onNavigate} />;
    }
  }, [currentUser, isAdmin, onNavigate, page]);

  return rendered;
}

export default PrototypePage;

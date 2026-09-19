import { useEffect, useMemo, useRef, useState } from 'react';
import PrimaryButton from './PrimaryButton';
import AISecretaryLogo from './AISecretaryLogo.jsx';
import AISecretaryNavigator from './AISecretaryNavigator.jsx';
import { knowledgeFileManager } from '../../../../core/knowledgeDrop/index.js';
import { quickNoteManager } from '../../../../core/quickNote/index.js';
import { notificationManager } from '../../../../core/notifications/index.js';
import { workSecretaryManager, workSecretaryConversationManager } from '../../../../core/workSecretary/index.js';
import { attachmentParser } from '../../../../core/attachments/AttachmentParser.js';
import { exportResultToPdf, exportResultToWord, parseResultMarkdown } from '../lib/resultExports.js';
import { getAssistantConversationText, getConversationText, isNearConversationBottom, shouldCollapseAssistantResponse, shouldRenderUserMessage } from '../lib/conversationDisplay.js';
import { fetchAiServiceStatus } from '../lib/aiServiceClient.js';
import { findPendingMemoryConfirmation, shouldKeepMemoryConfirmation } from '../lib/memoryConfirmationState.js';
import {
  confirmMemoryCapture,
  correctMemory,
  deleteMemory,
  fetchMemoryHistory,
  fetchMemoryList,
  permanentlyDeleteMemory,
  restoreMemory
} from '../lib/memoryClient.js';

const categoryLabels = { schedule: '日程', reminder: '提醒', todo: '待办', work_log: '日常', note: '日常' };
const quickNoteFilters = ['全部记录', '日常', '待办', '收入', '支出', '灵感', '客户', '会议', '其它分类', '历史记录'];
const attachmentStorageKey = 'ai-work-center-current-task-attachments';
const maxAttachmentSize = 20 * 1024 * 1024;
const supportedAttachmentExtensions = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg', 'webp']);
const supportedAttachmentMimePrefixes = ['image/'];

function createAttachmentId(file) {
  return `task-attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${String(file.name || 'file').replace(/[^\w.-]+/g, '-')}`;
}

function getFileExtension(name = '') {
  return String(name).toLowerCase().split('.').pop() || '';
}

function isSupportedAttachment(file) {
  const extension = getFileExtension(file.name);
  return supportedAttachmentExtensions.has(extension) || supportedAttachmentMimePrefixes.some((prefix) => String(file.type || '').startsWith(prefix));
}

function formatFileSize(size = 0) {
  const bytes = Number(size || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function attachmentTypeLabel(file = {}) {
  const extension = String(file.extension || getFileExtension(file.name)).toUpperCase();
  if (extension) return extension;
  if (file.mimeType || file.type) return String(file.mimeType || file.type);
  return '文件';
}

function attachmentStatusText(file = {}) {
  if (file.error) return file.error;
  return {
    pending: '等待解析',
    parsing: '解析中',
    readable: '可读取',
    partial: '部分读取',
    not_supported: '不支持',
    failed: '解析失败',
    vision_required: '需要视觉模型',
    too_large_to_read: '解析失败',
    read_failed: '解析失败'
  }[file.parseStatus] || (file.parseable ? '可读取' : '不支持');
}

function attachmentStatusTone(file = {}) {
  if (file.error || ['failed', 'read_failed'].includes(file.parseStatus)) return 'text-[#C2413B]';
  if (file.parseable) return 'text-[#1F8A5B]';
  if (file.parseStatus === 'vision_required') return 'text-[#9A6717]';
  return 'text-[#6B7280]';
}

function safeDisplayText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text === '[object Object]') return fallback;
    try {
      const parsed = JSON.parse(text);
      return safeDisplayText(parsed, fallback);
    } catch {
      return text;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => safeDisplayText(item)).filter(Boolean).join('、') || fallback;
  }
  if (typeof value === 'object') {
    const parts = [value.title, value.name, value.content, value.summary, value.text, value.userInput]
      .map((item) => safeDisplayText(item))
      .filter(Boolean);
    return parts[0] || fallback;
  }
  return String(value);
}

function safeDisplayTitle(record) {
  return safeDisplayText(record?.title, '')
    || safeDisplayText(record?.userInput, '')
    || safeDisplayText(record?.name, '')
    || safeDisplayText(record?.result, '')
    || '未命名记录';
}

function formatTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function formatReminderTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatTodayLabel(date = new Date()) {
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}

function inferQuickNoteFilter(note = {}) {
  const text = safeDisplayText(note.content || note.input, '');
  if (note.category === 'todo' || note.category === 'reminder' || note.category === 'schedule') return '待办';
  if (/收入|收款|到账|营收|销售额/.test(text)) return '收入';
  if (/支出|付款|花了|消费|报销|成本/.test(text)) return '支出';
  if (/灵感|想法|创意|点子/.test(text)) return '灵感';
  if (/客户|张总|李总|跟进|成交/.test(text)) return '客户';
  if (/会议|例会|开会|纪要/.test(text)) return '会议';
  if (note.category === 'work_log' || note.category === 'note') return '日常';
  return '其它分类';
}

function statusLabel(status) {
  return {
    completed: '已完成',
    processing: '处理中',
    pending: '待处理',
    needs_input: '待补充',
    failed: '失败',
    cancelled: '已取消'
  }[status] || '待处理';
}

function statusTone(status) {
  return {
    completed: 'bg-[#EAF6F0] text-[#1F8A5B]',
    processing: 'bg-[#EEF0FF] text-[#4D4FC4]',
    failed: 'bg-[#FFF0EE] text-[#C2413B]',
    needs_input: 'bg-[#FFF7E8] text-[#9A6717]'
  }[status] || 'bg-[#F0F1F4] text-[#6B7280]';
}

function EmptyState({ children, compact = false }) {
  const padding = compact ? 'px-2.5 py-2 text-xs leading-5 sm:px-4 sm:py-5 sm:text-sm sm:leading-6' : 'px-3 py-3 text-sm leading-6 sm:px-4 sm:py-5';
  return <div className={`rounded-[10px] border border-dashed border-[#D9DCE4] bg-[#FAFBFC] text-[#6B7280] ${padding}`}>{children}</div>;
}

function splitSourceResult(text = '') {
  const lines = String(text || '').split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) return { sourceLine: '', body: '' };
  const firstLine = lines[firstContentIndex].trim();
  if (!firstLine.startsWith('来源：')) return { sourceLine: '', body: text };
  const body = [...lines.slice(0, firstContentIndex), ...lines.slice(firstContentIndex + 1)].join('\n').trim();
  return {
    sourceLine: firstLine.replace(/\s+/g, ' ').replace(/\s+(\d+\s*[项条])/g, ' · $1'),
    body
  };
}

function shouldCompactSourceDetails(sourceLine = '') {
  return /安排|日程|提醒|待办/.test(sourceLine);
}

function SectionHeading({ eyebrow, title, action }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <div className="text-xs font-medium tracking-[0.08em] text-[#6B7280]">{eyebrow}</div>
        <h2 className="mt-1 text-[20px] font-semibold leading-7 text-[#16181D]">{title}</h2>
      </div>
      {action}
    </div>
  );
}

function ResultBody({ result, expanded, onToggle, compact = false }) {
  const text = getAssistantConversationText(result);
  if (!text) return <div className="theme-muted text-sm">这条回答没有可显示的内容。</div>;
  const { sourceLine, body } = splitSourceResult(text);
  const sourceOnly = sourceLine && shouldCompactSourceDetails(sourceLine);
  const displayText = sourceOnly && !expanded ? '' : (body || text);
  const blocks = parseResultMarkdown(displayText);
  const shouldCollapse = !sourceOnly && shouldCollapseAssistantResponse(displayText);
  return (
    <>
      {sourceLine ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex min-h-7 items-center rounded-full bg-[#EEF0FF] px-2.5 text-[11px] font-medium text-[#4D4FC4]">{sourceLine}</span>
          {sourceOnly ? <button className="min-h-8 rounded-[8px] px-2 text-xs font-medium text-[#4D4FC4] hover:bg-[#F3F3FF]" onClick={onToggle}>{expanded ? '收起详情' : '查看详情'}</button> : null}
        </div>
      ) : null}
      {shouldCollapse && expanded ? <button className="mb-2 min-h-8 rounded-[8px] px-2 text-xs font-medium text-[#4D4FC4] hover:bg-[#F3F3FF]" onClick={onToggle}>收起全文</button> : null}
      {displayText ? (
        <div className={`theme-soft-surface ${compact ? 'text-sm leading-6' : 'rounded-[12px] border border-[#E7E9EE] bg-[#FAFBFC] p-4 text-[15px] leading-7 sm:p-5'} text-[#16181D] ${shouldCollapse && !expanded ? 'line-clamp-3' : ''}`}>
          <div className="space-y-3">
            {blocks.map((block, index) => {
              if (block.type === 'spacer') return <div key={`spacer-${index}`} className="h-1" aria-hidden="true" />;
              if (block.type === 'heading1') return <h3 key={`heading-${index}`} className="text-xl font-semibold leading-8 text-[#16181D]">{block.text}</h3>;
              if (block.type === 'heading2') return <h4 key={`heading-${index}`} className="text-lg font-semibold leading-7 text-[#16181D]">{block.text}</h4>;
              if (block.type === 'heading3') return <h5 key={`heading-${index}`} className="text-base font-semibold leading-7 text-[#16181D]">{block.text}</h5>;
              if (block.type === 'bullet') return <div key={`bullet-${index}`} className="flex gap-2"><span className="shrink-0 text-[#5B5CE2]">•</span><span>{block.text}</span></div>;
              if (block.type === 'ordered') return <div key={`ordered-${index}`} className="flex gap-2"><span className="shrink-0 font-medium text-[#5B5CE2]">{block.marker}.</span><span>{block.text}</span></div>;
              return <p key={`paragraph-${index}`}>{block.text}</p>;
            })}
          </div>
        </div>
      ) : null}
      {shouldCollapse ? <button className="mt-2 min-h-8 rounded-[8px] px-2 text-xs font-medium text-[#4D4FC4] hover:bg-[#F3F3FF]" onClick={onToggle}>{expanded ? '收起全文' : '显示全文'}</button> : null}
    </>
  );
}

function exportMarkdownFile(title, result) {
  const text = safeDisplayText(result, '');
  if (!text) throw new Error('成果内容为空，无法导出 Markdown。');
  const filename = `AI-Work-Center-${safeDisplayText(title, '未命名成果').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60)}-${new Date().toISOString().slice(0, 10)}.md`;
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

function ChatMessage({ task, isActive, isExpanded, actionStatus, exporting, onToggle, onCopy, onExport, onContinueEdit, onRegenerate, onRetry, onWorkspaceAction }) {
  const userMessage = getConversationText(task, ['userInput', 'input', 'prompt', 'question']);
  const result = getAssistantConversationText(task);
  const failed = task.status === 'failed' || task.status === 'needs_input';
  const processing = task.status === 'processing';
  const workspaceActions = Array.isArray(task.workspaceMetadata?.actions) ? task.workspaceMetadata.actions : [];
  return (
    <div className="space-y-3">
      {shouldRenderUserMessage(userMessage) ? (
        <div className="flex justify-end">
          <div className="ai-chat-message ai-message-user max-w-[94%] rounded-[14px] px-4 py-3 text-sm leading-6 text-[color:var(--primary-text)] sm:max-w-[78%]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.08em] text-[color:var(--secondary-text)]">你</div>
            <div className="whitespace-pre-wrap">{userMessage}</div>
          </div>
        </div>
      ) : null}
      <div className="flex justify-start">
        <div className="ai-chat-message ai-message-assistant max-w-[92%] rounded-[18px] px-4 py-3 text-sm leading-6 text-[color:var(--primary-text)] sm:max-w-[76%]">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--secondary-text)]"><AISecretaryLogo size={22} showGlow={false} />AI分身</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] ${statusTone(task.status)}`}>{processing ? '正在处理' : failed ? '需要处理' : '已回复'}</span>
          </div>
          {processing ? <div className="text-[color:var(--secondary-text)]">正在整理你的工作，请稍等。</div> : failed ? <div className="text-[color:var(--danger-color)]">{safeDisplayText(task.error, '任务处理失败，请稍后重试。')}</div> : <ResultBody result={result} expanded={isExpanded} onToggle={onToggle} compact />}
          {!processing && result ? (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[color:var(--divider-color)] pt-3">
              {workspaceActions.length ? workspaceActions.map((action) => (
                <button key={action} className="chat-action-button" onClick={() => onWorkspaceAction(task, action)}>{action}</button>
              )) : (
                <>
                  <button className="chat-action-button" onClick={() => onCopy(task)}>复制</button>
                  <button className="chat-action-button" disabled={Boolean(exporting)} onClick={() => onExport(task, 'word')}>{exporting === 'word' ? '导出中' : '导出Word'}</button>
                  <button className="chat-action-button" disabled={Boolean(exporting)} onClick={() => onExport(task, 'pdf')}>{exporting === 'pdf' ? '导出中' : '导出PDF'}</button>
                  <button className="chat-action-button" onClick={() => onContinueEdit(task)}>继续编辑</button>
                  <button className="chat-action-button" onClick={() => onRegenerate(task)}>重新生成</button>
                </>
              )}
            </div>
          ) : null}
          {failed ? <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[color:var(--divider-color)] pt-3"><button className="chat-action-button" onClick={() => onRetry(task)}>重试</button></div> : null}
          {isActive && actionStatus ? <div className="mt-2 text-xs text-[color:var(--accent-color)]" role="status">{actionStatus}</div> : null}
        </div>
      </div>
    </div>
  );
}

function QuickNotePanel({ quickNote, pendingNote, isClassifyingNote, savedNotes, onChange, onUpdate, onCancel, onAssist, onSave, onOpenHistory, onOpenReports }) {
  const recentNotes = savedNotes.slice(0, 2);
  return (
    <div className="min-w-0 border-l border-[#E7E9EE] pl-3 sm:pl-5">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium tracking-[0.08em] text-[#6B7280] sm:text-xs">快速记录</div>
          <h2 className="mt-0.5 text-[16px] font-semibold leading-6 text-[#16181D] sm:text-[18px]">随手记</h2>
        </div>
        <button className="min-h-11 shrink-0 rounded-[10px] bg-[#F0F1F4] px-2.5 text-[11px] font-medium text-[#4D4FC4] hover:bg-[#E8E9FF]" onClick={onOpenHistory}>查看 / 历史</button>
      </div>
      <input data-quick-note value={quickNote} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSave(); } }} className="h-11 w-full rounded-[10px] border border-[#E7E9EE] bg-[#FAFBFC] px-3 text-xs text-[#16181D] outline-none focus:border-[#5B5CE2] sm:text-sm" placeholder="快速记一条..." />
      {pendingNote ? <div className="mt-2 space-y-2 rounded-[10px] bg-[#FAFBFC] p-2"><div className="grid gap-2 sm:grid-cols-2"><select value={pendingNote.category} onChange={(event) => onUpdate('category', event.target.value)} className="h-11 rounded-[10px] border border-[#E7E9EE] bg-white px-2 text-xs text-[#16181D]">{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input value={pendingNote.timeText} onChange={(event) => onUpdate('timeText', event.target.value)} placeholder="日期或时间" className="h-11 rounded-[10px] border border-[#E7E9EE] bg-white px-2 text-xs text-[#16181D]" /></div><input value={pendingNote.content} onChange={(event) => onUpdate('content', event.target.value)} className="h-11 w-full rounded-[10px] border border-[#E7E9EE] bg-white px-2 text-xs text-[#16181D]" />{pendingNote.missing ? <div className="text-xs leading-5 text-[#C2413B]">{pendingNote.missing}</div> : null}<div className="flex flex-wrap justify-end gap-1"><button className="min-h-11 rounded-[8px] px-2 text-xs text-[#6B7280]" onClick={onCancel}>取消</button>{pendingNote.category === 'note' ? <button className="min-h-11 rounded-[8px] px-2 text-xs text-[#6B7280]" disabled={isClassifyingNote} onClick={onAssist}>{isClassifyingNote ? '识别中' : 'AI 辅助分类'}</button> : null}<button className="min-h-11 rounded-[8px] bg-[#5B5CE2] px-2 text-xs text-white disabled:opacity-40" disabled={Boolean(pendingNote.missing)} onClick={onSave}>确认保存</button></div></div> : null}
      <div className="mt-2 flex min-h-11 items-center justify-between gap-2 rounded-[10px] bg-[#FAFBFC] px-2">
        <div className="min-w-0 text-xs leading-5 text-[#6B7280]">
          {recentNotes.length ? <span className="block truncate">最近：{recentNotes.map((note) => safeDisplayText(note.content || note.input, '未命名记录')).join(' / ')}</span> : '暂无记录'}
        </div>
        <button className="min-h-11 shrink-0 rounded-[8px] px-2 text-[11px] font-medium text-[#4D4FC4]" onClick={onOpenReports}>统计 / 报表</button>
      </div>
    </div>
  );
}

function TodayRemindersSection({ notificationMessage, reminders, onOpenSchedule }) {
  const visibleReminders = reminders.slice(0, 2);
  return (
    <section className="ai-glass-card min-h-[128px] rounded-[var(--radius-card)] p-3 sm:p-4" aria-label="今日事项">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-semibold leading-6 text-[color:var(--primary-text)] sm:text-[18px]">今日事项</h2>
          {notificationMessage ? <div className="mt-0.5 truncate text-xs text-[color:var(--accent-color)]" role="status">{notificationMessage}</div> : null}
        </div>
        <button className="min-h-11 shrink-0 rounded-[12px] px-2.5 text-[11px] font-medium text-[color:var(--accent-color)] hover:bg-[color:var(--accent-soft)]" onClick={onOpenSchedule}>查看日程</button>
      </div>
      {visibleReminders.length ? (
        <div className="space-y-1.5">
          {visibleReminders.map((note) => (
            <div key={note.id} className="flex min-h-8 items-center gap-2 rounded-[10px] bg-[color:var(--input-background)] px-2.5">
              <span className="shrink-0 text-xs font-semibold text-[color:var(--accent-color)]">{formatReminderTime(note.scheduledAt)}</span>
              <span className="min-w-0 truncate text-xs text-[color:var(--primary-text)]">{safeDisplayText(note.content || note.input, '未命名提醒')}</span>
            </div>
          ))}
        </div>
      ) : <div className="rounded-[10px] bg-[color:var(--input-background)] px-2.5 py-2 text-xs leading-5 text-[color:var(--secondary-text)]">今天暂无安排</div>}
    </section>
  );
}

function SchedulePanel({ reminders, notificationStatus, onEnable, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-[#16181D]/25 p-3 backdrop-blur-sm sm:p-6">
      <div className="theme-drawer mx-auto flex max-h-[88vh] w-full max-w-2xl flex-col rounded-[18px] bg-white shadow-[0_24px_80px_rgba(22,24,29,0.18)]">
        <div className="flex items-center justify-between gap-3 border-b border-[#E7E9EE] px-4 py-3">
          <div>
            <div className="text-xs font-medium tracking-[0.08em] text-[#6B7280]">今日安排</div>
            <h2 className="mt-1 text-xl font-semibold text-[#16181D]">完整日程</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {notificationStatus !== 'granted' ? <button className="min-h-11 rounded-[10px] border border-[#E7E9EE] px-3 text-sm text-[#16181D] hover:border-[#5B5CE2]" onClick={onEnable}>{notificationStatus === 'denied' ? '通知设置' : '开启提醒'}</button> : null}
            <button className="min-h-11 rounded-[10px] px-3 text-sm text-[#6B7280] hover:bg-[#FAFBFC]" onClick={onClose}>关闭</button>
          </div>
        </div>
        <div className="overflow-y-auto p-4">
          {reminders.length ? <div className="divide-y divide-[#E7E9EE]">{reminders.map((note) => <div key={note.id} className="py-3 first:pt-0 last:pb-0"><div className="text-sm font-semibold text-[#16181D]">{formatReminderTime(note.scheduledAt)} · {safeDisplayText(note.content || note.input, '未命名提醒')}</div><div className="mt-1 text-xs text-[#6B7280]">{safeDisplayText(note.dateText, '今天')} · {categoryLabels[note.category] || '提醒'}</div></div>)}</div> : <EmptyState>今天暂无安排</EmptyState>}
        </div>
      </div>
    </div>
  );
}

function QuickNoteHistoryPanel({ mode, notes, filter, onFilter, onClose }) {
  const filteredNotes = notes.filter((note) => {
    if (mode === 'reports') return false;
    if (filter === '全部记录' || filter === '历史记录') return true;
    return inferQuickNoteFilter(note) === filter;
  });
  return (
    <div className="fixed inset-0 z-50 bg-[#16181D]/25 p-3 backdrop-blur-sm sm:p-6">
      <div className="theme-drawer mx-auto flex max-h-[88vh] w-full max-w-3xl flex-col rounded-[18px] bg-white shadow-[0_24px_80px_rgba(22,24,29,0.18)]">
        <div className="flex items-center justify-between gap-3 border-b border-[#E7E9EE] px-4 py-3">
          <div>
            <div className="text-xs font-medium tracking-[0.08em] text-[#6B7280]">随手记</div>
            <h2 className="mt-1 text-xl font-semibold text-[#16181D]">{mode === 'reports' ? '统计 / 报表' : '查看 / 历史'}</h2>
          </div>
          <button className="min-h-11 rounded-[10px] px-3 text-sm text-[#6B7280] hover:bg-[#FAFBFC]" onClick={onClose}>关闭</button>
        </div>
        {mode === 'history' ? <div className="flex gap-2 overflow-x-auto border-b border-[#E7E9EE] px-4 py-3">{quickNoteFilters.map((item) => <button key={item} className={`min-h-11 shrink-0 rounded-full px-3 text-xs font-medium ${filter === item ? 'bg-[#5B5CE2] text-white' : 'bg-[#F0F1F4] text-[#6B7280]'}`} onClick={() => onFilter(item)}>{item}</button>)}</div> : null}
        <div className="overflow-y-auto p-4">
          {mode === 'reports' ? <EmptyState>随手记统计 / 报表功能建设中。当前不会使用 Mock 数据，后续会基于真实随手记生成日报、周报和月报。</EmptyState> : filteredNotes.length ? <div className="divide-y divide-[#E7E9EE]">{filteredNotes.map((note) => <div key={note.id} className="py-3 first:pt-0 last:pb-0"><div className="text-sm font-semibold text-[#16181D]">{safeDisplayText(note.content || note.input, '未命名记录')}</div><div className="mt-1 text-xs text-[#6B7280]">{inferQuickNoteFilter(note)} · {formatTime(note.createdAt)}</div></div>)}</div> : <EmptyState>没有符合条件的随手记。</EmptyState>}
        </div>
      </div>
    </div>
  );
}

function ConversationHistoryPanel({ conversations, activeConversationId, onOpen, onRename, onDelete, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-[#16181D]/25 p-3 backdrop-blur-sm sm:p-6">
      <div className="theme-drawer ml-auto flex h-full max-h-[92vh] w-full max-w-xl flex-col rounded-[18px] bg-white shadow-[0_24px_80px_rgba(22,24,29,0.18)]">
        <div className="flex items-center justify-between gap-3 border-b border-[#E7E9EE] px-4 py-3">
          <div>
            <div className="text-xs font-medium tracking-[0.08em] text-[#6B7280]">工作秘书</div>
            <h2 className="mt-1 text-xl font-semibold text-[#16181D]">历史对话</h2>
          </div>
          <button className="min-h-11 rounded-[10px] px-3 text-sm text-[#6B7280] hover:bg-[#FAFBFC]" onClick={onClose}>关闭</button>
        </div>
        <div className="overflow-y-auto p-4">
          {conversations.length ? (
            <div className="space-y-2">
              {conversations.map((conversation) => {
                const lastUserMessage = [...conversation.messages].reverse().find((message) => message.role === 'user');
                const isActive = conversation.conversationId === activeConversationId;
                return (
                  <div key={conversation.conversationId} className={`rounded-[14px] border p-3 ${isActive ? 'border-[#5B5CE2] bg-[#F7F7FF]' : 'border-[#E7E9EE] bg-white'}`}>
                    <button className="block w-full text-left" onClick={() => onOpen(conversation.conversationId)}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-[#16181D]">{safeDisplayText(conversation.title, '未命名对话')}</div>
                          <div className="mt-1 truncate text-xs text-[#6B7280]">{safeDisplayText(lastUserMessage?.content, '暂无问题')}</div>
                        </div>
                        <span className="shrink-0 rounded-full bg-[#F0F1F4] px-2 py-1 text-[11px] text-[#6B7280]">{conversation.messages.length} 条</span>
                      </div>
                      <div className="mt-2 text-xs text-[#9AA1AE]">{formatTime(conversation.updatedAt)}</div>
                    </button>
                    <div className="mt-2 flex gap-2 border-t border-[#EEF0F4] pt-2">
                      <button className="min-h-11 rounded-[8px] px-2 text-xs font-medium text-[#4D4FC4]" onClick={() => onOpen(conversation.conversationId)}>打开</button>
                      <button className="min-h-11 rounded-[8px] px-2 text-xs text-[#6B7280]" onClick={() => onRename(conversation)}>重命名</button>
                      <button className="min-h-11 rounded-[8px] px-2 text-xs text-[#C2413B]" onClick={() => onDelete(conversation)}>删除</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <EmptyState>还没有历史对话。开始第一项工作后，会话会保存在这里。</EmptyState>}
        </div>
      </div>
    </div>
  );
}

function WorkSecretaryHome({ onNavigate }) {
  const [draft, setDraft] = useState('');
  const [tasks, setTasks] = useState(() => workSecretaryManager.listTasks());
  const [activeTask, setActiveTask] = useState(() => workSecretaryManager.listTasks()[0] || null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [serviceConnected, setServiceConnected] = useState(false);
  const [knowledgeFiles, setKnowledgeFiles] = useState(() => knowledgeFileManager.listFiles());
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [attachmentNotice, setAttachmentNotice] = useState('');
  const [quickNote, setQuickNote] = useState('');
  const [pendingNote, setPendingNote] = useState(null);
  const [isClassifyingNote, setIsClassifyingNote] = useState(false);
  const [savedNotes, setSavedNotes] = useState(() => quickNoteManager.listNotes());
  const [resultActionStatus, setResultActionStatus] = useState('');
  const [exporting, setExporting] = useState('');
  const [resultExpanded, setResultExpanded] = useState({});
  const [notificationStatus, setNotificationStatus] = useState(() => notificationManager.getStatus());
  const [notificationMessage, setNotificationMessage] = useState('');
  const activeTaskRef = useRef(null);
  const fileInputRef = useRef(null);
  const knowledgeFileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const conversationMessagesRef = useRef(null);
  const shouldFollowLatestRef = useRef(true);
  const [showReturnToLatest, setShowReturnToLatest] = useState(false);
  const [knowledgeDropOpen, setKnowledgeDropOpen] = useState(false);
  const [meetingPanelOpen, setMeetingPanelOpen] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [memoryView, setMemoryView] = useState('current');
  const [memoryItems, setMemoryItems] = useState([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  const [pendingMemoryConfirmation, setPendingMemoryConfirmation] = useState(() => findPendingMemoryConfirmation(workSecretaryManager.listTasks()));
  const [memoryConfirmationEditing, setMemoryConfirmationEditing] = useState(false);
  const [memoryConfirmationDraft, setMemoryConfirmationDraft] = useState('');
  const [memoryConfirmationBusy, setMemoryConfirmationBusy] = useState(false);
  const [memoryConfirmationError, setMemoryConfirmationError] = useState('');
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [navigatorMessage, setNavigatorMessage] = useState('');
  const [schedulePanelOpen, setSchedulePanelOpen] = useState(false);
  const [quickNotePanelMode, setQuickNotePanelMode] = useState(null);
  const [quickNoteFilter, setQuickNoteFilter] = useState('全部记录');
  const [conversations, setConversations] = useState(() => workSecretaryConversationManager.listConversations(workSecretaryManager.listTasks()));
  const [activeConversationId, setActiveConversationId] = useState(() => workSecretaryConversationManager.getActiveConversationId(workSecretaryManager.listTasks()));
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);

  const refreshTasks = () => {
    const next = workSecretaryManager.listTasks();
    setTasks(next);
    const nextConversations = workSecretaryConversationManager.listConversations(next);
    setConversations(nextConversations);
    setActiveConversationId((current) => {
      if (current && nextConversations.some((conversation) => conversation.conversationId === current)) return current;
      return workSecretaryConversationManager.getActiveConversationId(next);
    });
    fetchAiServiceStatus().then(setServiceConnected);
    return next;
  };

  useEffect(() => {
    fetchAiServiceStatus().then(setServiceConnected);
  }, []);

  const scrollToLatest = (focusInput = false, behavior = 'smooth') => {
    const container = conversationMessagesRef.current;
    if (!container) return;
    window.requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior });
      setShowReturnToLatest(false);
      if (focusInput) window.setTimeout(() => textareaRef.current?.focus(), 80);
    });
  };

  const handleConversationScroll = (event) => {
    const nearBottom = isNearConversationBottom(event.currentTarget);
    shouldFollowLatestRef.current = nearBottom;
    setShowReturnToLatest(!nearBottom);
  };

  const settleComposerNearKeyboard = () => {
    const adjust = () => {
      const composer = document.querySelector('.conversation-composer');
      if (!composer) return;
      const visualViewport = window.visualViewport;
      const viewportBottom = visualViewport
        ? visualViewport.offsetTop + visualViewport.height
        : window.innerHeight;
      const keyboardLikelyOpen = visualViewport
        ? visualViewport.height < window.innerHeight * 0.86
        : false;
      const desiredGap = keyboardLikelyOpen ? 72 : 24;
      const composerBottom = composer.getBoundingClientRect().bottom;
      const coveredDistance = composerBottom - (viewportBottom - desiredGap);
      if (coveredDistance > 1) {
        window.scrollBy({ top: coveredDistance, behavior: 'smooth' });
      }
    };
    [120, 320, 620].forEach((delay) => window.setTimeout(adjust, delay));
  };

  useEffect(() => {
    refreshTasks();
    if (sessionStorage.getItem(attachmentStorageKey) === 'stale') {
      setAttachmentNotice('临时附件已失效，请重新添加。');
      sessionStorage.removeItem(attachmentStorageKey);
    }
  }, []);

  useEffect(() => {
    if (shouldFollowLatestRef.current) scrollToLatest(false);
  }, [tasks.length, activeTask?.taskId, activeTask?.status, status]);

  useEffect(() => {
    if (attachedFiles.length) {
      sessionStorage.setItem(attachmentStorageKey, 'stale');
    } else {
      sessionStorage.removeItem(attachmentStorageKey);
    }
  }, [attachedFiles]);

  const refreshKnowledge = () => setKnowledgeFiles(knowledgeFileManager.listFiles());
  const refreshNotes = () => setSavedNotes(quickNoteManager.listNotes());

  useEffect(() => {
    if (!quickNoteManager.subscribeScheduleChanges) return undefined;
    return quickNoteManager.subscribeScheduleChanges(() => refreshNotes());
  }, []);

  const todayReminders = useMemo(() => notificationManager.listTodayReminders(savedNotes), [savedNotes]);

  useEffect(() => {
    const checkDueReminders = () => {
      const delivered = notificationManager.notifyDueReminders(savedNotes);
      if (delivered.length) setNotificationMessage(`已发送 ${delivered.length} 条桌面提醒。`);
      setNotificationStatus(notificationManager.getStatus());
    };
    checkDueReminders();
    const timer = window.setInterval(checkDueReminders, 15000);
    return () => window.clearInterval(timer);
  }, [savedNotes]);

  const enableDesktopNotifications = async () => {
    const result = await notificationManager.requestPermission();
    setNotificationStatus(result.status);
    setNotificationMessage(result.message);
    if (result.status === 'granted') {
      const delivered = notificationManager.notifyDueReminders(savedNotes);
      if (delivered.length) setNotificationMessage(`已发送 ${delivered.length} 条桌面提醒。`);
    }
  };

  const addKnowledgeFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    files.forEach((file) => knowledgeFileManager.addFile({
        name: file.name,
        type: file.type,
        size: file.size,
        localPath: `local-ref://${file.name}-${file.lastModified || 'selected'}`
      }));
    refreshKnowledge();
    setKnowledgeDropOpen(true);
  };

  const addSelectedFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setAttachmentError('');
    setAttachmentNotice('正在解析附件。只有真实读取到的内容会用于本次任务。');
    const nextFiles = [];
    const errors = [];
    const existingKeys = new Set(attachedFiles.map((file) => file.sourceKey));
    for (const file of files) {
      const sourceKey = `${file.name}-${file.size}-${file.lastModified || 0}`;
      if (existingKeys.has(sourceKey) || nextFiles.some((item) => item.sourceKey === sourceKey)) {
        errors.push(`“${file.name}”已添加。`);
        continue;
      }
      if (!isSupportedAttachment(file)) {
        errors.push(`“${file.name}”暂不支持该文件类型。`);
        continue;
      }
      if (file.size > maxAttachmentSize) {
        errors.push(`“${file.name}”超过 ${formatFileSize(maxAttachmentSize)}，请换用较小文件。`);
        continue;
      }

      const parsed = await attachmentParser.parse(file);
      const parseStatusText = attachmentParser.getStatus(parsed);
      const parseStatus = {
        等待解析: 'pending',
        解析中: 'parsing',
        可读取: 'readable',
        部分读取: 'partial',
        不支持: 'not_supported',
        解析失败: 'failed',
        需要视觉模型: 'vision_required'
      }[parseStatusText] || 'failed';
      const hasText = Boolean(parsed.text?.trim());
      const hasTables = Array.isArray(parsed.tables) && parsed.tables.length > 0;
      const hasImagePayload = Boolean(parsed.imageDataUrl && parsed.metadata?.visionRequired);

      nextFiles.push({
        id: createAttachmentId(file),
        sourceKey,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        extension: getFileExtension(file.name),
        status: parseStatus,
        contentType: parsed.contentType,
        parseable: Boolean(parsed.parsed && (hasText || hasTables || hasImagePayload) && !parsed.error),
        readable: Boolean(parsed.parsed && (hasText || hasTables || hasImagePayload) && !parsed.error),
        parseStatus,
        content: String(parsed.text || '').slice(0, 24000),
        imageDataUrl: parsed.imageDataUrl || '',
        tables: parsed.tables || [],
        metadata: parsed.metadata || {},
        warnings: parsed.warnings || [],
        error: parsed.error || ''
      });
    }

    if (nextFiles.length) setAttachedFiles((current) => [...current, ...nextFiles]);
    if (errors.length) setAttachmentError(errors.join(' '));
    setAttachmentNotice(nextFiles.length ? '附件解析完成。不可读取的文件只保留记录，不会进入 AI 上下文。' : '');
  };

  const removeKnowledgeFile = (file) => {
    if (!window.confirm(`确定删除“${safeDisplayTitle(file)}”的应用索引吗？原文件不会被删除。`)) return;
    knowledgeFileManager.deleteFile(file.id);
    refreshKnowledge();
  };

  const detachFile = (fileId) => {
    setAttachedFiles((current) => current.filter((file) => file.id !== fileId));
  };

  const openKnowledgeDrop = () => {
    setKnowledgeDropOpen((current) => !current);
    setMeetingPanelOpen(false);
    setMemoryPanelOpen(false);
  };

  const openMeetingPanel = () => {
    setMeetingPanelOpen(true);
    setKnowledgeDropOpen(false);
    setMemoryPanelOpen(false);
  };

  const loadMemories = async (view = memoryView) => {
    setMemoryLoading(true);
    setMemoryError('');
    try {
      const result = await fetchMemoryList(view);
      setMemoryItems(Array.isArray(result?.data?.items) ? result.data.items : []);
      setMemoryView(view);
    } catch (loadError) {
      setMemoryItems([]);
      setMemoryError(loadError.message || '记忆暂时不可用，其他功能仍可继续。');
    } finally {
      setMemoryLoading(false);
    }
  };

  const showMemoryHistory = async (item) => {
    try {
      const result = await fetchMemoryHistory(item.memoryId);
      const count = result?.data?.items?.length || 0;
      setNavigatorMessage(count ? `这条记忆共有 ${count} 个可追溯版本。` : '这条记忆暂无历史版本。');
    } catch (historyError) {
      setNavigatorMessage(historyError.message || '暂时无法查看历史版本。');
    }
  };

  const correctMemoryItem = async (item) => {
    const value = window.prompt('请输入正确内容。旧版本会保留。', '');
    if (!value?.trim()) return;
    try {
      const first = await correctMemory(item.memoryId, { expectedVersion: item.version, value: value.trim() });
      if (first?.status === 'confirmation_required') {
        if (!window.confirm('这项纠正较敏感，确认长期保存新版本吗？')) return;
        await correctMemory(item.memoryId, {
          expectedVersion: item.version,
          value: value.trim(),
          confirmationToken: first.data?.confirmationToken
        });
      }
      setNavigatorMessage('已纠正。旧内容仍保留在历史版本中。');
      await loadMemories('current');
    } catch (correctionError) {
      setMemoryError(correctionError.message || '纠正失败，请重试。');
    }
  };

  const deleteMemoryItem = async (item) => {
    if (!window.confirm('删除后将进入 7 天回收站，并立即停止用于后续回答。')) return;
    try {
      const first = await deleteMemory(item.memoryId, { expectedVersion: item.version });
      if (first?.status === 'confirmation_required') {
        if (!window.confirm('这条记忆较敏感，确认移入回收站吗？')) return;
        const completed = await deleteMemory(item.memoryId, {
          expectedVersion: item.version,
          confirmationToken: first.data?.confirmationToken
        });
        if (completed?.status !== 'completed') throw new Error(completed?.safeMessage || '删除未完成。');
      } else if (first?.status !== 'completed') {
        throw new Error(first?.safeMessage || '删除未完成。');
      }
      setNavigatorMessage('已移入回收站，并停止用于后续回答。');
      await loadMemories(memoryView);
    } catch (deleteError) {
      setMemoryError(deleteError.message || '删除失败，请重试。');
    }
  };

  const restoreMemoryItem = async (item) => {
    try {
      await restoreMemory(item.memoryId, { expectedVersion: item.version });
      setNavigatorMessage('已恢复这条记忆。');
      await loadMemories('recycle_bin');
    } catch (restoreError) {
      setMemoryError(restoreError.message || '恢复失败，请重试。');
    }
  };

  const purgeMemoryItem = async (item) => {
    if (!window.confirm('永久删除后无法恢复。要继续吗？')) return;
    try {
      const first = await permanentlyDeleteMemory(item.memoryId, { expectedVersion: item.version });
      if (first?.status !== 'confirmation_required') throw new Error(first?.safeMessage || '未能发起永久删除。');
      if (!window.confirm('再次确认：永久删除这条记忆？')) return;
      await permanentlyDeleteMemory(item.memoryId, {
        expectedVersion: item.version,
        confirmationToken: first.data?.confirmationToken
      });
      setNavigatorMessage('已永久删除，无法恢复。');
      await loadMemories('recycle_bin');
    } catch (purgeError) {
      setMemoryError(purgeError.message || '永久删除失败，请重试。');
    }
  };

  const answerMemoryConfirmation = async (action) => {
    if (!pendingMemoryConfirmation?.confirmationId) return;
    if (action === 'edit') {
      setMemoryConfirmationEditing(true);
      setMemoryConfirmationDraft(pendingMemoryConfirmation.sensitivity === 'high' ? '' : (pendingMemoryConfirmation.safeSummary || ''));
      setMemoryConfirmationError('');
      return;
    }
    const editedText = action === 'save_edit' ? memoryConfirmationDraft.trim() : '';
    if (action === 'save_edit' && !editedText) {
      setMemoryConfirmationError('请输入修改后的内容。');
      return;
    }
    const requestAction = action === 'save_edit' ? 'edit' : action;
    setMemoryConfirmationBusy(true);
    setMemoryConfirmationError('');
    try {
      const result = await confirmMemoryCapture({
        confirmationId: pendingMemoryConfirmation.confirmationId,
        action: requestAction,
        editedText,
        requestId: `memory-confirm-${pendingMemoryConfirmation.confirmationId}-${requestAction}`,
        idempotencyKey: `memory-confirm:${pendingMemoryConfirmation.confirmationId}:${requestAction}`
      });
      const resolvedTask = pendingMemoryConfirmation.taskId
        ? workSecretaryManager.resolveMemoryConfirmation(pendingMemoryConfirmation.taskId, result)
        : null;
      if (resolvedTask) {
        workSecretaryConversationManager.syncTask(resolvedTask.conversationId || activeConversationId, resolvedTask);
        if (activeTask?.taskId === resolvedTask.taskId) setActiveTask(resolvedTask);
      }
      setNavigatorMessage(result?.safeMessage || (requestAction === 'cancel' ? '已取消，内容未保存。' : '记忆操作已完成。'));
      if (shouldKeepMemoryConfirmation(result)) {
        setPendingMemoryConfirmation({ ...pendingMemoryConfirmation, ...result, taskId: pendingMemoryConfirmation.taskId });
      } else {
        setPendingMemoryConfirmation(null);
      }
      setMemoryConfirmationEditing(false);
      setMemoryConfirmationDraft('');
      refreshTasks();
      if (memoryPanelOpen) await loadMemories('current');
    } catch (confirmationError) {
      setMemoryConfirmationError(confirmationError.message || '确认失败，请重试。');
    } finally {
      setMemoryConfirmationBusy(false);
    }
  };

  const handleNavigatorEntry = (entry) => {
    setNavigatorOpen(false);
    setNavigatorMessage('');
    if (entry.id === 'meeting') {
      onNavigate?.(entry.target || '会议记录');
      return;
    }
    if (entry.id === 'history') {
      setHistoryPanelOpen(true);
      return;
    }
    if (entry.id === 'memory') {
      setMemoryPanelOpen(true);
      setKnowledgeDropOpen(false);
      setMeetingPanelOpen(false);
      loadMemories('current');
      return;
    }
    if (entry.id === 'schedule') {
      setSchedulePanelOpen(true);
      return;
    }
    if (entry.id === 'statistics') {
      setQuickNotePanelMode('reports');
      return;
    }
    if (entry.id === 'knowledge') {
      openKnowledgeDrop();
      return;
    }
    if (entry.id === 'settings') {
      onNavigate?.('设置');
    }
  };

  const classifyQuickNote = (value) => {
    setQuickNote(value);
    setPendingNote(value.trim() ? quickNoteManager.classify(value) : null);
  };

  const updatePendingNote = (key, value) => {
    setPendingNote((current) => (current ? { ...current, [key]: value } : current));
  };

  const saveQuickNote = async () => {
    if (!pendingNote || pendingNote.missing) return;
    const currentInput = quickNote.trim();
    if (!currentInput) return;
    const result = await quickNoteManager.handleInput(currentInput, {
      sourceType: 'quick_note',
      sourceId: pendingNote.id,
      currentTime: new Date().toISOString(),
      locale: 'zh-CN'
    });
    if (result.status === 'needs_input') {
      setPendingNote((current) => current ? { ...current, missing: result.result || result.error || '请补充信息。', needsConfirmation: true } : current);
      return;
    }
    if (result.status === 'pass_through') {
      setDraft(currentInput);
      setPendingNote((current) => current ? { ...current, missing: '已识别为问题或工作任务，请在主对话发送。', needsConfirmation: true } : current);
      textareaRef.current?.focus();
      return;
    }
    refreshNotes();
    setQuickNote('');
    setPendingNote(null);
    window.setTimeout(() => textareaRef.current?.focus(), 80);
  };

  const createNoteSummaryTask = (period) => {
    const labels = { day: '日总结', week: '周总结', month: '月总结' };
    const limit = period === 'day' ? 20 : period === 'week' ? 60 : 120;
    const noteLines = savedNotes
      .slice(0, limit)
      .map((note, index) => `${index + 1}. [${categoryLabels[note.category] || '记录'}] ${safeDisplayText(note.content || note.input, '')}${note.timeText ? `（${note.timeText}）` : ''}`)
      .join('\n');
    const prompt = `请根据以下随手记生成${labels[period] || '总结'}，包括：已完成事项、待办事项、重要提醒、风险遗漏和下一步建议。\n\n${noteLines}`;
    setDraft(prompt);
    textareaRef.current?.focus();
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
    const taskAttachments = attachedFiles.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      extension: file.extension,
      status: file.status,
      parseable: file.parseable,
      readable: file.readable,
      parseStatus: file.parseStatus,
      content: file.content,
      contentType: file.contentType,
      tables: file.tables,
      metadata: file.metadata,
      warnings: file.warnings,
      error: file.error,
      imageDataUrl: file.imageDataUrl
    }));
    const conversationContext = workSecretaryConversationManager.buildContext(activeConversationId, input);
    const task = workSecretaryManager.createTask(input, {
      conversationId: activeConversationId,
      conversationContext,
      attachments: taskAttachments
    });
    workSecretaryConversationManager.syncTask(activeConversationId, task);
    shouldFollowLatestRef.current = true;
    activeTaskRef.current = task.taskId;
    setActiveTask(task);
    setDraft('');
    setAttachedFiles([]);
    setAttachmentError('');
    setAttachmentNotice('');
    refreshTasks();
    setStatus('processing');
    setError('');
    setResultActionStatus('');
    setResultExpanded((current) => ({ ...current, [task.taskId]: false }));
    try {
      const completed = await workSecretaryManager.executeTask(task.taskId);
      if (activeTaskRef.current !== task.taskId) return;
      workSecretaryConversationManager.syncTask(activeConversationId, completed);
      setActiveTask(completed);
      const confirmation = completed.workspaceMetadata?.memoryIntegration;
      if (confirmation?.confirmationId) {
        setPendingMemoryConfirmation({ ...confirmation, taskId: completed.taskId });
        setMemoryConfirmationEditing(false);
        setMemoryConfirmationDraft('');
        setMemoryConfirmationError('');
      }
      setError(completed.error || '');
      setStatus(completed.status === 'completed' ? 'done' : 'error');
      refreshTasks();
    } catch (requestError) {
      workSecretaryConversationManager.syncTask(activeConversationId, {
        ...task,
        status: 'failed',
        error: requestError.message || '任务处理失败，请稍后重试。',
        updatedAt: new Date().toISOString()
      });
      setError(requestError.message || '任务处理失败，请稍后重试。');
      setStatus('error');
      refreshTasks();
    }
  };

  const cancel = () => {
    if (!activeTaskRef.current) return;
    const cancelled = workSecretaryManager.cancelTask(activeTaskRef.current);
    workSecretaryConversationManager.syncTask(activeConversationId, cancelled);
    activeTaskRef.current = null;
    setActiveTask(cancelled);
    setStatus('cancelled');
    refreshTasks();
  };

  const copyResult = async (task = activeTask) => {
    const result = getAssistantConversationText(task);
    if (!result) {
      setResultActionStatus('当前没有可复制的成果。');
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持复制。');
      await navigator.clipboard.writeText(result);
      setResultActionStatus('已复制全文');
    } catch (copyError) {
      setResultActionStatus(copyError.message || '复制失败，请重试。');
    }
  };

  const saveToRecentResults = (task = activeTask) => {
    const saved = workSecretaryManager.saveTaskResult(task?.taskId);
    if (!saved) {
      setResultActionStatus('当前成果尚未完成，暂时无法保存。');
      return;
    }
    setActiveTask(saved);
    refreshTasks();
    setResultActionStatus('已保存到最近成果');
  };

  const exportResult = (taskOrFormat, maybeFormat) => {
    const task = typeof taskOrFormat === 'string' ? activeTask : taskOrFormat || activeTask;
    const format = typeof taskOrFormat === 'string' ? taskOrFormat : maybeFormat;
    const title = safeDisplayTitle(task);
    const result = getAssistantConversationText(task);
    if (!result) {
      setResultActionStatus('当前没有可导出的成果。');
      return;
    }
    setExporting(format);
    setResultActionStatus('');
    try {
      const filename = format === 'word'
        ? exportResultToWord(title, result)
        : format === 'markdown'
          ? exportMarkdownFile(title, result)
          : exportResultToPdf(title, result);
      setResultActionStatus(`已下载 ${filename}`);
    } catch (exportError) {
      setResultActionStatus(exportError.message || `${format === 'word' ? 'Word' : 'PDF'} 导出失败，请重试。`);
    } finally {
      setExporting('');
    }
  };

  const regenerate = (task = activeTask) => {
    const input = safeDisplayText(task?.userInput, '');
    if (!input) return;
    send(input);
  };

  const continueWith = (task = activeTask, instruction = '') => {
    if (!task || status === 'processing') return;
    setActiveTask(task);
    setDraft(instruction);
    window.setTimeout(() => textareaRef.current?.focus(), 80);
  };

  const handleWorkspaceAction = (task = activeTask, action = '') => {
    setActiveTask(task);
    const scheduleId = task?.workspaceMetadata?.scheduleId || '';
    if (action === '查看日程') {
      setSchedulePanelOpen(true);
      return;
    }
    if (action === '撤销') {
      if (!scheduleId) {
        setResultActionStatus('未找到可撤销的日程。');
        return;
      }
      quickNoteManager.deleteNote(scheduleId);
      refreshNotes();
      setResultActionStatus('已撤销。');
      return;
    }
    if (action === '修改') {
      setDraft('请说明新的时间或内容：');
      setResultActionStatus('请输入要修改的新时间或内容。');
      window.setTimeout(() => textareaRef.current?.focus(), 80);
    }
  };

  const openTask = (task) => {
    setActiveTask(task);
    setStatus(task.status === 'completed' ? 'done' : task.status === 'failed' ? 'error' : task.status);
    setError(safeDisplayText(task.error, ''));
    setResultExpanded((current) => ({ ...current, [task.taskId]: Boolean(current[task.taskId]) }));
    shouldFollowLatestRef.current = true;
    scrollToLatest();
  };

  const openConversation = (conversationId) => {
    const conversation = workSecretaryConversationManager.setActiveConversation(conversationId);
    if (!conversation) return;
    setActiveConversationId(conversation.conversationId);
    setHistoryPanelOpen(false);
    const taskIds = new Set(conversation.messages.map((message) => message.resultId).filter(Boolean));
    const latestTask = tasks
      .filter((task) => taskIds.has(task.taskId))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
    setActiveTask(latestTask);
    setStatus(latestTask?.status === 'completed' ? 'done' : latestTask?.status || 'idle');
    setError(safeDisplayText(latestTask?.error, ''));
    window.setTimeout(() => {
      shouldFollowLatestRef.current = true;
      scrollToLatest(true);
    }, 80);
  };

  const createNewConversation = () => {
    if (!window.confirm('开始新对话后，当前会话仍会保留在历史记录中。')) return;
    const conversation = workSecretaryConversationManager.createConversation('新的对话');
    setConversations(workSecretaryConversationManager.listConversations(tasks));
    setActiveConversationId(conversation.conversationId);
    setActiveTask(null);
    activeTaskRef.current = null;
    setDraft('');
    setError('');
    setStatus('idle');
    setAttachedFiles([]);
    setAttachmentError('');
    setAttachmentNotice('');
    setResultActionStatus('');
    window.setTimeout(() => textareaRef.current?.focus(), 80);
  };

  const renameConversation = (conversation) => {
    const nextTitle = window.prompt('请输入新的会话标题', conversation.title);
    if (!nextTitle) return;
    workSecretaryConversationManager.renameConversation(conversation.conversationId, nextTitle);
    setConversations(workSecretaryConversationManager.listConversations(tasks));
  };

  const deleteConversation = (conversation) => {
    if (!window.confirm(`确定删除“${safeDisplayText(conversation.title, '未命名对话')}”吗？Provider、API Key、随手记和知识库不会被删除。`)) return;
    const next = workSecretaryConversationManager.deleteConversation(conversation.conversationId);
    setConversations(workSecretaryConversationManager.listConversations(tasks));
    setActiveConversationId(next.conversationId);
    setActiveTask(null);
    setStatus('idle');
    setHistoryPanelOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 80);
  };

  const visibleTasks = tasks.filter((task) => safeDisplayTitle(task) !== '未命名记录' || safeDisplayText(task.userInput, ''));
  const completedToday = visibleTasks.filter((task) => task.status === 'completed' && task.completedAt && new Date(task.completedAt).toDateString() === new Date().toDateString()).length;
  const statusCounts = {
    pending: visibleTasks.filter((task) => ['pending', 'needs_input'].includes(task.status)).length,
    processing: visibleTasks.filter((task) => task.status === 'processing').length + (status === 'processing' ? 1 : 0),
    completed: visibleTasks.filter((task) => task.status === 'completed').length,
    confirmation: visibleTasks.filter((task) => task.status === 'needs_confirmation').length
  };

  const recentRecords = useMemo(() => {
    const taskRecords = visibleTasks.map((task) => ({
      id: `task-${task.taskId}`,
      type: task.status === 'completed' ? '成果' : '任务',
      title: safeDisplayTitle(task),
      time: task.completedAt || task.updatedAt || task.createdAt,
      status: task.status,
      detail: task.isSaved ? '已保存到最近成果' : '',
      onOpen: () => openTask(task)
    }));
    const fileRecords = knowledgeFiles.map((file) => ({
      id: `file-${file.id}`,
      type: '资料',
      title: safeDisplayTitle(file),
      time: file.createdAt,
      status: file.status === 'ready' ? 'completed' : file.status,
      detail: file.status === 'failed' ? safeDisplayText(file.error, '暂不支持该文件类型。') : '已保存，内容解析将在后续版本开放。'
    }));
    const noteRecords = savedNotes.map((note) => ({
      id: `note-${note.id}`,
      type: categoryLabels[note.category] || '随手记',
      title: safeDisplayTitle({ ...note, title: note.title || note.content }),
      time: note.createdAt || note.updatedAt,
      status: 'completed',
      detail: note.timeText || '无明确时间'
    }));
    return [...taskRecords, ...fileRecords, ...noteRecords]
      .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())
      .slice(0, 5);
  }, [knowledgeFiles, savedNotes, tasks]);

  const isBusy = status === 'processing';
  const hasOverviewData = Object.values(statusCounts).some(Boolean) || savedNotes.length > 0;
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === activeConversationId)
      || workSecretaryConversationManager.getConversation(activeConversationId, visibleTasks),
    [activeConversationId, conversations, visibleTasks]
  );
  const activeConversationTaskIds = useMemo(
    () => new Set((activeConversation?.messages || []).map((message) => message.resultId).filter(Boolean)),
    [activeConversation]
  );
  const conversationTasks = useMemo(() => {
    const merged = new Map();
    visibleTasks
      .filter((task) => task.conversationId === activeConversationId || activeConversationTaskIds.has(task.taskId))
      .forEach((task) => merged.set(task.taskId, task));
    if (activeTask?.taskId && (activeTask.conversationId === activeConversationId || activeConversationTaskIds.has(activeTask.taskId))) {
      merged.set(activeTask.taskId, activeTask);
    }
    return Array.from(merged.values())
      .filter((task) => safeDisplayText(task.userInput, ''))
      .sort((a, b) => new Date(a.createdAt || a.updatedAt || 0).getTime() - new Date(b.createdAt || b.updatedAt || 0).getTime());
  }, [visibleTasks, activeTask, activeConversationTaskIds, activeConversationId]);

  return (
    <div className="ai-secretary-home mx-auto flex w-full max-w-[1180px] flex-col gap-2 pb-[calc(16px+env(safe-area-inset-bottom))] sm:gap-3 sm:pb-6" data-page="work-secretary-home">
      <header className="ai-secretary-topbar flex min-h-[58px] items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AISecretaryLogo size={40} />
          <div className="min-w-0">
            <h1 className="truncate text-[20px] font-semibold leading-6 text-[color:var(--primary-text)] sm:text-[24px]">AI分身</h1>
            <div className="mt-0.5 truncate text-[11px] text-[color:var(--secondary-text)] sm:text-xs">{formatTodayLabel()}</div>
          </div>
        </div>
        <button className="ai-icon-button px-3 text-sm font-medium" onClick={() => onNavigate?.('设置')}>设置</button>
      </header>

      <section className="grid grid-cols-[minmax(0,1fr)_minmax(124px,0.82fr)] gap-2 md:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]" aria-label="今日状态">
        <TodayRemindersSection
          notificationMessage={notificationMessage}
          reminders={todayReminders}
          onOpenSchedule={() => setSchedulePanelOpen(true)}
        />
        <AISecretaryNavigator
          open={navigatorOpen}
          onToggle={() => setNavigatorOpen((current) => !current)}
          onEntry={handleNavigatorEntry}
          serviceConnected={serviceConnected}
          isBusy={isBusy}
        />
      </section>

      <section className="conversation-shell ai-glass-card rounded-[var(--radius-card)]" aria-label="AI分身主对话">
        <div className="conversation-toolbar flex items-center justify-between gap-2 border-b border-[color:var(--divider-color)] px-3 py-1.5 sm:px-4 sm:py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[color:var(--primary-text)]">{activeConversation?.title || '当前对话'}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[color:var(--secondary-text)]"><span className={`ai-status-dot ${serviceConnected ? 'is-online' : 'is-offline'}`} />{serviceConnected ? 'AI 已连接' : 'AI 服务暂时不可用'}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button className="ai-icon-button text-lg" onClick={createNewConversation} aria-label="新建对话" title="新建对话">＋</button>
            <button className="ai-icon-button text-sm" onClick={() => setHistoryPanelOpen(true)} aria-label="历史对话" title="历史对话">历史</button>
          </div>
        </div>

        <div ref={conversationMessagesRef} onScroll={handleConversationScroll} className="conversation-messages ai-conversation-bg space-y-3 px-3 py-3 sm:px-5 sm:py-4">
          {conversationTasks.length ? conversationTasks.map((task) => (
            <ChatMessage
              key={task.taskId}
              task={task}
              isActive={activeTask?.taskId === task.taskId}
              isExpanded={Boolean(resultExpanded[task.taskId])}
              actionStatus={resultActionStatus}
              exporting={activeTask?.taskId === task.taskId ? exporting : ''}
              onToggle={() => setResultExpanded((current) => ({ ...current, [task.taskId]: !current[task.taskId] }))}
              onCopy={(item) => { setActiveTask(item); copyResult(item); }}
              onExport={(item, format) => { setActiveTask(item); exportResult(item, format); }}
              onContinueEdit={(item) => continueWith(item, '请在上一条回答基础上继续编辑：')}
              onRegenerate={(item) => { setActiveTask(item); regenerate(item); }}
              onRetry={(item) => { setActiveTask(item); regenerate(item); }}
              onWorkspaceAction={handleWorkspaceAction}
            />
          )) : <div className="flex min-h-11 items-center rounded-[12px] bg-[color:var(--input-background)] px-3 text-sm leading-5 text-[color:var(--secondary-text)]">从这里直接说出问题、工作、安排或需要记录的事情。</div>}
          {status === 'cancelled' ? <div className="rounded-[12px] bg-[color:var(--input-background)] px-4 py-3 text-sm text-[color:var(--secondary-text)]">任务已取消。输入框已保留，可以继续交代下一句。</div> : null}
        </div>

        {knowledgeDropOpen ? (
          <div className="border-t border-[color:var(--divider-color)] bg-[color:var(--surface-background)] px-4 py-3 sm:px-6 sm:py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-[color:var(--secondary-text)]">资料库</div>
                <h3 className="mt-1 text-base font-semibold text-[color:var(--primary-text)]">现有资料入口</h3>
                <p className="mt-1 text-xs leading-5 text-[color:var(--secondary-text)] sm:text-sm sm:leading-6">长期保存到资料库。当前任务临时附件请用输入框左侧回形针。</p>
              </div>
              <button className="min-h-11 rounded-[8px] px-2 text-xs text-[color:var(--secondary-text)]" onClick={() => setKnowledgeDropOpen(false)}>收起</button>
            </div>
            <button className="mt-3 flex min-h-11 w-full items-center justify-center rounded-[12px] border border-dashed border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 py-2 text-center text-xs font-medium text-[color:var(--primary-text)] hover:border-[color:var(--accent-color)] sm:text-sm" onClick={() => knowledgeFileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addKnowledgeFiles(event.dataTransfer.files); }}>拖拽资料到这里，或点击上传</button>
            <input id="knowledge-file-input" name="knowledge-file-input" ref={knowledgeFileInputRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp" className="sr-only" multiple onChange={(event) => { addKnowledgeFiles(event.target.files); event.target.value = ''; }} />
            {knowledgeFiles.length ? <div className="mt-3 divide-y divide-[color:var(--divider-color)]">{knowledgeFiles.slice(0, 3).map((file) => <div key={file.id} className="flex items-center justify-between gap-3 py-2 text-xs"><span className="min-w-0 truncate text-[color:var(--primary-text)]">{safeDisplayTitle(file)}</span><span className="shrink-0 rounded-full bg-[color:var(--accent-soft)] px-2 py-1 text-[11px] text-[color:var(--secondary-text)]">{file.status === 'ready' ? '已保存，暂未解析' : statusLabel(file.status)}</span></div>)}</div> : <div className="mt-3 rounded-[10px] bg-[color:var(--input-background)] px-3 py-2 text-xs leading-5 text-[color:var(--secondary-text)]">还没有资料。上传后会先保存基础信息。</div>}
          </div>
        ) : null}

        {meetingPanelOpen ? (
          <div className="border-t border-[color:var(--divider-color)] bg-[color:var(--surface-background)] px-4 py-3 sm:px-6 sm:py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-[color:var(--secondary-text)]">会议记录</div>
                <h3 className="mt-1 text-base font-semibold text-[color:var(--primary-text)]">会议功能建设中</h3>
                <p className="mt-1 text-xs leading-5 text-[color:var(--secondary-text)] sm:text-sm sm:leading-6">当前没有真实录音与转写能力，不会伪造会议内容。可以把会议文字粘贴到主对话，让 AI分身整理摘要和待办。</p>
              </div>
              <button className="min-h-11 rounded-[8px] px-2 text-xs text-[color:var(--secondary-text)]" onClick={() => setMeetingPanelOpen(false)}>收起</button>
            </div>
            <button className="mt-3 min-h-11 rounded-[12px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 text-sm font-medium text-[color:var(--primary-text)] hover:border-[color:var(--accent-color)]" onClick={() => { setDraft('请整理以下会议记录，提取会议摘要、关键结论、待办事项、负责人和截止时间：'); setMeetingPanelOpen(false); textareaRef.current?.focus(); }}>用主对话整理会议文字</button>
          </div>
        ) : null}

        {memoryPanelOpen ? (
          <div className="border-t border-[color:var(--divider-color)] bg-[color:var(--surface-background)] px-4 py-3 sm:px-6 sm:py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-[color:var(--secondary-text)]">长期记忆</div>
                <h3 className="mt-1 text-base font-semibold text-[color:var(--primary-text)]">我的记忆</h3>
                <p className="mt-1 text-xs leading-5 text-[color:var(--secondary-text)] sm:text-sm sm:leading-6">查看、纠正或删除你明确保存的长期记忆。</p>
              </div>
              <button className="min-h-11 rounded-[8px] px-2 text-xs text-[color:var(--secondary-text)]" onClick={() => setMemoryPanelOpen(false)}>收起</button>
            </div>
            <div className="mt-3 flex gap-2">
              <button className={`min-h-10 rounded-[10px] px-3 text-xs font-medium ${memoryView === 'current' ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent-color)]' : 'bg-[color:var(--input-background)] text-[color:var(--secondary-text)]'}`} onClick={() => loadMemories('current')}>当前记忆</button>
              <button className={`min-h-10 rounded-[10px] px-3 text-xs font-medium ${memoryView === 'recycle_bin' ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent-color)]' : 'bg-[color:var(--input-background)] text-[color:var(--secondary-text)]'}`} onClick={() => loadMemories('recycle_bin')}>回收站</button>
            </div>
            {memoryError ? <div className="mt-3 rounded-[10px] bg-[#FFF0EE] px-3 py-2 text-xs text-[#C2413B]" role="alert">{memoryError}</div> : null}
            {memoryLoading ? <div className="mt-3 text-xs text-[color:var(--secondary-text)]">正在读取你的记忆…</div> : null}
            {!memoryLoading && !memoryItems.length ? <div className="mt-3 rounded-[10px] bg-[color:var(--input-background)] px-3 py-3 text-xs text-[color:var(--secondary-text)]">{memoryView === 'current' ? '还没有明确保存的长期记忆。' : '回收站为空。'}</div> : null}
            {memoryItems.length ? <div className="mt-3 space-y-2">{memoryItems.map((item) => (
              <div key={item.memoryId} className="rounded-[12px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 py-3">
                <div className="text-sm font-medium leading-5 text-[color:var(--primary-text)]">{safeDisplayText(item.safeSummary, '一条长期记忆')}</div>
                <div className="mt-1 text-[11px] text-[color:var(--secondary-text)]">{item.memoryType || '记忆'} · {formatTime(item.sourceTimestamp || item.updatedAt)} · {item.recallEligibility === 'eligible' ? '可用于相关回答' : '不会用于普通回答'}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {memoryView === 'current' ? <>
                    <button className="min-h-9 rounded-[8px] px-2 text-xs text-[color:var(--accent-color)]" onClick={() => showMemoryHistory(item)}>历史版本</button>
                    <button className="min-h-9 rounded-[8px] px-2 text-xs text-[color:var(--accent-color)]" onClick={() => correctMemoryItem(item)}>纠正</button>
                    <button className="min-h-9 rounded-[8px] px-2 text-xs text-[color:var(--danger-color)]" onClick={() => deleteMemoryItem(item)}>删除</button>
                  </> : <>
                    <button className="min-h-9 rounded-[8px] px-2 text-xs text-[color:var(--accent-color)]" onClick={() => restoreMemoryItem(item)}>恢复</button>
                    <button className="min-h-9 rounded-[8px] px-2 text-xs text-[color:var(--danger-color)]" onClick={() => purgeMemoryItem(item)}>永久删除</button>
                  </>}
                </div>
              </div>
            ))}</div> : null}
          </div>
        ) : null}

        <div className="conversation-composer z-20 border-t border-[color:var(--divider-color)] bg-[color:var(--surface-background)] px-3 py-2 shadow-[0_-14px_32px_rgba(17,24,39,0.08)] backdrop-blur sm:px-5 sm:py-3">
          {showReturnToLatest ? <button className="theme-control mb-2 min-h-11 rounded-[10px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 text-xs font-medium text-[color:var(--accent-color)]" onClick={() => { shouldFollowLatestRef.current = true; scrollToLatest(true); }}>↓ 回到最新</button> : null}
          {navigatorMessage ? <div className="mb-2 rounded-[10px] bg-[color:var(--accent-soft)] px-3 py-2 text-xs leading-5 text-[color:var(--primary-text)]" role="status">{navigatorMessage}</div> : null}
          {pendingMemoryConfirmation ? <div className="mb-2 rounded-[12px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 py-3" data-testid="memory-confirmation-card">
            <div className="text-sm font-medium text-[color:var(--primary-text)]">确认长期保存？</div>
            <div className="mt-1 text-xs leading-5 text-[color:var(--secondary-text)]">{pendingMemoryConfirmation.safeSummary || '存在一条较敏感记忆。'} · {pendingMemoryConfirmation.memoryType || '记忆'} · {pendingMemoryConfirmation.sensitivity === 'high' ? '高敏感' : '普通'}</div>
            {memoryConfirmationEditing ? <div className="mt-2 space-y-2">
              <input aria-label="修改记忆摘要" value={memoryConfirmationDraft} onChange={(event) => setMemoryConfirmationDraft(event.target.value)} placeholder="输入修改后的记忆内容" className="h-11 w-full rounded-[10px] border border-[color:var(--border-color)] bg-[color:var(--surface-background)] px-3 text-sm text-[color:var(--primary-text)]" />
              <div className="flex flex-wrap gap-2">
                <button className="min-h-10 rounded-[10px] bg-[color:var(--accent-color)] px-3 text-xs font-medium text-white disabled:opacity-50" disabled={memoryConfirmationBusy} onClick={() => answerMemoryConfirmation('save_edit')}>{memoryConfirmationBusy ? '检查中' : '保存修改'}</button>
                <button className="min-h-10 rounded-[10px] px-3 text-xs text-[color:var(--secondary-text)]" disabled={memoryConfirmationBusy} onClick={() => { setMemoryConfirmationEditing(false); setMemoryConfirmationError(''); }}>返回</button>
                <button className="min-h-10 rounded-[10px] px-3 text-xs text-[color:var(--secondary-text)]" disabled={memoryConfirmationBusy} onClick={() => answerMemoryConfirmation('cancel')}>取消</button>
              </div>
            </div> : <div className="mt-2 flex flex-wrap gap-2">
              <button className="min-h-10 rounded-[10px] bg-[color:var(--accent-color)] px-3 text-xs font-medium text-white disabled:opacity-50" disabled={memoryConfirmationBusy} onClick={() => answerMemoryConfirmation('confirm')}>{memoryConfirmationBusy ? '保存中' : '确认保存'}</button>
              <button className="min-h-10 rounded-[10px] bg-[color:var(--accent-soft)] px-3 text-xs font-medium text-[color:var(--accent-color)]" disabled={memoryConfirmationBusy} onClick={() => answerMemoryConfirmation('edit')}>修改</button>
              <button className="min-h-10 rounded-[10px] px-3 text-xs text-[color:var(--secondary-text)]" disabled={memoryConfirmationBusy} onClick={() => answerMemoryConfirmation('cancel')}>取消</button>
            </div>}
            {memoryConfirmationError ? <div className="mt-2 text-xs text-[color:var(--danger-color)]" role="alert">{memoryConfirmationError}</div> : null}
          </div> : null}
          {attachmentNotice ? <div className="mb-2 rounded-[10px] bg-[color:var(--accent-soft)] px-3 py-2 text-xs leading-5 text-[color:var(--primary-text)]">{attachmentNotice}</div> : null}
          {attachedFiles.length ? (
            <div className="mb-2 space-y-2">
              <div className="text-xs font-medium text-[color:var(--secondary-text)]">本次对话附件</div>
              <div className="grid gap-2">
                {attachedFiles.map((file) => (
                  <div key={file.id} className="flex min-h-11 items-center justify-between gap-2 rounded-[10px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[color:var(--primary-text)]">{safeDisplayTitle(file)}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1.5 text-[11px] text-[color:var(--secondary-text)]"><span>{attachmentTypeLabel(file)}</span><span>{formatFileSize(file.size)}</span><span className={attachmentStatusTone(file)}>{attachmentStatusText(file)}</span></div>
                    </div>
                    <button className="min-h-11 shrink-0 rounded-[8px] px-2 text-xs font-medium text-[color:var(--secondary-text)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--danger-color)]" onClick={() => detachFile(file.id)} aria-label={`移除 ${safeDisplayTitle(file)}`}>移除</button>
                  </div>
                ))}
              </div>
              <div className="text-xs leading-5 text-[color:var(--secondary-text)]">只把真实解析成功的内容交给 AI；不支持或需要视觉模型的附件不会被伪造分析。</div>
            </div>
          ) : null}
          {attachmentError ? <div className="mb-2 rounded-[10px] bg-[color:var(--accent-soft)] px-3 py-2 text-xs leading-5 text-[color:var(--danger-color)]">{attachmentError}</div> : null}
          <textarea
            ref={textareaRef}
            id="ai-secretary-input"
            name="ai-secretary-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={settleComposerNearKeyboard}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            className="theme-control h-[58px] w-full resize-none rounded-[16px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 py-2.5 text-[16px] leading-6 text-[color:var(--primary-text)] caret-[color:var(--accent-color)] outline-none placeholder:text-[color:var(--tertiary-text)] focus:border-[color:var(--accent-color)] sm:h-[72px] sm:py-3"
            placeholder="说出问题、工作、安排或需要记录的事情……"
          />
          <div className="mt-2 grid grid-cols-[minmax(44px,auto)_minmax(0,1fr)_minmax(74px,auto)] items-center gap-2">
            <button className="ai-icon-button justify-self-start px-3 text-sm" title="附件" aria-label="附件" onClick={() => fileInputRef.current?.click()}>📎 <span className="ml-1 hidden sm:inline">附件</span></button>
            <input id="conversation-attachment-input" name="conversation-attachment-input" ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp" className="sr-only" multiple onChange={(event) => { addSelectedFiles(event.target.files); event.target.value = ''; }} />
            <button className="ai-icon-button justify-self-center px-3 text-sm" onClick={() => setNavigatorMessage('语音功能建设中，当前请先使用文字输入。')}>🎙 <span className="ml-1">按住说话</span></button>
            <PrimaryButton className="ai-primary-button justify-self-end min-w-[74px] px-4 py-2.5" onClick={() => send()} disabled={!draft.trim() || isBusy}>{isBusy ? '处理中' : '发送'}</PrimaryButton>
          </div>
        </div>
      </section>

      {schedulePanelOpen ? <SchedulePanel reminders={todayReminders} notificationStatus={notificationStatus} onEnable={enableDesktopNotifications} onClose={() => setSchedulePanelOpen(false)} /> : null}
      {quickNotePanelMode ? <QuickNoteHistoryPanel mode={quickNotePanelMode} notes={savedNotes} filter={quickNoteFilter} onFilter={setQuickNoteFilter} onClose={() => setQuickNotePanelMode(null)} /> : null}
      {historyPanelOpen ? <ConversationHistoryPanel conversations={conversations} activeConversationId={activeConversationId} onOpen={openConversation} onRename={renameConversation} onDelete={deleteConversation} onClose={() => setHistoryPanelOpen(false)} /> : null}
    </div>
  );
}

export default WorkSecretaryHome;

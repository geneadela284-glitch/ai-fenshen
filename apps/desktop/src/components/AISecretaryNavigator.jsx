import AISecretaryLogo from './AISecretaryLogo.jsx';
import { AI_SECRETARY_NAVIGATOR_ENTRIES } from './aiSecretaryNavigation.js';

function AISecretaryNavigator({ open, onToggle, onEntry, serviceConnected, isBusy }) {
  const statusText = isBusy ? '处理中' : serviceConnected ? 'AI 已连接' : '服务正在恢复';
  const statusClass = isBusy ? 'is-busy' : serviceConnected ? 'is-online' : 'is-offline';

  return (
    <>
      <div className="ai-navigator-card ai-glass-card relative">
        <button
          type="button"
          className="absolute inset-0 z-10 rounded-[var(--radius-card)]"
          aria-expanded={open}
          aria-label={`导航仪，${statusText}`}
          onClick={onToggle}
        />
        <div className="min-h-[104px]">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="text-[16px] font-semibold leading-6 text-[color:var(--primary-text)] sm:text-[18px]">导航仪</div>
            <span className="ai-navigator-chevron" aria-hidden="true">{open ? '⌃' : '⌄'}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2.5">
            <AISecretaryLogo size={36} />
            <div className="min-w-0 text-xs text-[color:var(--secondary-text)]">
              <div className="flex items-center gap-1.5">
                <span className={`ai-status-dot ${statusClass}`} />
                <span>{statusText}</span>
              </div>
              <div className="mt-1 truncate">{serviceConnected ? 'AI秘书可以使用' : '请稍后重试'}</div>
            </div>
          </div>
        </div>
      </div>

      {open ? (
        <>
          <button type="button" className="ai-navigator-backdrop" aria-label="关闭导航仪" onClick={onToggle} />
          <div className="ai-navigator-menu z-20" role="menu" aria-label="导航仪功能">
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <div>
                <div className="text-sm font-semibold text-[color:var(--primary-text)]">导航仪</div>
                <div className="mt-0.5 text-xs text-[color:var(--secondary-text)]">只打开现有能力或真实状态</div>
              </div>
              <button type="button" className="ai-icon-button" onClick={onToggle} aria-label="关闭导航仪">×</button>
            </div>
            <div className="grid gap-1.5">
              {AI_SECRETARY_NAVIGATOR_ENTRIES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="ai-navigator-entry"
                  role="menuitem"
                  onClick={() => onEntry?.(entry)}
                >
                  <span className="ai-entry-icon" aria-hidden="true">{entry.label.slice(0, 1)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{entry.label}</span>
                    <span className="mt-0.5 block truncate text-xs text-[color:var(--secondary-text)]">{entry.description}</span>
                  </span>
                  <span className="text-[18px] text-[color:var(--secondary-text)]" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

export default AISecretaryNavigator;

import { theme } from '../theme/tokens';

const pageDescriptions = {
  工作秘书: '首页体验 · 普通用户只需要说要做什么',
  工作中心: 'Workspace · 项目、客户和文档上下文',
  'AI Daily': 'Daily Timeline · 每天工作记录',
  'AI Inbox': '确认中心 · 待处理与待归档',
  资料库: 'Knowledge · 企业资料和模板',
  Workflow: '流程模板 · 可重复的企业工作',
  团队: 'Team · 成员、角色和协作空间',
  设置: 'Settings · 个人偏好和连接状态',
  管理员中心: 'Admin · 工具、策略、权限和审计'
};

function formatHeaderDate() {
  return new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  });
}

function AppShell({ menu, activeMenu, search, onSearch, onMenuClick, onSettingsClick, onBack, backLabel = '返回', appearanceTheme = 'classic', children }) {
  const isSecretaryHome = activeMenu === '工作秘书';
  const isSettings = activeMenu === '设置';
  const isAdminCenter = activeMenu === '管理员中心';

  return (
    <div className={theme.page} data-theme={appearanceTheme} data-app-entry={isSecretaryHome ? 'work-secretary' : 'workspace'}>
      <div className={`flex min-h-screen w-full ${isSecretaryHome ? 'p-2 sm:p-3' : 'p-2.5 sm:p-5'}`}>
        <aside className={`${theme.panel} ${isSecretaryHome || isAdminCenter ? 'hidden' : 'hidden md:block'} w-72 rounded-[32px] p-5`}>
          <div className="mb-8 flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#1f1f1f] text-lg font-semibold text-white">
              AI
            </div>
            <div>
              <div className="text-sm font-semibold tracking-wide">AI Work Center</div>
              <div className="text-xs text-[#8d877d]">企业每天工作的起点</div>
            </div>
          </div>

          <nav className="space-y-2">
            {menu.map((item) => (
              <button
                key={item}
                className={`w-full rounded-2xl px-4 py-3 text-left text-sm transition active:scale-[0.98] ${
                  activeMenu === item
                    ? 'bg-[#1f1f1f] text-white shadow-[0_12px_28px_rgba(31,31,31,0.18)]'
                    : 'text-[#6f695f] hover:bg-white hover:text-[#1f1f1f]'
                }`}
                onClick={() => onMenuClick(item)}
              >
                <span className="block font-medium">{item}</span>
                <span className={`mt-1 block text-xs ${activeMenu === item ? 'text-white/60' : 'text-[#9a9287]'}`}>
                  {pageDescriptions[item]}
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <main className={`w-0 min-w-0 flex-1 ${isSecretaryHome ? 'px-0 py-0 sm:px-1 sm:py-0' : isSettings || isAdminCenter ? 'px-0 py-0 sm:px-8 sm:py-2' : 'px-2 py-2 sm:px-8'}`}>
          {!isSecretaryHome ? <header className={`theme-header sticky top-0 z-40 mb-2 flex items-center justify-between gap-2 bg-[color:var(--page-background)] py-2 ${isSettings || isAdminCenter ? 'border-b border-[#E7E9EE] pb-2 sm:mb-3 sm:gap-3 sm:pb-3' : 'mb-10'}`}>
            <div className="flex min-w-0 items-center gap-2 sm:gap-4">
              {onBack ? (
                <button
                  className="theme-control inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[10px] bg-white px-3 text-sm font-medium shadow-[0_16px_40px_rgba(60,54,45,0.08)] transition hover:-translate-y-0.5 active:scale-[0.98]"
                  onClick={onBack}
                  aria-label={backLabel}
                  title={backLabel}
                >
                  <span className="text-lg" aria-hidden="true">←</span>
                  <span>{backLabel}</span>
                </button>
              ) : null}
              <div>
                <div>
                  <div className={`${theme.eyebrow} hidden text-[11px] sm:block sm:text-sm`}>AI Work Center</div>
                  <h1 className={`${isSettings || isAdminCenter ? 'mt-0 text-base sm:mt-1 sm:text-2xl' : 'mt-2 text-[32px] sm:text-[40px]'} font-semibold leading-tight tracking-tight`}>{activeMenu}</h1>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <input
                value={search}
                onChange={(event) => onSearch(event.target.value)}
                placeholder="搜索：客户、合同、会议、资料..."
                className="hidden h-12 w-80 rounded-full border border-white/70 bg-white/75 px-5 text-sm outline-none shadow-[0_16px_40px_rgba(60,54,45,0.08)] transition focus:bg-white md:block"
              />
              {!isSettings ? <button
                className="theme-control h-12 rounded-[10px] border border-[#E7E9EE] bg-white px-5 text-sm font-medium text-[#16181D] transition hover:border-[#5B5CE2] active:scale-[0.98]"
                onClick={onSettingsClick}
              >设置</button> : null}
            </div>
          </header> : null}

          {children}
        </main>
      </div>
    </div>
  );
}

export default AppShell;

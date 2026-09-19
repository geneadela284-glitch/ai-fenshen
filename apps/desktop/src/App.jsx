import { useCallback, useEffect, useState } from 'react';
import PrototypePage from './components/PrototypePages';
import SettingsPage from './components/SettingsPage';
import LoginPage from './components/LoginPage.jsx';
import AppShell from './layouts/AppShell';
import dashboard from '../../../data/dashboard.json';
import { settingsManager } from '../../../core/settings/settingsManager.js';
import { applyAppearanceTheme } from './theme/appearance.js';
import { fetchCurrentUser, login, logout } from './lib/authClient.js';
import { activateUserStorage, resetUserStorage } from './lib/appStorage.js';
import { declineLegacyLocalData, inspectLegacyLocalData, migrateLegacyLocalData, sanitizeUserScopedSecurityState } from '../../../core/storage/userScopedStorage.js';
import { releasePageFocus } from './components/settingsNavigation.js';
import { filterAuthorizedMenu, isAdminUser, resolveAuthorizedPage } from '../../../core/auth/accessControl.js';

const DEFAULT_PAGE = '工作秘书';

function getInitialPage() {
  if (typeof window === 'undefined') return DEFAULT_PAGE;
  const hash = decodeURIComponent(window.location.hash.replace(/^#/, '')).trim();
  return hash || DEFAULT_PAGE;
}

function writePageHash(page) {
  if (typeof window === 'undefined') return;
  const nextHash = `#${encodeURIComponent(page || DEFAULT_PAGE)}`;
  if (window.location.hash !== nextHash) window.history.replaceState(null, '', nextHash);
}

function App() {
  const [authState, setAuthState] = useState({ loading: true, user: null });
  const [activeMenu, setActiveMenu] = useState(getInitialPage);
  const [history, setHistory] = useState([]);
  const [settingsReturnTarget, setSettingsReturnTarget] = useState(null);
  const [settingsMode, setSettingsMode] = useState('user');
  const [settingsHasUnsavedChanges, setSettingsHasUnsavedChanges] = useState(false);
  const [search, setSearch] = useState('');
  const [appearanceTheme, setAppearanceTheme] = useState(() => settingsManager.load().appearanceTheme || 'classic');

  const showSettings = activeMenu === '设置';

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser()
      .then((user) => {
        if (cancelled) return;
        if (user?.id) {
          activateUserStorage(user.id);
          sanitizeUserScopedSecurityState({ userId: user.id, role: user.role });
          setActiveMenu((current) => {
            const authorized = resolveAuthorizedPage(current, user);
            writePageHash(authorized);
            return authorized;
          });
        }
        setAuthState({ loading: false, user });
      })
      .catch(() => {
        if (!cancelled) setAuthState({ loading: false, user: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyAppearanceTheme(appearanceTheme);
  }, [appearanceTheme]);

  useEffect(() => {
    if (!authState.user?.id) return;
    const nextTheme = settingsManager.load().appearanceTheme || 'classic';
    setAppearanceTheme(nextTheme);
    applyAppearanceTheme(nextTheme);
    const legacy = inspectLegacyLocalData({ userId: authState.user.id });
    if (legacy.hasLegacyData && !legacy.alreadyMigrated) {
      const accepted = window.confirm('检测到本设备旧版数据，是否归入当前账号？');
      if (accepted) migrateLegacyLocalData({ userId: authState.user.id, role: authState.user.role });
      else declineLegacyLocalData({ userId: authState.user.id });
    }
  }, [authState.user?.id]);

  const handleLogin = async (username, password) => {
    const user = await login(username, password);
    activateUserStorage(user.id);
    sanitizeUserScopedSecurityState({ userId: user.id, role: user.role });
    setAuthState({ loading: false, user });
    setActiveMenu(DEFAULT_PAGE);
    return user;
  };

  const handleLogout = async () => {
    await logout();
    resetUserStorage();
    setHistory([]);
    setActiveMenu(DEFAULT_PAGE);
    setAuthState({ loading: false, user: null });
  };

  const changeAppearanceTheme = (themeId) => {
    const savedTheme = settingsManager.setAppearanceTheme(themeId);
    setAppearanceTheme(savedTheme);
  };

  const confirmSettingsExit = () => {
    if (!showSettings || !settingsHasUnsavedChanges) return true;
    return window.confirm('设置尚未保存，确定要离开吗？');
  };

  useEffect(() => {
    const handleHashChange = () => {
      const nextPage = resolveAuthorizedPage(getInitialPage(), authState.user);
      writePageHash(nextPage);
      if (nextPage && nextPage !== activeMenu && confirmSettingsExit()) {
        setSettingsHasUnsavedChanges(false);
        setSettingsMode('user');
        setSettingsReturnTarget(null);
        setHistory((current) => [...current, activeMenu]);
        setActiveMenu(nextPage);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [activeMenu, authState.user, confirmSettingsExit]);

  const navigateTo = useCallback((item, options = {}) => {
    const { push = true, mode = 'user' } = options;
    const authorizedItem = resolveAuthorizedPage(item, authState.user);
    const authorizedMode = mode === 'admin' && !isAdminUser(authState.user) ? 'user' : mode;
    if (authorizedItem === activeMenu && !(authorizedItem === '设置' && authorizedMode !== settingsMode)) return;
    if (!confirmSettingsExit()) return;

    setSettingsHasUnsavedChanges(false);
    setSettingsMode(authorizedItem === '设置' ? authorizedMode : 'user');
    setSettingsReturnTarget(authorizedItem === '设置' ? activeMenu : null);
    setHistory((current) => (push ? [...current, activeMenu] : current));
    writePageHash(authorizedItem);
    setActiveMenu(authorizedItem);
  }, [activeMenu, authState.user, confirmSettingsExit, settingsMode]);

  const handleBack = () => {
    if (!confirmSettingsExit()) return;
    const previous = history.at(-1) || DEFAULT_PAGE;
    if (previous === DEFAULT_PAGE) releasePageFocus(document);
    setHistory((current) => current.slice(0, -1));
    setSettingsHasUnsavedChanges(false);
    setSettingsMode('user');
    setSettingsReturnTarget(null);
    writePageHash(previous);
    setActiveMenu(previous);
  };

  const openSettings = () => {
    navigateTo('设置', { mode: 'user' });
  };

  const leaveSettingsAfterSave = () => {
    const target = settingsReturnTarget || history.at(-1) || DEFAULT_PAGE;
    setSettingsHasUnsavedChanges(false);
    setSettingsReturnTarget(null);
    if (history.length) {
      setHistory((current) => current.slice(0, -1));
    }
    writePageHash(target);
    setActiveMenu(target);
  };

  const handleMenuClick = (item) => {
    navigateTo(item);
  };

  if (authState.loading) {
    return <div className="grid min-h-dvh place-items-center text-sm text-[#6B7280]">正在检查登录状态...</div>;
  }

  if (!authState.user) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <AppShell
      key={authState.user.id}
      menu={filterAuthorizedMenu(dashboard.menu, authState.user)}
      activeMenu={activeMenu}
      search={search}
      onSearch={setSearch}
      onMenuClick={handleMenuClick}
      onSettingsClick={openSettings}
      onBack={showSettings || history.length ? handleBack : null}
      backLabel={showSettings ? '返回首页' : '返回'}
      appearanceTheme={appearanceTheme}
    >
      {showSettings ? (
        <SettingsPage initialMode={settingsMode} onNavigate={navigateTo} onDirtyChange={setSettingsHasUnsavedChanges} onSaved={leaveSettingsAfterSave} appearanceTheme={appearanceTheme} onAppearanceThemeChange={changeAppearanceTheme} currentUser={authState.user} onLogout={handleLogout} />
      ) : (
        <PrototypePage page={activeMenu} onNavigate={navigateTo} currentUser={authState.user} />
      )}
    </AppShell>
  );
}

export default App;

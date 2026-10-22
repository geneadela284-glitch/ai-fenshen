import AIFenshenWordmark from './AIFenshenWordmark.jsx';
import { useEffect, useRef, useState } from 'react';
import { fetchAdminAiSettings, saveAdminProvider, testAdminProvider } from '../../lib/aiServiceClient.js';
import {
  confirmDeletionRequest,
  createDeletionRequest,
  createMyDataExport,
  startAuthenticatedDownload
} from '../../lib/privacyClient.js';
import Icon from './Icon.jsx';
import {
  createProviderSavePayload,
  isAdminUser,
  maskAccountIdentifier,
  normalizeSafeAdminSettings
} from './realSettingsState.js';

const SAVE_RETURN_DELAY = 700;

function SettingsSection({ title, children, testId }) {
  return (
    <section className="af-settings-section" data-testid={testId}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function RealSettingsView({
  currentUser,
  onBack,
  onLogout,
  onAccountDeleted,
  onOpenFeatureIntro,
  onOpenMemory,
  themePreference = 'auto',
  onThemePreferenceChange
}) {
  const admin = isAdminUser(currentUser);
  const [providers, setProviders] = useState([]);
  const [keyDrafts, setKeyDrafts] = useState({});
  const [loadingProviders, setLoadingProviders] = useState(admin);
  const [pendingProvider, setPendingProvider] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [notice, setNotice] = useState('');
  const [privacyAction, setPrivacyAction] = useState('');
  const [deletionRequest, setDeletionRequest] = useState(null);
  const returnTimerRef = useRef(null);

  const loadProviders = async () => {
    if (!admin) return;
    const snapshot = normalizeSafeAdminSettings(await fetchAdminAiSettings());
    setProviders(snapshot.providers);
  };

  useEffect(() => {
    let active = true;
    if (!admin) return undefined;
    fetchAdminAiSettings().then((snapshot) => {
      if (active) setProviders(normalizeSafeAdminSettings(snapshot).providers);
    }).catch(() => {
      if (active) setNotice('AI服务状态暂时无法读取。');
    }).finally(() => {
      if (active) setLoadingProviders(false);
    });
    return () => { active = false; };
  }, [admin]);

  useEffect(() => () => {
    if (returnTimerRef.current) window.clearTimeout(returnTimerRef.current);
  }, []);

  const updateKeyDraft = (providerId, value) => {
    setNotice('');
    setKeyDrafts((current) => ({ ...current, [providerId]: value }));
  };

  const saveProvider = async (providerId) => {
    const apiKey = keyDrafts[providerId] || '';
    if (!apiKey.trim() || pendingProvider) return;
    setPendingProvider(providerId);
    setNotice('正在保存…');
    try {
      await saveAdminProvider(providerId, createProviderSavePayload(apiKey));
      await loadProviders();
      setKeyDrafts((current) => ({ ...current, [providerId]: '' }));
      setNotice('保存成功');
      returnTimerRef.current = window.setTimeout(onBack, SAVE_RETURN_DELAY);
    } catch {
      setNotice('保存失败，请稍后重试。');
    } finally {
      setPendingProvider('');
    }
  };

  const testProvider = async (providerId) => {
    if (pendingProvider) return;
    setPendingProvider(providerId);
    setNotice('正在测试连接…');
    try {
      const result = await testAdminProvider(providerId, createProviderSavePayload(keyDrafts[providerId] || ''));
      await loadProviders();
      setNotice(result?.ok
        ? result.healthPersistenceWarning
          ? '连接成功，但状态保存失败'
          : '连接正常'
        : '连接失败，请检查配置。');
    } catch {
      setNotice('连接测试失败，请稍后重试。');
    } finally {
      setPendingProvider('');
    }
  };

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setNotice('');
    try {
      await onLogout();
    } catch {
      setNotice('退出失败，请稍后重试。');
      setLoggingOut(false);
    }
  };

  const exportMyData = async () => {
    if (privacyAction) return;
    setPrivacyAction('export');
    setNotice('正在准备在线数据导出…');
    try {
      const result = await createMyDataExport();
      startAuthenticatedDownload(result.downloadUrl);
      setNotice('导出已开始下载，链接仅可使用一次。');
    } catch {
      setNotice('数据导出失败，请稍后重试。');
    } finally {
      setPrivacyAction('');
    }
  };

  const requestDeletion = async () => {
    if (privacyAction) return;
    setPrivacyAction('delete-request');
    setNotice('');
    try {
      setDeletionRequest(await createDeletionRequest());
    } catch {
      setNotice('暂时无法发起删除，请稍后重试。');
    } finally {
      setPrivacyAction('');
    }
  };

  const confirmDeletion = async () => {
    if (!deletionRequest?.confirmationHandle || privacyAction) return;
    setPrivacyAction('delete-confirm');
    setNotice('正在删除账号和在线个人数据…');
    try {
      const result = await confirmDeletionRequest(deletionRequest.confirmationHandle, 'DELETE_MY_ACCOUNT');
      setNotice('账号和在线个人数据已删除。');
      onAccountDeleted?.(result);
    } catch {
      setNotice('删除尚未完成，请联系测试管理员。');
      setPrivacyAction('');
    }
  };

  return (
    <main className="af-settings-view" data-testid="real-settings-view">
      <button type="button" className="af-settings-back" onClick={onBack} aria-label="返回首页">
        <Icon name="arrow-left" size={22} />
      </button>
      <div className="af-settings-scroll">
        <header className="af-settings-heading">
          <span className="af-settings-heading-icon" aria-hidden="true"><Icon name="settings" size={25} /></span>
          <div><AIFenshenWordmark size="compact" /><h1>设置</h1></div>
        </header>

        <SettingsSection title="账号" testId="settings-account">
          <div className="af-settings-account-row">
            <div><strong>{currentUser?.displayName || '当前账号'}</strong><span>{maskAccountIdentifier(currentUser?.username)}</span></div>
            <span className="af-settings-state">已登录</span>
          </div>
          <button type="button" className="af-settings-secondary-action" onClick={logout} disabled={loggingOut}>
            {loggingOut ? '正在退出…' : '退出登录'}
          </button>
        </SettingsSection>

        {admin ? (
          <SettingsSection title="AI服务设置" testId="settings-ai-service">
            {loadingProviders ? <p className="af-settings-muted" role="status">正在读取服务状态…</p> : null}
            {providers.map((provider) => (
              <article className="af-provider-setting" key={provider.id}>
                <div className="af-provider-setting-head">
                  <div><strong>{provider.label}</strong><span>{provider.apiKeyConfigured ? provider.maskedApiKey : '尚未配置'}</span></div>
                  <span className={`af-provider-health is-${provider.healthy === true ? 'ready' : provider.healthy === false ? 'error' : 'pending'}`}>
                    {provider.healthy === true ? '连接正常' : provider.healthy === false ? '连接异常' : '待检测'}
                  </span>
                </div>
                <label className="af-settings-key-field">
                  <span>更新 API Key</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={keyDrafts[provider.id] || ''}
                    onChange={(event) => updateKeyDraft(provider.id, event.target.value)}
                    placeholder={provider.apiKeyConfigured ? '输入新值以替换' : '输入 API Key'}
                    aria-label={`${provider.label} API Key`}
                  />
                </label>
                <div className="af-settings-provider-actions">
                  <button type="button" onClick={() => testProvider(provider.id)} disabled={Boolean(pendingProvider)}>连接测试</button>
                  <button type="button" onClick={() => saveProvider(provider.id)} disabled={Boolean(pendingProvider) || !String(keyDrafts[provider.id] || '').trim()}>保存</button>
                </div>
              </article>
            ))}
          </SettingsSection>
        ) : null}

        <SettingsSection title="长期记忆" testId="settings-memory-status">
          <p className="af-settings-muted">查看您明确授权保存的内容，或纠正、删除已有记忆。保存结果以本机回执为准。</p>
          <button type="button" className="af-settings-secondary-action" onClick={onOpenMemory}>查看与管理记忆</button>
        </SettingsSection>

        <SettingsSection title="首页主题" testId="settings-theme">
          <div className="af-theme-preference" role="radiogroup" aria-label="首页主题">
            {[
              ['auto', '自动'],
              ['day', '白天'],
              ['night', '夜晚']
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={themePreference === value}
                className={themePreference === value ? 'is-selected' : ''}
                onClick={() => onThemePreferenceChange?.(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="af-settings-muted">自动模式会按你的本地时区在07:00至18:59使用白天主题。</p>
        </SettingsSection>

        <SettingsSection title="隐私与数据" testId="settings-privacy-data">
          <p className="af-settings-muted">你可以导出在线保存的数据，或删除账号及在线个人数据。本机长期记忆暂不包含在此导出和删除范围内，请在上方记忆管理中查看、纠正或删除。</p>
          <button
            type="button"
            className="af-settings-secondary-action"
            onClick={exportMyData}
            disabled={Boolean(privacyAction)}
          >
            {privacyAction === 'export' ? '正在准备…' : '导出我的数据'}
          </button>
          {!deletionRequest ? (
            <button
              type="button"
              className="af-settings-danger-action"
              onClick={requestDeletion}
              disabled={Boolean(privacyAction)}
            >
              删除我的账号
            </button>
          ) : (
            <div className="af-delete-confirmation" role="alert">
              <strong>此操作不可撤销</strong>
              <p>将立即停用账号、撤销全部 Session，并删除 Conversation、Memory、Finance、Calendar 证据、配额计量、报表清单和临时导出文件。备份仅写入删除墓碑，物理清理将在后续治理阶段完成。</p>
              <div>
                <button type="button" onClick={() => setDeletionRequest(null)} disabled={Boolean(privacyAction)}>取消</button>
                <button type="button" className="af-settings-danger-action" onClick={confirmDeletion} disabled={Boolean(privacyAction)}>
                  {privacyAction === 'delete-confirm' ? '正在删除…' : '确认永久删除'}
                </button>
              </div>
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="关于" testId="settings-about">
          <div className="af-settings-about"><strong>AI分身</strong><span>M9 内测版</span><p>你的专属AI数字分身</p></div>
          <button type="button" className="af-settings-secondary-action" onClick={onOpenFeatureIntro}>
            查看功能介绍
          </button>
        </SettingsSection>

        {notice ? <p className="af-settings-notice" role="status">{notice}</p> : null}
      </div>
    </main>
  );
}

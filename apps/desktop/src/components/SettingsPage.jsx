import { useEffect, useMemo, useReducer, useState } from 'react';
import PrimaryButton from './PrimaryButton';
import AISecretaryLogo from './AISecretaryLogo.jsx';
import { knowledgeManager, knowledgeTypes } from '../../../../core/knowledge/knowledgeManager.js';
import { memoryManager, memoryTypes } from '../../../../core/memory/memoryManager.js';
import { canEditProviderSettings, canRevealApiKey, maskApiKey } from '../../../../core/settings/apiKeySecurity.js';
import { getProviderModelOptions, providerModelDefaults } from '../../../../core/settings/defaultSettings.js';
import { settingsManager } from '../../../../core/settings/settingsManager.js';
import { appearanceThemes, getAppearanceTheme } from '../../../../core/settings/appearanceTheme.js';
import { providerRegistry } from '../../../../core/providers/providerRegistry.js';
import { capabilityLabels, defaultRoutePolicy } from '../../../../core/router/index.js';
import { invocationTraceRepository } from '../../../../core/router/InvocationTraceRepository.js';
import { exportUserLocalData, importUserLocalData } from '../../../../core/storage/userScopedStorage.js';
import { getSettingsHomeEntries, reduceSettingsView, SETTINGS_VIEWS } from './settingsNavigation.js';
import { fetchExportScope } from '../lib/authClient.js';
import {
  fetchAdminAiSettings,
  fetchAdminAiTraces,
  importAdminAiSettings,
  saveAdminProvider,
  saveAdminRouter,
  testAdminProvider
} from '../lib/aiServiceClient.js';

function normalizeAdminSettings(snapshot = {}) {
  const providerConfigs = Array.isArray(snapshot.providers) ? snapshot.providers : Object.values(snapshot.providers || {});
  return {
    provider: snapshot.provider || 'deepseek',
    providers: Object.fromEntries(providerConfigs.map((provider) => [provider.id, provider])),
    router: snapshot.router || { routes: {} }
  };
}

function clearBrowserProviderSecrets(snapshot = {}) {
  const providers = Object.fromEntries(Object.entries(snapshot.providers || {}).map(([providerId, config]) => [
    providerId,
    { ...config, apiKey: '' }
  ]));
  settingsManager.save({ ...snapshot, apiKey: '', providers });
}

function SettingsPage({ onDirtyChange, onSaved, onNavigate, initialMode = 'user', appearanceTheme = 'classic', onAppearanceThemeChange, currentUser, onLogout }) {
  const isAdmin = currentUser?.role === 'admin';
  const providers = useMemo(() => isAdmin ? providerRegistry.list() : [], [isAdmin]);
  const [savedSettings, setSavedSettings] = useState(() => isAdmin
    ? settingsManager.loadClientSettings()
    : { appearanceTheme, providers: {}, router: { routes: {} } });
  const [settings, setSettings] = useState(savedSettings);
  const [activeTab, setActiveTab] = useState('ai');
  const [developerMode, setDeveloperMode] = useState(() => isAdmin && initialMode === 'admin');
  const [isSaving, setIsSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [memories, setMemories] = useState(() => memoryManager.list());
  const [knowledgeItems, setKnowledgeItems] = useState(() => knowledgeManager.list());
  const [knowledgeFilter, setKnowledgeFilter] = useState({ keyword: '', type: 'all', tag: '' });
  const [memoryDraft, setMemoryDraft] = useState({
    id: '',
    type: 'user',
    title: '',
    content: '',
    enabled: true
  });
  const [knowledgeDraft, setKnowledgeDraft] = useState({
    id: '',
    type: 'document',
    title: '',
    content: '',
    tags: '',
    enabled: true
  });
  const [status, setStatus] = useState('');
  const [providerConfigs, setProviderConfigs] = useState(() => isAdmin ? settingsManager.listProviderConfigsForAdmin() : []);
  const [selectedProviderId, setSelectedProviderId] = useState(() => savedSettings.provider || 'deepseek');
  const [providerDraft, setProviderDraft] = useState(() => isAdmin ? settingsManager.getProviderConfigForAdmin(savedSettings.provider || 'deepseek') : {});
  const [routerDraft, setRouterDraft] = useState(() => savedSettings.router || { routes: {} });
  const [recentInvocations, setRecentInvocations] = useState(() => isAdmin ? invocationTraceRepository.listRecent(20) : []);
  const [pendingProviderId, setPendingProviderId] = useState('');
  const canEditProvider = canEditProviderSettings({ developerMode: developerMode && isAdmin });
  const canRevealKey = canRevealApiKey({ developerMode });
  const apiKeyInputType = canRevealKey && showApiKey ? 'text' : 'password';
  const apiKeyConfigured = Object.values(savedSettings.providers || {}).some((provider) => provider.enabled && provider.apiKeyConfigured);
  const hasUnsavedChanges = JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const selectedProviderConfig = providerConfigs.find((provider) => provider.id === selectedProviderId) || providerDraft;
  const providerDirty = JSON.stringify(providerDraft) !== JSON.stringify(selectedProviderConfig);
  const routerDirty = JSON.stringify(routerDraft) !== JSON.stringify(savedSettings.router || { routes: {} });
  const activeModelOptions = getProviderModelOptions(settings.provider, settings.model);
  const providerModelOptions = getProviderModelOptions(selectedProviderId, providerDraft.defaultModel || providerDraft.model);

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges || providerDirty || routerDirty);
  }, [hasUnsavedChanges, onDirtyChange, providerDirty, routerDirty]);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    const loadAdminSettings = async () => {
      try {
        const local = settingsManager.load();
        let remote = await fetchAdminAiSettings();
        const remoteConfigured = remote.providers?.some?.((provider) => provider.apiKeyConfigured);
        const localConfigured = Object.values(local.providers || {}).some((provider) => provider.apiKey);
        if (!remoteConfigured && localConfigured) {
          const accepted = window.confirm('将现有 Provider 配置迁移到统一后端，迁移后所有设备共用此配置。');
          if (accepted) {
            remote = await importAdminAiSettings(local);
            clearBrowserProviderSecrets(local);
          }
        }
        if (!active) return;
        const next = normalizeAdminSettings(remote);
        const configs = Object.values(next.providers);
        setSavedSettings(next);
        setSettings(next);
        setProviderConfigs(configs);
        setSelectedProviderId(next.provider);
        setProviderDraft(configs.find((provider) => provider.id === next.provider) || configs[0] || {});
        setRouterDraft(next.router);
        setRecentInvocations(await fetchAdminAiTraces());
      } catch (error) {
        if (active) setStatus(error.message || 'AI 服务配置加载失败。');
      }
    };
    loadAdminSettings();
    return () => { active = false; };
  }, [isAdmin]);

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const update = (key, value) => {
    if (!canEditProvider) return;
    setStatus('');
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const selectActiveModel = (model) => {
    if (!canEditProvider) return;
    setStatus('');
    setSettings((current) => {
      const provider = current.provider;
      const activeProvider = current.providers?.[provider] || {};
      return {
        ...current,
        model,
        defaultModel: model,
        providers: {
          ...(current.providers || {}),
          [provider]: {
            ...activeProvider,
            defaultModel: model,
            model,
            status: '未测试',
            lastError: ''
          }
        }
      };
    });
  };

  const selectProvider = (provider) => {
    if (!canEditProvider) return;
    setStatus('');
    setSettings((current) => {
      const defaultModel = providerModelDefaults[provider] || getProviderModelOptions(provider)[0]?.value || current.model;
      const activeProvider = current.providers?.[provider] || {};
      return {
        ...current,
        provider,
        model: defaultModel,
        defaultModel,
        providers: {
          ...(current.providers || {}),
          [provider]: {
            ...activeProvider,
            defaultModel,
            model: defaultModel,
            status: activeProvider.apiKey ? '未测试' : '未配置',
            lastError: ''
          }
        }
      };
    });
  };

  const save = async () => {
    if (!canEditProvider || isSaving) return;

    setIsSaving(true);
    setStatus('正在保存...');
    try {
      const saved = settingsManager.save(settings);
      setSavedSettings(saved);
      setSettings(saved);
      onDirtyChange?.(false);
      setStatus('保存成功');
      window.setTimeout(() => {
        onSaved?.();
      }, 600);
    } catch (error) {
      setStatus(error.message || '保存失败，请检查配置后重试。');
      setIsSaving(false);
    }
  };

  const test = async () => {
    setStatus('正在测试...');
    const result = await settingsManager.testConnection(settings);
    setStatus(result.message);
  };

  const toggleDeveloperMode = (enabled) => {
    if (enabled && !isAdmin) {
      setStatus('普通内测账号不可访问 Provider 配置。');
      return;
    }
    setDeveloperMode(enabled);
    setShowApiKey(false);
    setStatus(enabled ? '管理员模式已启用，可修改 AI Provider Center。' : '已返回普通设置，AI Provider Center 已锁定。');
    if (!enabled) {
      setSettings(savedSettings);
      onDirtyChange?.(false);
    }
  };

  const commitProviderSelection = (providerId) => {
    const next = providerConfigs.find((provider) => provider.id === providerId) || {};
    setSelectedProviderId(providerId);
    setProviderDraft(next);
    setPendingProviderId('');
    setShowApiKey(false);
    setStatus('');
  };

  const requestProviderSelection = (providerId) => {
    if (providerId === selectedProviderId) return;
    if (providerDirty) {
      setPendingProviderId(providerId);
      return;
    }
    commitProviderSelection(providerId);
  };

  const updateProviderDraft = (key, value) => {
    setStatus('');
    setProviderDraft((current) => ({
      ...current,
      [key]: value,
      ...(key === 'defaultModel' ? { model: value } : {}),
      ...(['apiKey', 'baseUrl', 'defaultModel'].includes(key) ? { status: '未测试', lastError: '' } : {})
    }));
  };

  const saveProvider = async () => {
    const previous = providerConfigs.find((provider) => provider.id === selectedProviderId);
    if (previous?.apiKeyConfigured && providerDraft.apiKey && !window.confirm('确定覆盖当前 Provider 的 API Key 吗？')) return;
    setIsSaving(true);
    try {
      const saved = await saveAdminProvider(selectedProviderId, providerDraft);
      const nextConfigs = (await fetchAdminAiSettings()).providers;
      setProviderConfigs(nextConfigs);
      setProviderDraft(saved);
      const clientSettings = normalizeAdminSettings(await fetchAdminAiSettings());
      setSavedSettings(clientSettings);
      setSettings(clientSettings);
      setRouterDraft(clientSettings.router || { routes: {} });
      setStatus('保存成功');
      onDirtyChange?.(false);
    } finally {
      setIsSaving(false);
    }
  };

  const testSelectedProvider = async () => {
    setStatus('正在测试...');
    const result = await testAdminProvider(selectedProviderId, providerDraft);
    const nextConfigs = (await fetchAdminAiSettings()).providers;
    setProviderConfigs(nextConfigs);
    setProviderDraft(result.config || nextConfigs.find((provider) => provider.id === selectedProviderId));
    const clientSettings = normalizeAdminSettings(await fetchAdminAiSettings());
    setSavedSettings(clientSettings);
    setSettings(clientSettings);
    setStatus(result.ok ? `Connected · ${result.latency || 0} ms · ${result.model || providerDraft.defaultModel || ''}` : result.message);
  };

  const updateRouterRoute = (capability, providerId) => {
    const provider = providerConfigs.find((item) => item.id === providerId);
    setRouterDraft((current) => ({
      ...(current || { routes: {} }),
      routes: {
        ...(current?.routes || {}),
        [capability]: {
          ...(current?.routes?.[capability] || defaultRoutePolicy[capability]),
          providerId,
          model: provider?.defaultModel || provider?.model || defaultRoutePolicy[capability]?.model || ''
        }
      }
    }));
    setStatus('');
    onDirtyChange?.(true);
  };

  const saveRouter = async () => {
    const savedRouter = await saveAdminRouter(routerDraft);
    setRouterDraft(savedRouter);
    const clientSettings = normalizeAdminSettings(await fetchAdminAiSettings());
    setSavedSettings(clientSettings);
    setSettings(clientSettings);
    setStatus('AI Router 配置已保存');
    onDirtyChange?.(false);
  };

  const updateRouterModel = (capability, model) => {
    setRouterDraft((current) => ({
      ...(current || { routes: {} }),
      routes: {
        ...(current?.routes || {}),
        [capability]: {
          ...(current?.routes?.[capability] || defaultRoutePolicy[capability]),
          model
        }
      }
    }));
    setStatus('');
    onDirtyChange?.(true);
  };

  const refreshMemories = () => {
    setMemories(memoryManager.list());
  };

  const resetMemoryDraft = () => {
    setMemoryDraft({ id: '', type: 'user', title: '', content: '', enabled: true });
  };

  const saveMemory = () => {
    if (!memoryDraft.title.trim() || !memoryDraft.content.trim()) {
      setStatus('请填写 Memory 标题和内容。');
      return;
    }

    if (memoryDraft.id) {
      memoryManager.update(memoryDraft.id, memoryDraft);
      setStatus('Memory 已更新。');
    } else {
      memoryManager.create(memoryDraft);
      setStatus('Memory 已新增。');
    }
    resetMemoryDraft();
    refreshMemories();
  };

  const editMemory = (memory) => {
    setMemoryDraft(memory);
  };

  const deleteMemory = (memoryId) => {
    memoryManager.delete(memoryId);
    if (memoryDraft.id === memoryId) resetMemoryDraft();
    refreshMemories();
    setStatus('Memory 已删除。');
  };

  const toggleMemory = (memoryId, enabled) => {
    memoryManager.toggle(memoryId, enabled);
    refreshMemories();
  };

  const exportMemory = () => {
    const blob = new Blob([JSON.stringify(memoryManager.exportJson(), null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ai-work-center-memory.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const importMemory = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      memoryManager.importJson(await file.text());
      refreshMemories();
      setStatus('Memory 已导入。');
    } catch (error) {
      setStatus(error.message || 'Memory 导入失败。');
    } finally {
      event.target.value = '';
    }
  };

  const refreshKnowledge = (filter = knowledgeFilter) => {
    setKnowledgeItems(knowledgeManager.list(filter));
  };

  const resetKnowledgeDraft = () => {
    setKnowledgeDraft({ id: '', type: 'document', title: '', content: '', tags: '', enabled: true });
  };

  const updateKnowledgeFilter = (key, value) => {
    const next = { ...knowledgeFilter, [key]: value };
    setKnowledgeFilter(next);
    setKnowledgeItems(knowledgeManager.list(next));
  };

  const saveKnowledge = () => {
    if (!knowledgeDraft.title.trim() || !knowledgeDraft.content.trim()) {
      setStatus('请填写 Knowledge 标题和内容。');
      return;
    }
    if (knowledgeDraft.id) {
      knowledgeManager.update(knowledgeDraft.id, knowledgeDraft);
      setStatus('Knowledge 已更新。');
    } else {
      knowledgeManager.create(knowledgeDraft);
      setStatus('Knowledge 已新增。');
    }
    resetKnowledgeDraft();
    refreshKnowledge();
  };

  const editKnowledge = (item) => {
    setKnowledgeDraft({ ...item, tags: item.tags.join(', ') });
  };

  const deleteKnowledge = (knowledgeId) => {
    knowledgeManager.delete(knowledgeId);
    if (knowledgeDraft.id === knowledgeId) resetKnowledgeDraft();
    refreshKnowledge();
    setStatus('Knowledge 已删除。');
  };

  const toggleKnowledge = (knowledgeId, enabled) => {
    knowledgeManager.toggle(knowledgeId, enabled);
    refreshKnowledge();
  };

  const exportKnowledge = () => {
    const blob = new Blob([JSON.stringify(knowledgeManager.exportJson(), null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ai-work-center-knowledge.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const importKnowledge = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      knowledgeManager.importJson(await file.text());
      refreshKnowledge();
      setStatus('Knowledge 已导入。');
    } catch (error) {
      setStatus(error.message || 'Knowledge 导入失败。');
    } finally {
      event.target.value = '';
    }
  };

  if (developerMode && isAdmin) {
    return (
      <AdminAiSettings
        providers={providers}
        providerConfigs={providerConfigs}
        selectedProviderId={selectedProviderId}
        providerDraft={providerDraft}
        providerDirty={providerDirty}
        pendingProviderId={pendingProviderId}
        requestProviderSelection={requestProviderSelection}
        commitProviderSelection={commitProviderSelection}
        cancelProviderSelection={() => setPendingProviderId('')}
        updateProviderDraft={updateProviderDraft}
        providerModelOptions={providerModelOptions}
        status={status}
        isSaving={isSaving}
        test={testSelectedProvider}
        save={saveProvider}
        reset={() => setProviderDraft(providerConfigs.find((provider) => provider.id === selectedProviderId) || {})}
        routerDraft={routerDraft}
        updateRouterRoute={updateRouterRoute}
        updateRouterModel={updateRouterModel}
        saveRouter={saveRouter}
        recentInvocations={recentInvocations}
        refreshInvocations={() => fetchAdminAiTraces().then(setRecentInvocations)}
        onExitAdmin={() => toggleDeveloperMode(false)}
      />
    );
  }

  return <UserSettings apiKeyConfigured={apiKeyConfigured} appearanceTheme={appearanceTheme} onAppearanceThemeChange={onAppearanceThemeChange} currentUser={currentUser} isAdmin={isAdmin} onLogout={onLogout} toggleDeveloperMode={toggleDeveloperMode} status={status} />;

  return (
    <section className="rounded-[36px] border border-white/80 bg-white/70 p-7 shadow-[0_24px_80px_rgba(60,54,45,0.08)] backdrop-blur-xl">
      <div className="mb-8">
        <div className="text-sm text-[#8a8378]">AI 设置</div>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight">Provider 与模型配置</h2>
      </div>

      <div className="mb-6 rounded-[24px] bg-white/75 p-5 shadow-[0_14px_38px_rgba(60,54,45,0.05)]">
        <div className="flex items-start justify-between gap-5">
          <div>
            <div className="text-sm font-semibold text-[#2a2927]">
              当前模式：{developerMode ? 'Developer Mode' : 'User Mode'}
            </div>
            <div className="mt-2 text-sm leading-6 text-[#746d64]">
              {developerMode
                ? `Provider：${providerLabels[savedSettings.provider] || savedSettings.provider} · 模型：${savedSettings.model || '未配置'} · API Key：${apiKeyConfigured ? '已配置' : '未配置'}`
                : `AI 服务${apiKeyConfigured ? '已连接' : '未连接'}`}
            </div>
          </div>
          <label className="flex shrink-0 items-center gap-3 text-sm font-medium text-[#4d473f]">
            <input
              type="checkbox"
              checked={developerMode}
              onChange={(event) => toggleDeveloperMode(event.target.checked)}
            />
            Developer Mode
          </label>
        </div>
      </div>

      <div className="mb-6 flex gap-2 rounded-full bg-[#f8f5ef] p-1">
        {[
          ['ai', 'AI 设置'],
          ['memory', 'Memory'],
          ['knowledge', 'Knowledge']
        ].map(([id, label]) => (
          <button
            key={id}
            className={`rounded-full px-5 py-2 text-sm transition ${
              activeTab === id ? 'bg-[#1f1f1f] text-white shadow-sm' : 'text-[#6f695f] hover:bg-white'
            }`}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'ai' && !developerMode ? (
        <div className="rounded-[28px] bg-white p-6 text-sm leading-6 text-[#746d64] shadow-[0_16px_45px_rgba(60,54,45,0.06)]">
          {apiKeyConfigured ? 'AI 服务已连接。普通用户无需配置模型或 API Key。' : 'AI 服务未连接，请联系管理员完成设置。'}
        </div>
      ) : activeTab === 'ai' ? <div className="grid grid-cols-[280px_1fr] gap-6">
        <div className="rounded-[28px] bg-[#f8f5ef] p-5">
          <div className="mb-4 text-sm font-semibold text-[#4d473f]">Provider</div>
          <div className="space-y-3">
            {providers.map((provider) => (
              <label
                key={provider.id}
                className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition ${
                  settings.provider === provider.id
                    ? 'bg-[#1f1f1f] text-white shadow-[0_12px_28px_rgba(31,31,31,0.16)]'
                    : 'bg-white/60 text-[#6f695f] hover:bg-white hover:text-[#1f1f1f]'
                } ${canEditProvider ? 'cursor-pointer' : 'cursor-not-allowed opacity-75'}`}
              >
                <input
                  type="radio"
                  name="provider"
                  checked={settings.provider === provider.id}
                  disabled={!canEditProvider}
                  onChange={() => selectProvider(provider.id)}
                />
                {providerLabels[provider.id] || provider.name}
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-[28px] bg-white p-6 shadow-[0_16px_45px_rgba(60,54,45,0.06)]">
          <Field label="API Key">
            <div className="flex gap-3">
              <input
                type={apiKeyInputType}
                value={apiKeyValue}
                onChange={(event) => update('apiKey', event.target.value)}
                placeholder="□□□□□□□□□□□□□□"
                className="settings-input"
                readOnly={!canEditProvider}
                disabled={!canEditProvider}
              />
              <button
                type="button"
                className="shrink-0 rounded-2xl bg-[#f8f5ef] px-4 text-sm font-medium text-[#4d473f] transition hover:bg-[#ece5d9] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canRevealKey}
                onClick={() => setShowApiKey((current) => !current)}
              >
                {showApiKey ? '隐藏' : '显示'}
              </button>
            </div>
          </Field>

          <Field label="Base URL">
            <input
              value={settings.baseUrl}
              onChange={(event) => update('baseUrl', event.target.value)}
              placeholder="□□□□□□□□□□□□□□"
              className="settings-input"
              readOnly={!canEditProvider}
              disabled={!canEditProvider}
            />
          </Field>

          <Field label="Model">
            <select
              value={settings.model}
              onChange={(event) => selectActiveModel(event.target.value)}
              className="settings-input"
              disabled={!canEditProvider}
            >
              {activeModelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label={`Temperature：${settings.temperature}`}>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={settings.temperature}
              onChange={(event) => update('temperature', event.target.value)}
              className="w-full accent-[#1f1f1f]"
              disabled={!canEditProvider}
            />
          </Field>

          <Field label={`Max Tokens：${settings.maxTokens}`}>
            <input
              type="range"
              min="256"
              max="8192"
              step="256"
              value={settings.maxTokens}
              onChange={(event) => update('maxTokens', event.target.value)}
              className="w-full accent-[#1f1f1f]"
              disabled={!canEditProvider}
            />
          </Field>

          <div className="mt-8 flex items-center gap-3">
            <PrimaryButton variant="light" onClick={test} disabled={isSaving}>
              测试
            </PrimaryButton>
            <PrimaryButton onClick={save} disabled={!canEditProvider || isSaving}>
              {isSaving ? '保存中...' : '保存'}
            </PrimaryButton>
            {status ? <span className="text-sm text-[#746d64]">{status}</span> : null}
          </div>
        </div>
      </div> : activeTab === 'memory' ? (
        <div className="grid grid-cols-[320px_1fr] gap-6">
          <div className="rounded-[28px] bg-white p-6 shadow-[0_16px_45px_rgba(60,54,45,0.06)]">
            <Field label="Memory 类型">
              <select
                value={memoryDraft.type}
                onChange={(event) => setMemoryDraft((current) => ({ ...current, type: event.target.value }))}
                className="settings-input"
              >
                {memoryTypes.map((type) => (
                  <option key={type.id} value={type.id}>{type.label}</option>
                ))}
              </select>
            </Field>
            <Field label="标题">
              <input
                value={memoryDraft.title}
                onChange={(event) => setMemoryDraft((current) => ({ ...current, title: event.target.value }))}
                className="settings-input"
                placeholder="例如：品牌定位"
              />
            </Field>
            <Field label="内容">
              <textarea
                value={memoryDraft.content}
                onChange={(event) => setMemoryDraft((current) => ({ ...current, content: event.target.value }))}
                className="settings-input min-h-32 resize-none"
                placeholder="写下希望 AI 长期记住的信息。"
              />
            </Field>
            <label className="mb-5 flex items-center gap-3 text-sm text-[#4d473f]">
              <input
                type="checkbox"
                checked={memoryDraft.enabled}
                onChange={(event) => setMemoryDraft((current) => ({ ...current, enabled: event.target.checked }))}
              />
              启用
            </label>
            <div className="flex flex-wrap gap-3">
              <PrimaryButton onClick={saveMemory}>{memoryDraft.id ? '保存 Memory' : '新增 Memory'}</PrimaryButton>
              <PrimaryButton variant="light" onClick={resetMemoryDraft}>清空</PrimaryButton>
              <PrimaryButton variant="light" onClick={exportMemory}>导出 Memory</PrimaryButton>
              <label className="inline-flex cursor-pointer items-center rounded-full bg-[#f8f5ef] px-5 py-2.5 text-sm font-medium text-[#4d473f] transition hover:bg-white">
                导入 Memory
                <input type="file" accept="application/json" className="hidden" onChange={importMemory} />
              </label>
            </div>
            {status ? <div className="mt-4 text-sm text-[#746d64]">{status}</div> : null}
          </div>

          <div className="rounded-[28px] bg-[#f8f5ef] p-5">
            <div className="mb-4 text-sm font-semibold text-[#4d473f]">长期记忆</div>
            <div className="space-y-3">
              {memories.length === 0 ? (
                <div className="rounded-2xl bg-white/70 p-4 text-sm text-[#8a8378]">暂无 Memory。</div>
              ) : (
                memories.map((memory) => (
                  <div key={memory.id} className="rounded-2xl bg-white/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[#2a2927]">{memory.title}</div>
                        <div className="mt-1 text-xs text-[#8a8378]">
                          {memoryTypes.find((type) => type.id === memory.type)?.label || memory.type}
                        </div>
                      </div>
                      <label className="flex shrink-0 items-center gap-2 text-xs text-[#6f695f]">
                        <input
                          type="checkbox"
                          checked={memory.enabled}
                          onChange={(event) => toggleMemory(memory.id, event.target.checked)}
                        />
                        启用
                      </label>
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm leading-6 text-[#6f695f]">{memory.content}</p>
                    <div className="mt-4 flex gap-2">
                      <PrimaryButton variant="light" onClick={() => editMemory(memory)}>编辑</PrimaryButton>
                      <PrimaryButton variant="light" onClick={() => deleteMemory(memory.id)}>删除</PrimaryButton>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[340px_1fr] gap-6">
          <div className="rounded-[28px] bg-white p-6 shadow-[0_16px_45px_rgba(60,54,45,0.06)]">
            <Field label="知识分类">
              <select
                value={knowledgeDraft.type}
                onChange={(event) => setKnowledgeDraft((current) => ({ ...current, type: event.target.value }))}
                className="settings-input"
              >
                {knowledgeTypes.map((type) => (
                  <option key={type.id} value={type.id}>{type.label}</option>
                ))}
              </select>
            </Field>
            <Field label="标题">
              <input
                value={knowledgeDraft.title}
                onChange={(event) => setKnowledgeDraft((current) => ({ ...current, title: event.target.value }))}
                className="settings-input"
                placeholder="例如：产品卖点"
              />
            </Field>
            <Field label="标签">
              <input
                value={knowledgeDraft.tags}
                onChange={(event) => setKnowledgeDraft((current) => ({ ...current, tags: event.target.value }))}
                className="settings-input"
                placeholder="多个标签用英文逗号分隔"
              />
            </Field>
            <Field label="内容">
              <textarea
                value={knowledgeDraft.content}
                onChange={(event) => setKnowledgeDraft((current) => ({ ...current, content: event.target.value }))}
                className="settings-input min-h-36 resize-none"
                placeholder="写下企业知识、产品资料、FAQ 或模板。"
              />
            </Field>
            <label className="mb-5 flex items-center gap-3 text-sm text-[#4d473f]">
              <input
                type="checkbox"
                checked={knowledgeDraft.enabled}
                onChange={(event) => setKnowledgeDraft((current) => ({ ...current, enabled: event.target.checked }))}
              />
              启用
            </label>
            <div className="flex flex-wrap gap-3">
              <PrimaryButton onClick={saveKnowledge}>{knowledgeDraft.id ? '保存 Knowledge' : '新增知识'}</PrimaryButton>
              <PrimaryButton variant="light" onClick={resetKnowledgeDraft}>清空</PrimaryButton>
              <PrimaryButton variant="light" onClick={exportKnowledge}>导出 Knowledge</PrimaryButton>
              <label className="inline-flex cursor-pointer items-center rounded-full bg-[#f8f5ef] px-5 py-2.5 text-sm font-medium text-[#4d473f] transition hover:bg-white">
                导入 Knowledge
                <input type="file" accept="application/json" className="hidden" onChange={importKnowledge} />
              </label>
            </div>
            {status ? <div className="mt-4 text-sm text-[#746d64]">{status}</div> : null}
          </div>

          <div className="rounded-[28px] bg-[#f8f5ef] p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[#4d473f]">知识库</div>
              <div className="text-xs text-[#8a8378]">共 {knowledgeManager.count()} 条</div>
            </div>
            <div className="mb-4 grid grid-cols-[1fr_150px] gap-3">
              <input
                value={knowledgeFilter.keyword}
                onChange={(event) => updateKnowledgeFilter('keyword', event.target.value)}
                className="settings-input"
                placeholder="搜索知识、标签、内容"
              />
              <select
                value={knowledgeFilter.type}
                onChange={(event) => updateKnowledgeFilter('type', event.target.value)}
                className="settings-input"
              >
                <option value="all">全部分类</option>
                {knowledgeTypes.map((type) => (
                  <option key={type.id} value={type.id}>{type.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-3">
              {knowledgeItems.length === 0 ? (
                <div className="rounded-2xl bg-white/70 p-4 text-sm text-[#8a8378]">暂无 Knowledge。</div>
              ) : (
                knowledgeItems.map((item) => (
                  <div key={item.id} className="rounded-2xl bg-white/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[#2a2927]">{item.title}</div>
                        <div className="mt-1 text-xs text-[#8a8378]">
                          {knowledgeTypes.find((type) => type.id === item.type)?.label || item.type}
                          {item.tags.length ? ` · ${item.tags.join(' / ')}` : ''}
                        </div>
                      </div>
                      <label className="flex shrink-0 items-center gap-2 text-xs text-[#6f695f]">
                        <input
                          type="checkbox"
                          checked={item.enabled}
                          onChange={(event) => toggleKnowledge(item.id, event.target.checked)}
                        />
                        启用
                      </label>
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm leading-6 text-[#6f695f]">{item.content}</p>
                    <div className="mt-4 flex gap-2">
                      <PrimaryButton variant="light" onClick={() => editKnowledge(item)}>编辑</PrimaryButton>
                      <PrimaryButton variant="light" onClick={() => deleteKnowledge(item.id)}>删除</PrimaryButton>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function UserSettings({ apiKeyConfigured, appearanceTheme, onAppearanceThemeChange, currentUser, isAdmin, onLogout, toggleDeveloperMode, status }) {
  const [activeView, dispatchView] = useReducer(reduceSettingsView, SETTINGS_VIEWS.HOME);
  const [dataStatus, setDataStatus] = useState(status || '');
  const selectedTheme = getAppearanceTheme(appearanceTheme);
  const entries = getSettingsHomeEntries({ isAdmin });

  const exportLocalData = async () => {
    try {
      const userId = await fetchExportScope();
      const payload = exportUserLocalData({ userId });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ai-secretary-local-backup-${currentUser?.username || 'user'}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setDataStatus('已导出当前账号本地数据。');
    } catch (error) {
      setDataStatus(error.message || '导出失败。');
    }
  };

  const importLocalData = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const userId = await fetchExportScope();
      importUserLocalData({ userId, payload: await file.text() });
      setDataStatus('已导入当前账号本地备份，请刷新或重新进入页面查看。');
    } catch (error) {
      setDataStatus(error.message || '导入失败。');
    } finally {
      event.target.value = '';
    }
  };

  if (activeView === SETTINGS_VIEWS.APPEARANCE) {
    return (
      <AppearanceSettings
        appearanceTheme={appearanceTheme}
        onAppearanceThemeChange={onAppearanceThemeChange}
        onBack={() => dispatchView({ type: 'back' })}
      />
    );
  }

  if (activeView === SETTINGS_VIEWS.PRIVACY) {
    return (
      <PrivacyDataSettings
        dataStatus={dataStatus}
        onBack={() => dispatchView({ type: 'back' })}
        onExport={exportLocalData}
        onImport={importLocalData}
      />
    );
  }

  return (
    <section data-settings-view="home" className="settings-page theme-surface mx-auto w-full max-w-[1120px] rounded-[18px] border border-[#E7E9EE] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_8px_24px_rgba(22,24,29,0.04)] sm:rounded-[24px] sm:p-7">
      <div className="mb-5 sm:mb-8">
        <div className="text-xs font-medium tracking-[0.08em] text-[#6B7280]">个人设置</div>
        <h2 className="mt-2 whitespace-nowrap text-[26px] font-semibold leading-tight text-[#16181D] sm:text-[32px]">设置</h2>
        <p className="mt-2 text-sm leading-6 text-[#6B7280]">管理你的使用偏好和本地数据。</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {entries.map((entry) => {
          const state = entry.id === 'profile'
            ? (currentUser?.role === 'admin' ? '管理员' : '内测用户')
            : entry.id === 'appearance'
              ? selectedTheme.name
              : entry.id === 'notifications'
                ? '未配置'
                : entry.id === 'privacy'
                  ? '仅保存在本地'
                  : (apiKeyConfigured ? '已连接' : '未配置');
          const interactive = entry.id === 'appearance' || entry.id === 'privacy' || entry.id === 'ai-service';
          const content = (
            <>
              <span className="flex items-start justify-between gap-3">
                <span className="text-base font-semibold text-[#16181D]">{entry.title}</span>
                <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-[11px] text-[#6B7280]">{state}</span>
              </span>
              <span className="mt-2 block text-sm leading-6 text-[#6B7280]">{entry.description}</span>
              {interactive ? <span className="mt-3 block text-xs font-medium text-[#4D4FC4]">进入设置 →</span> : null}
            </>
          );

          return interactive ? (
            <button
              key={entry.id}
              type="button"
              className="theme-soft-surface min-h-[124px] rounded-[14px] border border-[#E7E9EE] bg-[#FAFBFC] p-4 text-left transition hover:border-[#5B5CE2] active:scale-[0.99] sm:p-5"
              onClick={() => {
                if (entry.id === 'appearance') dispatchView({ type: 'open-appearance' });
                if (entry.id === 'privacy') dispatchView({ type: 'open-privacy' });
                if (entry.id === 'ai-service') toggleDeveloperMode?.(true);
              }}
            >
              {content}
            </button>
          ) : (
            <div key={entry.id} className="theme-soft-surface min-h-[124px] rounded-[14px] border border-[#E7E9EE] bg-[#FAFBFC] p-4 sm:p-5">
              {content}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-col gap-2 border-t border-[#E7E9EE] pt-4 sm:flex-row sm:items-center sm:justify-between">
        <button className="min-h-11 rounded-[10px] px-3 text-left text-sm text-[#6B7280] hover:bg-[#FAFBFC]" onClick={onLogout}>退出登录</button>
        <span className="text-xs text-[#9AA1AE]">已登录：{currentUser?.displayName || currentUser?.username}</span>
      </div>
    </section>
  );
}

function AppearanceSettings({ appearanceTheme, onAppearanceThemeChange, onBack }) {
  const [themeStatus, setThemeStatus] = useState('');
  const selectedTheme = getAppearanceTheme(appearanceTheme);

  return (
    <section data-settings-view="appearance" className="settings-page theme-surface mx-auto w-full max-w-[1120px] rounded-[18px] border border-[#E7E9EE] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_8px_24px_rgba(22,24,29,0.04)] sm:rounded-[24px] sm:p-7">
      <div className="theme-surface sticky top-[68px] z-20 -mx-4 -mt-4 mb-5 flex items-center gap-3 border-b border-[#E7E9EE] bg-white px-4 py-3 sm:-mx-7 sm:-mt-7 sm:mb-8 sm:px-7 sm:py-4">
        <button
          type="button"
          className="theme-control inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[10px] border border-[#E7E9EE] bg-white px-3 text-sm font-medium text-[#16181D] transition hover:border-[#5B5CE2] active:scale-[0.98]"
          onClick={onBack}
          aria-label="返回设置"
        >
          <span aria-hidden="true">←</span>
          返回设置
        </button>
        <h2 className="min-w-0 text-[24px] font-semibold leading-tight text-[#16181D] sm:text-[30px]">外观</h2>
      </div>

      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div>
          <div className="text-xs font-medium tracking-[0.08em] text-[#6B7280]">当前主题</div>
          <p className="mt-1 text-base font-semibold text-[#16181D]">{selectedTheme.name}</p>
        </div>
        <p className="text-sm leading-6 text-[#6B7280]">选择后立即生效，并保存在当前账号的本地设置中。</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {appearanceThemes.map((item) => {
          const selected = item.id === appearanceTheme;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              className={`theme-control min-h-36 rounded-[14px] border p-3 text-left transition ${selected ? 'theme-choice-selected border-[#5B5CE2] bg-[#EEF0FF]' : 'border-[#E7E9EE] bg-white hover:border-[#5B5CE2]'}`}
              onClick={() => {
                onAppearanceThemeChange?.(item.id);
                setThemeStatus(`已应用${item.name}`);
              }}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-[#16181D]">{item.name}</span>
                {selected ? <span className="rounded-full bg-[#5B5CE2] px-2 py-1 text-[10px] text-white">使用中</span> : null}
              </span>
              <span className="mt-1 block text-xs leading-5 text-[#6B7280]">{item.description}</span>
              <span className="mt-3 block rounded-[12px] border border-black/10 p-2" style={{ background: item.preview.background }}>
                <span className="flex items-center gap-2">
                  <AISecretaryLogo size={24} showGlow={false} />
                  <span className="text-xs font-semibold" style={{ color: item.preview.text }}>AI秘书</span>
                </span>
                <span className="mt-2 block h-8 rounded-[10px]" style={{ background: item.preview.surface, border: `1px solid ${item.tokens.border}` }}>
                  <span className="mx-2 mt-2 block h-2 w-1/2 rounded-full" style={{ background: item.preview.accent }} />
                </span>
              </span>
              <span className="mt-3 flex gap-1.5" aria-hidden="true">
                {item.swatches.map((color) => <span key={color} className="h-4 w-4 rounded-full border border-black/10" style={{ backgroundColor: color }} />)}
              </span>
            </button>
          );
        })}
      </div>
      {themeStatus ? <div className="mt-3 text-xs text-[#4D4FC4]" role="status">{themeStatus}</div> : null}
    </section>
  );
}

function PrivacyDataSettings({ dataStatus, onBack, onExport, onImport }) {
  return (
    <section data-settings-view="privacy" className="settings-page theme-surface mx-auto w-full max-w-[1120px] rounded-[18px] border border-[#E7E9EE] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_8px_24px_rgba(22,24,29,0.04)] sm:rounded-[24px] sm:p-7">
      <div className="theme-surface sticky top-[68px] z-20 -mx-4 -mt-4 mb-5 flex items-center gap-3 border-b border-[#E7E9EE] bg-white px-4 py-3 sm:-mx-7 sm:-mt-7 sm:mb-8 sm:px-7 sm:py-4">
        <button
          type="button"
          className="theme-control inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[10px] border border-[#E7E9EE] bg-white px-3 text-sm font-medium text-[#16181D] transition hover:border-[#5B5CE2] active:scale-[0.98]"
          onClick={onBack}
          aria-label="返回设置"
        >
          <span aria-hidden="true">←</span>
          返回设置
        </button>
        <h2 className="min-w-0 text-[24px] font-semibold leading-tight text-[#16181D] sm:text-[30px]">隐私与数据</h2>
      </div>

      <div className="theme-soft-surface rounded-[14px] border border-[#E7E9EE] bg-[#FAFBFC] p-4 sm:p-5">
        <h3 className="text-base font-semibold text-[#16181D]">本地数据</h3>
        <p className="mt-2 text-sm leading-6 text-[#6B7280]">
          Beta 期间，记忆和工作数据仅保存在当前设备。更换设备或清除浏览器数据后无法自动恢复。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="min-h-11 rounded-[10px] border border-[#E7E9EE] px-4 text-sm font-medium text-[#16181D] hover:border-[#5B5CE2]" onClick={onExport}>导出我的本地数据</button>
          <label className="inline-flex min-h-11 cursor-pointer items-center rounded-[10px] border border-[#E7E9EE] px-4 text-sm font-medium text-[#16181D] hover:border-[#5B5CE2]">
            导入本地备份
            <input type="file" accept="application/json" className="hidden" onChange={onImport} />
          </label>
        </div>
        {dataStatus ? <div className="mt-3 text-xs text-[#4D4FC4]" role="status">{dataStatus}</div> : null}
      </div>
    </section>
  );
}

function AdminAiSettings({ providers, providerConfigs, selectedProviderId, providerDraft, providerDirty, pendingProviderId, requestProviderSelection, commitProviderSelection, cancelProviderSelection, updateProviderDraft, providerModelOptions, status, isSaving, test, save, reset, routerDraft, updateRouterRoute, updateRouterModel, saveRouter, recentInvocations, refreshInvocations, onExitAdmin }) {
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) || providers[0];
  const capabilityRows = [
    ['Vision', 'visionSupported'],
    ['Reasoning', 'reasoningSupported'],
    ['Tools', 'toolCallSupported'],
    ['Embedding', 'embeddingSupported']
  ];
  return (
    <section className="settings-page mx-auto w-full max-w-[1120px] rounded-[18px] border border-[#E7E9EE] bg-white p-4 shadow-[0_8px_24px_rgba(22,24,29,0.04)] sm:rounded-[24px] sm:p-7">
      <div className="mb-5 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs font-medium tracking-[0.08em] text-[#5B5CE2]">管理员中心 · Enterprise AI Capability Center</div>
          <h2 className="mt-2 whitespace-nowrap text-[26px] font-semibold leading-tight text-[#16181D] sm:text-[32px]">AI Provider Center</h2>
          <p className="mt-2 text-sm leading-6 text-[#6B7280]">管理员只配置密钥和能力边界，普通用户不选择模型，AI Router 自动调度。</p>
        </div>
        <button className="min-h-11 self-start rounded-[10px] border border-[#E7E9EE] px-3 text-sm text-[#16181D] hover:border-[#5B5CE2]" onClick={onExitAdmin}>返回普通设置</button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[250px_1fr] lg:gap-5">
        <div className="rounded-[14px] border border-[#E7E9EE] bg-[#FAFBFC] p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-2"><div className="text-sm font-semibold text-[#16181D]">Provider</div><span className="text-xs text-[#6B7280]">{providers.length} 个</span></div>
          <div className="space-y-2">
            {providers.map((provider) => (
              <button key={provider.id} type="button" className={`w-full rounded-[10px] px-3 py-2.5 text-left transition ${selectedProviderId === provider.id ? 'bg-[#EEF0FF] text-[#4D4FC4]' : 'bg-white text-[#6B7280] hover:border-[#5B5CE2]'}`} onClick={() => requestProviderSelection(provider.id)}>
                <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{provider.name}</span><span className="rounded-full bg-white/80 px-2 py-1 text-[10px]">{providerConfigs.find((item) => item.id === provider.id)?.status || '未配置'}</span></div>
                <div className="mt-1 text-[11px] text-[#6B7280]">{provider.vendor} · Priority {provider.priority}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[#E7E9EE] bg-[#FAFBFC] px-4 py-3 sm:px-5"><div><div className="text-xs text-[#6B7280]">Provider</div><div className="mt-1 text-base font-semibold text-[#16181D]">{selectedProvider?.name}</div><div className="mt-1 text-xs text-[#6B7280]">{providerDraft.vendor} · {providerDraft.configured ? '已配置' : '未配置'} · {providerDraft.healthy === true ? '可用' : providerDraft.healthy === false ? '不可用' : '未验证'} · 平均 {providerDraft.averageLatencyMs || 0} ms</div></div><label className="flex min-h-11 items-center gap-2 text-sm text-[#16181D]"><input type="checkbox" checked={Boolean(providerDraft.enabled)} onChange={(event) => updateProviderDraft('enabled', event.target.checked)} />Enabled</label></div>
          <div className="rounded-[14px] border border-[#E7E9EE] bg-white p-4 sm:p-5">
            <Field label="API Key">
              <input type="password" value={providerDraft.apiKey || ''} onChange={(event) => updateProviderDraft('apiKey', event.target.value)} placeholder={providerDraft.maskedApiKey || '输入新的 API Key'} autoComplete="new-password" className="settings-input" />
              <div className="mt-2 text-xs leading-5 text-[#6B7280]">{providerDraft.apiKeyConfigured ? `已配置：${providerDraft.maskedApiKey}` : '未配置'}。保存后不回显，也不提供复制操作。</div>
            </Field>
          </div>

          <div className="rounded-[14px] border border-[#E7E9EE] bg-white p-4 sm:p-5">
            <Field label="Base URL"><input value={providerDraft.baseUrl} onChange={(event) => updateProviderDraft('baseUrl', event.target.value)} className="settings-input" /></Field>
            <Field label={providerDraft.modelPlaceholder || 'Default Model'}><select value={providerDraft.defaultModel || ''} onChange={(event) => updateProviderDraft('defaultModel', event.target.value)} className="settings-input">{providerModelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
            <div className="grid gap-3 sm:grid-cols-2"><Field label="Priority"><input type="number" min="1" value={providerDraft.priority} onChange={(event) => updateProviderDraft('priority', event.target.value)} className="settings-input" /></Field><Field label="Cost Strategy"><select value={providerDraft.costStrategy || ''} onChange={(event) => updateProviderDraft('costStrategy', event.target.value)} className="settings-input"><option value="">使用企业默认 Balanced</option><option value="Cheap">Cheap</option><option value="Balanced">Balanced</option><option value="Quality">Quality</option><option value="Fast">Fast</option></select></Field></div>
            <div className="grid gap-3 sm:grid-cols-4">
              {capabilityRows.map(([label, key]) => <label key={key} className="flex min-h-11 items-center gap-2 rounded-[10px] border border-[#E7E9EE] bg-[#FAFBFC] px-3 text-sm text-[#16181D]"><input type="checkbox" checked={Boolean(providerDraft[key])} onChange={(event) => updateProviderDraft(key, event.target.checked)} />{label}</label>)}
            </div>
            <Field label="Capability Tags"><div className="flex min-h-12 flex-wrap items-center gap-1.5 rounded-[18px] border border-[#E7E9EE] bg-[#FAFBFC] px-3 py-2">{providerDraft.tags?.map((capability) => <span key={capability} className="rounded-full bg-white px-2 py-1 text-[11px] text-[#6B7280]">{capability}</span>)}</div></Field>
          </div>

          <details className="rounded-[14px] border border-[#E7E9EE] bg-[#FAFBFC] p-4 sm:p-5">
            <summary className="cursor-pointer list-none text-sm font-semibold text-[#16181D]">高级设置</summary>
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2"><Field label={`Temperature：${providerDraft.temperature}`}><input type="range" min="0" max="2" step="0.1" value={providerDraft.temperature} onChange={(event) => updateProviderDraft('temperature', event.target.value)} className="w-full accent-[#5B5CE2]" /></Field><Field label={`Max Tokens：${providerDraft.maxTokens}`}><input type="range" min="256" max="8192" step="256" value={providerDraft.maxTokens} onChange={(event) => updateProviderDraft('maxTokens', event.target.value)} className="w-full accent-[#5B5CE2]" /></Field></div>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Timeout"><input type="number" min="1000" value={providerDraft.timeout} onChange={(event) => updateProviderDraft('timeout', event.target.value)} className="settings-input" /></Field><Field label="Retry Count"><input type="number" min="0" max="5" value={providerDraft.retryCount} onChange={(event) => updateProviderDraft('retryCount', event.target.value)} className="settings-input" /></Field></div>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Max Context"><input type="number" min="0" value={providerDraft.maxContext} onChange={(event) => updateProviderDraft('maxContext', event.target.value)} className="settings-input" /></Field><Field label="Max Output"><input type="number" min="0" value={providerDraft.maxOutput} onChange={(event) => updateProviderDraft('maxOutput', event.target.value)} className="settings-input" /></Field></div>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="RPM"><input type="number" min="0" value={providerDraft.rpm} onChange={(event) => updateProviderDraft('rpm', event.target.value)} className="settings-input" /></Field><Field label="TPM"><input type="number" min="0" value={providerDraft.tpm} onChange={(event) => updateProviderDraft('tpm', event.target.value)} className="settings-input" /></Field></div>
            </div>
          </details>

          <div className="sticky bottom-0 flex flex-col gap-2 border-t border-[#E7E9EE] bg-white/95 pt-3 backdrop-blur sm:static sm:flex-row sm:items-center sm:border-0 sm:bg-transparent sm:pt-2">
            <PrimaryButton variant="light" className="min-h-11 w-full rounded-[10px] sm:w-auto" onClick={test} disabled={isSaving}>Test</PrimaryButton>
            <PrimaryButton className="min-h-11 w-full rounded-[10px] bg-[#5B5CE2] sm:w-auto" onClick={save} disabled={isSaving}>{isSaving ? '保存中...' : 'Save'}</PrimaryButton>
            <button className="min-h-11 w-full rounded-[10px] border border-[#E7E9EE] px-4 text-sm text-[#16181D] sm:w-auto" onClick={reset} disabled={isSaving}>Reset</button>
            {status ? <span className="text-center text-sm text-[#6B7280] sm:text-left">{status}</span> : null}
          </div>
        </div>
      </div>
      <div className="mt-5 rounded-[14px] border border-[#E7E9EE] bg-[#FAFBFC] p-4 sm:p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-xs font-medium tracking-[0.08em] text-[#5B5CE2]">AI Router</div>
            <h3 className="mt-1 text-[20px] font-semibold text-[#16181D]">Capability 默认模型调度</h3>
            <p className="mt-1 text-sm leading-6 text-[#6B7280]">页面只能请求 Capability，普通用户不会看到 Provider 或模型名称。</p>
          </div>
          <PrimaryButton className="min-h-11 rounded-[10px] bg-[#5B5CE2]" onClick={saveRouter}>保存 Router</PrimaryButton>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {Object.keys(defaultRoutePolicy).map((capability) => {
            const route = routerDraft?.routes?.[capability] || defaultRoutePolicy[capability];
            const selected = providerConfigs.find((provider) => provider.id === route.providerId);
            const enabled = Boolean(selected?.enabled && selected?.apiKeyConfigured);
            return (
              <div key={capability} className="rounded-[12px] border border-[#E7E9EE] bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#16181D]">{capabilityLabels[capability] || capability}</div>
                    <div className="mt-1 text-xs text-[#6B7280]">{capability}</div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${enabled ? 'bg-[#EAF6F0] text-[#1F8A5B]' : 'bg-[#F0F1F4] text-[#6B7280]'}`}>{enabled ? '已启用' : '未启用'}</span>
                </div>
                <select className="settings-input mt-3" value={route.providerId} onChange={(event) => updateRouterRoute(capability, event.target.value)}>
                  {providerConfigs.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.displayName}{provider.enabled && provider.apiKeyConfigured ? '' : '（未启用）'}</option>)}
                </select>
                <select className="settings-input mt-2" value={route.model || selected?.defaultModel || ''} onChange={(event) => updateRouterModel(capability, event.target.value)}>
                  {getProviderModelOptions(route.providerId, route.model || selected?.defaultModel || '').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <div className="mt-2 text-xs leading-5 text-[#6B7280]">默认：{selected?.name || route.providerId} · {route.model || selected?.defaultModel || '未配置'}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-5 rounded-[14px] border border-[#E7E9EE] bg-[#FAFBFC] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium tracking-[0.08em] text-[#5B5CE2]">Invocation Trace</div>
            <h3 className="mt-1 text-[20px] font-semibold text-[#16181D]">最近 AI 调用</h3>
            <p className="mt-1 text-sm leading-6 text-[#6B7280]">仅管理员可见，不记录 API Key、完整用户原文或文件内容。</p>
          </div>
          <button type="button" className="min-h-11 rounded-[10px] border border-[#E7E9EE] bg-white px-3 text-sm text-[#16181D]" onClick={refreshInvocations}>刷新</button>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[760px] w-full text-left text-xs text-[#6B7280]">
            <thead><tr className="border-b border-[#E7E9EE]"><th className="px-2 py-2 font-medium">时间</th><th className="px-2 py-2 font-medium">任务</th><th className="px-2 py-2 font-medium">Provider</th><th className="px-2 py-2 font-medium">Model</th><th className="px-2 py-2 font-medium">耗时</th><th className="px-2 py-2 font-medium">结果</th><th className="px-2 py-2 font-medium">回退</th></tr></thead>
            <tbody>
              {recentInvocations?.length ? recentInvocations.map((trace, index) => (
                <tr key={`${trace.requestId}-${trace.providerId}-${index}`} className="border-b border-[#E7E9EE]/70 bg-white/70">
                  <td className="px-2 py-2">{new Date(trace.createdAt).toLocaleString('zh-CN')}</td><td className="px-2 py-2">{trace.taskType || trace.capability}</td><td className="px-2 py-2">{trace.providerId}</td><td className="px-2 py-2">{trace.modelId}</td><td className="px-2 py-2">{trace.durationMs} ms</td><td className="px-2 py-2">{trace.success ? '成功' : trace.errorCode || '失败'}</td><td className="px-2 py-2">{trace.fallbackFrom || trace.fallbackTo ? `${trace.fallbackFrom || '-'} → ${trace.fallbackTo || '-'}` : '无'}</td>
                </tr>
              )) : <tr><td colSpan="7" className="px-2 py-5 text-center">暂无真实 AI 调用记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {pendingProviderId ? <div className="fixed inset-0 z-50 grid place-items-center bg-[#16181D]/25 p-4"><div className="w-full max-w-sm rounded-[18px] bg-white p-5 shadow-[0_20px_60px_rgba(22,24,29,0.18)]"><div className="text-base font-semibold text-[#16181D]">当前配置尚未保存</div><p className="mt-2 text-sm leading-6 text-[#6B7280]">切换 Provider 前如何处理当前修改？</p><div className="mt-5 grid gap-2"><button className="min-h-11 rounded-[10px] bg-[#5B5CE2] px-4 text-sm font-medium text-white" onClick={async () => { await save(); commitProviderSelection(pendingProviderId); }}>保存修改并切换</button><button className="min-h-11 rounded-[10px] border border-[#E7E9EE] px-4 text-sm text-[#16181D]" onClick={() => commitProviderSelection(pendingProviderId)}>放弃修改并切换</button><button className="min-h-11 rounded-[10px] px-4 text-sm text-[#6B7280]" onClick={cancelProviderSelection}>取消</button></div></div></div> : null}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <label className="mb-5 block">
      <div className="mb-2 text-sm font-semibold text-[#4d473f]">{label}</div>
      {children}
    </label>
  );
}

export default SettingsPage;

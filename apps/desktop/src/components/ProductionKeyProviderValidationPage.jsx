import { useCallback, useEffect, useRef, useState } from 'react';
import { createBrowserSafariValidationHarness } from '../lib/browserSafariValidationHarness.js';
import { createIndexedDbKeyStorage } from '../lib/browserKeyStore.js';
import { mergeSafariLifecycleEvidence } from '../lib/browserSafariLifecycleEvidence.js';
import { copyRecoveryCredential } from '../lib/recoveryCredentialClipboard.js';
import {
  beginRecoveryGeneration,
  completeRecoveryGeneration,
  failRecoveryGeneration,
  recoveryGenerationButtonLabel
} from '../lib/recoveryCredentialInteraction.js';
import {
  isSafariValidationComplete,
  mergeSafariValidationEvidence,
  SAFARI_VALIDATION_EVIDENCE_FIELDS
} from '../lib/browserSafariValidationEvidence.js';
import { probeKeyProviderCapabilities } from '../lib/keyProviderCapabilityProbe.js';
import {
  getValidationPageOptions,
  isRecoveryCredentialFormatValid,
  normalizeRecoveryCredential,
  toValidationPageState
} from '../lib/keyProviderValidationPageState.js';
import { isPortableRecoveryCredentialFormat } from '../lib/portableRecoveryCredential.js';

const labels = {
  secureContext: 'HTTPS 安全上下文',
  webCryptoAesGcm: 'Web Crypto AES-GCM',
  nonExportableKeyHandle: '不可导出密钥句柄',
  indexedDb: 'IndexedDB 可用',
  persistentCryptoKey: 'CryptoKey 持久化',
  storageQuota: '存储配额可用',
  persistentStorage: '持久化存储状态',
  pageRefreshRecovery: '页面刷新后恢复',
  browserRestartRecovery: '浏览器重启后恢复',
  deviceRestartRecovery: '设备重启后恢复',
  platformUserVerification: '平台用户验证/设备解锁',
  recoveryKeyWrapping: '恢复密钥包装',
  privateBrowsingSafe: '私密模式安全可判定',
  failClosedWhenStorageUnavailable: '存储不可用时 fail-closed'
};

const manualEvidenceLabels = {
  deviceUnlockVerified: '我已锁屏、解锁并重新解密合成记录',
  logoutLoginVerified: '我已退出登录、重新登录并重新解密合成记录',
  wrongAccountRejected: '我已确认错误账号无法读取',
  siteDataCleared: '我已清除网站数据并确认原设备不能直接读取',
  privateModeBlocked: '我已在私密浏览模式确认功能阻断且无明文降级'
};

function CapabilityRow({ name, supported, errorCode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-200 py-3 last:border-b-0">
      <span className="text-sm text-slate-700">{labels[name] || name}</span>
      <span className="text-right text-xs">
        <span className={supported ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700'}>{supported ? '支持' : '阻断'}</span>
        {errorCode ? <span className="ml-2 text-slate-500">{errorCode}</span> : null}
      </span>
    </div>
  );
}
function newPageLoadMarker() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `page-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function navigationType() {
  return globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type || 'navigate';
}

function verdictClass(verdict) {
  if (verdict === 'PRODUCTION_KEYPROVIDER_VALIDATED') return 'text-emerald-700';
  if (verdict === 'TEST_ENV_CAPABILITY_UNAVAILABLE') return 'text-slate-700';
  if (verdict === 'BROWSER_CAPABILITIES_READY_PENDING_MANUAL_VALIDATION') return 'text-amber-700';
  return 'text-rose-700';
}

export default function ProductionKeyProviderValidationPage({ secondDeviceRecovery = false } = {}) {
  const storageRef = useRef(null);
  const harnessRef = useRef(null);
  const recoveryCredentialRef = useRef(null);
  const recoveryGenerationLockRef = useRef(false);
  const queryPage = typeof window === 'undefined'
    ? { secondDeviceRecovery: false }
    : getValidationPageOptions(window.location.search, import.meta.env);
  const isSecondDeviceRecovery = secondDeviceRecovery === true || queryPage.secondDeviceRecovery === true;
  const [probe, setProbe] = useState(null);
  const [running, setRunning] = useState(false);
  const [recoveryCredentialInput, setRecoveryCredentialInput] = useState('');
  const [showRecoveryCredential, setShowRecoveryCredential] = useState(false);
  const [validation, setValidation] = useState({
    evidence: {},
    fixture: null,
    recoveryPackage: null,
    recoverySecret: '',
    portableRecoveryCredential: '',
    recoveryResult: null,
    revokeResult: null,
    recoveryGeneration: { status: 'idle', errorCode: '' },
    copyStatus: { status: 'idle', errorCode: '' },
    busy: false,
    error: ''
  });

  const runProbe = useCallback(async () => {
    setRunning(true);
    try {
      const storageProbe = storageRef.current || (storageRef.current = createIndexedDbKeyStorage());
      let lifecycleEvidence = {};
      let validationEvidence = {};
      try {
        const existing = await storageProbe.getLifecycleEvidence();
        const next = mergeSafariLifecycleEvidence({
          existing,
          navigationType: navigationType(),
          pageLoadMarker: newPageLoadMarker()
        });
        await storageProbe.setLifecycleEvidence(next);
        lifecycleEvidence = next;
      } catch {
        lifecycleEvidence = {};
      }
      try {
        validationEvidence = await storageProbe.getSafariValidationEvidence();
      } catch {
        validationEvidence = {};
      }
      const result = await probeKeyProviderCapabilities({
        storageProbe,
        lifecycleEvidence,
        realSafariEvidence: { validated: isSafariValidationComplete(validationEvidence) }
      });
      if (
        result.capabilities?.webCryptoAesGcm &&
        result.capabilities?.nonExportableKeyHandle &&
        result.capabilities?.indexedDb
      ) {
        if (!harnessRef.current) {
          harnessRef.current = createBrowserSafariValidationHarness({
            cryptoImpl: globalThis.crypto,
            storage: storageProbe,
            capabilities: result
          });
        }
      } else {
        harnessRef.current = null;
      }
      setValidation((current) => ({ ...current, evidence: validationEvidence, error: '' }));
      setProbe(result);
    } catch (error) {
      harnessRef.current = null;
      setProbe({ errorCode: error?.code || 'PROBE_FAILED' });
      setValidation((current) => ({ ...current, error: error?.code || 'PROBE_FAILED' }));
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    runProbe();
  }, [runProbe]);

  const updateEvidence = useCallback(async (updates) => {
    const harness = harnessRef.current;
    if (!harness) throw new Error('VALIDATION_HARNESS_UNAVAILABLE');
    const existing = await harness.getValidationEvidence();
    const next = mergeSafariValidationEvidence({ existing, updates });
    await harness.setValidationEvidence(next);
    setValidation((current) => ({ ...current, evidence: next, error: '' }));
    return next;
  }, []);

  const runHarnessAction = useCallback(async (action) => {
    const harness = harnessRef.current;
    if (!harness) {
      setValidation((current) => ({ ...current, error: 'VALIDATION_HARNESS_UNAVAILABLE' }));
      return null;
    }
    setValidation((current) => ({ ...current, busy: true, error: '' }));
    try {
      return await action(harness);
    } catch (error) {
      setValidation((current) => ({ ...current, error: error?.code || 'VALIDATION_ACTION_FAILED' }));
      return null;
    } finally {
      setValidation((current) => ({ ...current, busy: false }));
    }
  }, []);

  const verifyFixture = async () => {
    const result = await runHarnessAction((harness) => harness.verifySyntheticFixture());
    if (!result) return;
    await updateEvidence({ syntheticFixtureVerified: true });
    setValidation((current) => ({ ...current, fixture: result }));
    await runProbe();
  };

  const createRecovery = async () => {
    if (recoveryGenerationLockRef.current) return;
    const transition = beginRecoveryGeneration(validation.recoveryGeneration);
    if (!transition.accepted) return;
    const harness = harnessRef.current;
    if (!harness) {
      setValidation((current) => ({
        ...current,
        recoveryGeneration: failRecoveryGeneration(transition.state, 'VALIDATION_HARNESS_UNAVAILABLE'),
        error: 'VALIDATION_HARNESS_UNAVAILABLE'
      }));
      return;
    }
    recoveryGenerationLockRef.current = true;
    setValidation((current) => ({ ...current, recoveryGeneration: transition.state, copyStatus: { status: 'idle', errorCode: '' }, error: '' }));
    setValidation((current) => ({ ...current, busy: true }));
    try {
      const result = await harness.createRecoveryCredential();
      recoveryCredentialRef.current = result;
      setValidation((current) => ({
        ...current,
        recoveryPackage: result.package,
        recoverySecret: result.recoverySecret,
        recoveryGeneration: completeRecoveryGeneration(transition.state),
        recoveryResult: '已生成；恢复凭据只在当前页面展示，不写入存储或网络',
        error: ''
      }));
    } catch (error) {
      const errorCode = error?.code || 'RECOVERY_GENERATION_FAILED';
      setValidation((current) => ({
        ...current,
        recoveryGeneration: failRecoveryGeneration(transition.state, errorCode),
        error: errorCode
      }));
    } finally {
      recoveryGenerationLockRef.current = false;
      setValidation((current) => ({ ...current, busy: false }));
    }
  };

  const copyRecovery = async () => {
    const secret = recoveryCredentialRef.current?.recoverySecret || validation.recoverySecret;
    const result = await copyRecoveryCredential({ secret, clipboard: globalThis.navigator?.clipboard });
    setValidation((current) => ({
      ...current,
      copyStatus: { status: result.ok ? 'copied' : 'failed', errorCode: result.errorCode || '' }
    }));
  };

  const createPortableRecovery = async () => {
    const result = await runHarnessAction((harness) => harness.createPortableRecoveryCredential());
    if (!result) return;
    setValidation((current) => ({
      ...current,
      portableRecoveryCredential: result.credential,
      recoveryResult: '已升级为可携式恢复凭据；旧凭据未覆盖，密钥未轮换',
      error: ''
    }));
  };

  const copyPortableRecovery = async () => {
    const result = await copyRecoveryCredential({ secret: validation.portableRecoveryCredential, clipboard: globalThis.navigator?.clipboard });
    setValidation((current) => ({
      ...current,
      copyStatus: { status: result.ok ? 'copied' : 'failed', errorCode: result.errorCode || '' }
    }));
  };

  const restoreRecovery = async () => {
    const enteredRecoveryCredential = normalizeRecoveryCredential(recoveryCredentialInput);
    if (isSecondDeviceRecovery && !isPortableRecoveryCredentialFormat(enteredRecoveryCredential)) {
      setValidation((current) => ({
        ...current,
        error: enteredRecoveryCredential.length === 43 ? 'EXISTING_CREDENTIAL_NOT_PORTABLE' : 'RECOVERY_CREDENTIAL_FORMAT_INVALID'
      }));
      return;
    }
    if (isSecondDeviceRecovery) {
      const result = await runHarnessAction((harness) => harness.restoreWithRecovery({ credential: enteredRecoveryCredential }));
      if (!result) return;
      await updateEvidence({ recoveryVerified: true, secondDeviceRecovery: result.deviceChanged === true });
      setValidation((current) => ({ ...current, recoveryResult: result }));
      setRecoveryCredentialInput('');
      await runProbe();
      return;
    }
    const credential = recoveryCredentialRef.current || {
      package: validation.recoveryPackage,
      recoverySecret: validation.recoverySecret
    };
    if (!credential.package || !credential.recoverySecret) {
      setValidation((current) => ({
        ...current,
        error: isSecondDeviceRecovery ? 'RECOVERY_PACKAGE_NOT_AVAILABLE_IN_THIS_PAGE' : 'RECOVERY_CREDENTIAL_NOT_READY'
      }));
      return;
    }
    const result = await runHarnessAction((harness) => harness.restoreWithRecovery({
      package: credential.package,
      recoverySecret: credential.recoverySecret
    }));
    if (!result) return;
    await updateEvidence({ recoveryVerified: true, secondDeviceRecovery: result.deviceChanged === true });
    setValidation((current) => ({ ...current, recoveryResult: result }));
    await runProbe();
  };

  const revokeOldDevice = async () => {
    const result = await runHarnessAction((harness) => harness.revokeOldDevice());
    if (!result) return;
    if (result.oldDeviceReadable !== false) {
      setValidation((current) => ({ ...current, error: 'OLD_DEVICE_REVOCATION_FAILED', revokeResult: result }));
      return;
    }
    await updateEvidence({ oldDeviceRevoked: true });
    setValidation((current) => ({ ...current, revokeResult: result }));
    await runProbe();
  };

  const confirmManualStep = async (field) => {
    try {
      await updateEvidence({ [field]: true });
      await runProbe();
    } catch (error) {
      setValidation((current) => ({ ...current, error: error?.code || 'VALIDATION_EVIDENCE_FAILED' }));
    }
  };

  const state = toValidationPageState(probe);
  const capabilities = Object.entries(state.capabilities || {});
  const evidence = validation.evidence || {};
  const hasHarness = Boolean(harnessRef.current);
  const recoveryCredentialFormatValid = isSecondDeviceRecovery
    ? isPortableRecoveryCredentialFormat(recoveryCredentialInput)
    : isRecoveryCredentialFormatValid(recoveryCredentialInput);

  return (
    <main className="min-h-dvh bg-slate-50 px-4 py-8 text-slate-900">
      <div className="mx-auto max-w-2xl space-y-5">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">AI分身 · 临时验证页</p>
          {isSecondDeviceRecovery ? <p className="mt-2 inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold tracking-[0.12em] text-indigo-700" data-testid="validation-mode">当前模式：SECOND_DEVICE_RECOVERY</p> : null}
          <h1 className="mt-2 text-2xl font-semibold">ProductionKeyProvider 能力验证</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">此页面只验证合成数据、浏览器能力和设备恢复链路；不会显示会议数据。密钥、密文正文和恢复凭据不会进入日志、网络或持久化记录。</p>
        </header>

        {isSecondDeviceRecovery ? (
          <section className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm" aria-labelledby="second-device-recovery-title">
            <h2 id="second-device-recovery-title" className="text-base font-semibold">第二设备恢复</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">此入口不依赖原设备的 IndexedDB、sessionStorage 或内存状态。恢复凭据只在本页内存中使用，刷新后自动清空。</p>
            <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="recovery-credential-input">粘贴一次性恢复凭据</label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id="recovery-credential-input"
                data-testid="recovery-credential-input"
                className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 text-sm"
                type={showRecoveryCredential ? 'text' : 'password'}
                value={recoveryCredentialInput}
                onChange={(event) => setRecoveryCredentialInput(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                inputMode="text"
                placeholder="粘贴或手动输入"
                aria-describedby="recovery-credential-status"
              />
              <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-medium" onClick={() => setShowRecoveryCredential((current) => !current)}>{showRecoveryCredential ? '隐藏' : '显示'}</button>
            </div>
            <div id="recovery-credential-status" className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2" aria-live="polite">
              <span>credentialPresent：{recoveryCredentialInput ? 'true' : 'false'}</span>
              <span>credentialFormatValid：{recoveryCredentialFormatValid ? 'true' : 'false'}</span>
            </div>
            {!recoveryCredentialInput ? <p className="mt-2 text-xs text-slate-500">请输入已保存的恢复凭据后继续。</p> : null}
            {recoveryCredentialInput && !recoveryCredentialFormatValid ? <p className="mt-2 text-xs text-rose-700">恢复凭据格式无效，请检查是否完整粘贴。</p> : null}
            <button
              type="button"
              className="mt-4 min-h-11 rounded-xl bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-50"
              onClick={restoreRecovery}
              disabled={!recoveryCredentialFormatValid || validation.busy}
              data-testid="second-device-recovery-button"
            >
              {validation.busy ? '恢复中…' : '在新设备恢复'}
            </button>
            {isSecondDeviceRecovery && validation.recoveryResult?.recoveryRewrapVerified ? (
              <div className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800" data-testid="portable-recovery-verdicts" aria-live="polite">
                <div>RECOVERY_REWRAP_VERIFIED</div>
                {validation.recoveryResult.syntheticFixtureDecrypted ? <div>SYNTHETIC_RECORD_DECRYPTED</div> : null}
                {validation.recoveryResult.plaintextDigestMatch ? <div>PLAINTEXT_DIGEST_MATCH</div> : null}
                {validation.recoveryResult.syntheticFixtureDecrypted && validation.recoveryResult.plaintextDigestMatch ? <div className="mt-2 font-semibold">MAC_SAFARI_SECOND_DEVICE_RECOVERY_READY</div> : null}
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs text-slate-500">结论</div>
              <div className={`mt-1 text-lg font-semibold ${verdictClass(state.verdict)}`}>{state.verdict || '检测中'}</div>
            </div>
            <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-medium" onClick={runProbe} disabled={running}>{running ? '检测中…' : '重新检测'}</button>
          </div>
          {state.probeVersion ? <div className="mt-4 text-xs text-slate-500">Probe：{state.probeVersion}</div> : null}
          {validation.error ? <p className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">验证操作失败：{validation.error}</p> : null}
        </section>

        {state.runtime ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold">运行环境</h2>
            <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
              {Object.entries(state.runtime).map(([name, value]) => <div key={name}><dt className="text-slate-400">{name}</dt><dd>{String(value)}</dd></div>)}
            </dl>
          </section>
        ) : null}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold">能力矩阵</h2>
          {state.status === 'loading' ? <p className="mt-3 text-sm text-slate-500">正在检测浏览器能力…</p> : null}
          {state.status === 'error' ? <p className="mt-3 text-sm text-rose-700">检测失败：{state.errorCodes.probe}</p> : null}
          <div className="mt-2">{capabilities.map(([name, supported]) => <CapabilityRow key={name} name={name} supported={supported} errorCode={state.errorCodes?.[name]} />)}</div>
          {state.assessment === 'BROWSER_CAPABILITIES_READY_PENDING_MANUAL_VALIDATION' ? <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">浏览器能力已具备，但仍需完成真实 iPhone Safari 的刷新、退出、锁屏、重启、恢复和撤销验收。</p> : null}
          {state.assessment === 'TEST_ENV_CAPABILITY_UNAVAILABLE' ? <p className="mt-4 rounded-xl bg-slate-100 p-3 text-sm text-slate-700">当前是自动测试环境；缺少真实浏览器能力不能作为 Safari 平台阻断结论。</p> : null}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">合成数据与恢复链路</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">仅使用固定合成记录。先完成原设备加密，再在第二设备/独立 Safari 环境恢复，最后撤销旧设备。</p>
            </div>
            <span className={`text-xs font-semibold ${hasHarness ? 'text-emerald-700' : 'text-slate-500'}`}>{hasHarness ? '可验证' : '等待浏览器能力'}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {!isSecondDeviceRecovery ? <button type="button" className="min-h-11 rounded-xl bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-50" onClick={verifyFixture} disabled={!hasHarness || validation.busy}>写入/解密合成记录</button> : null}
            {!isSecondDeviceRecovery ? <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-medium disabled:opacity-50" onClick={createRecovery} disabled={!hasHarness || validation.busy || validation.recoveryGeneration.status === 'generated'}>{recoveryGenerationButtonLabel(validation.recoveryGeneration.status)}</button> : null}
            {!isSecondDeviceRecovery && validation.recoveryGeneration.status === 'generated' && !validation.portableRecoveryCredential ? <button type="button" className="min-h-11 rounded-xl border border-indigo-300 px-4 text-sm font-medium text-indigo-700 disabled:opacity-50" onClick={createPortableRecovery} disabled={!hasHarness || !validation.recoveryPackage || !validation.recoverySecret || validation.busy}>升级为可携式恢复凭据</button> : null}
            {!isSecondDeviceRecovery ? <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-medium disabled:opacity-50" onClick={restoreRecovery} disabled={(!validation.recoveryPackage && !recoveryCredentialRef.current) || validation.busy}>在新设备恢复</button> : null}
            {!isSecondDeviceRecovery ? <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-medium disabled:opacity-50" onClick={revokeOldDevice} disabled={!validation.recoveryResult || validation.busy}>撤销旧设备</button> : null}
          </div>
          {validation.recoveryGeneration.status === 'generating' ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800" aria-live="polite">正在生成恢复凭据，请保持页面打开…</p> : null}
          {validation.recoveryGeneration.status === 'failed' ? <p className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700" aria-live="polite">恢复凭据生成失败：{validation.recoveryGeneration.errorCode}。可以重试。</p> : null}
          {validation.fixture ? <p className="mt-3 text-xs text-slate-600">合成记录：{validation.fixture.action === 'created' ? '已加密写入' : '已成功解密'}。</p> : null}
          {validation.recoverySecret ? <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><div className="flex flex-wrap items-center justify-between gap-2"><div className="font-semibold">恢复凭据（只展示本次，立即安全保存）</div><button type="button" aria-label="复制旧版恢复凭据" className="min-h-10 rounded-lg border border-amber-700 px-3 text-xs font-semibold text-amber-900" onClick={copyRecovery}>复制</button></div><code className="mt-2 block select-text break-all text-xs" aria-label="恢复凭据，可长按复制">{validation.recoverySecret}</code>{validation.copyStatus.status === 'copied' ? <p className="mt-2 text-xs text-emerald-700" aria-live="polite">已复制。</p> : null}{validation.copyStatus.status === 'failed' ? <p className="mt-2 text-xs text-amber-800" aria-live="polite">复制失败（{validation.copyStatus.errorCode}）。请长按上方凭据手动复制。</p> : null}</div> : null}
          {validation.recoverySecret && !validation.portableRecoveryCredential ? <p className="mt-3 rounded-xl bg-indigo-50 p-3 text-xs leading-5 text-indigo-800">当前旧凭据只含secret，不能跨设备恢复。请在本页明确点击“升级为可携式恢复凭据”；不会覆盖旧凭据或轮换密钥。</p> : null}
          {validation.portableRecoveryCredential ? <div className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900"><div className="flex flex-wrap items-center justify-between gap-2"><div className="font-semibold">可携式恢复凭据（只展示本次，立即安全保存）</div><button type="button" aria-label="复制可携式mrc1恢复凭据" className="min-h-10 rounded-lg border border-emerald-700 px-3 text-xs font-semibold text-emerald-900" onClick={copyPortableRecovery}>复制</button></div><code className="mt-2 block select-text break-all text-xs" aria-label="可携式恢复凭据，可长按复制">{validation.portableRecoveryCredential}</code>{validation.copyStatus.status === 'copied' ? <p className="mt-2 text-xs text-emerald-700" aria-live="polite">已复制。</p> : null}{validation.copyStatus.status === 'failed' ? <p className="mt-2 text-xs text-amber-800" aria-live="polite">复制失败（{validation.copyStatus.errorCode}）。请长按上方凭据手动复制。</p> : null}</div> : null}
          {validation.recoveryResult ? <p className="mt-3 text-xs text-slate-600">恢复结果：{typeof validation.recoveryResult === 'string' ? validation.recoveryResult : `keyVersion=${validation.recoveryResult.keyVersion}，新设备=${validation.recoveryResult.deviceChanged ? '是' : '否'}${validation.recoveryResult.syntheticFixtureDecrypted ? '，合成记录=已成功解密' : ''}`}。</p> : null}
          {validation.revokeResult ? <p className="mt-3 text-xs text-slate-600">旧设备读取：{validation.revokeResult.oldDeviceReadable === false ? '已拒绝' : '仍可读取，不能通过'}</p> : null}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold">真实 Safari 人工步骤</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">只有你实际完成对应动作后才点击确认。页面只保存完成标记，不保存秘密。</p>
          <div className="mt-3 space-y-2">
            {SAFARI_VALIDATION_EVIDENCE_FIELDS.filter((field) => manualEvidenceLabels[field]).map((field) => (
              <button key={field} type="button" className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 text-left text-sm disabled:opacity-50" onClick={() => confirmManualStep(field)} disabled={!hasHarness || evidence[field] === true || validation.busy}>
                <span>{manualEvidenceLabels[field]}</span>
                <span className={evidence[field] === true ? 'text-emerald-700' : 'text-slate-400'}>{evidence[field] === true ? '已确认' : '待确认'}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">
            <div>刷新证据：{state.capabilities?.pageRefreshRecovery ? '已通过' : '请刷新此页后重新检测'}</div>
            <div>浏览器彻底关闭后恢复：{state.capabilities?.browserRestartRecovery ? '已通过' : '完成后重新打开并重新检测'}</div>
            <div>重启设备后恢复：{state.capabilities?.deviceRestartRecovery ? '已通过' : '完成后重新打开并重新检测'}</div>
          </div>
          {isSafariValidationComplete(evidence) && state.capabilitiesReady ? <p className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">人工步骤已全部确认；若能力矩阵全部通过，Probe 才会给出 VALIDATED。</p> : null}
        </section>
      </div>
    </main>
  );
}

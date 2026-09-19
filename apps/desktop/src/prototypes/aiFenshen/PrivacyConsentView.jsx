import { useRef, useState } from 'react';
import AIFenshenWordmark from './AIFenshenWordmark.jsx';

export default function PrivacyConsentView({ notice, onAccept }) {
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submitLockedRef = useRef(false);

  const submit = async () => {
    if (!accepted || submitting || submitLockedRef.current) return;
    submitLockedRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      await onAccept({
        privacyNoticeVersion: notice.privacyNoticeVersion,
        termsVersion: notice.termsVersion,
        locale: notice.locale,
        source: 'first_login'
      });
    } catch (caught) {
      setError(caught?.message || '同意状态暂时无法保存，请稍后重试。');
      setSubmitting(false);
      submitLockedRef.current = false;
    }
  };

  return (
    <main className="af-privacy-consent" data-testid="privacy-consent-view">
      <header><AIFenshenWordmark size="small" subtitle /><span>封闭测试隐私说明</span></header>
      <section className="af-privacy-card">
        <div className="af-privacy-scroll" data-testid="privacy-consent-scroll">
          <h1>开始使用前，请先了解数据如何处理</h1>
          <p className="af-privacy-lead">服务仍处于封闭测试阶段。账号和业务数据存储在受控 VPS。</p>
          <ul>
            <li>{notice.providerProcessing || '必要的用户输入会发送给已启用的大模型 Provider 处理。'}</li>
            <li>Conversation 用于连续对话；Memory 用于长期事实；Finance 用于收支和汇总；Calendar 使用生日与日期证据。</li>
            {notice.attachmentProcessing ? <li>{notice.attachmentProcessing}</li> : null}
            {notice.attachmentRetention ? <li>{notice.attachmentRetention}</li> : null}
            {notice.attachmentRights ? <li>{notice.attachmentRights}</li> : null}
            {notice.attachmentLimitations ? <li>{notice.attachmentLimitations}</li> : null}
            <li>{notice.retention}</li>
            <li>{notice.userRights}</li>
            <li>{notice.testDataWarning}</li>
          </ul>
          <p className="af-privacy-warning">请勿输入密码、API Key、身份证件、银行卡等高敏感数据。</p>
          <p className="af-privacy-contact">联系和反馈：{notice.contact}</p>
        </div>
        <footer className="af-privacy-actions" data-testid="privacy-consent-actions">
          <label className="af-privacy-check">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>我已阅读并明确同意当前版本的隐私说明和测试条款</span>
          </label>
          {error ? <p className="af-real-login-error" role="alert">{error}</p> : null}
          <button type="button" className="af-auth-primary" onClick={submit} disabled={!accepted || submitting}>
            {submitting ? '正在保存…' : '同意并继续'}
          </button>
        </footer>
      </section>
    </main>
  );
}

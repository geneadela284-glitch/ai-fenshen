import { useState } from 'react';
import * as m from 'motion/react-m';
import AIFenshenWordmark from './AIFenshenWordmark.jsx';

export default function RealAccountLogin({ onLogin, initialError = '' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (submitting || !username.trim() || !password) return;
    setError('');
    setSubmitting(true);
    try {
      await onLogin(username, password);
    } catch (caught) {
      setError(caught?.message || '用户名或密码错误。');
      setSubmitting(false);
    }
  };

  return (
    <main className="af-login is-login-real" data-testid="login-view" data-login-screen-state="real-account">
      <div className="af-status-safe" aria-hidden="true"><span>9:41</span></div>
      <header className="af-login-brand"><AIFenshenWordmark size="large" subtitle /></header>
      <div className="af-avatar-art" aria-hidden="true" />
      <section className="af-login-controls is-credentials">
        <m.section className="af-credential-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <form className="af-real-login-form" onSubmit={submit}>
            <div className="af-real-login-heading">
              <strong>使用现有账号登录</strong>
              <small>登录后进入你的AI分身</small>
            </div>
            <label className="af-auth-field-single">
              <span>用户名</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" aria-label="用户名" />
            </label>
            <label className="af-auth-field-single">
              <span>密码</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" aria-label="密码" />
            </label>
            {error ? <p className="af-real-login-error" role="alert">{error}</p> : null}
            <m.button type="submit" className="af-auth-primary" whileTap={{ scale: 0.98 }} disabled={submitting || !username.trim() || !password}>
              {submitting ? '登录中…' : '登录'}
            </m.button>
          </form>
        </m.section>
        <p className="af-policy">登录后请阅读并明确同意当前《隐私说明》与《测试条款》</p>
      </section>
    </main>
  );
}

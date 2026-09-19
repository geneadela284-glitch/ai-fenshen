import { useState } from 'react';
import AISecretaryLogo from './AISecretaryLogo.jsx';

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    setStatus('');
    setSubmitting(true);
    try {
      await onLogin(username, password);
    } catch (error) {
      setStatus(error.message || '用户名或密码错误。');
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-dvh bg-[var(--bg-primary,#F7F9FC)] px-5 py-8 text-[var(--text-primary,#111827)]">
      <section className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[390px] flex-col justify-center">
        <div className="rounded-[24px] border border-[var(--border,#E6EAF2)] bg-[var(--surface,rgba(255,255,255,0.78))] p-6 shadow-[0_18px_60px_rgba(17,24,39,0.08)] backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <AISecretaryLogo size={46} />
            <div>
              <div className="text-[22px] font-semibold leading-tight">AI秘书</div>
              <div className="mt-1 text-sm text-[var(--text-secondary,#6B7280)]">Beta 内测</div>
            </div>
          </div>
          <form className="mt-7 space-y-4" onSubmit={submit}>
            <label className="block">
              <span className="text-sm font-medium text-[var(--text-secondary,#6B7280)]">用户名</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                className="mt-2 h-12 w-full rounded-[14px] border border-[var(--border,#E6EAF2)] bg-white/80 px-4 text-base outline-none transition focus:border-[var(--accent-primary,#4C7BFF)] focus:ring-4 focus:ring-[rgba(76,123,255,0.14)]"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-[var(--text-secondary,#6B7280)]">密码</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                className="mt-2 h-12 w-full rounded-[14px] border border-[var(--border,#E6EAF2)] bg-white/80 px-4 text-base outline-none transition focus:border-[var(--accent-primary,#4C7BFF)] focus:ring-4 focus:ring-[rgba(76,123,255,0.14)]"
              />
            </label>
            {status ? <div className="rounded-[12px] bg-red-50 px-3 py-2 text-sm text-red-600">{status}</div> : null}
            <button
              type="submit"
              disabled={submitting || !username.trim() || !password}
              className="h-12 w-full rounded-[14px] bg-[var(--accent-primary,#4C7BFF)] text-base font-semibold text-white shadow-[0_12px_30px_rgba(76,123,255,0.26)] transition disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? '登录中...' : '登录'}
            </button>
          </form>
          <p className="mt-5 text-sm leading-6 text-[var(--text-secondary,#6B7280)]">
            当前为封闭内测。请使用管理员创建的内测账号登录。
          </p>
        </div>
      </section>
    </main>
  );
}

export default LoginPage;

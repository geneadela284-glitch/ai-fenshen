import { useState } from 'react';
import * as m from 'motion/react-m';
import AIFenshenWordmark from './AIFenshenWordmark.jsx';
import CredentialsLoginCard from './CredentialsLoginCard.jsx';
import FaceLoginPanel from './FaceLoginPanel.jsx';
import Icon from './Icon.jsx';

const alternativeLogins = [
  { label: '手机号', icon: 'device-mobile' },
  { label: '邮箱', icon: 'mail' }
];

export default function LoginExperience({ loginState, loginScreenState, onFaceScan, onAlternative, onEnterHome, onEnrollFace, onSkipFace, feedback }) {
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const faceReady = loginScreenState === 'face_ready';

  return (
    <main className={`af-login is-login-${loginScreenState}`} data-testid="login-view" data-login-screen-state={loginScreenState}>
      <div className="af-status-safe" aria-hidden="true"><span>9:41</span></div>
      <header className="af-login-brand"><AIFenshenWordmark size="large" subtitle /></header>
      <div className="af-avatar-art" aria-hidden="true" />
      <section className={`af-login-controls ${faceReady ? 'is-face-ready' : 'is-credentials'}`}>
        {faceReady ? (
          <>
            <FaceLoginPanel loginState={loginState} onScan={onFaceScan} />
            <m.button type="button" className="af-face-one-tap" whileTap={{ scale: 0.98 }} onClick={onEnterHome}>一键登录</m.button>
            <button type="button" className="af-other-login-toggle" onClick={() => setAlternativesOpen((value) => !value)} aria-expanded={alternativesOpen}>其他登录方式</button>
            {alternativesOpen ? (
              <div className="af-other-logins is-compact">
                {alternativeLogins.map((item) => (
                  <button key={item.label} type="button" onClick={() => onAlternative(item.label)} aria-label={`${item.label}登录原型`}>
                    <Icon name={item.icon} size={20} /><span>{item.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <CredentialsLoginCard loginScreenState={loginScreenState} onEnterHome={onEnterHome} onEnrollFace={onEnrollFace} onSkipFace={onSkipFace} />
        )}
        {feedback ? <p className="af-login-feedback" role="status">{feedback}</p> : null}
        <p className="af-policy">登录即代表同意 <button type="button">《用户协议》</button> 与 <button type="button">《隐私政策》</button></p>
      </section>
    </main>
  );
}

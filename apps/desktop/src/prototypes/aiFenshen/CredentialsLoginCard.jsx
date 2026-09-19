import { useReducer } from 'react';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import FaceEnrollmentPrompt from './FaceEnrollmentPrompt.jsx';
import Icon from './Icon.jsx';
import { createCredentialFlowState, credentialFlowReducer, CREDENTIAL_FLOW_STEPS } from './credentialFlowState.js';

export default function CredentialsLoginCard({ loginScreenState, onEnterHome, onEnrollFace, onSkipFace }) {
  const [flow, dispatch] = useReducer(credentialFlowReducer, loginScreenState, createCredentialFlowState);
  const isPhone = flow.method !== 'email';
  const isRegister = flow.mode === 'register';

  const next = (event) => {
    event?.preventDefault();
    dispatch({ type: 'CONTINUE' });
  };

  const renderStep = () => {
    if (flow.step === CREDENTIAL_FLOW_STEPS.choice) {
      return (
        <div className="af-auth-choice" data-auth-step="choice">
          <p>{loginScreenState === 'unregistered' ? '开始使用你的专属AI数字分身' : '欢迎回来'}</p>
          <m.button type="button" className="af-auth-choice-primary" whileTap={{ scale: 0.98 }} onClick={() => dispatch({ type: 'CHOOSE_METHOD', method: 'phone' })}>
            <Icon name="device-mobile" size={20} />手机号继续
          </m.button>
          <m.button type="button" whileTap={{ scale: 0.98 }} onClick={() => dispatch({ type: 'CHOOSE_METHOD', method: 'email' })}>
            <Icon name="mail" size={20} />邮箱继续
          </m.button>
          {loginScreenState === 'unregistered' ? <button type="button" className="af-auth-text-button" onClick={() => dispatch({ type: 'CHOOSE_LOGIN' })}>已有账号登录</button> : null}
        </div>
      );
    }

    if (flow.step === CREDENTIAL_FLOW_STEPS.enrollment) {
      return <FaceEnrollmentPrompt onEnroll={onEnrollFace} onSkip={onSkipFace} />;
    }

    if (flow.step === CREDENTIAL_FLOW_STEPS.success) {
      return (
        <div className="af-auth-success" data-auth-step="success">
          <span className="af-auth-success-icon"><Icon name="check" size={24} /></span>
          <strong>{isRegister ? '注册成功' : '验证通过'}</strong>
          <small>已完成前端原型验证，不会创建真实账户。</small>
          <m.button type="button" className="af-auth-primary" whileTap={{ scale: 0.98 }} onClick={onEnterHome}>进入AI分身</m.button>
        </div>
      );
    }

    const copy = {
      [CREDENTIAL_FLOW_STEPS.identifier]: {
        title: isRegister ? `输入${isPhone ? '手机号' : '邮箱'}` : '登录已有账号',
        label: isPhone ? '手机号' : '邮箱',
        placeholder: isPhone ? '请输入手机号' : '请输入邮箱'
      },
      [CREDENTIAL_FLOW_STEPS.code]: { title: '输入验证码', label: '验证码', placeholder: '请输入 6 位验证码' },
      [CREDENTIAL_FLOW_STEPS.password]: { title: '设置登录密码', label: '密码', placeholder: '设置登录密码' }
    }[flow.step];

    return (
      <form className="af-auth-step" data-auth-step={flow.step} onSubmit={next}>
        <button type="button" className="af-auth-back" onClick={() => dispatch({ type: 'BACK' })} aria-label="返回上一步"><Icon name="arrow-left" size={18} /></button>
        <div>
          <strong>{copy.title}</strong>
          <small>{flow.step === CREDENTIAL_FLOW_STEPS.code ? `验证码已发送至你的${isPhone ? '手机' : '邮箱'}` : '每一步只处理一件事'}</small>
        </div>
        <label className="af-auth-field-single">
          <span>{copy.label}</span>
          <input
            autoFocus
            type={flow.step === CREDENTIAL_FLOW_STEPS.password ? 'password' : isPhone ? 'tel' : 'email'}
            inputMode={flow.step === CREDENTIAL_FLOW_STEPS.code || isPhone ? 'numeric' : 'email'}
            placeholder={copy.placeholder}
            autoComplete={flow.step === CREDENTIAL_FLOW_STEPS.code ? 'one-time-code' : flow.step === CREDENTIAL_FLOW_STEPS.password ? 'new-password' : isPhone ? 'tel' : 'email'}
          />
        </label>
        <m.button type="submit" className="af-auth-primary" whileTap={{ scale: 0.98 }}>
          {flow.step === CREDENTIAL_FLOW_STEPS.password ? '注册并进入' : '继续'}
        </m.button>
      </form>
    );
  };

  return (
    <m.section
      className="af-credential-card"
      data-testid="credential-login-card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: [0.22, 0.8, 0.22, 1] }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={flow.step} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.18 }}>
          {renderStep()}
        </m.div>
      </AnimatePresence>
    </m.section>
  );
}

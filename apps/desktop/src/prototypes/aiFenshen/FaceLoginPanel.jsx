import Icon from './Icon.jsx';

const stateCopy = {
  idle: ['人脸识别登录', '请正对屏幕'],
  scanning: ['识别中', '请保持正对屏幕'],
  success: ['验证通过', '正在进入你的AI分身'],
  failure: ['未识别到人脸', '请调整位置后重试']
};

export default function FaceLoginPanel({ loginState, onScan }) {
  const [title, description] = stateCopy[loginState] || stateCopy.idle;
  const reducedMotion = useReducedMotion();

  return (
    <m.button
      type="button"
      className={`af-face-login is-${loginState}`}
      onClick={onScan}
      whileTap={{ scale: reducedMotion ? 0.99 : 0.975 }}
      animate={loginState === 'scanning' && !reducedMotion ? { scale: [1, 1.012, 1] } : { scale: 1 }}
      transition={loginState === 'scanning' && !reducedMotion ? { duration: 1.5, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.14 }}
      aria-label={loginState === 'scanning' ? '正在识别人脸，再次点击可模拟失败' : '开始人脸识别登录'}
      aria-live="polite"
    >
      <span className="af-face-scan-frame" aria-hidden="true">
        <Icon name={loginState === 'success' ? 'check' : 'scan'} size={32} />
        <span className="af-scan-line" />
      </span>
      <span className="af-face-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </m.button>
  );
}
import { useReducedMotion } from 'motion/react';
import * as m from 'motion/react-m';

import * as m from 'motion/react-m';

export default function FaceEnrollmentPrompt({ onEnroll, onSkip }) {
  return (
    <aside className="af-face-enrollment" aria-label="人脸识别开通引导">
      <div>
        <strong>开启人脸识别，更快登录</strong>
        <p>录入后下次可直接刷脸进入 AI分身</p>
      </div>
      <div className="af-face-enrollment-actions">
        <m.button type="button" whileTap={{ scale: 0.97 }} onClick={onEnroll}>立即录入</m.button>
        <button type="button" onClick={onSkip}>暂不设置</button>
      </div>
    </aside>
  );
}

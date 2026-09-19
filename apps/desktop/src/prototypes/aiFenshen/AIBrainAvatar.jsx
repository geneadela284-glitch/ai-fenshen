import BrainFunctionRing from './BrainFunctionRing.jsx';
import Icon from './Icon.jsx';

export default function AIBrainAvatar({ open, onToggle, onSelect, reducedMotion }) {
  return (
    <div className={`af-brain-avatar ${open ? 'is-open' : ''}`}>
      <m.button
        type="button"
        className="af-brain-hotspot"
        onClick={onToggle}
        whileTap={{ scale: reducedMotion ? 0.98 : 0.94 }}
        aria-expanded={open}
        aria-label={open ? '收起AI分身大脑功能' : '展开AI分身大脑功能'}
      >
        <span className="af-brain-pulse" aria-hidden="true" />
        <span className="af-brain-core">
          <Icon className="af-brain-icon" name="brain" size={25} />
          <span className="af-brain-label">AI大脑</span>
        </span>
      </m.button>
      <BrainFunctionRing open={open} onSelect={onSelect} reducedMotion={reducedMotion} />
    </div>
  );
}
import * as m from 'motion/react-m';

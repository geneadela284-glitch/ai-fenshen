import * as m from 'motion/react-m';
import Icon from './Icon.jsx';
import { FEATURE_REGISTRY } from './featureRegistry.js';

export const BRAIN_FUNCTION_ORBIT_ANGLES = [217, 245, 272, 184, 152, 120, 88];

export default function BrainFunctionRing({ open, onSelect, reducedMotion = false }) {
  return (
    <m.div className={`af-brain-ring ${open ? 'is-open' : ''}`} data-testid="brain-ring" aria-hidden={!open} inert={!open} animate={{ opacity: open ? 1 : 0 }} transition={{ duration: reducedMotion ? 0.12 : 0.18 }}>
      {open ? FEATURE_REGISTRY.map((item, index) => {
        const angle = BRAIN_FUNCTION_ORBIT_ANGLES[index];
        return (
          <span
            key={item.key}
            className="af-brain-orbit-slot"
            style={{
              '--brain-orbit-angle': `${angle}deg`,
              '--brain-orbit-counter-angle': `${-angle}deg`
            }}
          >
            <span className="af-brain-orbit-counter">
              <m.button
                type="button"
                className="af-brain-function"
                initial={{ opacity: 0, scale: 0.66 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={reducedMotion
                  ? { duration: 0.12, delay: index * 0.008 }
                  : { type: 'spring', stiffness: 390, damping: 27, mass: 0.66, delay: index * 0.028 }}
                whileTap={{ scale: 0.93 }}
                onClick={() => onSelect(item.key, item)}
                aria-label={`打开${item.label}入口`}
              >
                <Icon name={item.icon} size={16} />
                <span>{item.label}</span>
              </m.button>
            </span>
          </span>
        );
      }) : null}
    </m.div>
  );
}

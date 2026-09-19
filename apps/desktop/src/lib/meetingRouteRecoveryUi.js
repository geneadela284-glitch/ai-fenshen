import { consumeMeetingRouteRecovery } from './meetingRouteRecovery.js';

export function readMeetingRouteRecoveryForOwner(identity) {
  return consumeMeetingRouteRecovery({ ownerId: identity });
}

export function resolveMeetingPanel({ mobilePanel, activeMeetingId } = {}) {
  const requestedPanel = ['list', 'detail', 'import'].includes(mobilePanel) ? mobilePanel : 'list';
  if (requestedPanel === 'detail' && !String(activeMeetingId || '').trim()) return 'list';
  return requestedPanel;
}

export function handleMeetingTopBack({ mobilePanel, setMobilePanel, onNavigate } = {}) {
  if (mobilePanel === 'detail' || mobilePanel === 'import') {
    setMobilePanel?.('list');
    return 'list';
  }
  onNavigate?.('工作秘书');
  return 'home';
}

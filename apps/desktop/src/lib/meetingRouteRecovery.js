export const MEETING_ROUTE_RECOVERY_STORAGE_KEY = 'ai-fenshen:meeting-route-recovery:v1';

function normalized(value) {
  return String(value ?? '').trim();
}

function storageOrNull(storage) {
  if (storage) return storage;
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

export function persistMeetingRouteRecovery({
  storage = null,
  ownerId,
  meetingId,
  now = () => Date.now()
} = {}) {
  const target = storageOrNull(storage);
  const owner = normalized(ownerId);
  const meeting = normalized(meetingId);
  if (!target || !owner || !meeting || typeof target.setItem !== 'function') return false;
  try {
    target.setItem(MEETING_ROUTE_RECOVERY_STORAGE_KEY, JSON.stringify({
      version: 1,
      ownerId: owner,
      meetingId: meeting,
      createdAt: Number(now()) || Date.now()
    }));
    return true;
  } catch {
    return false;
  }
}

export function consumeMeetingRouteRecovery({ storage = null, ownerId } = {}) {
  const target = storageOrNull(storage);
  const owner = normalized(ownerId);
  if (!target || !owner || typeof target.getItem !== 'function') return null;
  let value = null;
  try {
    value = target.getItem(MEETING_ROUTE_RECOVERY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed?.version !== 1 || parsed.ownerId !== owner || !normalized(parsed.meetingId)) return null;
    target.removeItem?.(MEETING_ROUTE_RECOVERY_STORAGE_KEY);
    return Object.freeze({ meetingId: normalized(parsed.meetingId) });
  } catch {
    return null;
  }
}

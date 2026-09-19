const KEY_PREFIX = 'ai-fenshen-home-feature-intro:v1';
const SKIP_KEY_PREFIX = 'ai-fenshen-home-feature-intro-skip:v1';
const COMPLETE_KEY_PREFIX = 'ai-fenshen-home-feature-intro-complete:v1';
const HANDLED = 'handled';

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

export function homeBubbleExperienceKey(identity, dateKey, introVersion) {
  const user = required(identity, 'user');
  const date = required(dateKey, 'date');
  const version = required(introVersion, 'intro version');
  return `${KEY_PREFIX}:${encodeURIComponent(user)}:${encodeURIComponent(date)}:${encodeURIComponent(version)}`;
}

export function shouldShowDailyFeatureIntro({ storage, identity, dateKey, introVersion } = {}) {
  if (!storage?.getItem) return false;
  try {
    return storage.getItem(homeBubbleExperienceKey(identity, dateKey, introVersion)) !== HANDLED;
  } catch {
    return false;
  }
}

export function markDailyFeatureIntroHandled({ storage, identity, dateKey, introVersion } = {}) {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(homeBubbleExperienceKey(identity, dateKey, introVersion), HANDLED);
    return true;
  } catch {
    return false;
  }
}

export function featureIntroVersionSkipKey(identity, introVersion) {
  const user = required(identity, 'user');
  const version = required(introVersion, 'intro version');
  return `${SKIP_KEY_PREFIX}:${encodeURIComponent(user)}:${encodeURIComponent(version)}`;
}

export function markFeatureIntroVersionSkipped({ storage, identity, introVersion } = {}) {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(featureIntroVersionSkipKey(identity, introVersion), HANDLED);
    return true;
  } catch {
    return false;
  }
}

export function featureIntroVersionCompletionKey(identity, introVersion) {
  const user = required(identity, 'user');
  const version = required(introVersion, 'intro version');
  return `${COMPLETE_KEY_PREFIX}:${encodeURIComponent(user)}:${encodeURIComponent(version)}`;
}

export function markFeatureIntroVersionCompleted({ storage, identity, introVersion } = {}) {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(featureIntroVersionCompletionKey(identity, introVersion), HANDLED);
    return true;
  } catch {
    return false;
  }
}

export function resolveFeatureIntroPresentation({
  storage,
  identity,
  dateKey,
  introVersion
} = {}) {
  if (!storage?.getItem) return 'compact';
  try {
    if (storage.getItem(featureIntroVersionCompletionKey(identity, introVersion)) === HANDLED) {
      return 'hidden';
    }
    if (storage.getItem(featureIntroVersionSkipKey(identity, introVersion)) === HANDLED) {
      return 'compact';
    }
    return shouldShowDailyFeatureIntro({ storage, identity, dateKey, introVersion })
      ? 'expanded'
      : 'compact';
  } catch {
    return 'compact';
  }
}

import { normalizeAppearanceTheme } from '../../../../core/settings/appearanceTheme.js';

export function applyAppearanceTheme(themeId) {
  const theme = normalizeAppearanceTheme(themeId);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'professional-dark' ? 'dark' : 'light';
  return theme;
}

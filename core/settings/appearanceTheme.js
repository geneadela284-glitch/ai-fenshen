export const appearanceThemes = [
  {
    id: 'professional-dark',
    name: '暗夜未来风',
    description: '深色科技感，冷静专业，适合高频专注工作。',
    colorScheme: 'dark',
    isDark: true,
    swatches: ['#0A0C12', '#12161E', '#7C5CFF'],
    preview: {
      background: '#0A0C12',
      surface: '#12161E',
      accent: '#7C5CFF',
      text: '#E6E9F2'
    },
    tokens: {
      bgPrimary: '#0A0C12',
      bgSecondary: '#111827',
      surface: '#12161E',
      surfaceElevated: '#171D29',
      border: '#1E2A44',
      textPrimary: '#E6E9F2',
      textSecondary: '#8B93A6',
      accentPrimary: '#7C5CFF',
      accentSecondary: '#4DA3FF',
      success: '#22D3A8',
      warning: '#F4B860',
      error: '#FF647C'
    }
  },
  {
    id: 'classic',
    name: '极简轻盈风',
    description: '浅色、通透、克制，适合默认办公场景。',
    colorScheme: 'light',
    isDark: false,
    swatches: ['#F7F9FC', '#FFFFFF', '#4C7BFF'],
    preview: {
      background: '#F7F9FC',
      surface: '#FFFFFF',
      accent: '#4C7BFF',
      text: '#111827'
    },
    tokens: {
      bgPrimary: '#F7F9FC',
      bgSecondary: '#FFFFFF',
      surface: 'rgba(255,255,255,0.78)',
      surfaceElevated: '#FFFFFF',
      border: '#E6EAF2',
      textPrimary: '#111827',
      textSecondary: '#6B7280',
      accentPrimary: '#4C7BFF',
      accentSecondary: '#7C5CFF',
      success: '#22C55E',
      warning: '#F59E0B',
      error: '#EF4444'
    }
  },
  {
    id: 'warm-life',
    name: '暖光治愈风',
    description: '暖色、柔和、舒适，适合生活秘书与日常安排。',
    colorScheme: 'light',
    isDark: false,
    swatches: ['#FBF6EE', '#FFF9F1', '#C8924B'],
    preview: {
      background: '#FBF6EE',
      surface: '#FFF9F1',
      accent: '#C8924B',
      text: '#332A23'
    },
    tokens: {
      bgPrimary: '#FBF6EE',
      bgSecondary: '#FFF9F1',
      surface: 'rgba(255,250,241,0.82)',
      surfaceElevated: '#FFFDF9',
      border: '#EADCCB',
      textPrimary: '#332A23',
      textSecondary: '#75685D',
      accentPrimary: '#C8924B',
      accentSecondary: '#E0B168',
      success: '#3A9B72',
      warning: '#D79038',
      error: '#D35D5D'
    }
  }
];

export function normalizeAppearanceTheme(themeId) {
  const aliases = {
    'future-dark': 'professional-dark',
    'minimal-light': 'classic',
    'warm-healing': 'warm-life'
  };
  const resolved = aliases[themeId] || themeId;
  return appearanceThemes.some((theme) => theme.id === resolved) ? resolved : 'classic';
}

export function getAppearanceTheme(themeId) {
  const normalized = normalizeAppearanceTheme(themeId);
  return appearanceThemes.find((theme) => theme.id === normalized);
}

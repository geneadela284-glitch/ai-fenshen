import { createContext, useContext, useMemo } from 'react';
import { getThemeTokens } from './prototypeState.js';

const ThemeContext = createContext({ themeId: 'deep-blue', tokens: getThemeTokens('deep-blue') });

export function useAIFenshenTheme() {
  return useContext(ThemeContext);
}

export default function ThemeProvider({ children, themeId }) {
  const value = useMemo(() => ({ themeId, tokens: getThemeTokens(themeId) }), [themeId]);
  const style = useMemo(() => Object.fromEntries(
    Object.entries(value.tokens).map(([key, token]) => [`--af-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, token])
  ), [value.tokens]);

  return (
    <ThemeContext.Provider value={value}>
      <div className="af-theme" data-af-theme={themeId} style={style}>{children}</div>
    </ThemeContext.Provider>
  );
}

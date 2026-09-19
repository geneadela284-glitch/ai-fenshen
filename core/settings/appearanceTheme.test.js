import assert from 'node:assert/strict';
import test from 'node:test';
import { appearanceThemes, getAppearanceTheme, normalizeAppearanceTheme } from './appearanceTheme.js';

test('appearance themes expose the three AI secretary visual styles', () => {
  assert.deepEqual(appearanceThemes.map((theme) => theme.name), [
    '暗夜未来风',
    '极简轻盈风',
    '暖光治愈风'
  ]);

  for (const theme of appearanceThemes) {
    assert.ok(theme.colorScheme, `${theme.id} should expose colorScheme`);
    assert.equal(typeof theme.isDark, 'boolean', `${theme.id} should expose isDark`);
    assert.ok(theme.preview, `${theme.id} should expose preview metadata`);
    assert.ok(theme.tokens, `${theme.id} should expose implementation tokens`);
    assert.ok(theme.tokens.accentPrimary, `${theme.id} should expose accentPrimary token`);
  }
});

test('appearance theme normalization keeps saved settings compatible', () => {
  assert.equal(normalizeAppearanceTheme('classic'), 'classic');
  assert.equal(normalizeAppearanceTheme('professional-dark'), 'professional-dark');
  assert.equal(normalizeAppearanceTheme('warm-life'), 'warm-life');
  assert.equal(normalizeAppearanceTheme('minimal-light'), 'classic');
  assert.equal(normalizeAppearanceTheme('future-dark'), 'professional-dark');
  assert.equal(normalizeAppearanceTheme('warm-healing'), 'warm-life');
  assert.equal(normalizeAppearanceTheme('unknown-theme'), 'classic');
  assert.equal(getAppearanceTheme('future-dark').name, '暗夜未来风');
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('RED: skip closes the carousel into a persistent manually reopenable compact bubble', async () => {
  const [component, app] = await Promise.all([
    source('ReminderBubbleSequence.jsx'),
    source('AIFenshenRealApp.jsx')
  ]);
  assert.match(component, /onSkip/);
  assert.match(component, /handleSkip/);
  assert.match(component, /compact/);
  assert.match(component, /onReopen/);
  assert.match(app, /markFeatureIntroVersionSkipped/);
  assert.match(app, /featureIntroPresentation/);
});

test('RED: dots and horizontal swipe select a synchronized feature card', async () => {
  const component = await source('ReminderBubbleSequence.jsx');
  assert.match(component, /onDragEnd/);
  assert.match(component, /drag=\{[^}]*'x'/);
  assert.match(component, /onPointerDown/);
  assert.match(component, /onPointerUp/);
  assert.match(component, /setReminder\([^)]*index/s);
  assert.match(component, /aria-label=\{`查看第 \$\{index \+ 1\} 项`\}/);
  assert.match(component, /className=\{index === reminder\.index \? 'is-current' : ''\}/);
});

test('RED: skip, dots and bubble keep full pointer targets while motion is transform-opacity only', async () => {
  const [component, css] = await Promise.all([
    source('ReminderBubbleSequence.jsx'),
    source('aiFenshenPrototype.css')
  ]);
  assert.match(component, /whileTap=\{\{ scale: 0\.9[4567]/);
  assert.match(css, /\.af-reminder-skip\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /\.af-reminder-progress button\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /\.af-reminder-bubble\.is-compact/s);
  assert.doesNotMatch(component, /filter:\s*'blur\(/);
});

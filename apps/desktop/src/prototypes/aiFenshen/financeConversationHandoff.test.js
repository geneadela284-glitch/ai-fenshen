import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const financeViewSource = await readFile(new URL('FinanceView.jsx', import.meta.url), 'utf8');
const realAppSource = await readFile(new URL('AIFenshenRealApp.jsx', import.meta.url), 'utf8');

test('Finance AI entry emits a Conversation handoff instead of returning home or calling an API', () => {
  assert.match(
    financeViewSource,
    /export default function FinanceView\(\{ onBack, onStartConversation, financeF201Enabled = false \}\)/
  );
  assert.match(
    financeViewSource,
    /<FinanceF201View[\s\S]*?onBack=\{onBack\}[\s\S]*?onStartConversation=\{onStartConversation\}[\s\S]*?\/>/
  );
  assert.match(
    financeViewSource,
    /className="af-finance-ai-entry" onClick=\{onStartConversation\}/
  );
  assert.doesNotMatch(
    financeViewSource,
    /className="af-finance-ai-entry" onClick=\{returnToHome\}/
  );
  assert.doesNotMatch(financeViewSource, /fetch\(|ownerId|\/api\/ai\/chat|\/api\/finance\/chat/);
});

test('real app routes the Finance handoff into the existing empty unified Conversation entry', () => {
  const handler = realAppSource.match(/const startChatFromFinance = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(handler, 'expected a dedicated Finance-to-Conversation handoff');
  assert.match(handler[1], /setFeatureView\('home'\)/);
  assert.match(handler[1], /dispatch\(\{ type: 'CLOSE_BRAIN' \}\)/);
  assert.match(handler[1], /enterChat\(\);/);
  assert.doesNotMatch(handler[1], /pendingSend|startGeneration|setDraft|fetch\(|ownerId/);
  assert.match(
    realAppSource,
    /<FinanceView[\s\S]*?onStartConversation=\{startChatFromFinance\}[\s\S]*?financeF201Enabled=/
  );
});

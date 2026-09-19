import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let recordingModule;

before(async () => {
  vite = await createServer({
    root: new URL('../../../../', import.meta.url).pathname,
    configFile: new URL('../../../../vite.config.js', import.meta.url).pathname,
    appType: 'custom',
    logLevel: 'error',
    css: { postcss: { plugins: [] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, preTransformRequests: false }
  });
  recordingModule = await vite.ssrLoadModule('/src/components/meeting/recording/MeetingRecordingExperience.jsx');
});

after(async () => {
  await vite?.close();
});

function snapshot(overrides = {}) {
  return {
    status: '准备录音',
    message: '准备就绪后即可开始录音。',
    isRecording: false,
    isPaused: false,
    isInterrupted: false,
    isStopped: false,
    isBusy: false,
    canStart: true,
    canPause: false,
    canResume: false,
    canEnd: true,
    durationMs: 0,
    durationText: '00:00',
    microphone: { available: false, level: 0, bars: [] },
    ...overrides
  };
}

function experienceHarness(initialSnapshot) {
  let current = initialSnapshot;
  let listener = null;
  let unsubscribeCalls = 0;
  const calls = [];
  const implementations = {};
  return {
    calls,
    implementations,
    getSnapshot: () => current,
    subscribe(nextListener) {
      listener = nextListener;
      return () => { unsubscribeCalls += 1; };
    },
    emit(next) {
      current = next;
      listener?.(next);
    },
    start() { calls.push('start'); return implementations.start?.(); },
    pause() { calls.push('pause'); return implementations.pause?.(); },
    resume() { calls.push('resume'); return implementations.resume?.(); },
    end() { calls.push('end'); return implementations.end?.(); },
    get unsubscribeCalls() { return unsubscribeCalls; }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestNode {
  constructor(nodeType, ownerDocument = null) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] || null;
  }
  get textContent() {
    return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    if (this.nodeType === 3) {
      this.nodeValue = String(value);
      return;
    }
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== '' && value !== null && value !== undefined) {
      this.appendChild(this.ownerDocument.createTextNode(String(value)));
    }
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child, before) {
    if (!before) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.childNodes.indexOf(before);
    child.parentNode = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  contains(target) {
    return target === this || this.childNodes.some((child) => child.contains?.(target));
  }
  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) || new Set();
    listeners.add(listener);
    this._listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this._listeners.get(type)?.delete(listener);
  }
}

class TestTextNode extends TestNode {
  constructor(value, ownerDocument) {
    super(3, ownerDocument);
    this.nodeValue = value;
  }
}

class TestElement extends TestNode {
  constructor(tagName, ownerDocument) {
    super(1, ownerDocument);
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this.attributes = new Map();
    this.disabled = false;
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; }
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'disabled') this.disabled = true;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'disabled') this.disabled = false;
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  focus() {
    if (this.ownerDocument.activeElement === this) return;
    this.ownerDocument.activeElement = this;
    this.ownerDocument.dispatchFocusIn(this);
  }
  querySelectorAll(selector) {
    const descendants = descendantElements(this);
    if (selector.includes('button')) return descendants.filter((element) => element.tagName === 'BUTTON' && !element.disabled);
    return [];
  }
}

class TestDocument extends TestNode {
  constructor() {
    super(9, null);
    this.ownerDocument = this;
    this.nodeName = '#document';
    this.documentElement = new TestElement('html', this);
    this.body = new TestElement('body', this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
    this.focusDispatchCount = 0;
    this.focusDispatchLimit = 30;
    const HTMLIFrameElement = class {};
    this.defaultView = { document: this, HTMLIFrameElement };
  }
  createElement(tagName) { return new TestElement(tagName, this); }
  createElementNS(_namespace, tagName) { return new TestElement(tagName, this); }
  createTextNode(value) { return new TestTextNode(value, this); }
  dispatchFocusIn(target) {
    this.focusDispatchCount += 1;
    if (this.focusDispatchCount > this.focusDispatchLimit) throw new Error('focusin oscillation detected');
    for (const listener of [...(this._listeners.get('focusin') || [])]) listener({ target });
  }
  resetFocusDispatchCount() { this.focusDispatchCount = 0; }
  querySelector(selector) {
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    return descendantElements(this).find((element) => (element.getAttribute('class') || '').split(/\s+/).includes(className)) || null;
  }
}

function descendantElements(node) {
  const result = [];
  for (const child of node?.childNodes || []) {
    if (child.nodeType === 1) result.push(child);
    result.push(...descendantElements(child));
  }
  return result;
}

function reactHandler(element, name) {
  const key = Object.getOwnPropertyNames(element).find((property) => property.startsWith('__reactProps$'));
  assert.ok(key, `React props missing for ${element.tagName}`);
  assert.equal(typeof element[key][name], 'function', `${name} handler missing`);
  return element[key][name];
}

function buttonsWithText(root, text) {
  return descendantElements(root).filter((element) => element.tagName === 'BUTTON' && element.textContent === text);
}

async function withMountedDom(run) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const documentImpl = new TestDocument();
  globalThis.document = documentImpl;
  globalThis.window = documentImpl.defaultView;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = documentImpl.createElement('div');
  documentImpl.body.appendChild(container);
  const root = createRoot(container);
  try {
    await run({ container, documentImpl, root });
  } finally {
    await act(async () => root.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
}

function requiredFunction(name) {
  assert.equal(typeof recordingModule[name], 'function', `${name} production behavior is not implemented`);
  return recordingModule[name];
}

function render(initialSnapshot) {
  const MeetingRecordingExperience = requiredFunction('MeetingRecordingExperience');
  return renderToStaticMarkup(React.createElement(MeetingRecordingExperience, {
    experience: experienceHarness(initialSnapshot)
  }));
}

test('ready and starting SSR never receive the true-recording marker or red recording copy', () => {
  for (const initial of [
    snapshot(),
    snapshot({ status: '正在准备', message: '正在请求麦克风并准备录音，请稍候。', canStart: false, isBusy: true })
  ]) {
    const html = render(initial);
    assert.doesNotMatch(html, /data-recording="true"/);
    assert.doesNotMatch(html, /meeting-stage3c-recording-status--recording/);
    assert.doesNotMatch(html, />正在录音</);
  }
});

test('true recording SSR shows a semantic recording marker, facade timer, and measured bars', () => {
  const html = render(snapshot({
    status: '正在录音',
    message: '录音正在进行，请保持麦克风畅通。',
    isRecording: true,
    canStart: false,
    canPause: true,
    durationMs: 83_000,
    durationText: '01:23',
    microphone: { available: true, level: 0.72, bars: [0.1, 0.55, 1] }
  }));

  assert.match(html, /data-recording="true"/);
  assert.match(html, />正在录音</);
  assert.match(html, /<time[^>]*>01:23<\/time>/);
  assert.equal((html.match(/meeting-stage3c-recording-waveform-bar/g) || []).length, 3);
  assert.match(html, /音量反馈正常/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /class="meeting-stage3c-recording-signal" role="group" aria-label="麦克风音量反馈"/);
  assert.match(html, /class="meeting-stage3c-recording-controls" role="group" aria-label="录音操作"/);
});

test('StrictMode effect replay keeps the mounted recording controls active', async () => {
  await withMountedDom(async ({ container, root }) => {
    const experience = experienceHarness(snapshot());
    await act(async () => {
      root.render(React.createElement(StrictMode, null,
        React.createElement(requiredFunction('MeetingRecordingExperience'), { experience })
      ));
    });

    const [startButton] = buttonsWithText(container, '开始录音');
    assert.ok(startButton);
    await act(async () => {
      reactHandler(startButton, 'onClick')({});
      await Promise.resolve();
    });
    assert.deepEqual(experience.calls, ['start']);
  });
});

test('failed end keeps the exact safe error inside the open aria-modal dialog', async () => {
  await withMountedDom(async ({ container, documentImpl, root }) => {
    const experience = experienceHarness(snapshot({ canStart: false, canEnd: true }));
    experience.implementations.end = async () => {
      throw new Error('MIME codec chunk revision owner key database fingerprint Provider Manager Store Backend');
    };
    await act(async () => {
      root.render(React.createElement(requiredFunction('MeetingRecordingExperience'), { experience }));
    });

    const [openButton] = buttonsWithText(container, '结束并保存');
    await act(async () => reactHandler(openButton, 'onClick')({}));
    const [confirmButton] = buttonsWithText(documentImpl.body, '结束并安全保存');
    assert.ok(confirmButton);
    await act(async () => {
      reactHandler(confirmButton, 'onClick')({});
      await Promise.resolve();
    });

    const dialog = descendantElements(documentImpl.body).find((element) => element.getAttribute('role') === 'dialog');
    assert.ok(dialog, 'end dialog closed after failure');
    const alerts = descendantElements(dialog).filter((element) => element.getAttribute('role') === 'alert');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].textContent, '操作未能完成，请稍后重试。');
  });
});

test('multiple mounted dialogs use unique local title relationships', async () => {
  await withMountedDom(async ({ container, documentImpl, root }) => {
    const first = experienceHarness(snapshot({ canStart: false, canEnd: true }));
    const second = experienceHarness(snapshot({ canStart: false, canEnd: true }));
    await act(async () => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement(requiredFunction('MeetingRecordingExperience'), { experience: first }),
        React.createElement(requiredFunction('MeetingRecordingExperience'), { experience: second })
      ));
    });
    const openButtons = buttonsWithText(container, '结束并保存');
    assert.equal(openButtons.length, 2);
    await act(async () => {
      reactHandler(openButtons[0], 'onClick')({});
      reactHandler(openButtons[1], 'onClick')({});
    });

    const dialogs = descendantElements(documentImpl.body).filter((element) => element.getAttribute('role') === 'dialog');
    assert.equal(dialogs.length, 2);
    const titleIds = dialogs.map((dialog) => dialog.getAttribute('aria-labelledby'));
    assert.equal(new Set(titleIds).size, 2);
    for (let index = 0; index < dialogs.length; index += 1) {
      assert.ok(descendantElements(dialogs[index]).some((element) => element.getAttribute('id') === titleIds[index]));
    }
  });
});

test('multiple mounted dialogs share one topmost focus trap and one order-safe body lock', async () => {
  await withMountedDom(async ({ container, documentImpl, root }) => {
    documentImpl.body.style.overflow = 'scroll';
    const first = experienceHarness(snapshot({ canStart: false, canEnd: true }));
    const second = experienceHarness(snapshot({ canStart: false, canEnd: true }));
    const component = requiredFunction('MeetingRecordingExperience');
    const pair = () => React.createElement(React.Fragment, null,
      React.createElement(component, { experience: first, key: 'first' }),
      React.createElement(component, { experience: second, key: 'second' })
    );
    const openBoth = async () => {
      const buttons = buttonsWithText(container, '结束并保存');
      assert.equal(buttons.length, 2);
      await act(async () => {
        reactHandler(buttons[0], 'onClick')({});
        reactHandler(buttons[1], 'onClick')({});
      });
      return descendantElements(documentImpl.body).filter((element) => element.getAttribute('role') === 'dialog');
    };
    const closeDialog = async (dialog) => {
      const [cancel] = buttonsWithText(dialog, '继续录音');
      await act(async () => reactHandler(cancel, 'onClick')({}));
    };

    await act(async () => root.render(pair()));
    let dialogs = await openBoth();
    assert.equal(documentImpl.body.style.overflow, 'hidden');
    assert.equal(documentImpl.activeElement === dialogs[1], true, 'new topmost dialog did not receive focus after registration');
    const outside = documentImpl.createElement('button');
    documentImpl.body.appendChild(outside);
    documentImpl.resetFocusDispatchCount();
    assert.doesNotThrow(() => outside.focus());
    assert.equal(documentImpl.activeElement, dialogs[1], 'non-topmost dialog captured focus');
    assert.ok(documentImpl.focusDispatchCount <= 2, 'focus containment oscillated');

    await closeDialog(dialogs[0]);
    assert.equal(documentImpl.body.style.overflow, 'hidden');
    await closeDialog(dialogs[1]);
    assert.equal(documentImpl.body.style.overflow, 'scroll');

    dialogs = await openBoth();
    await closeDialog(dialogs[1]);
    assert.equal(documentImpl.body.style.overflow, 'hidden');
    await closeDialog(dialogs[0]);
    assert.equal(documentImpl.body.style.overflow, 'scroll');

    await openBoth();
    await act(async () => root.render(React.createElement(component, { experience: second, key: 'second' })));
    assert.equal(documentImpl.body.style.overflow, 'hidden');
    await act(async () => root.render(null));
    assert.equal(documentImpl.body.style.overflow, 'scroll');

    await act(async () => root.render(pair()));
    await openBoth();
    await act(async () => root.render(React.createElement(component, { experience: first, key: 'first' })));
    assert.equal(documentImpl.body.style.overflow, 'hidden');
    await act(async () => root.render(null));
    assert.equal(documentImpl.body.style.overflow, 'scroll');
  });
});

test('paused, system-interrupted, and stopped snapshots render truthful controls and copy', () => {
  const paused = render(snapshot({
    status: '已暂停', message: '录音已暂停，可以继续录音或结束会议。',
    isPaused: true, canStart: false, canResume: true, durationText: '00:18'
  }));
  assert.match(paused, />已暂停</);
  assert.match(paused, />继续录音</);
  assert.match(paused, />结束并保存</);
  assert.doesNotMatch(paused, />暂停录音</);

  const interrupted = render(snapshot({
    status: '已中断', message: '录音已中断，需要您明确选择继续录音。',
    isInterrupted: true, canStart: false, canResume: true, durationText: '00:21'
  }));
  assert.match(interrupted, />录音已中断，需要您明确选择继续录音。</);
  assert.match(interrupted, />继续录音</);
  assert.doesNotMatch(interrupted, /data-recording="true"/);

  const stopped = render(snapshot({
    status: '已结束', message: '录音已结束。', isStopped: true,
    canStart: false, canEnd: false, durationText: '03:20'
  }));
  assert.match(stopped, />录音已结束。</);
  assert.doesNotMatch(stopped, /<button\b/);
});

test('recording without signal remains calm and never fabricates waveform bars', () => {
  const recording = render(snapshot({
    status: '正在录音', message: '录音正在进行，请保持麦克风畅通。',
    isRecording: true, canStart: false, canPause: true,
    microphone: { available: false, level: 0, bars: [] }
  }));
  assert.match(recording, /录音仍在进行，音量反馈暂不可用/);
  assert.doesNotMatch(recording, /meeting-stage3c-recording-waveform-bar/);

  const ready = render(snapshot());
  assert.match(ready, /开始录音后将显示音量反馈/);
});

test('visible recording surface never exposes raw technical or internal vocabulary', () => {
  const html = render(snapshot({
    status: '录音未完成', message: '录音没有正常开始或保存，请检查后重试。',
    canStart: true
  }));
  for (const forbidden of [
    'error', 'stack', 'MIME', 'mime', 'codec', 'chunk', 'revision', 'owner', 'database',
    'fingerprint', 'Provider', 'Manager', 'Store', 'Backend', 'API', 'key'
  ]) {
    assert.equal(html.toLowerCase().includes(forbidden.toLowerCase()), false, `leaked ${forbidden}`);
  }
});

test('action controller validates capabilities, locks duplicates, and requires explicit end confirmation', async () => {
  const pending = deferred();
  const experience = experienceHarness(snapshot());
  experience.implementations.start = () => pending.promise;
  const pendingStates = [];
  const controller = requiredFunction('createRecordingActionController')(experience, {
    onPendingChange: (value) => pendingStates.push(value)
  });

  const first = controller.run('start');
  const duplicate = controller.run('start');
  assert.equal(experience.calls.length, 1);
  assert.equal(first, duplicate);
  assert.equal(controller.requestEnd(), false, 'busy action unexpectedly opened end confirmation');
  pending.resolve();
  assert.equal(await first, true);
  assert.deepEqual(pendingStates, [true, false]);

  experience.emit(snapshot({ canStart: false, canEnd: true }));
  assert.equal(controller.requestEnd(), true);
  assert.deepEqual(experience.calls, ['start'], 'requesting confirmation called end early');
  await controller.confirmEnd();
  assert.deepEqual(experience.calls, ['start', 'end']);

  experience.emit(snapshot({ canStart: false, canPause: true, canEnd: true }));
  await controller.run('pause');
  experience.emit(snapshot({ canStart: false, canResume: true, canEnd: true }));
  await controller.run('resume');
  assert.deepEqual(experience.calls, ['start', 'end', 'pause', 'resume']);
});

test('finalization pending keeps the end flow available without claiming whole-meeting completion', async () => {
  const experience = experienceHarness(snapshot({ canStart: false, canEnd: true }));
  const completions = [];
  experience.implementations.end = async () => ({
    meeting: { recordingState: 'finalization_pending' },
    finalizationPending: true
  });
  const controller = requiredFunction('createRecordingActionController')(experience, {
    onEndComplete: () => completions.push('closed')
  });

  assert.equal(await controller.confirmEnd(), true);
  assert.deepEqual(completions, []);
  assert.deepEqual(experience.calls, ['end']);
});

test('action errors collapse to one safe message and late completion after dispose cannot update UI', async () => {
  const pending = deferred();
  const experience = experienceHarness(snapshot());
  experience.implementations.start = () => pending.promise;
  const errors = [];
  const pendingStates = [];
  const controller = requiredFunction('createRecordingActionController')(experience, {
    onSafeError: (message) => errors.push(message),
    onPendingChange: (value) => pendingStates.push(value)
  });

  const action = controller.run('start');
  controller.dispose();
  const raw = new Error('MIME codec chunk revision owner key database fingerprint Provider Manager Store Backend');
  pending.reject(raw);
  assert.equal(await action, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(pendingStates, [true]);

  const nextExperience = experienceHarness(snapshot());
  nextExperience.implementations.start = async () => { throw raw; };
  const visibleErrors = [];
  const activeController = requiredFunction('createRecordingActionController')(nextExperience, {
    onSafeError: (message) => visibleErrors.push(message)
  });
  assert.equal(await activeController.run('start'), false);
  assert.deepEqual(visibleErrors, ['操作未能完成，请稍后重试。']);
});

test('asset mismatch exposes a safe reload action without starting a recording', async () => {
  await withMountedDom(async ({ container, root }) => {
    const experience = experienceHarness(snapshot());
    experience.implementations.start = async () => {
      const error = new Error('asset mismatch');
      error.code = 'CLIENT_ASSET_VERSION_MISMATCH';
      throw error;
    };
    await act(async () => {
      root.render(React.createElement(requiredFunction('MeetingRecordingExperience'), { experience }));
    });
    const [startButton] = buttonsWithText(container, '开始录音');
    await act(async () => {
      reactHandler(startButton, 'onClick')({});
      await Promise.resolve();
    });
    assert.equal(experience.calls.filter((call) => call === 'start').length, 1);
    assert.equal(buttonsWithText(container, '版本已更新，点击重新加载').length, 1);
    assert.match(container.textContent, /版本已更新，请重新加载后再开始录音/);
  });
});

test('reloadCurrentClientAssets cache-busts the document URL and never starts recording', () => {
  const replaced = [];
  const result = requiredFunction('reloadCurrentClientAssets')({
    locationImpl: {
      href: 'https://example.test/meeting?run=1',
      replace(value) { replaced.push(value); }
    },
    now: () => 270
  });
  assert.equal(result, true);
  assert.deepEqual(replaced, ['https://example.test/meeting?run=1&__meeting_asset_refresh=270']);
});

test('experience subscription unsubscribes once and ignores late snapshots after cleanup', () => {
  const experience = experienceHarness(snapshot());
  const observed = [];
  const unsubscribe = requiredFunction('subscribeToRecordingExperience')(experience, (next) => observed.push(next));

  experience.emit(snapshot({ status: '正在准备' }));
  unsubscribe();
  unsubscribe();
  experience.emit(snapshot({ status: '正在录音', isRecording: true }));

  assert.deepEqual(observed.map((item) => item.status), ['正在准备']);
  assert.equal(experience.unsubscribeCalls, 1);
});

test('dialog focus helpers handle zero, one, and multiple controls plus busy containment', () => {
  const {
    containDialogFocus,
    focusInitialDialog,
    restoreDialogFocus,
    trapDialogTabKey
  } = recordingModule;
  for (const name of ['containDialogFocus', 'focusInitialDialog', 'restoreDialogFocus', 'trapDialogTabKey']) {
    requiredFunction(name);
  }

  let activeElement = null;
  let prevented = 0;
  const documentImpl = { get activeElement() { return activeElement; } };
  const first = { focus: () => { activeElement = first; }, disabled: false };
  const middle = { focus: () => { activeElement = middle; }, disabled: false };
  const last = { focus: () => { activeElement = last; }, disabled: false };
  let controls = [];
  const dialog = {
    focus: () => { activeElement = dialog; },
    contains: (element) => element === dialog || controls.includes(element),
    querySelectorAll: () => controls
  };
  const tab = (shiftKey = false) => ({ key: 'Tab', shiftKey, preventDefault: () => { prevented += 1; } });

  focusInitialDialog(dialog);
  assert.equal(activeElement, dialog);
  activeElement = null;
  trapDialogTabKey(tab(), dialog, documentImpl);
  assert.equal(activeElement, dialog);

  controls = [first];
  focusInitialDialog(dialog);
  assert.equal(activeElement, first);
  trapDialogTabKey(tab(), dialog, documentImpl);
  assert.equal(activeElement, first);

  controls = [first, middle, last];
  activeElement = last;
  trapDialogTabKey(tab(), dialog, documentImpl);
  assert.equal(activeElement, first);
  activeElement = first;
  trapDialogTabKey(tab(true), dialog, documentImpl);
  assert.equal(activeElement, last);
  activeElement = middle;
  const beforeMiddle = prevented;
  trapDialogTabKey(tab(), dialog, documentImpl);
  assert.equal(prevented, beforeMiddle);

  activeElement = { id: 'outside' };
  containDialogFocus({ target: activeElement }, dialog);
  assert.equal(activeElement, dialog);

  const prior = { isConnected: true, focus: () => { activeElement = prior; } };
  restoreDialogFocus(prior);
  assert.equal(activeElement, prior);
});

test('Escape and direct backdrop close only while idle', () => {
  const closeFromDialogEscape = requiredFunction('closeFromDialogEscape');
  const closeFromDialogBackdrop = requiredFunction('closeFromDialogBackdrop');
  let closed = 0;
  let prevented = 0;
  let stopped = 0;
  const escape = {
    key: 'Escape',
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; }
  };

  assert.equal(closeFromDialogEscape(escape, false, () => { closed += 1; }), true);
  assert.equal(closeFromDialogEscape(escape, true, () => { closed += 1; }), false);
  assert.equal(closeFromDialogEscape({ ...escape, key: 'Enter' }, false, () => { closed += 1; }), false);
  assert.deepEqual({ closed, prevented, stopped }, { closed: 1, prevented: 1, stopped: 1 });

  const backdrop = {};
  assert.equal(closeFromDialogBackdrop({ target: backdrop, currentTarget: backdrop }, false, () => { closed += 1; }), true);
  assert.equal(closeFromDialogBackdrop({ target: {}, currentTarget: backdrop }, false, () => { closed += 1; }), false);
  assert.equal(closeFromDialogBackdrop({ target: backdrop, currentTarget: backdrop }, true, () => { closed += 1; }), false);
  assert.equal(closed, 2);
});

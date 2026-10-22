async (page) => {
  const failures = [];
  const results = [];
  const check = (condition, name, details = {}) => {
    results.push({ name, pass: Boolean(condition), ...details });
    if (!condition) failures.push(name);
  };

  let authenticated = true;
  let consentCurrent = false;
  let consentPosts = 0;
  let failConsentPost = false;
  const currentUrl = page.url();
  const baseUrl = currentUrl.startsWith('http://') || currentUrl.startsWith('https://')
    ? currentUrl.split('/').slice(0, 3).join('/')
    : 'http://127.0.0.1:4173';

  const notice = {
    privacyNoticeVersion: 'mobile-hotfix-privacy-v1',
    termsVersion: 'mobile-hotfix-terms-v1',
    locale: 'zh-CN',
    providerProcessing: '必要的用户输入会发送给已启用的大模型 Provider 处理。',
    retention: '在线用户内容保留至账号删除；封闭测试数据最长参考保留期为 30 天。',
    userRights: '用户可以导出和删除自己的数据。',
    testDataWarning: '测试数据可能因系统测试或故障被清理。',
    contact: '测试邀请渠道'
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.includes('/api/auth/me')) {
      return route.fulfill(authenticated
        ? {
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              user: { id: 'layout-only', username: 'layout-only', role: 'user' }
            })
          }
        : {
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, user: null })
          });
    }
    if (url.includes('/api/privacy/consent')) {
      if (request.method() === 'POST') {
        consentPosts += 1;
        await page.waitForTimeout(80);
        if (failConsentPost) {
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: false,
              code: 'PRIVACY_SERVICE_UNAVAILABLE',
              message: '隐私同意保存失败，请稍后重试。'
            })
          });
        }
        consentCurrent = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, consent: { current: true } })
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          consent: { current: consentCurrent },
          notice
        })
      });
    }
    if (url.includes('/api/ai/conversations')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, conversations: [] })
      });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false })
    });
  });

  const loadConsent = async ({ width, height }) => {
    authenticated = true;
    consentCurrent = false;
    failConsentPost = false;
    await page.setViewportSize({ width, height });
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('[data-testid="privacy-consent-view"]');
  };

  const layout = () => page.evaluate(() => {
    const view = document.querySelector('[data-testid="privacy-consent-view"]');
    const scroller = document.querySelector('[data-testid="privacy-consent-scroll"]') || view;
    const actions = document.querySelector('[data-testid="privacy-consent-actions"]') || view;
    const canvas = document.querySelector('.af-prototype-canvas');
    const header = view.querySelector(':scope > header');
    const card = view.querySelector('.af-privacy-card');
    const button = view.querySelector('button');
    const buttonRect = button.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const viewRect = view.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const before = scroller.scrollTop;
    scroller.scrollTop = scroller.scrollHeight;
    const after = scroller.scrollTop;
    return {
      viewportHeight: window.innerHeight,
      canvasTop: canvasRect.top,
      canvasBottom: canvasRect.bottom,
      canvasHeight: canvasRect.height,
      viewTop: viewRect.top,
      viewBottom: viewRect.bottom,
      viewClientHeight: view.clientHeight,
      viewScrollHeight: view.scrollHeight,
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      cardTop: cardRect.top,
      cardBottom: cardRect.bottom,
      cardHeight: cardRect.height,
      cardFlex: getComputedStyle(card).flex,
      scrollerClientHeight: scroller.clientHeight,
      scrollerScrollHeight: scroller.scrollHeight,
      scrolled: after > before,
      buttonTop: buttonRect.top,
      buttonBottom: buttonRect.bottom,
      actionsBottom: actionsRect.bottom,
      buttonVisible: buttonRect.top >= 0 && buttonRect.bottom <= window.innerHeight,
      actionsVisible: actionsRect.top >= 0 && actionsRect.bottom <= window.innerHeight,
      pointerEvents: getComputedStyle(button).pointerEvents,
      topElementIsButton: document.elementFromPoint(
        buttonRect.left + buttonRect.width / 2,
        buttonRect.top + buttonRect.height / 2
      )?.closest('button') === button
    };
  });

  await loadConsent({ width: 390, height: 664 });
  const portrait = await layout();
  check(
    portrait.scrollerScrollHeight > portrait.scrollerClientHeight && portrait.scrolled,
    'portrait privacy content scrolls to the bottom',
    portrait
  );
  check(
    portrait.buttonVisible && portrait.actionsVisible &&
      portrait.pointerEvents !== 'none' && portrait.topElementIsButton,
    'portrait CTA remains visible and unobstructed above the Safari toolbar',
    portrait
  );

  const checkbox = page.getByRole('checkbox');
  const submit = page.getByRole('button', { name: '同意并继续' });
  check(await submit.isDisabled(), 'CTA is disabled before explicit consent');
  await checkbox.check();
  check(await submit.isEnabled(), 'CTA is enabled after explicit consent');

  consentPosts = 0;
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.includes('同意并继续'));
    button.click();
    button.click();
  });
  await page.waitForSelector('[data-testid="home-view"]');
  check(consentPosts === 1, 'rapid activation submits consent exactly once', { consentPosts });
  check(
    await page.locator('[data-testid="home-view"]').isVisible(),
    'successful consent enters the main view'
  );

  failConsentPost = true;
  consentCurrent = false;
  consentPosts = 0;
  await page.reload();
  await page.waitForSelector('[data-testid="privacy-consent-view"]');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '同意并继续' }).evaluate((button) => button.click());
  const alert = page.getByRole('alert');
  await alert.waitFor();
  check(
    (await alert.textContent()).includes('保存失败') &&
      await page.locator('[data-testid="privacy-consent-view"]').isVisible() &&
      await page.getByRole('button', { name: '同意并继续' }).isEnabled(),
    'failed consent shows an explicit error and stays on the consent view'
  );

  failConsentPost = false;
  await loadConsent({ width: 844, height: 390 });
  const landscape = await layout();
  check(
    landscape.scrollerScrollHeight > landscape.scrollerClientHeight &&
      landscape.scrolled && landscape.buttonVisible && landscape.actionsVisible,
    'landscape consent remains scrollable with a reachable CTA',
    landscape
  );

  authenticated = false;
  await page.reload();
  await page.waitForSelector('[data-testid="login-view"]');
  check(
    await page.locator('[data-testid="login-view"]').isVisible(),
    'login layout remains operable'
  );

  authenticated = true;
  consentCurrent = true;
  await page.reload();
  await page.waitForSelector('[data-testid="home-view"]');
  check(
    await page.locator('[data-testid="home-view"]').isVisible(),
    'main layout remains operable'
  );

  if (failures.length) {
    const failedResults = results.filter((result) => !result.pass);
    throw new Error(
      `PRIVACY_CONSENT_MOBILE_ACCEPTANCE_FAILED: ${failures.join('; ')} ${JSON.stringify(failedResults)}`
    );
  }
  return {
    status: 'PASS',
    tests: results.length,
    consentPosts,
    results
  };
}

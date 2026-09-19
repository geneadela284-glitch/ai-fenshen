import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PRIVACY_NOTICE,
  publicPrivacyNotice
} from './privacyPolicy.js';

test('current privacy notice requires a new image-processing version and explains the complete attachment lifecycle', () => {
  const notice = publicPrivacyNotice();
  assert.equal(DEFAULT_PRIVACY_NOTICE.privacyNoticeVersion, 'closed-beta-privacy-2026-07-30-image-v2');
  assert.match(notice.attachmentProcessing, /受控 VPS/);
  assert.match(notice.attachmentProcessing, /Qwen.*视觉.*OCR/);
  assert.match(notice.attachmentRetention, /未绑定.*1小时/);
  assert.match(notice.attachmentRetention, /封闭测试保留策略/);
  assert.match(notice.attachmentRights, /导出/);
  assert.match(notice.attachmentRights, /删除账号/);
  assert.match(notice.attachmentLimitations, /JPEG.*PNG.*WebP/);
  assert.match(notice.attachmentLimitations, /法律级|排版级/);
  assert.match(notice.prohibitedSensitiveData, /密码.*API Key.*身份证件.*银行卡/);
});

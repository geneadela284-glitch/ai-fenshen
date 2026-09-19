export const DEFAULT_PRIVACY_NOTICE = Object.freeze({
  privacyNoticeVersion: 'closed-beta-privacy-2026-07-30-image-v2',
  termsVersion: 'closed-beta-terms-2026-07-29-v1',
  locale: 'zh-CN',
  retentionDays: 30,
  contact: '请通过测试邀请渠道联系管理员'
});

export function normalizePrivacyPolicy(value = {}) {
  const policy = {
    ...DEFAULT_PRIVACY_NOTICE,
    ...(value && typeof value === 'object' ? value : {})
  };
  for (const key of ['privacyNoticeVersion', 'termsVersion', 'locale', 'contact']) {
    if (typeof policy[key] !== 'string' || !policy[key].trim()) {
      throw new TypeError(`Privacy policy ${key} is required.`);
    }
    policy[key] = policy[key].trim();
  }
  const retentionDays = Number(policy.retentionDays);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError('Privacy policy retentionDays must be a positive integer.');
  }
  return Object.freeze({ ...policy, retentionDays });
}

export function publicPrivacyNotice(policyInput = {}) {
  const policy = normalizePrivacyPolicy(policyInput);
  return Object.freeze({
    closedBeta: true,
    privacyNoticeVersion: policy.privacyNoticeVersion,
    termsVersion: policy.termsVersion,
    locale: policy.locale,
    storage: '封闭测试期间，账号与用户业务数据存储在受控 VPS。',
    providerProcessing: '为生成回复，必要的用户输入会发送给当前已启用的大模型 Provider 处理。',
    attachmentProcessing: '用户选择发送的图片会存储在受控 VPS，并发送给已启用的 Qwen 视觉与 OCR 服务，用于理解画面、提取文字和生成基于附件证据的回复。',
    attachmentRetention: '未绑定到消息的附件会在1小时后清理；已绑定附件、OCR文字和派生结果遵循当前封闭测试保留策略。',
    attachmentRights: '数据导出包含本人附件及安全派生结果；删除账号会删除本人附件、OCR文字和派生结果。',
    attachmentLimitations: '首期仅支持 JPEG、PNG 和 WebP，单张不超过8 MiB、单条消息最多3张。OCR不承诺法律级或排版级逐字符准确性，低质量图片可能无法完整识别。',
    dataUses: Object.freeze({
      conversation: '保存连续对话及回复，支持恢复上下文。',
      memory: '保存用户确认或规则允许的长期事实、偏好及其来源。',
      finance: '保存用户提交的收支交易并生成确定性汇总与报表。',
      calendar: '使用长期记忆中的生日和日期证据完成确定性日期计算。'
    }),
    retention: `在线用户内容原则上保留至账号删除；临时导出文件最多短期保留。封闭测试数据最长参考保留期为 ${policy.retentionDays} 天，且可能因系统测试或故障被清理。`,
    userRights: '用户可在设置中导出自己的完整数据，或通过两阶段确认删除账号及在线个人数据。',
    prohibitedSensitiveData: '请勿输入密码、API Key、身份证件、银行卡或其它高敏感数据。',
    testDataWarning: '服务仍处于封闭测试阶段，测试数据可能因系统测试、故障或恢复操作被清理。',
    contact: policy.contact
  });
}

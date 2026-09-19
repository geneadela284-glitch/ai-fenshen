function field(id, kind = 'secret', required = true) {
  return Object.freeze({ id, kind, required, write_only: kind === 'secret' });
}

function schema(providerId, variants) {
  return Object.freeze({
    schema_id: `${providerId}.credentials.v1`,
    variants: Object.freeze(variants.map((variant) => Object.freeze({
      id: variant.id,
      fields: Object.freeze(variant.fields)
    })))
  });
}

const bearer = (providerId, extraFields = []) => schema(providerId, [{
  id: 'bearer_api_key',
  fields: [field('api_key'), ...extraFields]
}]);

export const CREDENTIAL_SCHEMAS = Object.freeze({
  deepseek: bearer('deepseek'),
  qwen: bearer('qwen', [field('workspace_id', 'identifier', false)]),
  doubao: bearer('doubao', [field('endpoint_id', 'identifier', false)]),
  zhipu: bearer('zhipu'),
  kimi: bearer('kimi'),
  minimax: bearer('minimax', [field('group_id', 'identifier', false)]),
  hunyuan: schema('hunyuan', [
    { id: 'bearer_api_key', fields: [field('api_key')] },
    { id: 'tc3_openapi', fields: [field('secret_id', 'identifier'), field('secret_key')] }
  ]),
  qianfan: schema('qianfan', [
    { id: 'bearer_api_key', fields: [field('api_key'), field('app_id', 'identifier', false)] },
    { id: 'legacy_ak_sk', fields: [field('access_key'), field('secret_key')] }
  ]),
  iflytek: schema('iflytek', [
    { id: 'http_api_password', fields: [field('api_password')] },
    { id: 'signed_app', fields: [field('app_id', 'identifier'), field('api_key'), field('api_secret')] }
  ]),
  stepfun: bearer('stepfun'),
  baichuan: bearer('baichuan'),
  openai: bearer('openai'),
  anthropic: bearer('anthropic'),
  gemini: bearer('gemini'),
  xai: bearer('xai'),
  mistral: bearer('mistral'),
  runway: bearer('runway'),
  elevenlabs: bearer('elevenlabs'),
  black_forest_labs: bearer('black_forest_labs')
});

export function getCredentialSchema(providerId) {
  return CREDENTIAL_SCHEMAS[providerId] || null;
}

export function requiredCredentialFields(credentialSchema, variantId = '') {
  const variant = credentialSchema?.variants?.find((item) => item.id === variantId)
    || credentialSchema?.variants?.[0];
  return Object.freeze((variant?.fields || []).filter((item) => item.required).map((item) => item.id));
}

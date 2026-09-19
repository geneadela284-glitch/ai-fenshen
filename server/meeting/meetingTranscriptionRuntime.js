import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMeetingSpeechGateway } from '../../core/meeting/stage3a/meetingSpeechGateway.js';
import { createXfyunAsrLlmMeetingProvider } from './xfyunAsrLlmMeetingProvider.js';

export const DEFAULT_XFYUN_MEETING_CREDENTIALS_FILE = path.join(
  os.homedir(),
  'Library/Application Support/AI-Fenshen/secrets/xfyun-meeting-asr.env'
);

const CREDENTIAL_FIELDS = Object.freeze([
  ['XFYUN_APP_ID', 'appId'],
  ['XFYUN_API_KEY', 'accessKeyId'],
  ['XFYUN_API_SECRET', 'accessKeySecret']
]);

export const FORMAL_XFYUN_CREDENTIAL_PROVIDER_ID = 'iflytek';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeValue(value) {
  const normalized = String(value ?? '').trim();
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
}

function parseEnvFile(contents) {
  const values = new Map();
  for (const line of String(contents || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals < 1) continue;
    const name = trimmed.slice(0, equals).trim();
    if (!CREDENTIAL_FIELDS.some(([field]) => field === name)) continue;
    values.set(name, normalizeValue(trimmed.slice(equals + 1)));
  }
  return values;
}

function credentialsFromValues(values) {
  const missing = CREDENTIAL_FIELDS.filter(([field]) => !String(values.get(field) || '').trim()).map(([field]) => field);
  if (missing.length) throw codedError('XFYUN_ASR_CREDENTIALS_MISSING');
  return Object.freeze(Object.fromEntries(CREDENTIAL_FIELDS.map(([field, property]) => [property, values.get(field)])));
}

function credentialsFromEnvironment(env) {
  const values = new Map(CREDENTIAL_FIELDS.map(([field]) => [field, normalizeValue(env?.[field])]));
  if (CREDENTIAL_FIELDS.every(([field]) => values.get(field))) return credentialsFromValues(values);
  return null;
}

export function readXfyunMeetingCredentials({ filePath = DEFAULT_XFYUN_MEETING_CREDENTIALS_FILE, env = process.env } = {}) {
  const environmentCredentials = credentialsFromEnvironment(env);
  if (environmentCredentials) return environmentCredentials;
  const resolvedPath = path.resolve(String(filePath || DEFAULT_XFYUN_MEETING_CREDENTIALS_FILE));
  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch {
    throw codedError('XFYUN_ASR_CREDENTIALS_MISSING');
  }
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw codedError('XFYUN_CREDENTIALS_PERMISSIONS_UNSAFE');
  let contents;
  try {
    contents = readFileSync(resolvedPath, 'utf8');
  } catch {
    throw codedError('XFYUN_ASR_CREDENTIALS_MISSING');
  }
  return credentialsFromValues(parseEnvFile(contents));
}

export function createLocalMeetingSpeechGateway({
  credentials = null,
  credentialsFilePath = DEFAULT_XFYUN_MEETING_CREDENTIALS_FILE,
  env = process.env,
  fetchImpl = globalThis.fetch,
  providerOptions = {}
} = {}) {
  let resolvedCredentials = credentials;
  if (!resolvedCredentials) {
    try {
      resolvedCredentials = readXfyunMeetingCredentials({ filePath: credentialsFilePath, env });
    } catch {
      return createMeetingSpeechGateway();
    }
  }
  try {
    const provider = createXfyunAsrLlmMeetingProvider({
      credentials: resolvedCredentials,
      fetchImpl,
      ...providerOptions
    });
    return createMeetingSpeechGateway({ provider });
  } catch {
    return createMeetingSpeechGateway();
  }
}

function formalXfyunCredentials(credentials = {}) {
  return Object.freeze({
    appId: String(credentials.app_id || '').trim(),
    accessKeyId: String(credentials.api_key || '').trim(),
    accessKeySecret: String(credentials.api_secret || '').trim()
  });
}

export function createProviderRegistryMeetingSpeechGateway({
  credentialResolver = null,
  providerId = FORMAL_XFYUN_CREDENTIAL_PROVIDER_ID,
  fetchImpl = globalThis.fetch,
  providerOptions = {}
} = {}) {
  const normalizedProviderId = String(providerId || FORMAL_XFYUN_CREDENTIAL_PROVIDER_ID).trim();
  const readiness = () => {
    if (typeof credentialResolver?.describeProvider !== 'function') {
      return Object.freeze({
        available: false,
        status: 'blocked',
        reasonCode: 'CREDENTIAL_RESOLVER_UNAVAILABLE',
        credentialRevision: null
      });
    }
    try {
      return Object.freeze(credentialResolver.describeProvider({
        providerId: normalizedProviderId,
        purpose: 'invoke'
      }));
    } catch (error) {
      return Object.freeze({
        available: false,
        status: 'blocked',
        reasonCode: error?.code || 'CREDENTIAL_RESOLVER_UNAVAILABLE',
        credentialRevision: null
      });
    }
  };
  const runtimeDescription = () => {
    const status = readiness();
    const available = status.available === true;
    return Object.freeze({
      available,
      sourceAvailable: available,
      diarizationAvailable: available,
      realProvider: available,
      deterministicFixture: false,
      status: available ? 'available' : 'blocked',
      reasonCode: status.reasonCode || null,
      credentialRevision: Number.isInteger(status.credentialRevision) ? status.credentialRevision : null
    });
  };
  async function withProvider(request, method) {
    if (runtimeDescription().available !== true) throw codedError('REAL_MEETING_ASR_PROVIDER_BLOCKED');
    if (typeof credentialResolver?.withCredentials !== 'function') throw codedError('REAL_MEETING_ASR_PROVIDER_BLOCKED');
    return credentialResolver.withCredentials({
      providerId: normalizedProviderId,
      purpose: 'invoke'
    }, async (credentials) => {
      const provider = createXfyunAsrLlmMeetingProvider({
        ...providerOptions,
        credentials: formalXfyunCredentials(credentials),
        fetchImpl
      });
      return provider[method](request);
    });
  }
  const provider = Object.freeze({
    providerId: 'xfyun_asr_llm',
    model: 'recording_file_transcription_llm',
    isDeterministicFixture: false,
    supportsDiarization: true,
    describe: runtimeDescription,
    async transcribeChunk(request) {
      return withProvider(request, 'transcribeChunk');
    },
    async transcribeSource(request) {
      return withProvider(request, 'transcribeSource');
    }
  });
  return createMeetingSpeechGateway({ provider });
}

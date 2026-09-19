import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';

const SENSITIVE_KEY = /api.?key|authorization|cookie|password|private.?key|credential|secret|token|kek/i;
const KEY_LIKE_VALUE = /\b(?:sk|ak)-[A-Za-z0-9_-]{12,}\b/g;
const SAFE_TOKEN_COUNT_KEY = /^(?:input|output|total|max)_tokens$/;
const SAFE_BUDGET_KEYS = new Set([
  'estimated_input_tokens_formal',
  'estimated_input_tokens_hard',
  'max_output_tokens_formal',
  'max_output_tokens_hard',
  'estimated_total_tokens_formal',
  'estimated_total_tokens_hard',
  'hard_token_budget',
  'within_hard_token_budget'
]);

function escaped(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactEvaluationValue(value, secrets = []) {
  const secretValues = [...new Set(secrets.map(String).filter(Boolean))];
  if (typeof value === 'string') {
    let redacted = value.replace(KEY_LIKE_VALUE, '[REDACTED]');
    for (const secret of secretValues) {
      redacted = redacted.replace(new RegExp(escaped(secret), 'g'), '[REDACTED]');
    }
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactEvaluationValue(item, secretValues));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY.test(key) &&
        !((SAFE_TOKEN_COUNT_KEY.test(key) && typeof nested === 'number') ||
          (SAFE_BUDGET_KEYS.has(key) && (typeof nested === 'number' || typeof nested === 'boolean')))
        ? '[REDACTED]'
        : redactEvaluationValue(nested, secretValues)
    ])
  );
}

async function writePrivate(filePath, value, { exclusive = false } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, value, {
    encoding: 'utf8',
    mode: 0o600,
    flag: exclusive ? 'wx' : 'w'
  });
  await chmod(filePath, 0o600);
}

export class EvaluationCache {
  constructor({ directory, secrets = [] } = {}) {
    if (!path.isAbsolute(String(directory || ''))) {
      throw new Error('EVALUATION_CACHE_PATH_INVALID');
    }
    this.directory = directory;
    this.secrets = [...secrets];
    this.rawPath = path.join(directory, 'raw-cache.ndjson');
    this.markerPath = path.join(directory, 'formal-run-marker.json');
  }

  async beginFormalRun(manifest) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writePrivate(
        this.markerPath,
        `${JSON.stringify(redactEvaluationValue(manifest, this.secrets), null, 2)}\n`,
        { exclusive: true }
      );
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('FORMAL_EVALUATION_ALREADY_STARTED');
      throw error;
    }
  }

  async append(record) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const safe = redactEvaluationValue(record, this.secrets);
    await appendFile(this.rawPath, `${JSON.stringify(safe)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'a'
    });
    await chmod(this.rawPath, 0o600);
    return safe;
  }

  async readAll() {
    const bytes = await readFile(this.rawPath, 'utf8');
    return bytes.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  async writeJson(name, value) {
    const filePath = path.join(this.directory, name);
    await writePrivate(
      filePath,
      `${JSON.stringify(redactEvaluationValue(value, this.secrets), null, 2)}\n`
    );
    return filePath;
  }

  async writeText(name, value) {
    const filePath = path.join(this.directory, name);
    await writePrivate(filePath, redactEvaluationValue(String(value), this.secrets));
    return filePath;
  }
}

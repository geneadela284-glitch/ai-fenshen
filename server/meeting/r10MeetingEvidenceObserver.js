import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TARGET_SOURCE = 'de4106fcc5c8fd78';
const TARGET_OWNER = 'e8853c3d9cee1c03';
const ROOT = '/tmp/ai-fenshen-r10-duration-evidence';
const EXPIRES_AT = Date.now() + 30 * 60 * 1000;
let captured = false;
const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
function selected(session) {
  return Date.now() < EXPIRES_AT && hash(session.sourceId) === TARGET_SOURCE && hash(session.ownerId) === TARGET_OWNER;
}
function log(value) { console.log(`R10_SCOPED_EVIDENCE ${JSON.stringify(value)}`); }

export async function observeR10Source(session, traceId) {
  if (!selected(session) || captured || session.totalBytes > 8 * 1024 * 1024 || session.chunks.length > 64) return;
  try {
    fs.mkdirSync(ROOT, { mode: 0o700 });
    captured = true;
    const names = fs.readdirSync(session.directory).filter(name => /^(source|recorder-session-\d+|segment-\d+)\.(m4a|webm|wav)$/.test(name));
    let total = 0;
    const files = [];
    for (const name of names) {
      const sourcePath = path.join(session.directory, name);
      const stat = fs.lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('EVIDENCE_FILE_TYPE_INVALID');
      total += stat.size;
      if (total > 16 * 1024 * 1024) throw new Error('EVIDENCE_SIZE_LIMIT');
      fs.copyFileSync(sourcePath, path.join(ROOT, name), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(ROOT, name), 0o600);
      files.push({ name, byteLength: stat.size });
    }
    const index = new Map(session.chunks.map((chunk, i) => [chunk.sourceChunkId, i]));
    const manifest = {
      capturedAt: new Date().toISOString(), expiresAt: new Date(EXPIRES_AT).toISOString(), traceId,
      sourceIdHash: TARGET_SOURCE, ownerIdHash: TARGET_OWNER,
      source: { ...session.source, fileName: 'scoped-test-recording.m4a' },
      effectiveContainerLayout: session.effectiveContainerLayout,
      multipleFragmentedMp4Sessions: session.multipleFragmentedMp4Sessions,
      inputFile: path.basename(session.inputPath),
      chunks: session.chunks.map((chunk, i) => ({ ...chunk, sourceChunkId: `chunk-${i}` })),
      sessions: session.fragmentedMp4Sessions.map(s => ({ sequence: s.sequence, file: path.basename(s.inputPath), chunkSequences: s.sourceChunkIds.map(id => index.get(id)), durationMs: s.durationMs, byteLength: s.byteLength })),
      independentSegments: session.independentSegments.map(s => ({ sequence: s.sequence, file: path.basename(s.inputPath), durationMs: s.durationMs, byteLength: s.byteLength, checksum: s.checksum })),
      files
    };
    fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    log({ event: 'captured', traceId, sourceIdHash: TARGET_SOURCE, durationMs: manifest.source.durationMs, chunkCount: manifest.chunks.length, sessionCount: manifest.sessions.length, temporaryOnly: true });
  } catch (error) {
    log({ event: 'capture_failed', code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'EVIDENCE_CAPTURE_FAILED' });
  }
}

export function observeR10Duration(session, traceId, error, assembly) {
  if (!selected(session)) return;
  const entry = { event: 'duration_result', traceId, sourceIdHash: TARGET_SOURCE, declaredDurationMs: session.source.durationMs, decodedDurationMs: assembly?.source?.durationMs ?? error?.decodedDurationMs ?? null };
  for (const key of ['declaredDurationMs', 'decodedDurationMs', 'durationDifferenceMs', 'toleranceMs']) {
    if (Number.isFinite(error?.[key])) entry[key] = error[key];
  }
  if (error?.code && /^[A-Z0-9_]+$/.test(error.code)) entry.errorCode = error.code;
  if (['positive', 'negative', 'none'].includes(error?.driftDirection)) entry.driftDirection = error.driftDirection;
  log(entry);
  try { if (captured) fs.appendFileSync(path.join(ROOT, 'duration-results.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); } catch {}
}

const expire = () => { if (captured) { try { fs.rmSync(ROOT, { recursive: true }); } catch {} } };
setTimeout(expire, 30 * 60 * 1000).unref();
process.once('exit', expire);

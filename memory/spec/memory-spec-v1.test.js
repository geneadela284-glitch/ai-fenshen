import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MEMORY_KERNEL_ERROR_CODES, MemoryLifecycle } from '../kernel/index.js';
import {
  MEMORY_SPEC_RULES_V1,
  MEMORY_SPEC_VERSION,
  SPEC_LEVELS,
  SPEC_PROFILES,
  SPEC_STATUSES
} from './memory-spec-v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const specDir = path.join(root, 'docs/memory/spec');
const requiredDocuments = [
  'MEMORY_SPECIFICATION_V1.md',
  'MEMORY_SPEC_IMPLEMENTATION_MAP_V1.md',
  'MEMORY_STATE_TRANSITION_TABLE_V1.md',
  'MEMORY_ERROR_CATALOG_V1.md',
  'MEMORY_CONFORMANCE_PROFILES_V1.md',
  'MEMORY_SPEC_GAP_REPORT_V1.md',
  'MEMORY_SPEC_CHANGE_PROCESS.md',
  'MEMORY_SPEC_V1_ACCEPTANCE.md'
];

function readDocument(name) {
  return fs.readFileSync(path.join(specDir, name), 'utf8');
}

function idsIn(text) {
  return [...text.matchAll(/MEMV1-[KRP]-\d{3}/g)].map((match) => match[0]);
}

test('Memory Specification manifest freezes version 1.0.0', () => {
  assert.equal(MEMORY_SPEC_VERSION, '1.0.0');
  assert.ok(Object.isFrozen(MEMORY_SPEC_RULES_V1));
});

test('every rule has the exact required manifest fields', () => {
  const expected = [
    'specVersion', 'ruleId', 'level', 'category', 'description',
    'implementedBy', 'testedBy', 'status', 'profile', 'targetStage'
  ];
  for (const rule of MEMORY_SPEC_RULES_V1) {
    assert.deepEqual(Object.keys(rule).sort(), [...expected].sort(), rule.ruleId);
    assert.ok(Object.isFrozen(rule), rule.ruleId);
    assert.ok(Object.isFrozen(rule.implementedBy), rule.ruleId);
    assert.ok(Object.isFrozen(rule.testedBy), rule.ruleId);
  }
});

test('rule ids are stable and unique', () => {
  const ids = MEMORY_SPEC_RULES_V1.map((rule) => rule.ruleId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^MEMV1-[KRP]-\d{3}$/);
});

test('rule levels, profiles, statuses, and descriptions are valid', () => {
  for (const rule of MEMORY_SPEC_RULES_V1) {
    assert.ok(SPEC_LEVELS.includes(rule.level), rule.ruleId);
    assert.ok(SPEC_PROFILES.includes(rule.profile), rule.ruleId);
    assert.ok(SPEC_STATUSES.includes(rule.status), rule.ruleId);
    assert.equal(rule.specVersion, MEMORY_SPEC_VERSION, rule.ruleId);
    assert.match(rule.description, new RegExp(`\\b${rule.level.replace('_NOT', ' NOT')}\\b`), rule.ruleId);
    assert.ok(rule.category.trim(), rule.ruleId);
    assert.ok(rule.targetStage.trim(), rule.ruleId);
    assert.ok(rule.testedBy.length > 0, rule.ruleId);
    if (rule.status === 'implemented') assert.ok(rule.implementedBy.length > 0, rule.ruleId);
  }
});

test('manifest paths exist and future rules are not implemented', () => {
  for (const rule of MEMORY_SPEC_RULES_V1) {
    for (const relativePath of [...rule.implementedBy, ...rule.testedBy]) {
      assert.ok(fs.existsSync(path.join(root, relativePath)), `${rule.ruleId}: ${relativePath}`);
    }
    if (rule.status === 'future') assert.equal(rule.implementedBy.length, 0, rule.ruleId);
  }
});

test('all required specification documents exist and are non-empty', () => {
  for (const name of requiredDocuments) {
    const location = path.join(specDir, name);
    assert.ok(fs.existsSync(location), name);
    assert.ok(fs.statSync(location).size > 0, name);
  }
});

test('normative specification and implementation map cover exactly every rule id', () => {
  const manifestIds = MEMORY_SPEC_RULES_V1.map((rule) => rule.ruleId).sort();
  for (const name of ['MEMORY_SPECIFICATION_V1.md', 'MEMORY_SPEC_IMPLEMENTATION_MAP_V1.md']) {
    const documentIds = idsIn(readDocument(name)).sort();
    assert.deepEqual(documentIds, manifestIds, name);
  }
});

test('normative rows and implementation rows match the manifest exactly', () => {
  const specification = readDocument('MEMORY_SPECIFICATION_V1.md');
  const implementationMap = readDocument('MEMORY_SPEC_IMPLEMENTATION_MAP_V1.md');
  for (const rule of MEMORY_SPEC_RULES_V1) {
    const normativeRow = `| ${rule.ruleId} | ${rule.level.replace('_', ' ')} | ${rule.category} | ${rule.description} |`;
    assert.ok(specification.includes(normativeRow), rule.ruleId);
    const implementationRow = [
      rule.ruleId,
      rule.status,
      rule.targetStage,
      rule.implementedBy.join('<br>') || '—',
      rule.testedBy.join('<br>')
    ].join(' | ');
    assert.ok(implementationMap.includes(`| ${implementationRow} |`), rule.ruleId);
  }
});

test('state transition table covers the Kernel lifecycle exactly', () => {
  const table = readDocument('MEMORY_STATE_TRANSITION_TABLE_V1.md');
  const expected = Object.entries(MemoryLifecycle.transitions)
    .flatMap(([from, targets]) => targets.length ? targets.map((to) => `${from} -> ${to}`) : [`${from} -> NONE`])
    .sort();
  const actual = [...table.matchAll(/`([a-z_]+ -> (?:[a-z_]+|NONE))`/g)].map((match) => match[1]).sort();
  assert.deepEqual(actual, expected);
});

test('error catalog includes every Kernel and Persistence error code', () => {
  const catalog = readDocument('MEMORY_ERROR_CATALOG_V1.md');
  for (const code of MEMORY_KERNEL_ERROR_CODES) assert.match(catalog, new RegExp(`\\b${code}\\b`));
  const persistenceSource = fs.readFileSync(path.join(root, 'memory/persistence/errors.js'), 'utf8');
  const persistenceCodes = [...persistenceSource.matchAll(/\b(PERSISTENCE_[A-Z_]+):/g)].map((match) => match[1]);
  for (const code of persistenceCodes) assert.match(catalog, new RegExp(`\\b${code}\\b`));
});

test('acceptance document reports manifest rule and level counts', () => {
  const acceptance = readDocument('MEMORY_SPEC_V1_ACCEPTANCE.md');
  const counts = Object.fromEntries(SPEC_LEVELS.map((level) => [
    level,
    MEMORY_SPEC_RULES_V1.filter((rule) => rule.level === level).length
  ]));
  assert.match(acceptance, new RegExp(`Rules: ${MEMORY_SPEC_RULES_V1.length}\\b`));
  for (const [level, count] of Object.entries(counts)) {
    assert.match(acceptance, new RegExp(`${level}: ${count}\\b`));
  }
});

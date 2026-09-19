export const ENTITY_V2_SHADOW_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;

CREATE TABLE IF NOT EXISTS entities (
  owner_user_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  entity_role TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, entity_id)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  owner_user_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, alias, entity_id),
  FOREIGN KEY (owner_user_id, entity_id)
    REFERENCES entities (owner_user_id, entity_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS entity_relations (
  owner_user_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation_kind TEXT NOT NULL,
  role TEXT NOT NULL,
  effective_from_ms INTEGER NOT NULL,
  effective_to_ms INTEGER,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, relation_id),
  FOREIGN KEY (owner_user_id, source_entity_id)
    REFERENCES entities (owner_user_id, entity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_user_id, target_entity_id)
    REFERENCES entities (owner_user_id, entity_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS memory_records_v2 (
  owner_user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  subject_entity_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, memory_id),
  FOREIGN KEY (owner_user_id, subject_entity_id)
    REFERENCES entities (owner_user_id, entity_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS entity_idempotency (
  owner_user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, namespace, idempotency_key)
);

CREATE TABLE IF NOT EXISTS entity_uow_receipts (
  owner_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_one_active_self
  ON entities (owner_user_id)
  WHERE status = 'active' AND entity_role = 'self';
CREATE INDEX IF NOT EXISTS idx_entities_owner_entity
  ON entities (owner_user_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_aliases_owner_alias
  ON entity_aliases (owner_user_id, alias, status, entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_owner_source_kind_effective
  ON entity_relations (
    owner_user_id, source_entity_id, relation_kind,
    effective_from_ms, effective_to_ms, status
  );
CREATE INDEX IF NOT EXISTS idx_memories_owner_entity_predicate_status
  ON memory_records_v2 (owner_user_id, subject_entity_id, predicate, status, memory_id);
`;

export function initializeEntityV2ShadowSchema(database) {
  database.exec(ENTITY_V2_SHADOW_SQL);
  database.exec('PRAGMA foreign_keys = ON');
  const enabled = database.prepare('PRAGMA foreign_keys').get()?.foreign_keys;
  if (enabled !== 1) throw new Error('SQLite foreign_keys could not be enabled.');
}

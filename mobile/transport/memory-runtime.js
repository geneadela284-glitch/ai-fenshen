(() => {
  // memory/mobile/nativeCrypto.js
  var host = () => globalThis.__memoryCrypto;
  var nativeCrypto_default = {
    createHash(algorithm) {
      if (algorithm !== "sha256") throw new Error("Unsupported digest");
      let text = "";
      return { update(value) {
        text += String(value);
        return this;
      }, digest(format) {
        if (format !== "hex") throw new Error("Unsupported digest encoding");
        return host().sha256(text);
      } };
    },
    randomUUID: () => host().uuid(),
    randomBytes: (count) => ({ toString(format) {
      if (format !== "hex") throw new Error("Unsupported random encoding");
      const value = host().randomHex(count);
      if (typeof value !== "string" || value.length !== count * 2) throw new Error("Secure random failed");
      return value;
    } })
  };

  // memory/entity/contracts.js
  var ENTITY_MODEL_SCHEMA_VERSION = "v2";
  var ENTITY_ID_PATTERN = /^ent_[0-9a-f]{32}$/;
  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }
  function schema(name, fields, required3 = fields) {
    return Object.freeze({
      name,
      schemaVersion: ENTITY_MODEL_SCHEMA_VERSION,
      fields: Object.freeze([...fields]),
      required: Object.freeze([...required3]),
      unknownFieldPolicy: "reject"
    });
  }
  var ENTITY_TYPES = Object.freeze([
    "person",
    "organization",
    "event",
    "place",
    "project",
    "other"
  ]);
  var ENTITY_STATUSES = Object.freeze([
    "candidate",
    "active",
    "merged",
    "archived",
    "deleted"
  ]);
  var ENTITY_ALIAS_STATUSES = Object.freeze([
    "active",
    "inactive",
    "disputed",
    "deleted"
  ]);
  var ENTITY_RELATION_STATUSES = Object.freeze([
    "active",
    "ended",
    "disputed",
    "deleted"
  ]);
  var ENTITY_RESOLUTION_STATUSES = Object.freeze([
    "exact",
    "ambiguous",
    "no_match"
  ]);
  var MEMORY_DECISIONS = Object.freeze([
    "answer_only",
    "ignore",
    "temporary_context",
    "store_silently",
    "confirm_before_store",
    "business_record"
  ]);
  var MEMORY_DECISION_TYPES = Object.freeze([
    "fact",
    "relationship",
    "preference",
    "goal",
    "life_event",
    "habit_candidate",
    "decision",
    "constraint",
    "temporary_context",
    "financial_record",
    "schedule_record",
    "health_record"
  ]);
  var MEMORY_DECISION_RETENTION_MODES = Object.freeze([
    "none",
    "session",
    "ttl",
    "long_term",
    "business_record"
  ]);
  var MEMORY_DECISION_ACKNOWLEDGEMENT_POLICIES = Object.freeze([
    "none",
    "silent",
    "after_commit"
  ]);
  var MEMORY_DECISION_RESPONSE_POLICIES = Object.freeze([
    "none",
    "answer_only",
    "financial_report_opt_in_advice",
    "silent",
    "request_confirmation",
    "acknowledge_only_after_commit"
  ]);
  var MEMORY_V2_STATUSES = Object.freeze([
    "candidate",
    "pending_confirmation",
    "confirmed",
    "disputed",
    "superseded",
    "expired",
    "archived",
    "deleted"
  ]);
  var MEMORY_V2_CONFIRMATION_STATUSES = Object.freeze([
    "not_required",
    "pending",
    "user_confirmed",
    "user_rejected",
    "system_verified"
  ]);
  var MEMORY_V2_SENSITIVITIES = Object.freeze([
    "public",
    "low",
    "medium",
    "high",
    "restricted"
  ]);
  var MEMORY_V2_PROVENANCE_LEVELS = Object.freeze([
    "user_stated",
    "user_confirmed",
    "system_verified",
    "ai_inferred",
    "imported_unverified"
  ]);
  var ENTITY_SOURCE_FIELDS = Object.freeze(["type", "id"]);
  var EntitySource = schema("EntitySource", ENTITY_SOURCE_FIELDS);
  var ENTITY_FIELDS = Object.freeze([
    "schemaVersion",
    "entityId",
    "ownerUserId",
    "type",
    "status",
    "version",
    "source",
    "checksum",
    "createdAt",
    "updatedAt",
    "metadata"
  ]);
  var Entity = schema("Entity", ENTITY_FIELDS);
  var ENTITY_ALIAS_FIELDS = Object.freeze([
    "schemaVersion",
    "alias",
    "entityId",
    "ownerUserId",
    "source",
    "confidence",
    "status",
    "version",
    "createdAt",
    "updatedAt",
    "metadata"
  ]);
  var EntityAlias = schema("EntityAlias", ENTITY_ALIAS_FIELDS);
  var ENTITY_RELATION_FIELDS = Object.freeze([
    "schemaVersion",
    "relationId",
    "ownerUserId",
    "sourceEntityId",
    "targetEntityId",
    "relationKind",
    "role",
    "effectiveFrom",
    "effectiveTo",
    "status",
    "version",
    "source",
    "checksum",
    "createdAt",
    "updatedAt",
    "metadata"
  ]);
  var EntityRelation = schema("EntityRelation", ENTITY_RELATION_FIELDS);
  var MEMORY_RECORD_V2_FIELDS = Object.freeze([
    "memoryId",
    "schemaVersion",
    "ownerUserId",
    "memoryType",
    "subjectEntityId",
    "predicate",
    "structuredValue",
    "displayValue",
    "legacySubject",
    "source",
    "provenance",
    "sourceTimestamp",
    "createdAt",
    "updatedAt",
    "effectiveFrom",
    "effectiveTo",
    "confidence",
    "importance",
    "sensitivity",
    "status",
    "confirmationStatus",
    "expiresAt",
    "version",
    "supersedesId",
    "supersededById",
    "conflictGroupId",
    "retentionPolicy",
    "accessPolicy",
    "checksum",
    "tags",
    "metadata"
  ]);
  var MEMORY_RECORD_V2_REQUIRED_FIELDS = Object.freeze([
    "memoryId",
    "schemaVersion",
    "ownerUserId",
    "memoryType",
    "subjectEntityId",
    "predicate",
    "structuredValue",
    "source",
    "provenance",
    "sourceTimestamp",
    "createdAt",
    "updatedAt",
    "effectiveFrom",
    "confidence",
    "importance",
    "sensitivity",
    "status",
    "confirmationStatus",
    "version",
    "retentionPolicy",
    "accessPolicy",
    "checksum",
    "metadata"
  ]);
  var MemoryRecordV2 = schema(
    "MemoryRecordV2",
    MEMORY_RECORD_V2_FIELDS,
    MEMORY_RECORD_V2_REQUIRED_FIELDS
  );
  var MEMORY_RECORD_V2_CHECKSUM_FIELDS = Object.freeze([
    "memoryId",
    "ownerUserId",
    "subjectEntityId",
    "predicate",
    "structuredValue",
    "provenance",
    "version"
  ]);
  var PREDICATE_STRUCTURED_VALUE_SCHEMAS = deepFreeze({
    fact_statement: {
      fields: ["value"],
      required: ["value"],
      fieldTypes: { value: "string" },
      cardinality: "multiple",
      unknownFieldPolicy: "reject"
    },
    birthday: {
      fields: ["date", "calendarType", "year", "month", "day", "lunarLeapMonth", "recurrence"],
      required: ["date"],
      fieldTypes: {
        date: "iso-date",
        calendarType: "calendar-type",
        year: "year-or-null",
        month: "month",
        day: "day",
        lunarLeapMonth: "lunar-leap-month",
        recurrence: "recurrence"
      },
      unknownFieldPolicy: "reject"
    },
    preference_statement: {
      fields: ["value", "values"],
      required: ["value"],
      fieldTypes: { value: "string", values: "string-array" },
      unknownFieldPolicy: "reject"
    },
    favorite_preference_statement: {
      fields: ["value"],
      required: ["value"],
      fieldTypes: { value: "string" },
      unknownFieldPolicy: "reject"
    }
  });
  var ENTITY_RESOLUTION_FIELDS = Object.freeze([
    "schemaVersion",
    "resolutionStatus",
    "ownerUserId",
    "entityType",
    "entityId",
    "relationKind",
    "role",
    "predicate",
    "candidateEntityIds",
    "sourceRelationIds",
    "resolutionReason",
    "policyVersion",
    "resolvedAt"
  ]);
  var EntityResolution = schema("EntityResolution", ENTITY_RESOLUTION_FIELDS);
  var MEMORY_DECISION_FIELDS = Object.freeze([
    "schemaVersion",
    "decision",
    "memoryType",
    "ownerUserId",
    "subjectEntityId",
    "predicate",
    "confidence",
    "importance",
    "sensitivity",
    "retentionPolicy",
    "reasonCodes",
    "sourceTextDigest",
    "entityResolutionStatus",
    "confirmationRequired",
    "acknowledgementPolicy",
    "duplicateCheckRequired",
    "suggestedStructuredValue",
    "responsePolicy",
    "policyVersion",
    "decidedAt"
  ]);
  var MemoryDecision = schema("MemoryDecision", MEMORY_DECISION_FIELDS);

  // memory/entity/validation.js
  var RELATION_ID_PATTERN = /^rel_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
  var SHA256_PATTERN = /^[a-f0-9]{64}$/i;
  function issue(path, code, message) {
    return Object.freeze({ path, code, message });
  }
  function result(errors = [], warnings = []) {
    return { valid: errors.length === 0, errors, warnings };
  }
  function object(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }
  function isoDate(value) {
    return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
  }
  function isoCalendarDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return false;
    const [, year, month, day] = match.map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }
  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!object(value)) return value;
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  function canonicalSerializeMemoryRecordV2ChecksumInput(value) {
    const payload = {};
    for (const field of MEMORY_RECORD_V2_CHECKSUM_FIELDS) {
      payload[field] = field === "structuredValue" ? canonicalize(value?.[field]) : value?.[field];
    }
    return JSON.stringify(payload);
  }
  function computeMemoryRecordV2Checksum(value) {
    return nativeCrypto_default.createHash("sha256").update(canonicalSerializeMemoryRecordV2ChecksumInput(value)).digest("hex");
  }
  function validateShape(value, contract, errors) {
    if (!object(value)) {
      errors.push(issue("", "INVALID_TYPE", `${contract.name} must be an object.`));
      return false;
    }
    for (const field of contract.required) {
      if (!(field in value) || value[field] === void 0) {
        errors.push(issue(field, "REQUIRED", `${field} is required.`));
      }
    }
    for (const field of Object.keys(value)) {
      if (!contract.fields.includes(field)) {
        errors.push(issue(field, "UNKNOWN_FIELD", `Unknown field: ${field}`));
      }
    }
    return true;
  }
  function validateSchemaVersion(value, errors) {
    if (value !== ENTITY_MODEL_SCHEMA_VERSION) {
      errors.push(issue("schemaVersion", "UNSUPPORTED_SCHEMA_VERSION", "schemaVersion must be v2."));
    }
  }
  function validateOwner(ownerUserId, trustedOwnerUserId, errors) {
    if (!nonEmptyString(ownerUserId)) {
      errors.push(issue("ownerUserId", "REQUIRED", "ownerUserId is required."));
    }
    if (!nonEmptyString(trustedOwnerUserId)) {
      errors.push(issue("ownerUserId", "OWNER_SCOPE_REQUIRED", "trustedOwnerUserId is required."));
    } else if (nonEmptyString(ownerUserId) && ownerUserId !== trustedOwnerUserId) {
      errors.push(issue("ownerUserId", "OWNER_SCOPE_MISMATCH", "ownerUserId must match trusted context."));
    }
  }
  function validateEnum(value, allowed, path, errors) {
    if (!allowed.includes(value)) errors.push(issue(path, "INVALID_ENUM", `${path} is invalid.`));
  }
  function validateEntityId(value, path, errors, { requiredCode = "ENTITY_ID_INVALID" } = {}) {
    if (!ENTITY_ID_PATTERN.test(String(value || ""))) {
      errors.push(issue(path, requiredCode, `${path} must be an opaque Entity ID.`));
    }
  }
  function validateRelationId(value, path, errors) {
    if (!RELATION_ID_PATTERN.test(String(value || ""))) {
      errors.push(issue(path, "RELATION_ID_INVALID", `${path} must be an opaque Relation ID.`));
    }
  }
  function validateVersion(value, path, errors) {
    if (!Number.isInteger(value) || value < 1) {
      errors.push(issue(path, "INVALID_NUMBER", `${path} must be a positive integer.`));
    }
  }
  function validateChecksum(value, path, errors) {
    if (!SHA256_PATTERN.test(String(value || ""))) {
      errors.push(issue(path, "CHECKSUM_INVALID", `${path} must be a SHA-256 hex digest.`));
    }
  }
  function validateRequiredDate(value, path, errors) {
    if (!isoDate(value)) errors.push(issue(path, "INVALID_DATE", `${path} must be an ISO date.`));
  }
  function validateOptionalDate(value, path, errors) {
    if (value !== null && value !== void 0 && !isoDate(value)) {
      errors.push(issue(path, "INVALID_DATE", `${path} must be an ISO date or null.`));
    }
  }
  function validateUnitNumber(value, path, errors) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(issue(path, "INVALID_NUMBER", `${path} must be between zero and one.`));
    }
  }
  function validateStructuredValue(predicate, value, errors) {
    const schema3 = PREDICATE_STRUCTURED_VALUE_SCHEMAS[predicate];
    if (!schema3) {
      errors.push(issue("predicate", "PREDICATE_SCHEMA_MISSING", "predicate must have a registered structuredValue schema."));
      return;
    }
    if (!object(value)) {
      errors.push(issue("structuredValue", "INVALID_TYPE", "structuredValue must be an object."));
      return;
    }
    for (const field of schema3.required) {
      if (!(field in value) || value[field] === void 0) {
        errors.push(issue(`structuredValue.${field}`, "REQUIRED", `${field} is required.`));
      }
    }
    for (const field of Object.keys(value)) {
      if (!schema3.fields.includes(field)) {
        errors.push(issue(`structuredValue.${field}`, "UNKNOWN_FIELD", `Unknown structuredValue field: ${field}`));
      }
    }
    for (const [field, type] of Object.entries(schema3.fieldTypes)) {
      if (field in value && type === "iso-date" && !isoCalendarDate(value[field])) {
        errors.push(issue(`structuredValue.${field}`, "INVALID_TYPE", `${field} must be a valid YYYY-MM-DD calendar date.`));
      } else if (field in value && type === "calendar-type" && !["gregorian", "lunar", "unknown"].includes(value[field])) {
        errors.push(issue(`structuredValue.${field}`, "INVALID_TYPE", `${field} must be gregorian, lunar, or unknown.`));
      } else if (field in value && type === "year-or-null" && value[field] !== null && (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 9999)) {
        errors.push(issue(`structuredValue.${field}`, "INVALID_TYPE", `${field} must be a valid year or null.`));
      } else if (field in value && type === "month" && (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 12)) {
        errors.push(issue(`structuredValue.${field}`, "INVALID_TYPE", `${field} must be a valid month.`));
      } else if (field in value && type === "day" && (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 31)) {
        errors.push(issue(`structuredValue.${field}`, "INVALID_TYPE", `${field} must be a valid day.`));
      } else if (field in value && type === "lunar-leap-month" && ![true, false, "unknown"].includes(value[field])) {
        errors.push(issue(`structuredValue.${field}`, "INVALID_TYPE", `${field} must be boolean or unknown.`));
      } else if (field in value && type === "recurrence" && !["yearly", "one_time", "unknown"].includes(value[field])) {
        errors.push(issue(`structuredValue.${field}`, "INVALID_TYPE", `${field} is invalid.`));
      } else if (field in value && type === "string" && !nonEmptyString(value[field])) {
        errors.push(issue(`structuredValue.${field}`, "INVALID_TYPE", `${field} must be a non-empty string.`));
      } else if (field in value && type === "string-array" && (!Array.isArray(value[field]) || value[field].length === 0 || !value[field].every(nonEmptyString) || new Set(value[field].map((item) => item.trim())).size !== value[field].length)) {
        errors.push(issue(`structuredValue.${field}`, "INVALID_TYPE", `${field} must be a non-empty array of unique strings.`));
      }
    }
    if (value.calendarType !== "lunar" && value.lunarLeapMonth !== void 0 && value.lunarLeapMonth !== "unknown") {
      errors.push(issue("structuredValue.lunarLeapMonth", "INVARIANT_VIOLATION", "lunarLeapMonth requires lunar calendarType."));
    }
    if (value.calendarType === "lunar" && Number.isInteger(value.day) && value.day > 30) {
      errors.push(issue("structuredValue.day", "INVALID_TYPE", "Lunar day cannot exceed 30."));
    }
  }
  function prefixErrors(errors, prefix) {
    return errors.map((error) => issue(
      error.path ? `${prefix}.${error.path}` : prefix,
      error.code,
      error.message
    ));
  }
  function validateSource(source) {
    const errors = [];
    if (!validateShape(source, EntitySource, errors)) return result(errors);
    for (const field of ["type", "id"]) {
      if (!nonEmptyString(source[field])) errors.push(issue(field, "SOURCE_REQUIRED", `${field} is required.`));
    }
    return result(errors);
  }
  function validateAuditFields(value, errors) {
    validateVersion(value.version, "version", errors);
    validateChecksum(value.checksum, "checksum", errors);
    validateRequiredDate(value.createdAt, "createdAt", errors);
    validateRequiredDate(value.updatedAt, "updatedAt", errors);
    if (isoDate(value.createdAt) && isoDate(value.updatedAt) && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
      errors.push(issue("updatedAt", "INVALID_RANGE", "updatedAt cannot be before createdAt."));
    }
    if (!object(value.metadata)) errors.push(issue("metadata", "INVALID_TYPE", "metadata must be an object."));
    errors.push(...prefixErrors(validateSource(value.source).errors, "source"));
  }
  function validateEntity(value, { trustedOwnerUserId } = {}) {
    const errors = [];
    if (!validateShape(value, Entity, errors)) return result(errors);
    validateSchemaVersion(value.schemaVersion, errors);
    validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
    validateEntityId(value.entityId, "entityId", errors);
    validateEnum(value.type, ENTITY_TYPES, "type", errors);
    validateEnum(value.status, ENTITY_STATUSES, "status", errors);
    validateAuditFields(value, errors);
    return result(errors);
  }
  function validateEntityAlias(value, { trustedOwnerUserId } = {}) {
    const errors = [];
    if (!validateShape(value, EntityAlias, errors)) return result(errors);
    validateSchemaVersion(value.schemaVersion, errors);
    validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
    if (!nonEmptyString(value.alias)) errors.push(issue("alias", "REQUIRED", "alias is required."));
    validateEntityId(value.entityId, "entityId", errors);
    validateUnitNumber(value.confidence, "confidence", errors);
    validateEnum(value.status, ENTITY_ALIAS_STATUSES, "status", errors);
    validateVersion(value.version, "version", errors);
    validateRequiredDate(value.createdAt, "createdAt", errors);
    validateRequiredDate(value.updatedAt, "updatedAt", errors);
    if (!object(value.metadata)) errors.push(issue("metadata", "INVALID_TYPE", "metadata must be an object."));
    errors.push(...prefixErrors(validateSource(value.source).errors, "source"));
    return result(errors);
  }
  function validateEntityRelation(value, { trustedOwnerUserId } = {}) {
    const errors = [];
    if (!validateShape(value, EntityRelation, errors)) return result(errors);
    validateSchemaVersion(value.schemaVersion, errors);
    validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
    validateRelationId(value.relationId, "relationId", errors);
    validateEntityId(value.sourceEntityId, "sourceEntityId", errors);
    validateEntityId(value.targetEntityId, "targetEntityId", errors);
    if (value.sourceEntityId === value.targetEntityId) {
      errors.push(issue("targetEntityId", "INVARIANT_VIOLATION", "A relation cannot target its source Entity."));
    }
    for (const field of ["relationKind", "role"]) {
      if (!nonEmptyString(value[field])) errors.push(issue(field, "REQUIRED", `${field} is required.`));
    }
    validateRequiredDate(value.effectiveFrom, "effectiveFrom", errors);
    validateOptionalDate(value.effectiveTo, "effectiveTo", errors);
    if (isoDate(value.effectiveFrom) && isoDate(value.effectiveTo) && Date.parse(value.effectiveTo) <= Date.parse(value.effectiveFrom)) {
      errors.push(issue("effectiveTo", "INVALID_RANGE", "effectiveTo must be after effectiveFrom."));
    }
    validateEnum(value.status, ENTITY_RELATION_STATUSES, "status", errors);
    validateAuditFields(value, errors);
    return result(errors);
  }
  function validateEntityResolution(value, { trustedOwnerUserId } = {}) {
    const errors = [];
    if (!validateShape(value, EntityResolution, errors)) return result(errors);
    validateSchemaVersion(value.schemaVersion, errors);
    validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
    validateEnum(value.resolutionStatus, ENTITY_RESOLUTION_STATUSES, "resolutionStatus", errors);
    validateEnum(value.entityType, ENTITY_TYPES, "entityType", errors);
    for (const field of ["relationKind", "role", "predicate"]) {
      if (value[field] !== null && !nonEmptyString(value[field])) {
        errors.push(issue(field, "INVALID_TYPE", `${field} must be a non-empty string or null.`));
      }
    }
    if (!Array.isArray(value.candidateEntityIds)) {
      errors.push(issue("candidateEntityIds", "INVALID_TYPE", "candidateEntityIds must be an array."));
    } else {
      value.candidateEntityIds.forEach((id) => validateEntityId(id, "candidateEntityIds", errors));
    }
    if (!Array.isArray(value.sourceRelationIds) || value.sourceRelationIds.some((id) => !nonEmptyString(id))) {
      errors.push(issue("sourceRelationIds", "INVALID_TYPE", "sourceRelationIds must be an array of non-empty strings."));
    }
    for (const field of ["resolutionReason", "policyVersion"]) {
      if (!nonEmptyString(value[field])) errors.push(issue(field, "REQUIRED", `${field} is required.`));
    }
    validateRequiredDate(value.resolvedAt, "resolvedAt", errors);
    const candidateIds = Array.isArray(value.candidateEntityIds) ? [...new Set(value.candidateEntityIds)] : [];
    if (value.resolutionStatus === "exact") {
      validateEntityId(value.entityId, "entityId", errors);
      if (candidateIds.length > 0) {
        errors.push(issue("candidateEntityIds", "RESOLUTION_AMBIGUOUS", "Exact resolution cannot retain candidate Entity IDs."));
      }
    } else if (value.resolutionStatus === "ambiguous") {
      if (value.entityId !== null) errors.push(issue("entityId", "RESOLUTION_AMBIGUOUS", "Ambiguous resolution cannot select an Entity."));
      if (candidateIds.length < 2) errors.push(issue("candidateEntityIds", "RESOLUTION_AMBIGUOUS", "Ambiguous resolution requires multiple Entity candidates."));
    } else if (value.resolutionStatus === "no_match") {
      if (value.entityId !== null) errors.push(issue("entityId", "INVARIANT_VIOLATION", "No-match resolution cannot select an Entity."));
      if (candidateIds.length !== 0) errors.push(issue("candidateEntityIds", "INVARIANT_VIOLATION", "No-match resolution cannot retain candidates."));
    }
    return result(errors);
  }
  function validateMemoryRecordV2(value, { trustedOwnerUserId, resolution } = {}) {
    const errors = [];
    if (!validateShape(value, MemoryRecordV2, errors)) return result(errors);
    validateSchemaVersion(value.schemaVersion, errors);
    validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
    for (const field of ["memoryId", "memoryType", "predicate"]) {
      if (!nonEmptyString(value[field])) errors.push(issue(field, "REQUIRED", `${field} is required.`));
    }
    if (!nonEmptyString(value.subjectEntityId)) {
      errors.push(issue("subjectEntityId", "SUBJECT_ENTITY_REQUIRED", "Confirmed MemoryRecordV2 requires subjectEntityId."));
    } else {
      validateEntityId(value.subjectEntityId, "subjectEntityId", errors);
    }
    validateStructuredValue(value.predicate, value.structuredValue, errors);
    if (value.displayValue !== null && value.displayValue !== void 0 && !nonEmptyString(value.displayValue)) errors.push(issue("displayValue", "INVALID_TYPE", "displayValue must be a string or null."));
    if (value.legacySubject !== null && value.legacySubject !== void 0 && !nonEmptyString(value.legacySubject)) errors.push(issue("legacySubject", "INVALID_TYPE", "legacySubject must be a string or null."));
    validateEnum(value.status, MEMORY_V2_STATUSES, "status", errors);
    validateEnum(value.confirmationStatus, MEMORY_V2_CONFIRMATION_STATUSES, "confirmationStatus", errors);
    validateEnum(value.provenance, MEMORY_V2_PROVENANCE_LEVELS, "provenance", errors);
    validateEnum(value.sensitivity, MEMORY_V2_SENSITIVITIES, "sensitivity", errors);
    validateUnitNumber(value.confidence, "confidence", errors);
    validateUnitNumber(value.importance, "importance", errors);
    for (const field of ["sourceTimestamp", "createdAt", "updatedAt", "effectiveFrom"]) validateRequiredDate(value[field], field, errors);
    for (const field of ["effectiveTo", "expiresAt"]) validateOptionalDate(value[field], field, errors);
    if (isoDate(value.effectiveFrom) && isoDate(value.effectiveTo) && Date.parse(value.effectiveTo) <= Date.parse(value.effectiveFrom)) {
      errors.push(issue("effectiveTo", "INVALID_RANGE", "effectiveTo must be after effectiveFrom."));
    }
    validateVersion(value.version, "version", errors);
    validateChecksum(value.checksum, "checksum", errors);
    if (SHA256_PATTERN.test(String(value.checksum || "")) && value.checksum !== computeMemoryRecordV2Checksum(value)) {
      errors.push(issue("checksum", "CHECKSUM_MISMATCH", "checksum does not match canonical MemoryRecordV2 input."));
    }
    errors.push(...prefixErrors(validateSource(value.source).errors, "source"));
    for (const field of ["retentionPolicy", "accessPolicy", "metadata"]) {
      if (!object(value[field])) errors.push(issue(field, "INVALID_TYPE", `${field} must be an object.`));
    }
    if (value.tags !== void 0 && value.tags !== null && (!Array.isArray(value.tags) || value.tags.some((tag) => !nonEmptyString(tag)))) {
      errors.push(issue("tags", "INVALID_TYPE", "tags must be an array of non-empty strings."));
    }
    for (const field of ["supersedesId", "supersededById", "conflictGroupId"]) {
      if (value[field] !== null && value[field] !== void 0 && !nonEmptyString(value[field])) errors.push(issue(field, "INVALID_TYPE", `${field} must be a string or null.`));
    }
    if (resolution !== void 0) {
      const resolutionValidation = validateEntityResolution(resolution, { trustedOwnerUserId });
      if (!resolutionValidation.valid || resolution.resolutionStatus !== "exact") {
        errors.push(issue("resolution", "RESOLUTION_EXACT_REQUIRED", "Only exact Entity resolution can authorize a MemoryRecordV2 write."));
      } else if (resolution.entityId !== value.subjectEntityId) {
        errors.push(issue("subjectEntityId", "ENTITY_SCOPE_MISMATCH", "Memory subjectEntityId must match the resolved Entity."));
      }
    }
    return result(errors);
  }
  function validateEntityScopedRecordSet(records, { trustedOwnerUserId, subjectEntityId, predicate } = {}) {
    const errors = [];
    if (!Array.isArray(records)) return result([issue("records", "INVALID_TYPE", "records must be an array.")]);
    validateEntityId(subjectEntityId, "subjectEntityId", errors);
    if (!nonEmptyString(predicate)) errors.push(issue("predicate", "REQUIRED", "predicate is required."));
    records.forEach((record, index) => {
      const recordValidation = validateMemoryRecordV2(record, { trustedOwnerUserId });
      errors.push(...prefixErrors(recordValidation.errors, `records[${index}]`));
      if (record.ownerUserId !== trustedOwnerUserId) {
        errors.push(issue(`records[${index}].ownerUserId`, "OWNER_SCOPE_MISMATCH", "Record owner is outside the trusted scope."));
      }
      if (record.subjectEntityId !== subjectEntityId) {
        errors.push(issue(`records[${index}].subjectEntityId`, "ENTITY_SCOPE_MISMATCH", "Record Entity is outside the exact scope."));
      }
      if (record.predicate !== predicate) {
        errors.push(issue(`records[${index}].predicate`, "PREDICATE_SCOPE_MISMATCH", "Record predicate is outside the exact scope."));
      }
    });
    return result(errors);
  }

  // memory/entity/kernel.js
  function deepFreeze2(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze2(child);
    return Object.freeze(value);
  }
  var EntityKernelValidationError = class extends TypeError {
    constructor(issues) {
      super("Entity Model V2 Kernel rejected an invalid contract value.");
      this.name = "EntityKernelValidationError";
      this.code = "ENTITY_KERNEL_VALIDATION_FAILED";
      this.issues = Object.freeze([...issues]);
    }
  };
  function materialize(value, validator, options, prepare = (candidate) => candidate) {
    const candidate = prepare(structuredClone(value));
    const validation = validator(candidate, options);
    if (!validation.valid) throw new EntityKernelValidationError(validation.errors);
    return deepFreeze2(candidate);
  }
  function createEntity(value, options = {}) {
    return materialize(value, validateEntity, options);
  }
  function createEntityAlias(value, options = {}) {
    return materialize(value, validateEntityAlias, options);
  }
  function createEntityRelation(value, options = {}) {
    return materialize(value, validateEntityRelation, options);
  }
  function createMemoryRecordV2(value, options = {}) {
    return materialize(value, validateMemoryRecordV2, options, (candidate) => {
      candidate.checksum = computeMemoryRecordV2Checksum(candidate);
      return candidate;
    });
  }

  // memory/entity/inMemoryFoundationState.js
  var EntityFoundationError = class extends Error {
    constructor(code, message) {
      super(message);
      this.name = "EntityFoundationError";
      this.code = code;
    }
  };
  function createFoundationState() {
    return {
      entities: /* @__PURE__ */ new Map(),
      aliases: /* @__PURE__ */ new Map(),
      relations: /* @__PURE__ */ new Map(),
      memories: /* @__PURE__ */ new Map(),
      memoryScopeIndex: /* @__PURE__ */ new Map(),
      selfByOwner: /* @__PURE__ */ new Map(),
      idempotency: /* @__PURE__ */ new Map(),
      unitOfWorkIdempotency: /* @__PURE__ */ new Map()
    };
  }
  function cloneFoundationState(state) {
    return structuredClone(state);
  }
  function deepFreeze3(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze3(child);
    return Object.freeze(value);
  }
  function immutableCopy(value) {
    if (value === null || value === void 0) return value;
    return deepFreeze3(structuredClone(value));
  }
  function assertOwnerUserId(ownerUserId) {
    if (typeof ownerUserId !== "string" || ownerUserId.trim().length === 0) {
      throw new EntityFoundationError("OWNER_SCOPE_REQUIRED", "ownerUserId is required.");
    }
  }
  function assertOwnerScope(scopeOwnerUserId, ownerUserId) {
    assertOwnerUserId(ownerUserId);
    if (scopeOwnerUserId !== null && scopeOwnerUserId !== ownerUserId) {
      throw new EntityFoundationError("OWNER_SCOPE_MISMATCH", "ownerUserId is outside the Unit of Work scope.");
    }
  }
  function assertOwnerMatch(trustedOwnerUserId, recordOwnerUserId) {
    assertOwnerUserId(trustedOwnerUserId);
    if (trustedOwnerUserId !== recordOwnerUserId) {
      throw new EntityFoundationError("OWNER_SCOPE_MISMATCH", "record ownerUserId does not match trusted scope.");
    }
  }
  function assertOpaqueEntityId(entityId) {
    if (!ENTITY_ID_PATTERN.test(String(entityId || ""))) {
      throw new EntityFoundationError("ENTITY_ID_INVALID", "entityId must be an opaque Entity ID.");
    }
  }
  function assertAllowedFilters(filters, allowed) {
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
      throw new EntityFoundationError("FILTERS_INVALID", "filters must be an object.");
    }
    const unknown = Object.keys(filters).find((field) => !allowed.includes(field));
    if (unknown) {
      throw new EntityFoundationError("UNKNOWN_FILTER", `Unknown query filter: ${unknown}.`);
    }
  }
  function entityKey(ownerUserId, entityId) {
    return JSON.stringify([ownerUserId, entityId]);
  }
  function aliasKey(ownerUserId, alias, entityId) {
    return JSON.stringify([ownerUserId, alias, entityId]);
  }
  function relationKey(ownerUserId, relationId) {
    return JSON.stringify([ownerUserId, relationId]);
  }
  function memoryKey(ownerUserId, memoryId) {
    return JSON.stringify([ownerUserId, memoryId]);
  }
  function memoryScopeKey(ownerUserId, subjectEntityId, predicate) {
    return JSON.stringify([ownerUserId, subjectEntityId, predicate]);
  }
  function canonicalize2(value) {
    if (Array.isArray(value)) return value.map(canonicalize2);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize2(value[key])]));
  }
  function digest(value) {
    return nativeCrypto_default.createHash("sha256").update(JSON.stringify(canonicalize2(value))).digest("hex");
  }
  function runIdempotent(state, namespace, ownerUserId, idempotencyKey, payload, operation) {
    if (idempotencyKey === void 0 || idempotencyKey === null) return operation();
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new EntityFoundationError("IDEMPOTENCY_KEY_INVALID", "idempotencyKey must be a non-empty string.");
    }
    const key = JSON.stringify([namespace, ownerUserId, idempotencyKey]);
    const payloadDigest = digest(payload);
    const existing = state.idempotency.get(key);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) {
        throw new EntityFoundationError("IDEMPOTENCY_CONFLICT", "idempotencyKey was already used for a different payload.");
      }
      return immutableCopy(existing.result);
    }
    const result3 = operation();
    state.idempotency.set(key, { payloadDigest, result: immutableCopy(result3) });
    return immutableCopy(result3);
  }
  function sha256(value) {
    return nativeCrypto_default.createHash("sha256").update(String(value)).digest("hex");
  }
  function sortByField(values, field) {
    return [...values].sort((left, right) => {
      const a = String(left[field]);
      const b = String(right[field]);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  // memory/entity/inMemoryAliasRepository.js
  function assertAlias(alias) {
    if (typeof alias !== "string" || alias.trim().length === 0) {
      throw new EntityFoundationError("ALIAS_REQUIRED", "alias is required.");
    }
  }
  var InMemoryAliasRepository = class {
    constructor(holder, {
      now = () => (/* @__PURE__ */ new Date()).toISOString(),
      scopeOwnerUserId = null
    } = {}) {
      this.holder = holder;
      this.now = now;
      this.scopeOwnerUserId = scopeOwnerUserId;
    }
    addAlias(ownerUserId, value, { idempotencyKey } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertOwnerMatch(ownerUserId, value?.ownerUserId);
      const alias = createEntityAlias(value, { trustedOwnerUserId: ownerUserId });
      if (!this.holder.state.entities.has(entityKey(ownerUserId, alias.entityId))) {
        throw new EntityFoundationError("ENTITY_NOT_FOUND", "Alias target Entity was not found.");
      }
      return runIdempotent(
        this.holder.state,
        "alias.add",
        ownerUserId,
        idempotencyKey,
        alias,
        () => {
          const key = aliasKey(ownerUserId, alias.alias, alias.entityId);
          if (this.holder.state.aliases.has(key)) {
            throw new EntityFoundationError("ALIAS_ALREADY_EXISTS", "Alias record already exists.");
          }
          this.holder.state.aliases.set(key, alias);
          return alias;
        }
      );
    }
    findByAlias(ownerUserId, alias) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertAlias(alias);
      const candidates = [...this.holder.state.aliases.values()].filter(
        (record) => record.ownerUserId === ownerUserId && record.alias === alias && record.status === "active"
      );
      return immutableCopy(sortByField(candidates, "entityId"));
    }
    updateAlias(ownerUserId, alias, entityId, { expectedVersion, changes = {} } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertAlias(alias);
      assertOpaqueEntityId(entityId);
      const key = aliasKey(ownerUserId, alias, entityId);
      const current = this.holder.state.aliases.get(key);
      if (!current) throw new EntityFoundationError("ALIAS_NOT_FOUND", "Alias record was not found.");
      if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
        throw new EntityFoundationError("CAS_CONFLICT", "Alias version does not match expectedVersion.");
      }
      const candidate = createEntityAlias({
        ...structuredClone(current),
        ...structuredClone(changes),
        schemaVersion: current.schemaVersion,
        alias: current.alias,
        entityId: current.entityId,
        ownerUserId: current.ownerUserId,
        version: current.version + 1
      }, { trustedOwnerUserId: ownerUserId });
      this.holder.state.aliases.set(key, candidate);
      return immutableCopy(candidate);
    }
    disableAlias(ownerUserId, alias, entityId, { expectedVersion, updatedAt = this.now() } = {}) {
      return this.updateAlias(ownerUserId, alias, entityId, {
        expectedVersion,
        changes: { status: "inactive", updatedAt }
      });
    }
  };

  // memory/entity/inMemoryEntityRepository.js
  var InMemoryEntityRepository = class {
    constructor(holder, {
      now = () => (/* @__PURE__ */ new Date()).toISOString(),
      entityIdFactory = () => `ent_${nativeCrypto_default.randomBytes(16).toString("hex")}`,
      scopeOwnerUserId = null
    } = {}) {
      this.holder = holder;
      this.now = now;
      this.entityIdFactory = entityIdFactory;
      this.scopeOwnerUserId = scopeOwnerUserId;
      this.related = null;
    }
    bindRelated(related) {
      this.related = related;
      return this;
    }
    create(ownerUserId, value, { idempotencyKey } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertOwnerMatch(ownerUserId, value?.ownerUserId);
      const entity = createEntity(value, { trustedOwnerUserId: ownerUserId });
      return runIdempotent(
        this.holder.state,
        "entity.create",
        ownerUserId,
        idempotencyKey,
        entity,
        () => {
          const key = entityKey(ownerUserId, entity.entityId);
          if (this.holder.state.entities.has(key)) {
            throw new EntityFoundationError("ENTITY_ALREADY_EXISTS", "Entity already exists.");
          }
          this.holder.state.entities.set(key, entity);
          return entity;
        }
      );
    }
    createEntity(...args) {
      return this.create(...args);
    }
    getById(ownerUserId, entityId) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertOpaqueEntityId(entityId);
      return immutableCopy(this.holder.state.entities.get(entityKey(ownerUserId, entityId)) ?? null);
    }
    listByOwner(ownerUserId, filters = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertAllowedFilters(filters, ["type", "status"]);
      const values = [...this.holder.state.entities.values()].filter(
        (entity) => entity.ownerUserId === ownerUserId && (filters.type === void 0 || entity.type === filters.type) && (filters.status === void 0 || entity.status === filters.status)
      );
      return immutableCopy(sortByField(values, "entityId"));
    }
    query(ownerUserId, filters = {}) {
      return this.listByOwner(ownerUserId, filters);
    }
    update(ownerUserId, entityId, { expectedVersion, changes = {} } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertOpaqueEntityId(entityId);
      const key = entityKey(ownerUserId, entityId);
      const current = this.holder.state.entities.get(key);
      if (!current) throw new EntityFoundationError("ENTITY_NOT_FOUND", "Entity was not found.");
      if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
        throw new EntityFoundationError("CAS_CONFLICT", "Entity version does not match expectedVersion.");
      }
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        throw new EntityFoundationError("INVALID_CHANGES", "changes must be an object.");
      }
      const candidate = createEntity({
        ...structuredClone(current),
        ...structuredClone(changes),
        schemaVersion: current.schemaVersion,
        entityId: current.entityId,
        ownerUserId: current.ownerUserId,
        version: current.version + 1
      }, { trustedOwnerUserId: ownerUserId });
      this.holder.state.entities.set(key, candidate);
      return immutableCopy(candidate);
    }
    updateEntity(...args) {
      return this.update(...args);
    }
    archive(ownerUserId, entityId, { expectedVersion, updatedAt = this.now() } = {}) {
      return this.update(ownerUserId, entityId, {
        expectedVersion,
        changes: { status: "archived", updatedAt }
      });
    }
    ensureSelfEntity(ownerUserId) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      const mappedId = this.holder.state.selfByOwner.get(ownerUserId);
      const mapped = mappedId ? this.holder.state.entities.get(entityKey(ownerUserId, mappedId)) : null;
      if (mapped?.status === "active") return immutableCopy(mapped);
      const activeSelf = this.listByOwner(ownerUserId, { status: "active" }).filter((entity) => entity.metadata?.entityRole === "self");
      if (activeSelf.length > 1) {
        throw new EntityFoundationError("SELF_ENTITY_CONFLICT", "Owner has more than one active self Entity.");
      }
      if (activeSelf.length === 1) {
        this.holder.state.selfByOwner.set(ownerUserId, activeSelf[0].entityId);
        return activeSelf[0];
      }
      let entityId;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = this.entityIdFactory();
        assertOpaqueEntityId(candidate);
        if (!this.holder.state.entities.has(entityKey(ownerUserId, candidate))) {
          entityId = candidate;
          break;
        }
      }
      if (!entityId) throw new EntityFoundationError("ENTITY_ID_COLLISION", "Unable to allocate a unique self Entity ID.");
      const timestamp = this.now();
      const self = this.create(ownerUserId, {
        schemaVersion: "v2",
        entityId,
        ownerUserId,
        type: "person",
        status: "active",
        version: 1,
        source: { type: "system_verified", id: "ensure-self-entity" },
        checksum: sha256(JSON.stringify({ ownerUserId, entityId, version: 1 })),
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: { entityRole: "self" }
      }, { idempotencyKey: "ensure-self-entity" });
      this.holder.state.selfByOwner.set(ownerUserId, self.entityId);
      return self;
    }
    findByAlias(...args) {
      return this.#related("aliases").findByAlias(...args);
    }
    addAlias(...args) {
      return this.#related("aliases").addAlias(...args);
    }
    updateAlias(...args) {
      return this.#related("aliases").updateAlias(...args);
    }
    findRelations(...args) {
      return this.#related("relations").listRelations(...args);
    }
    createRelation(...args) {
      return this.#related("relations").createRelation(...args);
    }
    endRelation(...args) {
      return this.#related("relations").endRelation(...args);
    }
    #related(name) {
      if (!this.related?.[name]) throw new EntityFoundationError("REPOSITORY_NOT_BOUND", `${name} repository is unavailable.`);
      return this.related[name];
    }
  };

  // memory/entity/memoryQueryV2.js
  var MEMORY_QUERY_V2_MAX_LIMIT = 50;
  var MEMORY_QUERY_V2_DEFAULT_LIMIT = 20;
  var MEMORY_QUERY_V2_READ_MODES = Object.freeze(["current", "historical"]);
  var MEMORY_QUERY_V2_PROVENANCE_POLICIES = Object.freeze({
    trusted_v2: Object.freeze(["user_stated", "user_confirmed", "system_verified"]),
    user_confirmed_v2: Object.freeze(["user_confirmed"])
  });
  var QUERY_INPUT_FIELDS = Object.freeze([
    "subjectEntityId",
    "predicate",
    "effectiveAt",
    "memoryType",
    "allowedStatuses",
    "limit",
    "cursor",
    "provenancePolicy",
    "readMode"
  ]);
  var QUERY_FIELDS = Object.freeze([
    "schemaVersion",
    "ownerUserId",
    ...QUERY_INPUT_FIELDS
  ]);
  var HISTORICAL_STATUSES = Object.freeze(["confirmed", "superseded", "archived"]);
  var CURSOR_VERSION = "memory-query-v2-cursor-v1";
  var CURSOR_DOMAIN = "aiwc-memory-query-v2-cursor";
  var MemoryQueryV2 = Object.freeze({
    name: "MemoryQueryV2",
    schemaVersion: "v2",
    fields: QUERY_FIELDS,
    required: QUERY_FIELDS,
    unknownFieldPolicy: "reject",
    maxLimit: MEMORY_QUERY_V2_MAX_LIMIT,
    cursorPolicy: "opaque-only"
  });
  var MemoryQueryV2Error = class extends Error {
    constructor(code, message) {
      super(message);
      this.name = "MemoryQueryV2Error";
      this.code = code;
    }
  };
  function fail(code, message) {
    throw new MemoryQueryV2Error(code, message);
  }
  function object2(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function nonEmptyString2(value) {
    return typeof value === "string" && value.trim().length > 0;
  }
  function isoTimestamp(value) {
    return nonEmptyString2(value) && !Number.isNaN(Date.parse(value));
  }
  function assertUnknownFields(value, allowedFields, label) {
    if (!object2(value)) fail("QUERY_INVALID", `${label} must be an object.`);
    const unknown = Object.keys(value).find((field) => !allowedFields.includes(field));
    if (unknown) fail("UNKNOWN_FIELD", `Unknown ${label} field: ${unknown}.`);
  }
  function normalizeStatuses(readMode, value) {
    const statuses = value === void 0 ? readMode === "current" ? ["confirmed"] : [...HISTORICAL_STATUSES] : value;
    if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((status) => !nonEmptyString2(status)) || new Set(statuses).size !== statuses.length) {
      fail("STATUS_POLICY_INVALID", "allowedStatuses must be a non-empty unique allowlist.");
    }
    if (readMode === "current" && (statuses.length !== 1 || statuses[0] !== "confirmed")) {
      fail("STATUS_POLICY_INVALID", "Current reads allow confirmed status only.");
    }
    if (readMode === "historical" && statuses.some((status) => !HISTORICAL_STATUSES.includes(status))) {
      fail("STATUS_POLICY_INVALID", "Historical status policy contains an unsupported status.");
    }
    return [...statuses];
  }
  function normalizeLimit(limit = MEMORY_QUERY_V2_DEFAULT_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      fail("LIMIT_INVALID", "limit must be a positive integer.");
    }
    if (limit > MEMORY_QUERY_V2_MAX_LIMIT) {
      fail("LIMIT_EXCEEDED", `limit cannot exceed ${MEMORY_QUERY_V2_MAX_LIMIT}.`);
    }
    return limit;
  }
  function assertProvenancePolicy(policy) {
    if (!Object.hasOwn(MEMORY_QUERY_V2_PROVENANCE_POLICIES, policy)) {
      fail("PROVENANCE_POLICY_INVALID", "provenancePolicy is unsupported.");
    }
  }
  function assertCursor(cursor) {
    if (cursor !== null && cursor !== void 0 && !nonEmptyString2(cursor)) {
      fail("CURSOR_INVALID", "cursor must be an opaque string or null.");
    }
  }
  function assertSubjectAndPredicate(subjectEntityId, predicate) {
    if (!ENTITY_ID_PATTERN.test(String(subjectEntityId || ""))) {
      fail("ENTITY_ID_INVALID", "subjectEntityId must be an opaque Entity ID.");
    }
    if (!nonEmptyString2(predicate) || !Object.hasOwn(PREDICATE_STRUCTURED_VALUE_SCHEMAS, predicate)) {
      fail("PREDICATE_INVALID", "predicate must have a registered structuredValue schema.");
    }
  }
  function assertMemoryType(memoryType) {
    if (memoryType !== null && !nonEmptyString2(memoryType)) {
      fail("MEMORY_TYPE_INVALID", "memoryType must be a non-empty string or null.");
    }
  }
  function assertContext(context) {
    if (!object2(context) || !nonEmptyString2(context.ownerUserId)) {
      fail("OWNER_SCOPE_REQUIRED", "Trusted context ownerUserId is required.");
    }
    if (!isoTimestamp(context.now)) fail("TRUSTED_TIME_REQUIRED", "Trusted context now is required.");
  }
  function canonicalize3(value) {
    if (Array.isArray(value)) return value.map(canonicalize3);
    if (!object2(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize3(value[key])]));
  }
  function stableJson(value) {
    return JSON.stringify(canonicalize3(value));
  }
  function sha2562(value) {
    return nativeCrypto_default.createHash("sha256").update(value).digest("hex");
  }
  function queryBinding(context, query) {
    if (!nonEmptyString2(context.repositoryGeneration)) {
      fail("REPOSITORY_GENERATION_REQUIRED", "Trusted repositoryGeneration is required.");
    }
    return {
      ownerUserId: query.ownerUserId,
      subjectEntityId: query.subjectEntityId,
      predicate: query.predicate,
      effectiveAt: query.effectiveAt,
      memoryType: query.memoryType,
      allowedStatuses: query.allowedStatuses,
      limit: query.limit,
      provenancePolicy: query.provenancePolicy,
      readMode: query.readMode,
      repositoryGeneration: context.repositoryGeneration,
      sort: ["effectiveFrom:desc", "createdAt:desc", "memoryId:asc"]
    };
  }
  function cursorSignature(encodedPayload) {
    return sha2562(`${CURSOR_DOMAIN}
${CURSOR_VERSION}
${encodedPayload}`);
  }
  function encodeCursor(context, query, record) {
    const payload = {
      bindingHash: sha2562(stableJson(queryBinding(context, query))),
      position: {
        effectiveFrom: record.effectiveFrom,
        createdAt: record.createdAt,
        memoryId: record.memoryId
      }
    };
    const encodedPayload = Buffer.from(stableJson(payload)).toString("base64url");
    return `${CURSOR_VERSION}.${encodedPayload}.${cursorSignature(encodedPayload)}`;
  }
  function decodeCursor(context, query) {
    if (query.cursor === null) return null;
    const parts = String(query.cursor).split(".");
    if (parts.length !== 3) fail("CURSOR_INVALID", "cursor is malformed.");
    const [version, encodedPayload, signature] = parts;
    if (version !== CURSOR_VERSION) fail("CURSOR_VERSION_UNSUPPORTED", "cursor version is unsupported.");
    const expected = cursorSignature(encodedPayload);
    const actualBytes = Buffer.from(signature, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    if (actualBytes.length !== expectedBytes.length || !nativeCrypto_default.timingSafeEqual(actualBytes, expectedBytes)) {
      fail("CURSOR_INVALID", "cursor integrity check failed.");
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      fail("CURSOR_INVALID", "cursor payload is invalid.");
    }
    const bindingHash = sha2562(stableJson(queryBinding(context, query)));
    if (payload?.bindingHash !== bindingHash) {
      fail("CURSOR_SCOPE_MISMATCH", "cursor does not belong to this query scope.");
    }
    const position = payload?.position;
    if (!object2(position) || !isoTimestamp(position.effectiveFrom) || !isoTimestamp(position.createdAt) || !nonEmptyString2(position.memoryId)) {
      fail("CURSOR_INVALID", "cursor sort position is invalid.");
    }
    return position;
  }
  function compareRecords(left, right) {
    for (const [field, direction] of [["effectiveFrom", -1], ["createdAt", -1], ["memoryId", 1]]) {
      const a = String(left[field]);
      const b = String(right[field]);
      if (a < b) return -1 * direction;
      if (a > b) return 1 * direction;
    }
    return 0;
  }
  function effectiveAt(record, timestamp) {
    const instant = Date.parse(timestamp);
    return Date.parse(record.effectiveFrom) <= instant && (record.effectiveTo === null || record.effectiveTo === void 0 || instant < Date.parse(record.effectiveTo)) && (record.expiresAt === null || record.expiresAt === void 0 || instant < Date.parse(record.expiresAt));
  }
  function matchesQueryPolicy(record, query) {
    return record.ownerUserId === query.ownerUserId && record.subjectEntityId === query.subjectEntityId && record.predicate === query.predicate && query.allowedStatuses.includes(record.status) && (query.memoryType === null || record.memoryType === query.memoryType) && allowedProvenanceForProvenancePolicy(query.provenancePolicy).includes(record.provenance) && effectiveAt(record, query.effectiveAt) && (query.readMode !== "current" || ["user_confirmed", "system_verified", "not_required"].includes(record.confirmationStatus));
  }
  function applyVersionPolicy(records, query) {
    const childrenByParent = /* @__PURE__ */ new Map();
    for (const record of records) {
      if (!record.supersedesId) continue;
      const children = childrenByParent.get(record.supersedesId) ?? [];
      children.push(record);
      childrenByParent.set(record.supersedesId, children);
    }
    for (const children of childrenByParent.values()) {
      if (children.length > 1) {
        fail("MEMORY_CONFLICT", "Memory version chain has multiple current branches.");
      }
    }
    const supersededIds = /* @__PURE__ */ new Set([...childrenByParent.keys()]);
    return records.filter((record) => {
      if (supersededIds.has(record.memoryId)) return false;
      if (query.readMode === "current" && record.supersededById) return false;
      return true;
    });
  }
  function resultItem(record, query) {
    return Object.freeze({
      ...structuredClone(record),
      provenance: Object.freeze({
        policy: query.provenancePolicy,
        level: record.provenance,
        source: structuredClone(record.source)
      })
    });
  }
  function validateMemoryQueryV2(query, { trustedOwnerUserId } = {}) {
    try {
      assertUnknownFields(query, QUERY_FIELDS, "MemoryQueryV2");
      for (const field of QUERY_FIELDS) {
        if (!(field in query) || query[field] === void 0) fail("REQUIRED", `${field} is required.`);
      }
      if (query.schemaVersion !== "v2") fail("UNSUPPORTED_SCHEMA_VERSION", "schemaVersion must be v2.");
      if (!nonEmptyString2(trustedOwnerUserId)) fail("OWNER_SCOPE_REQUIRED", "Trusted owner is required.");
      if (query.ownerUserId !== trustedOwnerUserId) fail("OWNER_SCOPE_MISMATCH", "Query owner is outside trusted scope.");
      assertSubjectAndPredicate(query.subjectEntityId, query.predicate);
      if (!MEMORY_QUERY_V2_READ_MODES.includes(query.readMode)) fail("READ_MODE_INVALID", "readMode is unsupported.");
      if (!isoTimestamp(query.effectiveAt)) fail("EFFECTIVE_AT_INVALID", "effectiveAt must be an ISO timestamp.");
      normalizeStatuses(query.readMode, query.allowedStatuses);
      assertMemoryType(query.memoryType);
      normalizeLimit(query.limit);
      assertCursor(query.cursor);
      assertProvenancePolicy(query.provenancePolicy);
      return Object.freeze({ valid: true, errors: Object.freeze([]), warnings: Object.freeze([]) });
    } catch (error) {
      if (!(error instanceof MemoryQueryV2Error)) throw error;
      return Object.freeze({
        valid: false,
        errors: Object.freeze([Object.freeze({ path: "", code: error.code, message: error.message })]),
        warnings: Object.freeze([])
      });
    }
  }
  function assertMemoryQueryV2(query, { trustedOwnerUserId } = {}) {
    const validation = validateMemoryQueryV2(query, { trustedOwnerUserId });
    if (!validation.valid) {
      const error = validation.errors[0];
      fail(error.code, error.message);
    }
    return query;
  }
  function assertMemoryQueryV2ExecutionContext(context, query) {
    assertContext(context);
    assertMemoryQueryV2(query, { trustedOwnerUserId: context.ownerUserId });
    if (!nonEmptyString2(context.repositoryGeneration)) {
      fail("REPOSITORY_GENERATION_REQUIRED", "Trusted repositoryGeneration is required.");
    }
    const resolution = context.entityResolution;
    if (!object2(resolution) || resolution.resolutionStatus !== "exact") {
      fail("RESOLUTION_EXACT_REQUIRED", "Repository query requires exact Entity resolution.");
    }
    const validation = validateEntityResolution(resolution, {
      trustedOwnerUserId: context.ownerUserId
    });
    if (!validation.valid) fail("RESOLUTION_INVALID", "Entity resolution is invalid.");
    if (resolution.entityId !== query.subjectEntityId) {
      fail("ENTITY_SCOPE_MISMATCH", "Repository query Entity differs from exact resolution.");
    }
    if (resolution.predicate !== null && resolution.predicate !== query.predicate) {
      fail("PREDICATE_SCOPE_MISMATCH", "Repository query predicate differs from exact resolution.");
    }
    if (query.readMode === "current" && query.effectiveAt !== context.now) {
      fail("EFFECTIVE_AT_NOT_TRUSTED", "Current query time differs from trusted context.");
    }
    return true;
  }
  function allowedProvenanceForProvenancePolicy(policy) {
    assertProvenancePolicy(policy);
    return MEMORY_QUERY_V2_PROVENANCE_POLICIES[policy];
  }
  function finalizeMemoryQueryV2Page(records, context, query) {
    assertMemoryQueryV2ExecutionContext(context, query);
    const scopedValidation = validateEntityScopedRecordSet(records, {
      trustedOwnerUserId: context.ownerUserId,
      subjectEntityId: query.subjectEntityId,
      predicate: query.predicate
    });
    if (!scopedValidation.valid) {
      fail("REPOSITORY_SCOPE_VIOLATION", scopedValidation.errors[0]?.message || "Repository returned an invalid record set.");
    }
    const eligible = records.filter((record) => matchesQueryPolicy(record, query));
    const versioned = applyVersionPolicy(eligible, query).sort(compareRecords);
    const position = decodeCursor(context, query);
    let start = 0;
    if (position) {
      const index = versioned.findIndex(
        (record) => record.effectiveFrom === position.effectiveFrom && record.createdAt === position.createdAt && record.memoryId === position.memoryId
      );
      if (index < 0) fail("CURSOR_STALE", "cursor position no longer exists in this query snapshot.");
      start = index + 1;
    }
    const selected = versioned.slice(start, start + query.limit);
    const hasMore = start + selected.length < versioned.length;
    return Object.freeze({
      items: Object.freeze(selected.map((record) => resultItem(record, query))),
      nextCursor: hasMore && selected.length > 0 ? encodeCursor(context, query, selected[selected.length - 1]) : null,
      scope: Object.freeze({
        ownerUserId: query.ownerUserId,
        subjectEntityId: query.subjectEntityId,
        predicate: query.predicate,
        effectiveAt: query.effectiveAt,
        readMode: query.readMode,
        sourceMode: "v2",
        repositoryGeneration: context.repositoryGeneration
      })
    });
  }

  // memory/entity/v2Presence.js
  var REASON_ORDER = Object.freeze([
    "confirmed_v2",
    "deleted_tombstone",
    "purged_marker",
    "superseded_chain",
    "explicit_v2_presence",
    "unresolved_conflict"
  ]);
  function hasReason(record, reason) {
    if (reason === "confirmed_v2") return record.status === "confirmed";
    if (reason === "deleted_tombstone") return record.status === "deleted";
    if (reason === "purged_marker") {
      return record.metadata?.purgedMarker === true || record.metadata?.v2PresenceMarker === "purged";
    }
    if (reason === "superseded_chain") {
      return record.status === "superseded" || Boolean(record.supersedesId) || Boolean(record.supersededById);
    }
    if (reason === "explicit_v2_presence") return record.metadata?.v2PresenceMarker === true;
    if (reason === "unresolved_conflict") {
      return Boolean(record.conflictGroupId) || record.metadata?.unresolvedConflictMarker === true;
    }
    return false;
  }
  function deepFreeze4(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze4(child);
    return Object.freeze(value);
  }
  function classifyV2Presence(records, query) {
    const reasons2 = REASON_ORDER.filter((reason) => records.some((record) => hasReason(record, reason)));
    return deepFreeze4({
      ownerUserId: query.ownerUserId,
      subjectEntityId: query.subjectEntityId,
      predicate: query.predicate,
      suppressLegacy: reasons2.length > 0,
      reasons: reasons2,
      memoryIds: records.map((record) => record.memoryId).sort()
    });
  }

  // memory/entity/inMemoryMemoryRecordV2Repository.js
  var InMemoryMemoryRecordV2Repository = class {
    constructor(holder, {
      now = () => (/* @__PURE__ */ new Date()).toISOString(),
      scopeOwnerUserId = null
    } = {}) {
      this.holder = holder;
      this.now = now;
      this.scopeOwnerUserId = scopeOwnerUserId;
    }
    create(ownerUserId, value, { idempotencyKey, resolution } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertOwnerMatch(ownerUserId, value?.ownerUserId);
      const memory = createMemoryRecordV2(value, {
        trustedOwnerUserId: ownerUserId,
        resolution
      });
      if (!this.holder.state.entities.has(entityKey(ownerUserId, memory.subjectEntityId))) {
        throw new EntityFoundationError("ENTITY_NOT_FOUND", "Memory subject Entity was not found.");
      }
      return runIdempotent(
        this.holder.state,
        "memory-v2.create",
        ownerUserId,
        idempotencyKey,
        memory,
        () => {
          const key = memoryKey(ownerUserId, memory.memoryId);
          if (this.holder.state.memories.has(key)) {
            throw new EntityFoundationError("MEMORY_ALREADY_EXISTS", "MemoryRecordV2 already exists.");
          }
          this.holder.state.memories.set(key, memory);
          const scopeKey = memoryScopeKey(ownerUserId, memory.subjectEntityId, memory.predicate);
          const indexedKeys = this.holder.state.memoryScopeIndex.get(scopeKey) ?? /* @__PURE__ */ new Set();
          indexedKeys.add(key);
          this.holder.state.memoryScopeIndex.set(scopeKey, indexedKeys);
          return memory;
        }
      );
    }
    getById(ownerUserId, memoryId) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      if (typeof memoryId !== "string" || memoryId.trim().length === 0) {
        throw new EntityFoundationError("MEMORY_ID_INVALID", "memoryId is required.");
      }
      return immutableCopy(this.holder.state.memories.get(memoryKey(ownerUserId, memoryId)) ?? null);
    }
    listByEntityAndPredicateForLifecycle(ownerUserId, subjectEntityId, predicate) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertOpaqueEntityId(subjectEntityId);
      if (typeof predicate !== "string" || predicate.trim().length === 0) {
        throw new EntityFoundationError("PREDICATE_REQUIRED", "predicate is required.");
      }
      return immutableCopy(sortByField(
        this.#recordsForScope(ownerUserId, subjectEntityId, predicate),
        "memoryId"
      ));
    }
    transition(ownerUserId, memoryId, value, { expectedVersion } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      const key = memoryKey(ownerUserId, memoryId);
      const current = this.holder.state.memories.get(key);
      if (!current) throw new EntityFoundationError("MEMORY_NOT_FOUND", "MemoryRecordV2 was not found.");
      if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
        throw new EntityFoundationError("CAS_CONFLICT", "MemoryRecordV2 version does not match expectedVersion.");
      }
      const candidate = createMemoryRecordV2(value, { trustedOwnerUserId: ownerUserId });
      if (candidate.memoryId !== memoryId || candidate.subjectEntityId !== current.subjectEntityId || candidate.predicate !== current.predicate) {
        throw new EntityFoundationError("LIFECYCLE_SCOPE_VIOLATION", "Lifecycle transition cannot change record identity or scope.");
      }
      this.holder.state.memories.set(key, candidate);
      return immutableCopy(candidate);
    }
    purgeChain(ownerUserId, {
      targetMemoryId,
      subjectEntityId,
      predicate,
      expectedVersion,
      chainMemoryIds,
      marker
    } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertOpaqueEntityId(subjectEntityId);
      const targetKey = memoryKey(ownerUserId, targetMemoryId);
      const target = this.holder.state.memories.get(targetKey);
      if (!target) throw new EntityFoundationError("MEMORY_NOT_FOUND", "MemoryRecordV2 was not found.");
      if (!Number.isInteger(expectedVersion) || target.version !== expectedVersion) {
        throw new EntityFoundationError("CAS_CONFLICT", "MemoryRecordV2 version does not match expectedVersion.");
      }
      if (target.subjectEntityId !== subjectEntityId || target.predicate !== predicate || !Array.isArray(chainMemoryIds) || !chainMemoryIds.includes(targetMemoryId)) {
        throw new EntityFoundationError("LIFECYCLE_SCOPE_VIOLATION", "Purge chain is outside exact Memory scope.");
      }
      const indexedKeys = this.holder.state.memoryScopeIndex.get(
        memoryScopeKey(ownerUserId, subjectEntityId, predicate)
      ) ?? /* @__PURE__ */ new Set();
      for (const memoryId of new Set(chainMemoryIds)) {
        const key = memoryKey(ownerUserId, memoryId);
        const record = this.holder.state.memories.get(key);
        if (!record || record.subjectEntityId !== subjectEntityId || record.predicate !== predicate) {
          throw new EntityFoundationError("LIFECYCLE_SCOPE_VIOLATION", "Purge chain contains an invalid Memory.");
        }
        this.holder.state.memories.delete(key);
        indexedKeys.delete(key);
      }
      const storedMarker = immutableCopy(marker);
      this.holder.state.memories.set(targetKey, storedMarker);
      indexedKeys.add(targetKey);
      this.holder.state.memoryScopeIndex.set(memoryScopeKey(ownerUserId, subjectEntityId, predicate), indexedKeys);
      return storedMarker;
    }
    queryByEntityAndPredicate(ownerOrContext, subjectOrQuery, predicate, filters = {}) {
      if (ownerOrContext && typeof ownerOrContext === "object" && !Array.isArray(ownerOrContext)) {
        return this.#queryV2(ownerOrContext, subjectOrQuery);
      }
      return this.#querySprint3C(ownerOrContext, subjectOrQuery, predicate, filters);
    }
    inspectPresenceByEntityAndPredicate(context, query) {
      assertOwnerScope(this.scopeOwnerUserId, context?.ownerUserId);
      assertMemoryQueryV2ExecutionContext(context, query);
      return classifyV2Presence(immutableCopy(this.#recordsForScope(
        context.ownerUserId,
        query.subjectEntityId,
        query.predicate
      )), query);
    }
    #recordsForScope(ownerUserId, subjectEntityId, predicate) {
      const indexedKeys = this.holder.state.memoryScopeIndex.get(
        memoryScopeKey(ownerUserId, subjectEntityId, predicate)
      ) ?? /* @__PURE__ */ new Set();
      return [...indexedKeys].map((key) => this.holder.state.memories.get(key)).filter(Boolean);
    }
    #queryV2(context, query) {
      assertOwnerScope(this.scopeOwnerUserId, context?.ownerUserId);
      assertMemoryQueryV2ExecutionContext(context, query);
      const values = this.#recordsForScope(
        context.ownerUserId,
        query.subjectEntityId,
        query.predicate
      ).filter((record) => record.metadata?.purgedMarker !== true);
      return finalizeMemoryQueryV2Page(immutableCopy(values), context, query);
    }
    #querySprint3C(ownerUserId, subjectEntityId, predicate, filters = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertOpaqueEntityId(subjectEntityId);
      if (typeof predicate !== "string" || predicate.trim().length === 0) {
        throw new EntityFoundationError("PREDICATE_REQUIRED", "predicate is required.");
      }
      assertAllowedFilters(filters, ["status"]);
      const values = this.#recordsForScope(ownerUserId, subjectEntityId, predicate).filter(
        (memory) => filters.status === void 0 || memory.status === filters.status
      );
      return immutableCopy(sortByField(values, "memoryId"));
    }
    archive(ownerUserId, memoryId, { expectedVersion, updatedAt = this.now() } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      const key = memoryKey(ownerUserId, memoryId);
      const current = this.holder.state.memories.get(key);
      if (!current) throw new EntityFoundationError("MEMORY_NOT_FOUND", "MemoryRecordV2 was not found.");
      if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
        throw new EntityFoundationError("CAS_CONFLICT", "MemoryRecordV2 version does not match expectedVersion.");
      }
      const candidate = createMemoryRecordV2({
        ...structuredClone(current),
        status: "archived",
        updatedAt,
        version: current.version + 1
      }, { trustedOwnerUserId: ownerUserId });
      this.holder.state.memories.set(key, candidate);
      return immutableCopy(candidate);
    }
  };

  // memory/entity/inMemoryRelationRepository.js
  function assertTimestamp(value) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new EntityFoundationError("INVALID_DATE", "effective timestamp must be an ISO date.");
    }
  }
  var InMemoryRelationRepository = class {
    constructor(holder, {
      now = () => (/* @__PURE__ */ new Date()).toISOString(),
      scopeOwnerUserId = null
    } = {}) {
      this.holder = holder;
      this.now = now;
      this.scopeOwnerUserId = scopeOwnerUserId;
    }
    createRelation(ownerUserId, value, { idempotencyKey } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertOwnerMatch(ownerUserId, value?.ownerUserId);
      const relation = createEntityRelation(value, { trustedOwnerUserId: ownerUserId });
      for (const entityId of [relation.sourceEntityId, relation.targetEntityId]) {
        if (!this.holder.state.entities.has(entityKey(ownerUserId, entityId))) {
          throw new EntityFoundationError("ENTITY_NOT_FOUND", "Relation Entity was not found.");
        }
      }
      return runIdempotent(
        this.holder.state,
        "relation.create",
        ownerUserId,
        idempotencyKey,
        relation,
        () => {
          const key = relationKey(ownerUserId, relation.relationId);
          if (this.holder.state.relations.has(key)) {
            throw new EntityFoundationError("RELATION_ALREADY_EXISTS", "Relation already exists.");
          }
          this.holder.state.relations.set(key, relation);
          return relation;
        }
      );
    }
    listRelations(ownerUserId, filters = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      const supported = [
        "sourceEntityId",
        "targetEntityId",
        "relationKind",
        "role",
        "status"
      ];
      assertAllowedFilters(filters, supported);
      const values = [...this.holder.state.relations.values()].filter(
        (relation) => relation.ownerUserId === ownerUserId && supported.every(
          (field) => filters[field] === void 0 || relation[field] === filters[field]
        )
      );
      return immutableCopy(sortByField(values, "relationId"));
    }
    findEffectiveRelations(ownerUserId, effectiveAt2, filters = {}) {
      assertTimestamp(effectiveAt2);
      const at = Date.parse(effectiveAt2);
      return immutableCopy(this.listRelations(ownerUserId, filters).filter(
        (relation) => relation.status !== "deleted" && Date.parse(relation.effectiveFrom) <= at && (relation.effectiveTo === null || relation.effectiveTo === void 0 || at < Date.parse(relation.effectiveTo))
      ));
    }
    endRelation(ownerUserId, relationId, {
      expectedVersion,
      effectiveTo,
      updatedAt = this.now()
    } = {}) {
      assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
      assertTimestamp(effectiveTo);
      const key = relationKey(ownerUserId, relationId);
      const current = this.holder.state.relations.get(key);
      if (!current) throw new EntityFoundationError("RELATION_NOT_FOUND", "Relation was not found.");
      if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
        throw new EntityFoundationError("CAS_CONFLICT", "Relation version does not match expectedVersion.");
      }
      const candidate = createEntityRelation({
        ...structuredClone(current),
        status: "ended",
        effectiveTo,
        updatedAt,
        version: current.version + 1
      }, { trustedOwnerUserId: ownerUserId });
      this.holder.state.relations.set(key, candidate);
      return immutableCopy(candidate);
    }
  };

  // memory/entity/inMemoryUnitOfWork.js
  var InMemoryMemoryUnitOfWork = class {
    constructor(holder, buildRepositories2, { beforeCommit = null } = {}) {
      this.holder = holder;
      this.buildRepositories = buildRepositories2;
      this.tail = Promise.resolve();
      this.beforeCommit = beforeCommit;
    }
    run(context, work) {
      const operation = () => this.#run(context, work);
      const scheduled = this.tail.then(operation, operation);
      this.tail = scheduled.catch(() => void 0);
      return scheduled;
    }
    async #run(context, work) {
      const ownerUserId = context?.ownerUserId;
      assertOwnerUserId(ownerUserId);
      if (typeof work !== "function") {
        throw new EntityFoundationError("UNIT_OF_WORK_CALLBACK_REQUIRED", "Unit of Work callback is required.");
      }
      const idempotencyKey = context?.idempotencyKey;
      if (idempotencyKey !== void 0 && idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0)) {
        throw new EntityFoundationError("IDEMPOTENCY_KEY_INVALID", "idempotencyKey must be a non-empty string.");
      }
      const replayKey = idempotencyKey === void 0 || idempotencyKey === null ? null : JSON.stringify([ownerUserId, idempotencyKey]);
      if (replayKey && this.holder.state.unitOfWorkIdempotency.has(replayKey)) {
        return immutableCopy(this.holder.state.unitOfWorkIdempotency.get(replayKey));
      }
      const baseState = this.holder.state;
      const draftHolder = { state: cloneFoundationState(baseState) };
      const repositories = this.buildRepositories(draftHolder, ownerUserId);
      const result3 = await work(repositories);
      if (this.holder.state !== baseState) {
        throw new EntityFoundationError("UNIT_OF_WORK_CONFLICT", "Foundation changed while Unit of Work was running.");
      }
      if (replayKey) draftHolder.state.unitOfWorkIdempotency.set(replayKey, immutableCopy(result3));
      if (this.beforeCommit) await this.beforeCommit(cloneFoundationState(draftHolder.state));
      this.holder.state = draftHolder.state;
      return immutableCopy(result3);
    }
  };

  // memory/entity/inMemoryFoundation.js
  function buildRepositories(holder, options, scopeOwnerUserId = null) {
    const shared = { ...options, scopeOwnerUserId };
    const repository = new InMemoryEntityRepository(holder, shared);
    const aliases = new InMemoryAliasRepository(holder, shared);
    const relations = new InMemoryRelationRepository(holder, shared);
    const memories = new InMemoryMemoryRecordV2Repository(holder, shared);
    repository.bindRelated({ aliases, relations });
    return { repository, aliases, relations, memories };
  }
  function createInMemoryEntityFoundation(options = {}) {
    const holder = { state: options.initialState ? cloneFoundationState(options.initialState) : createFoundationState() };
    const repositories = buildRepositories(holder, options);
    const unitOfWork = new InMemoryMemoryUnitOfWork(
      holder,
      (draftHolder, ownerUserId) => buildRepositories(draftHolder, options, ownerUserId),
      { beforeCommit: options.beforeCommit }
    );
    return Object.freeze({ ...repositories, unitOfWork });
  }

  // memory/entity/aiMemoryClassifier.js
  var PROPOSAL_FIELDS = Object.freeze([
    "proposedDecision",
    "memoryType",
    "predicate",
    "confidence",
    "importance",
    "sensitivity",
    "retentionPolicy",
    "reasonCodes",
    "suggestedStructuredValue",
    "containsPersonalFact",
    "needsClarification",
    "explicitBusinessIntent"
  ]);
  function immutable(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) immutable(child);
    return Object.freeze(value);
  }
  function optionalString(value, field) {
    if (value === null) return null;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${field} must be a non-empty string or null.`);
    }
    return value.trim();
  }
  function unitNumber(value, field) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`${field} must be between zero and one.`);
    }
    return value;
  }
  function boolean(value, field) {
    if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean.`);
    return value;
  }
  function parseRetentionPolicy(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("retentionPolicy must be an object.");
    }
    for (const field of Object.keys(value)) {
      if (!["mode", "expiresAt"].includes(field)) {
        throw new TypeError(`Unknown retentionPolicy field: ${field}`);
      }
    }
    if (!MEMORY_DECISION_RETENTION_MODES.includes(value.mode)) {
      throw new TypeError("retentionPolicy.mode is invalid.");
    }
    const expiresAt = value.expiresAt ?? null;
    if (expiresAt !== null && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) {
      throw new TypeError("retentionPolicy.expiresAt must be an ISO timestamp or null.");
    }
    if (value.mode === "ttl" && expiresAt === null) {
      throw new TypeError("retentionPolicy.expiresAt is required for ttl.");
    }
    if (value.mode !== "ttl" && expiresAt !== null) {
      throw new TypeError("retentionPolicy.expiresAt is allowed only for ttl.");
    }
    return immutable({ mode: value.mode, expiresAt });
  }
  function parseReasonCodes(value) {
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
      throw new TypeError("reasonCodes must be a non-empty string array.");
    }
    return Object.freeze([...new Set(value.map((entry) => entry.trim()))]);
  }
  function parseSuggestedStructuredValue(value) {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("suggestedStructuredValue must be an object or null.");
    }
    return immutable(structuredClone(value));
  }
  function validateAIMemoryClassifier(value) {
    const errors = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push("AI Memory Classifier must be an object.");
    } else if (typeof value.classify !== "function") {
      errors.push("AI Memory Classifier must expose classify(input).");
    }
    return immutable({ valid: errors.length === 0, errors });
  }
  function parseAIMemoryClassificationProposal(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("AI Memory classification proposal must be an object.");
    }
    for (const field of Object.keys(value)) {
      if (!PROPOSAL_FIELDS.includes(field)) throw new TypeError(`Unknown field: ${field}`);
    }
    for (const field of PROPOSAL_FIELDS) {
      if (!(field in value)) throw new TypeError(`${field} is required.`);
    }
    if (!MEMORY_DECISIONS.includes(value.proposedDecision)) {
      throw new TypeError("proposedDecision is invalid.");
    }
    if (value.memoryType !== null && !MEMORY_DECISION_TYPES.includes(value.memoryType)) {
      throw new TypeError("memoryType is invalid.");
    }
    if (!MEMORY_V2_SENSITIVITIES.includes(value.sensitivity)) {
      throw new TypeError("sensitivity is invalid.");
    }
    const predicate = optionalString(value.predicate, "predicate");
    const suggestedStructuredValue = parseSuggestedStructuredValue(value.suggestedStructuredValue);
    if (value.memoryType === null && (predicate !== null || suggestedStructuredValue !== null)) {
      throw new TypeError("memoryType is required when predicate or suggestedStructuredValue is present.");
    }
    if (value.memoryType !== null && (predicate === null || suggestedStructuredValue === null)) {
      throw new TypeError("predicate and suggestedStructuredValue are required for a memory candidate.");
    }
    return immutable({
      proposedDecision: value.proposedDecision,
      memoryType: value.memoryType,
      predicate,
      confidence: unitNumber(value.confidence, "confidence"),
      importance: unitNumber(value.importance, "importance"),
      sensitivity: value.sensitivity,
      retentionPolicy: parseRetentionPolicy(value.retentionPolicy),
      reasonCodes: parseReasonCodes(value.reasonCodes),
      suggestedStructuredValue,
      containsPersonalFact: boolean(value.containsPersonalFact, "containsPersonalFact"),
      needsClarification: boolean(value.needsClarification, "needsClarification"),
      explicitBusinessIntent: boolean(value.explicitBusinessIntent, "explicitBusinessIntent")
    });
  }

  // memory/entity/memoryDecisionPolicy.js
  var MEMORY_DECISION_POLICY_VERSION = "memory-capture-decision-v1";
  var SAFE_SENSITIVITIES = /* @__PURE__ */ new Set(["public", "low"]);
  var CONFLICT_STATUSES = /* @__PURE__ */ new Set(["none", "conflict", "unknown"]);
  var DUPLICATE_STATUSES = /* @__PURE__ */ new Set(["none", "possible", "exact", "unknown"]);
  var STRUCTURED_VALUE_SCHEMAS = Object.freeze({
    birthday: Object.freeze({ required: ["date"], optional: [], types: { date: "iso-date" } }),
    fact_statement: Object.freeze({ required: ["value"], optional: [], types: { value: "string" } }),
    relationship_statement: Object.freeze({ required: ["summary"], optional: [], types: { summary: "string" } }),
    preference_statement: Object.freeze({ required: ["value"], optional: ["values"], types: { value: "string", values: "string-array" } }),
    favorite_preference_statement: Object.freeze({ required: ["value"], optional: [], types: { value: "string" } }),
    goal_statement: Object.freeze({ required: ["summary"], optional: ["targetDate"], types: { summary: "string", targetDate: "iso-date-or-null" } }),
    life_event: Object.freeze({ required: ["summary"], optional: ["date"], types: { summary: "string", date: "iso-date-or-null" } }),
    habit_observation: Object.freeze({ required: ["summary", "observedAt"], optional: [], types: { summary: "string", observedAt: "iso-timestamp" } }),
    decision_statement: Object.freeze({ required: ["summary"], optional: [], types: { summary: "string" } }),
    constraint_statement: Object.freeze({ required: ["summary"], optional: [], types: { summary: "string" } }),
    temporary_presence: Object.freeze({ required: ["summary", "expiresAt"], optional: [], types: { summary: "string", expiresAt: "iso-timestamp" } }),
    financial_transaction: Object.freeze({
      required: ["direction", "amount", "currency", "category"],
      optional: [],
      types: { direction: "financial-direction", amount: "positive-number", currency: "currency", category: "string" }
    }),
    schedule_item: Object.freeze({ required: ["title", "startsAt"], optional: [], types: { title: "string", startsAt: "iso-timestamp" } }),
    health_observation: Object.freeze({ required: ["summary"], optional: [], types: { summary: "string" } })
  });
  function immutable2(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) immutable2(child);
    return Object.freeze(value);
  }
  function nonEmptyString3(value) {
    return typeof value === "string" && value.trim().length > 0;
  }
  function isoCalendarDate2(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return false;
    const [, year, month, day] = match.map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }
  function validType(value, type) {
    if (type === "string") return nonEmptyString3(value);
    if (type === "string-array") return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString3) && new Set(value.map((item) => item.trim())).size === value.length;
    if (type === "iso-date") return isoCalendarDate2(value);
    if (type === "iso-date-or-null") return value === null || isoCalendarDate2(value);
    if (type === "iso-timestamp") return typeof value === "string" && !Number.isNaN(Date.parse(value));
    if (type === "positive-number") return Number.isFinite(value) && value > 0;
    if (type === "currency") return /^[A-Z]{3}$/.test(String(value || ""));
    if (type === "financial-direction") return ["income", "expense"].includes(value);
    return false;
  }
  function validateMemoryDecisionStructuredValue(predicate, value) {
    const errors = [];
    const schema3 = STRUCTURED_VALUE_SCHEMAS[predicate];
    if (!schema3) return immutable2({ valid: false, errors: ["predicate_schema_missing"] });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return immutable2({ valid: false, errors: ["structured_value_invalid_type"] });
    }
    const allowed = /* @__PURE__ */ new Set([...schema3.required, ...schema3.optional]);
    for (const field of schema3.required) {
      if (!(field in value)) errors.push(`structured_value_required:${field}`);
    }
    for (const field of Object.keys(value)) {
      if (!allowed.has(field)) errors.push(`structured_value_unknown_field:${field}`);
    }
    for (const [field, type] of Object.entries(schema3.types)) {
      if (field in value && !validType(value[field], type)) errors.push(`structured_value_invalid_type:${field}`);
    }
    return immutable2({ valid: errors.length === 0, errors });
  }
  function reasons(proposal, additions) {
    return Object.freeze([.../* @__PURE__ */ new Set([...proposal.reasonCodes, ...additions])]);
  }
  function exactEntity(ownerUserId, resolution) {
    return resolution?.resolutionStatus === "exact" && resolution.ownerUserId === ownerUserId && ENTITY_ID_PATTERN.test(String(resolution.entityId || ""));
  }
  function responsePolicy(decision, reasonCodes) {
    if (decision === "answer_only" && reasonCodes.includes("financial_report_query")) {
      return "financial_report_opt_in_advice";
    }
    return {
      answer_only: "answer_only",
      ignore: "none",
      temporary_context: "none",
      store_silently: "silent",
      confirm_before_store: "request_confirmation",
      business_record: "acknowledge_only_after_commit"
    }[decision];
  }
  function acknowledgementPolicy(decision) {
    if (decision === "store_silently") return "silent";
    if (decision === "business_record") return "after_commit";
    return "none";
  }
  function expectedRetention(decision) {
    if (decision === "temporary_context") return /* @__PURE__ */ new Set(["session", "ttl"]);
    if (decision === "store_silently" || decision === "confirm_before_store") return /* @__PURE__ */ new Set(["long_term", "business_record", "ttl"]);
    if (decision === "business_record") return /* @__PURE__ */ new Set(["business_record"]);
    return /* @__PURE__ */ new Set(["none"]);
  }
  function evaluateMemoryDecisionPolicy({ ownerUserId, entityResolution, proposal, inspection }) {
    const additions = [];
    let decision = proposal.proposedDecision;
    const storingCandidate = !["answer_only", "ignore"].includes(decision);
    const entityExact = exactEntity(ownerUserId, entityResolution);
    const conflictStatus = CONFLICT_STATUSES.has(inspection?.conflictStatus) ? inspection.conflictStatus : "unknown";
    const duplicateStatus = DUPLICATE_STATUSES.has(inspection?.duplicateStatus) ? inspection.duplicateStatus : "unknown";
    const structured = proposal.predicate === null ? { valid: proposal.suggestedStructuredValue === null } : validateMemoryDecisionStructuredValue(proposal.predicate, proposal.suggestedStructuredValue);
    if (storingCandidate && entityResolution?.ownerUserId !== ownerUserId) {
      decision = "confirm_before_store";
      additions.push("owner_scope_mismatch");
    } else if (storingCandidate && !entityExact) {
      decision = "confirm_before_store";
      additions.push("entity_resolution_not_exact");
    }
    if (storingCandidate && !structured.valid) {
      decision = "confirm_before_store";
      additions.push("structured_value_invalid");
    }
    if (storingCandidate && proposal.needsClarification) {
      decision = "confirm_before_store";
      additions.push("semantic_clarification_required");
    }
    if (storingCandidate && (!SAFE_SENSITIVITIES.has(proposal.sensitivity) || proposal.confidence < 0.85)) {
      decision = "confirm_before_store";
      additions.push(!SAFE_SENSITIVITIES.has(proposal.sensitivity) ? "sensitive_information" : "confidence_below_silent_threshold");
    }
    if (proposal.proposedDecision === "store_silently" && proposal.importance < 0.5) {
      decision = "ignore";
      additions.push("importance_below_storage_threshold");
    }
    if (proposal.proposedDecision === "temporary_context" && proposal.retentionPolicy.mode === "ttl" && proposal.suggestedStructuredValue?.expiresAt !== proposal.retentionPolicy.expiresAt) {
      decision = "confirm_before_store";
      additions.push("retention_expiry_mismatch");
    }
    if (storingCandidate && conflictStatus !== "none") {
      decision = "confirm_before_store";
      additions.push(conflictStatus === "conflict" ? "existing_fact_conflict" : "conflict_check_unavailable");
    }
    if (storingCandidate && duplicateStatus === "exact") {
      decision = "ignore";
      additions.push("exact_duplicate");
    } else if (storingCandidate && duplicateStatus !== "none") {
      decision = "confirm_before_store";
      additions.push(duplicateStatus === "possible" ? "possible_duplicate" : "duplicate_check_unavailable");
    }
    const policyIgnoredStorage = duplicateStatus === "exact" || additions.includes("importance_below_storage_threshold");
    if (!policyIgnoredStorage && !expectedRetention(decision).has(proposal.retentionPolicy.mode)) {
      decision = "confirm_before_store";
      additions.push("retention_policy_mismatch");
    }
    if (proposal.proposedDecision === "business_record" && !proposal.explicitBusinessIntent) {
      decision = "confirm_before_store";
      additions.push("business_intent_not_explicit");
    }
    const reasonCodes = reasons(proposal, additions);
    return immutable2({
      decision,
      subjectEntityId: entityExact ? entityResolution.entityId : null,
      confirmationRequired: decision === "confirm_before_store",
      acknowledgementPolicy: acknowledgementPolicy(decision),
      duplicateCheckRequired: storingCandidate,
      responsePolicy: responsePolicy(decision, reasonCodes),
      reasonCodes
    });
  }
  function validateMemoryDecision(value) {
    const errors = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["invalid_type"] };
    for (const field of MemoryDecision.required) if (!(field in value)) errors.push(`required:${field}`);
    for (const field of Object.keys(value)) if (!MemoryDecision.fields.includes(field)) errors.push(`unknown:${field}`);
    if (value.schemaVersion !== ENTITY_MODEL_SCHEMA_VERSION) errors.push("schema_version");
    if (!MEMORY_DECISIONS.includes(value.decision)) errors.push("decision");
    if (value.memoryType !== null && !MEMORY_DECISION_TYPES.includes(value.memoryType)) errors.push("memory_type");
    if (!MEMORY_V2_SENSITIVITIES.includes(value.sensitivity)) errors.push("sensitivity");
    if (!ENTITY_RESOLUTION_STATUSES.includes(value.entityResolutionStatus)) errors.push("resolution_status");
    if (!MEMORY_DECISION_ACKNOWLEDGEMENT_POLICIES.includes(value.acknowledgementPolicy)) errors.push("acknowledgement_policy");
    if (!MEMORY_DECISION_RESPONSE_POLICIES.includes(value.responsePolicy)) errors.push("response_policy");
    if (!/^[a-f0-9]{64}$/.test(String(value.sourceTextDigest || ""))) errors.push("source_text_digest");
    return { valid: errors.length === 0, errors };
  }

  // memory/entity/memoryCaptureDecisionService.js
  function immutable3(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) immutable3(child);
    return Object.freeze(value);
  }
  function requiredString(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${field} is required.`);
    }
    return value;
  }
  function assertInspector(value) {
    if (!value || typeof value.inspect !== "function") {
      throw new TypeError("Memory decision inspector must expose inspect(input).");
    }
  }
  function digest2(text) {
    return nativeCrypto_default.createHash("sha256").update(text, "utf8").digest("hex");
  }
  function failClosedProposal(reasonCode) {
    return immutable3({
      proposedDecision: "confirm_before_store",
      memoryType: null,
      predicate: null,
      confidence: 0,
      importance: 0,
      sensitivity: "restricted",
      retentionPolicy: immutable3({ mode: "none", expiresAt: null }),
      reasonCodes: Object.freeze([reasonCode]),
      suggestedStructuredValue: null,
      containsPersonalFact: false,
      needsClarification: true,
      explicitBusinessIntent: false
    });
  }
  function orderedDecision({ ownerUserId, sourceTextDigest, entityResolution, proposal, policy, decidedAt }) {
    const values = {
      schemaVersion: ENTITY_MODEL_SCHEMA_VERSION,
      decision: policy.decision,
      memoryType: proposal.memoryType,
      ownerUserId,
      subjectEntityId: policy.subjectEntityId,
      predicate: proposal.predicate,
      confidence: proposal.confidence,
      importance: proposal.importance,
      sensitivity: proposal.sensitivity,
      retentionPolicy: proposal.retentionPolicy,
      reasonCodes: policy.reasonCodes,
      sourceTextDigest,
      entityResolutionStatus: ENTITY_RESOLUTION_STATUSES.includes(entityResolution?.resolutionStatus) ? entityResolution.resolutionStatus : "no_match",
      confirmationRequired: policy.confirmationRequired,
      acknowledgementPolicy: policy.acknowledgementPolicy,
      duplicateCheckRequired: policy.duplicateCheckRequired,
      suggestedStructuredValue: proposal.suggestedStructuredValue,
      responsePolicy: policy.responsePolicy,
      policyVersion: MEMORY_DECISION_POLICY_VERSION,
      decidedAt
    };
    return Object.fromEntries(MemoryDecision.fields.map((field) => [field, values[field]]));
  }
  var MemoryCaptureDecisionService = class {
    constructor({ classifier, inspector, now = () => (/* @__PURE__ */ new Date()).toISOString() }) {
      if (!validateAIMemoryClassifier(classifier).valid) throw new TypeError("AI Memory Classifier is invalid.");
      assertInspector(inspector);
      if (typeof now !== "function") throw new TypeError("now must be a function.");
      this.classifier = classifier;
      this.inspector = inspector;
      this.now = now;
    }
    async decide({ ownerUserId, text, locale = "zh-CN", entityResolution, conversationContext = null }) {
      requiredString(ownerUserId, "ownerUserId");
      requiredString(text, "text");
      requiredString(locale, "locale");
      let proposal;
      try {
        proposal = parseAIMemoryClassificationProposal(await this.classifier.classify({
          ownerUserId,
          text,
          locale,
          entityResolution: structuredClone(entityResolution),
          conversationContext: structuredClone(conversationContext)
        }));
      } catch {
        proposal = failClosedProposal("classifier_unavailable");
      }
      const storingCandidate = !["answer_only", "ignore"].includes(proposal.proposedDecision);
      let inspection = { conflictStatus: "none", duplicateStatus: "none" };
      if (storingCandidate) {
        try {
          inspection = await this.inspector.inspect({
            ownerUserId,
            subjectEntityId: entityResolution?.resolutionStatus === "exact" ? entityResolution.entityId : null,
            predicate: proposal.predicate,
            suggestedStructuredValue: proposal.suggestedStructuredValue
          });
        } catch {
          inspection = { conflictStatus: "unknown", duplicateStatus: "unknown" };
        }
      }
      const policy = evaluateMemoryDecisionPolicy({ ownerUserId, entityResolution, proposal, inspection });
      const decision = orderedDecision({
        ownerUserId,
        sourceTextDigest: digest2(text),
        entityResolution,
        proposal,
        policy,
        decidedAt: this.now()
      });
      const validation = validateMemoryDecision(decision);
      if (!validation.valid) throw new TypeError(`MemoryDecision validation failed: ${validation.errors.join(", ")}`);
      return immutable3(decision);
    }
  };
  function createMemoryCaptureDecisionService(options) {
    return new MemoryCaptureDecisionService(options);
  }

  // memory/entity/memorySafeWriteService.js
  function immutable4(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) immutable4(child);
    return Object.freeze(value);
  }
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  function sameValue(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  }
  function required(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} is required.`);
    return value;
  }
  function exactResolution(ownerUserId, resolution) {
    return resolution?.resolutionStatus === "exact" && resolution.ownerUserId === ownerUserId && typeof resolution.entityId === "string";
  }
  function resolutionContract(resolution, predicate) {
    const relationEvidence = resolution.evidence?.find((item) => item.type === "effective_relation") ?? null;
    return {
      schemaVersion: ENTITY_MODEL_SCHEMA_VERSION,
      resolutionStatus: "exact",
      ownerUserId: resolution.ownerUserId,
      entityType: resolution.entityType,
      entityId: resolution.entityId,
      relationKind: relationEvidence?.relationKind ?? null,
      role: relationEvidence?.role ?? null,
      predicate,
      candidateEntityIds: [],
      sourceRelationIds: relationEvidence?.relationId ? [relationEvidence.relationId] : [],
      resolutionReason: resolution.resolutionMethod,
      policyVersion: "memory-capture-orchestration-v1",
      resolvedAt: resolution.resolvedAt
    };
  }
  function createMemoryDuplicateConflictInspector({ memories, now = () => (/* @__PURE__ */ new Date()).toISOString() }) {
    if (!memories || typeof memories.queryByEntityAndPredicate !== "function") {
      throw new TypeError("Memory duplicate/conflict inspector requires MemoryRecordV2 Repository.");
    }
    return Object.freeze({
      async inspect({ ownerUserId, subjectEntityId, predicate, suggestedStructuredValue }) {
        if (!ownerUserId || !subjectEntityId || !predicate || suggestedStructuredValue == null) {
          return immutable4({ conflictStatus: "unknown", duplicateStatus: "unknown", matchingMemoryIds: [] });
        }
        const records = memories.queryByEntityAndPredicate(ownerUserId, subjectEntityId, predicate, { status: "confirmed" }).filter((record) => record.effectiveTo === null || Date.parse(now()) < Date.parse(record.effectiveTo));
        const exact = records.filter((record) => sameValue(record.structuredValue, suggestedStructuredValue));
        if (exact.length) {
          return immutable4({
            conflictStatus: "none",
            duplicateStatus: "exact",
            matchingMemoryIds: exact.map((record) => record.memoryId)
          });
        }
        if (records.length && PREDICATE_STRUCTURED_VALUE_SCHEMAS[predicate]?.cardinality !== "multiple") {
          return immutable4({
            conflictStatus: "conflict",
            duplicateStatus: "none",
            matchingMemoryIds: records.map((record) => record.memoryId)
          });
        }
        return immutable4({ conflictStatus: "none", duplicateStatus: "none", matchingMemoryIds: [] });
      }
    });
  }
  function memoryCandidate({ decision, resolution, memoryId, now, confirmationStatus, correction, sourceMessageId }) {
    const trustedSourceMessageId = typeof sourceMessageId === "string" && sourceMessageId.trim() ? sourceMessageId.trim() : null;
    return {
      memoryId,
      schemaVersion: ENTITY_MODEL_SCHEMA_VERSION,
      ownerUserId: decision.ownerUserId,
      memoryType: decision.memoryType,
      subjectEntityId: decision.subjectEntityId,
      predicate: decision.predicate,
      structuredValue: structuredClone(decision.suggestedStructuredValue),
      displayValue: null,
      legacySubject: null,
      source: trustedSourceMessageId ? { type: "conversation_message", id: trustedSourceMessageId } : { type: "capture_orchestrator", id: decision.sourceTextDigest },
      provenance: confirmationStatus === "user_confirmed" ? "user_confirmed" : "user_stated",
      sourceTimestamp: decision.decidedAt,
      createdAt: now,
      updatedAt: now,
      effectiveFrom: now,
      effectiveTo: null,
      confidence: decision.confidence,
      importance: decision.importance,
      sensitivity: decision.sensitivity,
      status: "confirmed",
      confirmationStatus,
      expiresAt: decision.retentionPolicy.expiresAt,
      version: 1,
      supersedesId: correction?.memoryId ?? null,
      supersededById: null,
      conflictGroupId: correction ? correction.conflictGroupId ?? `conflict:${correction.memoryId}` : null,
      retentionPolicy: structuredClone(decision.retentionPolicy),
      accessPolicy: { ownerOnly: true },
      checksum: "",
      tags: [],
      metadata: {
        policyVersion: decision.policyVersion,
        reasonCodes: [...decision.reasonCodes],
        resolutionMethod: resolution.resolutionMethod,
        ...trustedSourceMessageId ? { sourceMessageId: trustedSourceMessageId } : {}
      }
    };
  }
  function createMemorySafeWriteService({
    foundation,
    inspector,
    now = () => (/* @__PURE__ */ new Date()).toISOString(),
    memoryIdFactory
  }) {
    if (!foundation?.unitOfWork || typeof foundation.unitOfWork.run !== "function") {
      throw new TypeError("Safe write requires MemoryUnitOfWork.");
    }
    if (!inspector || typeof inspector.inspect !== "function") throw new TypeError("Safe write requires duplicate/conflict inspector.");
    if (typeof now !== "function" || typeof memoryIdFactory !== "function") {
      throw new TypeError("Safe write requires clock and memoryId factories.");
    }
    return Object.freeze({
      async inspect({ ownerUserId, resolution, decision }) {
        if (!exactResolution(ownerUserId, resolution) || decision?.ownerUserId !== ownerUserId || decision?.subjectEntityId !== resolution.entityId) {
          throw new Error("Exact owner-scoped Entity resolution is required.");
        }
        return inspector.inspect({
          ownerUserId,
          subjectEntityId: decision.subjectEntityId,
          predicate: decision.predicate,
          suggestedStructuredValue: decision.suggestedStructuredValue
        });
      },
      async write({
        ownerUserId,
        resolution,
        decision,
        idempotencyKey,
        confirmationStatus = "system_verified",
        confirmedConflictMemoryId = null,
        sourceMessageId = null
      }) {
        required(ownerUserId, "ownerUserId");
        required(idempotencyKey, "idempotencyKey");
        if (!exactResolution(ownerUserId, resolution) || decision?.ownerUserId !== ownerUserId || decision?.subjectEntityId !== resolution.entityId) {
          throw new Error("Exact owner-scoped Entity resolution is required.");
        }
        const decisionValidation = validateMemoryDecision(decision);
        if (!decisionValidation.valid) throw new TypeError("MemoryDecision is invalid.");
        if (!MEMORY_DECISION_TYPES.includes(decision.memoryType)) throw new TypeError("memoryType is invalid.");
        if (!PREDICATE_STRUCTURED_VALUE_SCHEMAS[decision.predicate]) throw new TypeError("predicate is not registered for MemoryRecordV2.");
        if (!["long_term", "ttl"].includes(decision.retentionPolicy.mode)) throw new TypeError("retentionPolicy does not permit formal Memory.");
        if (!["public", "low"].includes(decision.sensitivity) && confirmationStatus !== "user_confirmed") {
          throw new Error("Sensitive Memory requires user confirmation.");
        }
        const inspection = await inspector.inspect({
          ownerUserId,
          subjectEntityId: decision.subjectEntityId,
          predicate: decision.predicate,
          suggestedStructuredValue: decision.suggestedStructuredValue
        });
        if (inspection.duplicateStatus === "exact") {
          return immutable4({ outcome: "duplicate_detected", memoryId: inspection.matchingMemoryIds[0] });
        }
        if (inspection.conflictStatus === "conflict" && !confirmedConflictMemoryId) {
          return immutable4({ outcome: "confirmation_required", conflictMemoryIds: inspection.matchingMemoryIds });
        }
        if (confirmedConflictMemoryId && !inspection.matchingMemoryIds.includes(confirmedConflictMemoryId)) {
          throw new Error("Confirmed conflict is stale or outside the current owner scope.");
        }
        const memoryId = required(memoryIdFactory(), "memoryId");
        const contractResolution = resolutionContract(resolution, decision.predicate);
        return foundation.unitOfWork.run({ ownerUserId, idempotencyKey }, async ({ memories }) => {
          const correction = confirmedConflictMemoryId ? memories.getById(ownerUserId, confirmedConflictMemoryId) : null;
          if (confirmedConflictMemoryId && (!correction || correction.status !== "confirmed" || correction.subjectEntityId !== decision.subjectEntityId || correction.predicate !== decision.predicate)) {
            throw new Error("Confirmed conflict Memory is invalid.");
          }
          if (correction) {
            memories.archive(ownerUserId, correction.memoryId, {
              expectedVersion: correction.version,
              updatedAt: now()
            });
          }
          const memory = memories.create(ownerUserId, memoryCandidate({
            decision,
            resolution,
            memoryId,
            now: now(),
            confirmationStatus,
            correction,
            sourceMessageId
          }), {
            idempotencyKey: `${idempotencyKey}:memory`,
            resolution: contractResolution
          });
          return immutable4({ outcome: "memory_written", memory });
        });
      }
    });
  }

  // memory/entity/memoryLifecycleV2.js
  var ACTIONS = Object.freeze(["correction", "delete", "restore", "purge"]);
  var COMMAND_FIELDS = Object.freeze([
    "schemaVersion",
    "lifecycleAction",
    "subjectEntityId",
    "predicate",
    "memoryId",
    "expectedVersion",
    "idempotencyKey",
    "structuredValue",
    "confirmed",
    "sourceMessageId"
  ]);
  var COMMAND_REQUIRED_FIELDS = Object.freeze(COMMAND_FIELDS.filter((field) => field !== "sourceMessageId"));
  var INVALIDATION_FIELDS = Object.freeze([
    "ownerUserId",
    "subjectEntityId",
    "predicate",
    "memoryId",
    "lifecycleAction",
    "previousVersion",
    "newVersion",
    "invalidationToken",
    "occurredAt"
  ]);
  var CACHE_KEY_FIELDS = Object.freeze([
    "ownerUserId",
    "subjectEntityId",
    "predicate",
    "generation",
    "invalidationToken",
    "readMode"
  ]);
  var MemoryLifecycleCommandV2 = Object.freeze({
    name: "MemoryLifecycleCommandV2",
    schemaVersion: "v2",
    fields: COMMAND_FIELDS,
    required: COMMAND_REQUIRED_FIELDS,
    unknownFieldPolicy: "reject",
    lifecycleActions: ACTIONS
  });
  var MemoryInvalidationV2 = Object.freeze({
    name: "MemoryInvalidationV2",
    fields: INVALIDATION_FIELDS,
    required: INVALIDATION_FIELDS,
    unknownFieldPolicy: "reject"
  });
  var MemoryRecallCacheKeyV2 = Object.freeze({
    name: "MemoryRecallCacheKeyV2",
    fields: CACHE_KEY_FIELDS,
    required: CACHE_KEY_FIELDS,
    unknownFieldPolicy: "reject"
  });
  var MemoryLifecycleV2Error = class extends EntityFoundationError {
    constructor(code, message) {
      super(code, message);
      this.name = "MemoryLifecycleV2Error";
    }
  };
  function fail2(code, message) {
    throw new MemoryLifecycleV2Error(code, message);
  }
  function object3(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function nonEmptyString4(value) {
    return typeof value === "string" && value.trim().length > 0;
  }
  function isoTimestamp2(value) {
    return nonEmptyString4(value) && !Number.isNaN(Date.parse(value));
  }
  function assertCommandFields(value) {
    if (!object3(value)) fail2("LIFECYCLE_INPUT_INVALID", "MemoryLifecycleCommandV2 must be an object.");
    const unknown = Object.keys(value).find((field) => !COMMAND_FIELDS.includes(field));
    if (unknown) fail2("LIFECYCLE_UNKNOWN_FIELD", `Unknown MemoryLifecycleCommandV2 field: ${unknown}.`);
    const missing = COMMAND_REQUIRED_FIELDS.find((field) => !(field in value) || value[field] === void 0);
    if (missing) fail2("LIFECYCLE_FIELD_REQUIRED", `MemoryLifecycleCommandV2.${missing} is required.`);
  }
  function canonicalize4(value) {
    if (Array.isArray(value)) return value.map(canonicalize4);
    if (!object3(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize4(value[key])]));
  }
  function digest3(value) {
    return nativeCrypto_default.createHash("sha256").update(JSON.stringify(canonicalize4(value))).digest("hex");
  }
  function assertContext2(context) {
    if (!object3(context) || Object.keys(context).some((field) => field !== "ownerUserId") || !nonEmptyString4(context.ownerUserId)) {
      fail2("OWNER_SCOPE_REQUIRED", "Trusted lifecycle context requires ownerUserId only.");
    }
  }
  function assertCommand(command) {
    assertCommandFields(command);
    if (command.schemaVersion !== "v2") fail2("UNSUPPORTED_SCHEMA_VERSION", "schemaVersion must be v2.");
    if (!ACTIONS.includes(command.lifecycleAction)) fail2("LIFECYCLE_ACTION_INVALID", "lifecycleAction is unsupported.");
    if (!ENTITY_ID_PATTERN.test(String(command.subjectEntityId ?? ""))) {
      fail2("ENTITY_ID_INVALID", "subjectEntityId must be an opaque Entity ID.");
    }
    if (!nonEmptyString4(command.predicate) || !Object.hasOwn(PREDICATE_STRUCTURED_VALUE_SCHEMAS, command.predicate)) {
      fail2("PREDICATE_INVALID", "predicate must have a registered structuredValue schema.");
    }
    if (!nonEmptyString4(command.memoryId)) fail2("MEMORY_ID_INVALID", "memoryId is required.");
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
      fail2("EXPECTED_VERSION_INVALID", "expectedVersion must be a positive integer.");
    }
    if (!nonEmptyString4(command.idempotencyKey)) fail2("IDEMPOTENCY_KEY_INVALID", "idempotencyKey is required.");
    if (typeof command.confirmed !== "boolean") fail2("CONFIRMATION_INVALID", "confirmed must be boolean.");
    if (command.sourceMessageId !== void 0 && command.sourceMessageId !== null && !nonEmptyString4(command.sourceMessageId)) {
      fail2("SOURCE_MESSAGE_ID_INVALID", "sourceMessageId must be a non-empty string or null.");
    }
    if (command.lifecycleAction === "correction") {
      if (!object3(command.structuredValue)) fail2("STRUCTURED_VALUE_REQUIRED", "Correction requires structuredValue.");
    } else if (command.structuredValue !== null) {
      fail2("STRUCTURED_VALUE_FORBIDDEN", "Only correction accepts structuredValue.");
    }
    if (command.lifecycleAction !== "purge" && command.confirmed) {
      fail2("CONFIRMATION_INVALID", "confirmed is reserved for purge.");
    }
    return command;
  }
  function assertVersion(current, expectedVersion) {
    if (current.version !== expectedVersion) fail2("CAS_CONFLICT", "Memory version changed before lifecycle command.");
  }
  function assertScope(current, command, action) {
    if (current.subjectEntityId !== command.subjectEntityId) {
      fail2(
        action === "correction" ? "REBIND_REQUIRED" : "ENTITY_SCOPE_MISMATCH",
        action === "correction" ? "Ordinary correction cannot rebind an Entity." : "Memory is outside the exact Entity scope."
      );
    }
    if (current.predicate !== command.predicate) {
      fail2("PREDICATE_SCOPE_MISMATCH", "Memory is outside the exact predicate scope.");
    }
  }
  function auditMetadata(current, action, occurredAt) {
    return {
      ...structuredClone(current.metadata ?? {}),
      lifecycleAudit: {
        lifecycleAction: action,
        previousVersion: current.version,
        previousChecksum: current.checksum,
        occurredAt
      }
    };
  }
  function transitionRecord(current, changes, action, occurredAt) {
    return createMemoryRecordV2({
      ...structuredClone(current),
      ...structuredClone(changes),
      updatedAt: occurredAt,
      version: current.version + 1,
      metadata: auditMetadata(current, action, occurredAt)
    }, { trustedOwnerUserId: current.ownerUserId });
  }
  function correctedRecord(current, command, memoryId, occurredAt, correctionSensitivity) {
    const assessed = correctionSensitivity(immutableCopy(current), immutableCopy(command));
    if (!MEMORY_V2_SENSITIVITIES.includes(assessed)) fail2("SENSITIVITY_INVALID", "Correction sensitivity must be governed.");
    const sensitivity = MEMORY_V2_SENSITIVITIES[Math.max(MEMORY_V2_SENSITIVITIES.indexOf(current.sensitivity), MEMORY_V2_SENSITIVITIES.indexOf(assessed))];
    const sourceMessageId = nonEmptyString4(command.sourceMessageId) ? command.sourceMessageId.trim() : null;
    return createMemoryRecordV2({
      ...structuredClone(current),
      memoryId,
      structuredValue: structuredClone(command.structuredValue),
      displayValue: null,
      sensitivity,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      effectiveFrom: occurredAt,
      effectiveTo: null,
      status: "confirmed",
      version: current.version + 1,
      supersedesId: current.memoryId,
      supersededById: null,
      conflictGroupId: null,
      provenance: "user_confirmed",
      source: sourceMessageId ? { type: "conversation_message", id: sourceMessageId } : structuredClone(current.source),
      sourceTimestamp: sourceMessageId ? occurredAt : current.sourceTimestamp,
      metadata: {
        ...auditMetadata(current, "correction", occurredAt),
        ...sourceMessageId ? { sourceMessageId } : {}
      }
    }, { trustedOwnerUserId: current.ownerUserId });
  }
  function invalidation({ ownerUserId, command, memoryId, previousVersion, newVersion, occurredAt }) {
    const binding = {
      ownerUserId,
      subjectEntityId: command.subjectEntityId,
      predicate: command.predicate,
      memoryId,
      lifecycleAction: command.lifecycleAction,
      previousVersion,
      newVersion,
      occurredAt
    };
    return Object.freeze({ ...binding, invalidationToken: digest3(binding) });
  }
  function result2(outcome, command, event, memoryId) {
    return Object.freeze({
      outcome,
      confirmationRequired: command.lifecycleAction === "purge",
      lifecycleAction: command.lifecycleAction,
      memoryId,
      invalidation: event
    });
  }
  function idempotentResult(value, commandFingerprint) {
    return Object.freeze({ ...value, commandFingerprint });
  }
  function publicResult(value, commandFingerprint) {
    if (value?.commandFingerprint !== commandFingerprint) {
      fail2("IDEMPOTENCY_CONFLICT", "idempotencyKey was already used for a different lifecycle command.");
    }
    const { commandFingerprint: ignored, ...visible } = value;
    return Object.freeze(visible);
  }
  function chainFor(records, targetMemoryId) {
    const ids = /* @__PURE__ */ new Set([targetMemoryId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        if (ids.has(record.memoryId) || ids.has(record.supersedesId) || ids.has(record.supersededById)) {
          if (!ids.has(record.memoryId)) {
            ids.add(record.memoryId);
            changed = true;
          }
        }
      }
    }
    return records.filter((record) => ids.has(record.memoryId));
  }
  function purgedMarker(current, event) {
    return Object.freeze({
      ownerUserId: current.ownerUserId,
      memoryId: current.memoryId,
      subjectEntityId: current.subjectEntityId,
      predicate: current.predicate,
      status: "deleted",
      version: event.newVersion,
      metadata: Object.freeze({
        purgedMarker: true,
        lifecycleAction: "purge",
        invalidationToken: event.invalidationToken,
        purgedAt: event.occurredAt
      })
    });
  }
  function createMemoryLifecycleV2({
    foundation,
    now = () => (/* @__PURE__ */ new Date()).toISOString(),
    memoryIdFactory,
    faultInjector = () => {
    },
    correctionSensitivity = (current) => current.sensitivity
  } = {}) {
    if (!foundation?.unitOfWork || typeof foundation.unitOfWork.run !== "function" || typeof memoryIdFactory !== "function" || typeof now !== "function" || typeof faultInjector !== "function" || typeof correctionSensitivity !== "function") {
      throw new TypeError("Memory Lifecycle V2 requires Foundation Unit of Work, clock, ID factory, and fault injector.");
    }
    return Object.freeze({
      async execute(trustedContext, input) {
        assertContext2(trustedContext);
        const command = assertCommand(input);
        if (command.lifecycleAction === "purge" && !command.confirmed) {
          return Object.freeze({
            outcome: "confirmation_required",
            confirmationRequired: true,
            lifecycleAction: "purge",
            memoryId: command.memoryId,
            invalidation: null
          });
        }
        const ownerUserId = trustedContext.ownerUserId;
        const commandFingerprint = digest3(command);
        const stored = await foundation.unitOfWork.run({
          ownerUserId,
          idempotencyKey: `memory-lifecycle-v2:${command.idempotencyKey}`
        }, async ({ memories }) => {
          const current = memories.getById(ownerUserId, command.memoryId);
          if (!current) fail2("MEMORY_NOT_FOUND", "Memory was not found in the trusted owner scope.");
          if (current.metadata?.purgedMarker === true) fail2("MEMORY_PURGED", "Purged Memory cannot be restored or changed.");
          assertScope(current, command, command.lifecycleAction);
          const occurredAt = now();
          if (!isoTimestamp2(occurredAt)) fail2("TRUSTED_TIME_INVALID", "Lifecycle clock must return an ISO timestamp.");
          const records = memories.listByEntityAndPredicateForLifecycle(
            ownerUserId,
            command.subjectEntityId,
            command.predicate
          );
          if (command.lifecycleAction === "correction") {
            if (current.supersededById || records.some((record) => record.supersedesId === current.memoryId)) {
              fail2("MEMORY_CONFLICT", "Memory version already has a superseding branch.");
            }
            if (current.status !== "confirmed" || current.conflictGroupId) {
              fail2("MEMORY_CONFLICT", "Only one unconflicted current confirmed Memory can be corrected.");
            }
            assertVersion(current, command.expectedVersion);
            const replacementId = memoryIdFactory();
            if (!nonEmptyString4(replacementId)) fail2("MEMORY_ID_INVALID", "Correction memoryIdFactory returned an invalid ID.");
            const previous = transitionRecord(current, {
              status: "superseded",
              supersededById: replacementId,
              effectiveTo: occurredAt
            }, "correction", occurredAt);
            memories.transition(ownerUserId, current.memoryId, previous, { expectedVersion: current.version });
            faultInjector("after_previous_superseded");
            const replacement = correctedRecord(current, command, replacementId, occurredAt, correctionSensitivity);
            memories.create(ownerUserId, replacement);
            faultInjector("after_correction");
            const event2 = invalidation({
              ownerUserId,
              command,
              memoryId: replacement.memoryId,
              previousVersion: current.version,
              newVersion: replacement.version,
              occurredAt
            });
            return idempotentResult(result2("corrected", command, event2, replacement.memoryId), commandFingerprint);
          }
          if (command.lifecycleAction === "delete") {
            if (current.supersededById || current.status === "superseded") {
              fail2("DELETE_SUPERSEDED_FORBIDDEN", "Superseded old Memory cannot be deleted as current fact.");
            }
            assertVersion(current, command.expectedVersion);
            const deleted = transitionRecord(current, { status: "deleted" }, "delete", occurredAt);
            memories.transition(ownerUserId, current.memoryId, deleted, { expectedVersion: current.version });
            faultInjector("after_delete");
            const event2 = invalidation({
              ownerUserId,
              command,
              memoryId: deleted.memoryId,
              previousVersion: current.version,
              newVersion: deleted.version,
              occurredAt
            });
            return idempotentResult(result2("deleted", command, event2, deleted.memoryId), commandFingerprint);
          }
          if (command.lifecycleAction === "restore") {
            if (current.status === "superseded" || current.supersededById) {
              fail2("RESTORE_SUPERSEDED_FORBIDDEN", "Superseded old Memory cannot become current through restore.");
            }
            if (current.status !== "deleted") fail2("RESTORE_NOT_DELETED", "Only deleted Memory can be restored.");
            if (current.conflictGroupId || records.filter((record) => record.supersedesId === current.memoryId).length > 0) {
              fail2("MEMORY_CONFLICT", "Conflicted Memory cannot be restored.");
            }
            assertVersion(current, command.expectedVersion);
            const restored = transitionRecord(current, { status: "confirmed", effectiveTo: null }, "restore", occurredAt);
            memories.transition(ownerUserId, current.memoryId, restored, { expectedVersion: current.version });
            faultInjector("after_restore");
            const event2 = invalidation({
              ownerUserId,
              command,
              memoryId: restored.memoryId,
              previousVersion: current.version,
              newVersion: restored.version,
              occurredAt
            });
            return idempotentResult(result2("restored", command, event2, restored.memoryId), commandFingerprint);
          }
          assertVersion(current, command.expectedVersion);
          const chain = chainFor(records, current.memoryId);
          const event = invalidation({
            ownerUserId,
            command,
            memoryId: current.memoryId,
            previousVersion: current.version,
            newVersion: current.version + 1,
            occurredAt
          });
          memories.purgeChain(ownerUserId, {
            targetMemoryId: current.memoryId,
            subjectEntityId: current.subjectEntityId,
            predicate: current.predicate,
            expectedVersion: current.version,
            chainMemoryIds: chain.map((record) => record.memoryId),
            marker: purgedMarker(current, event)
          });
          faultInjector("after_purge");
          return idempotentResult(result2("purged", command, event, current.memoryId), commandFingerprint);
        });
        return publicResult(stored, commandFingerprint);
      }
    });
  }

  // memory/entity/memoryCaptureStores.js
  function freeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
  }
  function copy(value) {
    return value === null || value === void 0 ? value : freeze(structuredClone(value));
  }
  function required2(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${field} is required.`);
    }
    return value;
  }
  var PendingCandidateStore = class {
    constructor({ now, tokenFactory, ttlMs }) {
      this.now = now;
      this.tokenFactory = tokenFactory;
      this.ttlMs = ttlMs;
      this.entries = /* @__PURE__ */ new Map();
    }
    create(ownerUserId, candidate) {
      required2(ownerUserId, "ownerUserId");
      const confirmationToken = required2(this.tokenFactory(), "confirmationToken");
      const createdAt = this.now();
      const entry = {
        confirmationToken,
        ownerUserId,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + this.ttlMs).toISOString(),
        candidate: structuredClone(candidate)
      };
      if (this.entries.has(confirmationToken)) throw new Error("confirmationToken collision.");
      this.entries.set(confirmationToken, entry);
      return copy(entry);
    }
    get(ownerUserId, confirmationToken) {
      required2(ownerUserId, "ownerUserId");
      required2(confirmationToken, "confirmationToken");
      const entry = this.entries.get(confirmationToken);
      if (!entry) throw new Error("Pending candidate was not found.");
      if (entry.ownerUserId !== ownerUserId) throw new Error("Pending candidate owner mismatch.");
      if (Date.parse(this.now()) >= Date.parse(entry.expiresAt)) {
        this.entries.delete(confirmationToken);
        throw new Error("Pending candidate expired.");
      }
      return copy(entry);
    }
    consume(ownerUserId, confirmationToken) {
      const entry = this.get(ownerUserId, confirmationToken);
      this.entries.delete(confirmationToken);
      return entry;
    }
    reject(ownerUserId, confirmationToken) {
      return this.consume(ownerUserId, confirmationToken);
    }
    size(ownerUserId) {
      required2(ownerUserId, "ownerUserId");
      return [...this.entries.values()].filter(
        (entry) => entry.ownerUserId === ownerUserId && Date.parse(this.now()) < Date.parse(entry.expiresAt)
      ).length;
    }
    clearOwner(ownerUserId) {
      required2(ownerUserId, "ownerUserId");
      let deleted = 0;
      for (const [token, entry] of this.entries.entries()) {
        if (entry.ownerUserId !== ownerUserId) continue;
        this.entries.delete(token);
        deleted += 1;
      }
      return deleted;
    }
  };
  var TemporaryContextStore = class {
    constructor({ now, tokenFactory }) {
      this.now = now;
      this.tokenFactory = tokenFactory;
      this.entries = /* @__PURE__ */ new Map();
      this.idempotency = /* @__PURE__ */ new Map();
    }
    put({ ownerUserId, subjectEntityId, decision, idempotencyKey }) {
      required2(ownerUserId, "ownerUserId");
      required2(subjectEntityId, "subjectEntityId");
      required2(idempotencyKey, "idempotencyKey");
      const replayKey = JSON.stringify([ownerUserId, idempotencyKey]);
      const replayId = this.idempotency.get(replayKey);
      if (replayId) return copy(this.entries.get(replayId));
      const expiresAt = decision?.retentionPolicy?.expiresAt;
      if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(this.now())) {
        throw new TypeError("Temporary context requires a future expiresAt.");
      }
      const contextId = required2(this.tokenFactory(), "contextId");
      const entry = {
        contextId,
        ownerUserId,
        subjectEntityId,
        memoryType: decision.memoryType,
        predicate: decision.predicate,
        structuredValue: structuredClone(decision.suggestedStructuredValue),
        sourceTextDigest: decision.sourceTextDigest,
        createdAt: this.now(),
        expiresAt
      };
      this.entries.set(contextId, entry);
      this.idempotency.set(replayKey, contextId);
      return copy(entry);
    }
    listActive(ownerUserId) {
      required2(ownerUserId, "ownerUserId");
      const now = Date.parse(this.now());
      return Object.freeze([...this.entries.values()].filter((entry) => entry.ownerUserId === ownerUserId && now < Date.parse(entry.expiresAt)).map(copy));
    }
    clearOwner(ownerUserId) {
      required2(ownerUserId, "ownerUserId");
      let deleted = 0;
      for (const [contextId, entry] of this.entries.entries()) {
        if (entry.ownerUserId !== ownerUserId) continue;
        this.entries.delete(contextId);
        deleted += 1;
      }
      for (const [key, contextId] of this.idempotency.entries()) {
        if (!this.entries.has(contextId)) this.idempotency.delete(key);
      }
      return deleted;
    }
  };
  function createMemoryCaptureStores({
    now = () => (/* @__PURE__ */ new Date()).toISOString(),
    tokenFactory = () => nativeCrypto_default.randomUUID(),
    pendingTtlMs = 15 * 60 * 1e3
  } = {}) {
    if (typeof now !== "function" || typeof tokenFactory !== "function") {
      throw new TypeError("Memory capture stores require clock and token factories.");
    }
    if (!Number.isInteger(pendingTtlMs) || pendingTtlMs < 1) {
      throw new TypeError("pendingTtlMs must be a positive integer.");
    }
    return Object.freeze({
      pendingCandidates: new PendingCandidateStore({ now, tokenFactory, ttlMs: pendingTtlMs }),
      temporaryContexts: new TemporaryContextStore({ now, tokenFactory })
    });
  }

  // memory/kernel/enums.js
  function frozenValues(definition) {
    return Object.freeze(Object.values(definition));
  }
  var MemoryStatus = Object.freeze({
    CANDIDATE: "candidate",
    PENDING_CONFIRMATION: "pending_confirmation",
    CONFIRMED: "confirmed",
    DISPUTED: "disputed",
    SUPERSEDED: "superseded",
    EXPIRED: "expired",
    ARCHIVED: "archived",
    DELETED: "deleted"
  });
  var MemoryConfirmation = Object.freeze({
    NOT_REQUIRED: "not_required",
    PENDING: "pending",
    USER_CONFIRMED: "user_confirmed",
    USER_REJECTED: "user_rejected",
    SYSTEM_VERIFIED: "system_verified"
  });
  var MemorySensitivity = Object.freeze({
    PUBLIC: "public",
    LOW: "low",
    MEDIUM: "medium",
    HIGH: "high",
    RESTRICTED: "restricted"
  });
  var MemoryImportance = Object.freeze({
    MIN: 0,
    MAX: 1
  });
  var MemorySourceType = Object.freeze({
    USER_EXPLICIT: "user_explicit",
    USER_CONFIRMED: "user_confirmed",
    STRUCTURED_SYSTEM_RECORD: "structured_system_record",
    REPEATED_OBSERVATION: "repeated_observation",
    MODEL_INFERRED: "model_inferred",
    IMPORTED: "imported",
    LEGACY_UNKNOWN: "legacy_unknown"
  });
  var MemoryType = Object.freeze({
    FACT: "fact",
    RELATIONSHIP: "relationship",
    PREFERENCE: "preference",
    GOAL: "goal",
    LIFE_EVENT: "life_event",
    HABIT_ROUTINE: "habit_routine",
    CONSTRAINT: "constraint",
    COMMITMENT: "commitment",
    DECISION: "decision",
    CONTEXT: "context",
    MEMORY_CANDIDATE: "memory_candidate",
    SENSITIVE_MEMORY: "sensitive_memory"
  });
  var MemoryEventType = Object.freeze({
    CANDIDATE_CREATED: "candidate_created",
    CONFIRMATION_REQUESTED: "confirmation_requested",
    CONFIRMED: "confirmed",
    DISPUTED: "disputed",
    SUPERSEDED: "superseded",
    EXPIRED: "expired",
    ARCHIVED: "archived",
    DELETED: "deleted"
  });
  var MEMORY_STATUSES = frozenValues(MemoryStatus);
  var MEMORY_CONFIRMATIONS = frozenValues(MemoryConfirmation);
  var MEMORY_SENSITIVITIES = frozenValues(MemorySensitivity);
  var MEMORY_SOURCE_TYPES = frozenValues(MemorySourceType);
  var MEMORY_TYPES = frozenValues(MemoryType);
  var MEMORY_EVENT_TYPES = frozenValues(MemoryEventType);
  var MEMORY_IMPORTANCE_RANGE = Object.freeze({ min: MemoryImportance.MIN, max: MemoryImportance.MAX });

  // memory/kernel/errors.js
  var MEMORY_KERNEL_ERROR_CODES = Object.freeze([
    "INVALID_TYPE",
    "REQUIRED",
    "UNKNOWN_FIELD",
    "UNSUPPORTED_SCHEMA_VERSION",
    "INVALID_ENUM",
    "INVALID_NUMBER",
    "INVALID_DATE",
    "INVALID_RANGE",
    "USER_SCOPE_REQUIRED",
    "USER_SCOPE_MISMATCH",
    "SOURCE_REQUIRED",
    "MODEL_CONFIRMED_FORBIDDEN",
    "CANDIDATE_STATUS_REQUIRED",
    "CONFIRMATION_REQUIRED",
    "SECRET_FORBIDDEN",
    "INVALID_TRANSITION",
    "INTERFACE_METHOD_MISSING",
    "INVARIANT_VIOLATION",
    "MEMORY_EXPECTED_VERSION_REQUIRED",
    "MEMORY_VERSION_CONFLICT",
    "MEMORY_RECORD_NOT_FOUND",
    "MEMORY_TRANSACTION_FAILED",
    "MEMORY_NESTED_TRANSACTION_UNSUPPORTED",
    "MEMORY_BATCH_ATOMICITY_FAILED",
    "MEMORY_IDEMPOTENCY_CONFLICT"
  ]);

  // memory/kernel/interfaces.js
  function descriptor(name, requiredMethods) {
    return Object.freeze({
      name,
      schemaVersion: "v1",
      requiredMethods: Object.freeze(requiredMethods)
    });
  }
  var MemoryRepository = descriptor("MemoryRepository", [
    "getById",
    "query",
    "count",
    "getVersionChain",
    "getConflictGroup",
    "create",
    "createMany",
    "update",
    "confirm",
    "reject",
    "dispute",
    "archive",
    "expire",
    "supersede",
    "moveToRecycleBin",
    "restore",
    "purge",
    "withTransaction"
  ]);

  // memory/kernel/invariants.js
  function freezeTransitions(transitions) {
    return Object.freeze(Object.fromEntries(
      Object.entries(transitions).map(([status, next]) => [status, Object.freeze(next)])
    ));
  }
  var MemoryLifecycle = Object.freeze({
    schemaVersion: "v1",
    transitions: freezeTransitions({
      [MemoryStatus.CANDIDATE]: [
        MemoryStatus.PENDING_CONFIRMATION,
        MemoryStatus.CONFIRMED,
        MemoryStatus.DISPUTED,
        MemoryStatus.EXPIRED,
        MemoryStatus.ARCHIVED,
        MemoryStatus.DELETED
      ],
      [MemoryStatus.PENDING_CONFIRMATION]: [
        MemoryStatus.CONFIRMED,
        MemoryStatus.DISPUTED,
        MemoryStatus.EXPIRED,
        MemoryStatus.ARCHIVED,
        MemoryStatus.DELETED
      ],
      [MemoryStatus.CONFIRMED]: [
        MemoryStatus.DISPUTED,
        MemoryStatus.SUPERSEDED,
        MemoryStatus.EXPIRED,
        MemoryStatus.ARCHIVED,
        MemoryStatus.DELETED
      ],
      [MemoryStatus.DISPUTED]: [
        MemoryStatus.CONFIRMED,
        MemoryStatus.SUPERSEDED,
        MemoryStatus.ARCHIVED,
        MemoryStatus.DELETED
      ],
      [MemoryStatus.SUPERSEDED]: [MemoryStatus.ARCHIVED, MemoryStatus.DELETED],
      [MemoryStatus.EXPIRED]: [MemoryStatus.ARCHIVED, MemoryStatus.DELETED],
      [MemoryStatus.ARCHIVED]: [MemoryStatus.DELETED],
      [MemoryStatus.DELETED]: []
    })
  });
  var MEMORY_INVARIANTS = Object.freeze([
    Object.freeze({ id: "USER_ID_REQUIRED", statement: "Every Memory contract is scoped to one trusted userId." }),
    Object.freeze({ id: "SOURCE_REQUIRED", statement: "Every Memory has a traceable source." }),
    Object.freeze({ id: "FORMAL_MEMORY_TRACEABLE", statement: "Formal Memory retains source, time, and version." }),
    Object.freeze({ id: "MODEL_CANNOT_CONFIRM", statement: "A model can propose a Candidate but cannot confirm a fact." }),
    Object.freeze({ id: "CANDIDATE_NOT_FORMAL", statement: "A Candidate is not a confirmed fact." }),
    Object.freeze({ id: "SUPERSEDED_NOT_CURRENT", statement: "Superseded Memory is never current." }),
    Object.freeze({ id: "DELETED_NOT_RECALLABLE", statement: "Deleted Memory is never recallable." }),
    Object.freeze({ id: "NO_SILENT_OVERWRITE", statement: "A changed fact creates a version link instead of overwriting history." })
  ]);

  // memory/kernel/schemas.js
  var MEMORY_SCHEMA_VERSION = "v1";
  function schema2(name, fields, required3 = fields) {
    return Object.freeze({
      name,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      fields: Object.freeze([...fields]),
      required: Object.freeze([...required3]),
      unknownFieldPolicy: "reject"
    });
  }
  var MEMORY_RECORD_FIELDS = Object.freeze([
    "id",
    "schemaVersion",
    "userId",
    "memoryType",
    "subject",
    "predicate",
    "value",
    "normalizedValue",
    "source",
    "sourceTimestamp",
    "createdAt",
    "updatedAt",
    "effectiveFrom",
    "effectiveTo",
    "confidence",
    "importance",
    "sensitivity",
    "status",
    "confirmationStatus",
    "expiresAt",
    "version",
    "supersedesId",
    "supersededById",
    "conflictGroupId",
    "retentionPolicy",
    "accessPolicy",
    "checksum",
    "tags",
    "metadata"
  ]);
  var MemoryRecord = schema2("MemoryRecord", MEMORY_RECORD_FIELDS, [
    "id",
    "schemaVersion",
    "userId",
    "memoryType",
    "subject",
    "predicate",
    "value",
    "normalizedValue",
    "source",
    "sourceTimestamp",
    "createdAt",
    "updatedAt",
    "effectiveFrom",
    "effectiveTo",
    "confidence",
    "importance",
    "sensitivity",
    "status",
    "confirmationStatus",
    "version",
    "retentionPolicy",
    "accessPolicy",
    "metadata"
  ]);
  var MemoryCandidate = schema2("MemoryCandidate", [
    "id",
    "schemaVersion",
    "userId",
    "proposedMemory",
    "source",
    "createdAt",
    "expiresAt",
    "modelGenerated",
    "metadata"
  ]);
  var MemorySource = schema2("MemorySource", ["type", "id"]);
  var MemoryPolicy = schema2("MemoryPolicy", ["retentionPolicy", "accessPolicy"]);
  var MemoryQuery = schema2("MemoryQuery", [
    "userId",
    "id",
    "memoryType",
    "memoryTypes",
    "status",
    "statuses",
    "confirmationStatus",
    "confirmationStatuses",
    "sensitivityMax",
    "sensitivities",
    "subject",
    "predicate",
    "effectiveAt",
    "tags",
    "includeHistorical",
    "includeCandidates",
    "limit",
    "cursor",
    "sort"
  ], ["userId"]);
  var MemoryResult = schema2("MemoryResult", ["ok", "data", "error", "metadata"], ["ok", "data", "error"]);
  var MemoryVersion = schema2("MemoryVersion", [
    "memoryId",
    "version",
    "supersedesId",
    "supersededById",
    "checksum",
    "createdAt"
  ], ["memoryId", "version", "createdAt"]);
  var MemoryConflict = schema2("MemoryConflict", [
    "conflictGroupId",
    "userId",
    "memoryIds",
    "createdAt"
  ]);
  var MemoryEvent = schema2("MemoryEvent", [
    "id",
    "userId",
    "memoryId",
    "eventType",
    "occurredAt",
    "metadata"
  ]);

  // memory/kernel/types.js
  var MEMORY_KERNEL_TYPE_NAMES = Object.freeze([
    "MemoryRecord",
    "MemoryCandidate",
    "MemorySource",
    "MemoryPolicy",
    "MemoryQuery",
    "MemoryResult",
    "MemoryVersion",
    "MemoryConflict",
    "MemoryStatus",
    "MemoryConfirmation",
    "MemorySensitivity",
    "MemoryImportance",
    "MemoryLifecycle",
    "MemoryEvent",
    "MemoryRepository"
  ]);

  // memory/capture/contracts.js
  var CaptureIntent = Object.freeze({
    NOT_MEMORY: "not_memory",
    CONTEXT_ONLY: "context_only",
    LONG_TERM_MEMORY: "long_term_memory",
    EXPLICIT_REMEMBER: "explicit_remember",
    FORGET: "forget"
  });
  var CaptureOutcome = Object.freeze({
    REJECTED: "rejected",
    CONTEXT_ONLY: "context_only",
    CANDIDATE: "candidate",
    STORED: "stored",
    FORGOTTEN: "forgotten"
  });
  var CaptureReasonCode = Object.freeze({
    NOT_MEMORY: "CAPTURE_NOT_MEMORY",
    USER_OPTED_OUT: "CAPTURE_USER_OPTED_OUT",
    INVALID_INPUT: "CAPTURE_INVALID_INPUT",
    INVALID_CONTEXT: "CAPTURE_INVALID_CONTEXT",
    SOURCE_REQUIRED: "CAPTURE_SOURCE_REQUIRED",
    LONG_TERM_SIGNAL: "CAPTURE_LONG_TERM_SIGNAL",
    PROACTIVE_HIGH_VALUE_SIGNAL: "CAPTURE_PROACTIVE_HIGH_VALUE_SIGNAL",
    PROACTIVE_HIGH_VALUE_AUTHORIZED: "CAPTURE_PROACTIVE_HIGH_VALUE_AUTHORIZED",
    UNCERTAIN_USER_STATEMENT: "CAPTURE_UNCERTAIN_USER_STATEMENT",
    EXPLICIT_REMEMBER: "CAPTURE_EXPLICIT_REMEMBER",
    EXPLICIT_REMEMBER_AUTHORIZED: "CAPTURE_EXPLICIT_REMEMBER_AUTHORIZED",
    CONTEXT_ONLY: "CAPTURE_CONTEXT_ONLY",
    CONFIRMATION_REQUIRED: "CAPTURE_CONFIRMATION_REQUIRED",
    SENSITIVE_CONFIRMATION_REQUIRED: "CAPTURE_SENSITIVE_CONFIRMATION_REQUIRED",
    PROHIBITED_SECRET: "CAPTURE_PROHIBITED_SECRET",
    USER_CONFIRMED: "CAPTURE_USER_CONFIRMED",
    INVALID_CANDIDATE: "CAPTURE_INVALID_CANDIDATE",
    CANDIDATE_INTEGRITY_FAILED: "CAPTURE_CANDIDATE_INTEGRITY_FAILED",
    FORGET_INTENT: "CAPTURE_FORGET_INTENT",
    TARGET_MEMORY_REQUIRED: "CAPTURE_TARGET_MEMORY_REQUIRED",
    EXPECTED_VERSION_REQUIRED: "CAPTURE_EXPECTED_VERSION_REQUIRED",
    MOVED_TO_RECYCLE_BIN: "CAPTURE_MOVED_TO_RECYCLE_BIN",
    CONFLICT_CONFIRMATION_REQUIRED: "CAPTURE_CONFLICT_CONFIRMATION_REQUIRED",
    CONFLICT_SUPERSEDED: "CAPTURE_CONFLICT_SUPERSEDED",
    ASSISTANT_CANDIDATE_ONLY: "CAPTURE_ASSISTANT_CANDIDATE_ONLY",
    ASSISTANT_SENSITIVE_REJECTED: "CAPTURE_ASSISTANT_SENSITIVE_REJECTED"
  });
  var ConfirmationDecision = Object.freeze({
    AUTHORIZED: "authorized",
    REQUIRED: "required",
    REJECTED: "rejected"
  });
  var CaptureResult = Object.freeze({
    name: "CaptureResult",
    fields: Object.freeze([
      "ok",
      "outcome",
      "reasonCode",
      "intent",
      "candidate",
      "memory",
      "context",
      "requiresConfirmation",
      "audit",
      "error"
    ])
  });

  // memory/capture/familyBirthdayParser.js
  var RELATIONSHIPS = Object.freeze([
    { aliases: ["\u5988\u5988", "\u6BCD\u4EB2", "\u5988"], relation: "mother", personReference: "\u5988\u5988" },
    { aliases: ["\u7238\u7238", "\u7236\u4EB2", "\u7238"], relation: "father", personReference: "\u7238\u7238" },
    { aliases: ["\u8001\u5A46", "\u59BB\u5B50"], relation: "wife", personReference: "\u59BB\u5B50" },
    { aliases: ["\u8001\u516C", "\u4E08\u592B"], relation: "husband", personReference: "\u4E08\u592B" },
    { aliases: ["\u5973\u513F"], relation: "daughter", personReference: "\u5973\u513F" },
    { aliases: ["\u513F\u5B50"], relation: "son", personReference: "\u513F\u5B50" }
  ]);
  var CALENDARS = Object.freeze({
    \u519C\u5386: { calendarType: "lunar", label: "\u519C\u5386" },
    \u9634\u5386: { calendarType: "lunar", label: "\u519C\u5386" },
    \u516C\u5386: { calendarType: "solar", label: "\u516C\u5386" },
    \u9633\u5386: { calendarType: "solar", label: "\u516C\u5386" }
  });
  var UNCERTAIN = /(?:好像|可能|大概|也许|似乎|不确定|记不清|没记错的话)/;
  var DATE = /(?:(?<year>\d{4}|[〇零一二三四五六七八九]{4})年)?(?<month>\d{1,2}|正|冬|腊|十二|十一|十|[一二三四五六七八九])月(?<day>\d{1,2}|初[一二三四五六七八九十]|十[一二三四五六七八九]?|二十[一二三四五六七八九]?|廿[一二三四五六七八九]?|三十|卅|[一二三四五六七八九])(?:日|号)?/;
  var DIGITS = Object.freeze({ \u96F6: 0, "\u3007": 0, \u4E00: 1, \u4E8C: 2, \u4E09: 3, \u56DB: 4, \u4E94: 5, \u516D: 6, \u4E03: 7, \u516B: 8, \u4E5D: 9 });
  var SMALL_NUMBERS = Object.freeze(["\u96F6", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D", "\u4E03", "\u516B", "\u4E5D", "\u5341", "\u5341\u4E00", "\u5341\u4E8C", "\u5341\u4E09", "\u5341\u56DB", "\u5341\u4E94", "\u5341\u516D", "\u5341\u4E03", "\u5341\u516B", "\u5341\u4E5D", "\u4E8C\u5341", "\u4E8C\u5341\u4E00", "\u4E8C\u5341\u4E8C", "\u4E8C\u5341\u4E09", "\u4E8C\u5341\u56DB", "\u4E8C\u5341\u4E94", "\u4E8C\u5341\u516D", "\u4E8C\u5341\u4E03", "\u4E8C\u5341\u516B", "\u4E8C\u5341\u4E5D", "\u4E09\u5341", "\u4E09\u5341\u4E00"]);
  function compact(value) {
    return String(value ?? "").trim().replace(/\s+/g, "").replace(/[。！!，,；;]$/, "");
  }
  function chineseNumber(value) {
    const text = String(value);
    if (/^\d+$/.test(text)) return Number(text);
    if (text === "\u6B63") return 1;
    if (text === "\u51AC") return 11;
    if (text === "\u814A") return 12;
    if (text.startsWith("\u521D")) return chineseNumber(text.slice(1));
    if (text === "\u5345") return 30;
    if (text.startsWith("\u5EFF")) return 20 + chineseNumber(text.slice(1) || "\u96F6");
    if (text.startsWith("\u4E8C\u5341")) return 20 + chineseNumber(text.slice(2) || "\u96F6");
    if (text.startsWith("\u5341")) return 10 + chineseNumber(text.slice(1) || "\u96F6");
    return DIGITS[text] ?? Number.NaN;
  }
  function yearNumber(value) {
    if (!value) return null;
    if (/^\d{4}$/.test(value)) return Number(value);
    const digits = [...value].map((character) => DIGITS[character]);
    return digits.some((digit) => digit === void 0) ? Number.NaN : Number(digits.join(""));
  }
  function validDate({ calendarType, year, month, day }) {
    if (!Number.isInteger(month) || month < 1 || month > 12) return false;
    if (!Number.isInteger(day) || day < 1 || day > (calendarType === "lunar" ? 30 : 31)) return false;
    if (!year || calendarType === "lunar") return true;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  function displayDate({ calendarType, calendarLabel, year, month, day }) {
    const monthText = SMALL_NUMBERS[month];
    const dayText = calendarType === "lunar" && day <= 10 ? `\u521D${SMALL_NUMBERS[day]}` : SMALL_NUMBERS[day];
    return `${calendarLabel}${year ? `${year}\u5E74` : ""}${monthText}\u6708${dayText}\u65E5`;
  }
  function relationshipAtStart(text) {
    if (!text.startsWith("\u6211")) return null;
    const rest = text.slice(1);
    for (const relationship of RELATIONSHIPS) {
      const alias = relationship.aliases.find((candidate) => rest.startsWith(candidate));
      if (alias) return { ...relationship, alias, rest: rest.slice(alias.length) };
    }
    return null;
  }
  function parseFamilyBirthdayStatement(input) {
    const text = compact(input);
    const person = relationshipAtStart(text);
    if (!person || !person.rest.includes("\u751F\u65E5") && !person.rest.includes("\u51FA\u751F")) return null;
    const dateMatch = person.rest.match(DATE);
    if (!dateMatch?.groups) return null;
    const calendarToken = Object.keys(CALENDARS).find((token) => person.rest.includes(token)) || null;
    const calendar = calendarToken ? CALENDARS[calendarToken] : { calendarType: null, label: "" };
    const year = yearNumber(dateMatch.groups.year);
    const month = chineseNumber(dateMatch.groups.month);
    const day = chineseNumber(dateMatch.groups.day);
    if (!validDate({ calendarType: calendar.calendarType, year, month, day })) return null;
    const residue = person.rest.replace(dateMatch[0], "").replace(calendarToken || "", "").replace("\u751F\u65E5", "").replace(/出生日期|出生/g, "").replace(UNCERTAIN, "").replace(/[的是在于]/g, "");
    if (residue) return null;
    const normalizedDate = displayDate({
      calendarType: calendar.calendarType,
      calendarLabel: calendar.label,
      year,
      month,
      day
    });
    return Object.freeze({
      content: `\u6211${person.personReference}\u7684\u751F\u65E5\u662F${normalizedDate}`,
      uncertain: UNCERTAIN.test(text),
      semantic: Object.freeze({
        kind: "family_birthday",
        factType: "birthday",
        relation: person.relation,
        relationship: person.relation,
        personReference: person.personReference,
        calendarType: calendar.calendarType,
        year,
        month,
        day
      })
    });
  }

  // memory/capture/policies.js
  var PROHIBITED = Object.freeze([
    ["password", /(?:密码|password|passcode)/i],
    ["api_key", /api[\s_-]*key/i],
    ["cookie", /cookie/i],
    ["session_token", /session[\s_-]*token/i],
    ["access_token", /access[\s_-]*token/i],
    ["refresh_token", /refresh[\s_-]*token/i],
    ["private_key", /(?:私钥|private[\s_-]*key)/i],
    ["recovery_code", /(?:恢复码|recovery[\s_-]*code)/i],
    ["full_bank_card", /(?:完整)?(?:银行卡号|银行卡|卡号).{0,16}\d(?:[\s-]?\d){11,18}/i],
    ["full_identity_number", /(?:完整)?(?:身份证件号码|身份证号码|身份证号|证件号码).{0,16}\d{15,17}[\dXx]/i]
  ]);
  var HIGH_SENSITIVITY = Object.freeze([
    ["health", /(?:过敏|健康|病历|诊断|疾病|用药|体检|手术)/],
    ["finance", /(?:收入|工资|财务|资产|负债|存款|投资|欠款)/],
    ["family_relationship", /(?:女儿|儿子|父亲|母亲|爸爸|妈妈|妻子|丈夫|家庭关系)/],
    ["precise_address", /(?:家庭住址|住址|详细地址|家庭地址).{0,60}(?:号|室|栋|单元)/],
    ["precise_location", /(?:长期住在|精确位置|测试坐标|经度|纬度).{0,60}(?:\d|号)/],
    ["private_relationship", /(?:私密关系|亲密关系|婚外关系)/]
  ]);
  var SensitivePolicy = class {
    evaluate(input) {
      const text = String(input ?? "");
      const prohibitedCategories = PROHIBITED.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
      if (prohibitedCategories.length) {
        return { sensitivity: MemorySensitivity.RESTRICTED, prohibited: true, categories: prohibitedCategories };
      }
      const lowRiskFamilyBirthday = Boolean(parseFamilyBirthdayStatement(text));
      const categories = HIGH_SENSITIVITY.filter(([category, pattern]) => pattern.test(text) && !(category === "family_relationship" && lowRiskFamilyBirthday)).map(([category]) => category);
      return {
        sensitivity: categories.length ? MemorySensitivity.HIGH : MemorySensitivity.LOW,
        prohibited: false,
        categories
      };
    }
  };

  // memory/mobile/snapshot.js
  var fail3 = () => {
    throw Object.assign(new Error("Local memory snapshot failed validation."), { code: "LOCAL_MEMORY_CORRUPT" });
  };
  function encodeSnapshot(ownerUserId, state, requests) {
    return JSON.stringify({
      schemaVersion: "mobile-memory-v2:1",
      ownerUserId,
      state: Object.fromEntries(Object.entries(state).map(([key, map]) => [
        key,
        [...map.entries()].map(([k, v]) => [k, v instanceof Set ? [...v] : v])
      ])),
      requests
    });
  }
  function decodeSnapshot(ownerUserId, data) {
    if (data === null) return { state: createFoundationState(), requests: {} };
    try {
      const parsed = JSON.parse(data);
      if (parsed.schemaVersion !== "mobile-memory-v2:1" || parsed.ownerUserId !== ownerUserId || !parsed.requests || Array.isArray(parsed.requests)) fail3();
      const state = createFoundationState();
      if (Object.keys(parsed.state).length !== Object.keys(state).length) fail3();
      for (const key of Object.keys(state)) {
        if (!Array.isArray(parsed.state[key])) fail3();
        state[key] = new Map(parsed.state[key]);
        if (state[key].size !== parsed.state[key].length) fail3();
      }
      for (const [kind, validate] of Object.entries({
        entities: validateEntity,
        aliases: validateEntityAlias,
        relations: validateEntityRelation,
        memories: validateMemoryRecordV2
      })) {
        for (const record of state[kind].values()) {
          if (record.ownerUserId !== ownerUserId || !validate(record, { trustedOwnerUserId: ownerUserId }).valid) fail3();
        }
      }
      const expected = /* @__PURE__ */ new Map();
      for (const [key, record] of state.memories) {
        if (key !== memoryKey(ownerUserId, record.memoryId)) fail3();
        const scope = memoryScopeKey(ownerUserId, record.subjectEntityId, record.predicate);
        if (!expected.has(scope)) expected.set(scope, /* @__PURE__ */ new Set());
        expected.get(scope).add(key);
      }
      for (const [key, members] of state.memoryScopeIndex) {
        if (!Array.isArray(members) || !expected.has(key) || members.length !== expected.get(key).size || members.some((x) => !expected.get(key).has(x))) fail3();
      }
      if (state.memoryScopeIndex.size !== expected.size) fail3();
      state.memoryScopeIndex = expected;
      return { state, requests: parsed.requests };
    } catch {
      return fail3();
    }
  }

  // core/memory/localEvidence.js
  function explicitMemoryText(text) {
    return String(text || "").trim().match(/^(?:(?:请|帮我|替我)\s*)?(?:记住|记一下|记下|以后记得|记录一下)[：:,，\s]*(.+)$|^(?:please\s+)?remember\s+(.+)$/isu)?.slice(1).find(Boolean)?.trim() || null;
  }

  // memory/mobile/runtime.js
  var fail4 = (code) => {
    throw Object.assign(new Error(code), { code });
  };
  var hash = (value) => nativeCrypto_default.createHash("sha256").update(value).digest("hex");
  var sensitive = new SensitivePolicy();
  function projection(record) {
    return {
      memoryId: record.memoryId,
      version: record.version,
      text: record.structuredValue.value,
      source: record.source,
      updatedAt: record.updatedAt,
      createdAt: record.createdAt,
      sensitivity: record.sensitivity
    };
  }
  var relatedTerms = [
    ["\u5DE5\u4F5C", "\u804C\u4E1A", "\u884C\u4E1A", "\u505A\u4EC0\u4E48", "\u54EA\u4E00\u884C", "\u7ECF\u8425", "\u5DE5\u5382", "\u516C\u53F8", "\u8001\u677F", "\u5458\u5DE5", "\u9000\u4F11"],
    ["\u751F\u65E5", "\u51FA\u751F", "\u751F\u8FB0", "\u51E0\u6708\u51E0\u53F7"],
    ["\u559C\u6B22", "\u504F\u597D", "\u7231\u597D", "\u4E60\u60EF"],
    ["\u559D", "\u996E\u6599", "\u996E\u54C1", "\u8336", "\u5496\u5561"],
    ["\u4F4F", "\u5C45\u4F4F", "\u5BB6\u4E61", "\u8001\u5BB6", "\u54EA\u91CC\u4EBA"],
    ["\u79F0\u547C", "\u540D\u5B57", "\u59D3\u540D", "\u53EB\u4EC0\u4E48"],
    ["\u5BB6\u4EBA", "\u5BB6\u5EAD", "\u5988\u5988", "\u6BCD\u4EB2", "\u7238\u7238", "\u7236\u4EB2", "\u5973\u513F", "\u513F\u5B50", "\u59BB\u5B50", "\u4E08\u592B"]
  ];
  function relevance(question, text) {
    const terms = new Set(String(question).toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu)?.flatMap((t) => /^[a-z0-9]/.test(t) ? [t] : [...t].slice(0, -1).map((c, i) => c + t[i + 1])) || []);
    for (const stop of ["\u4EC0\u4E48", "\u54EA\u4E2A", "\u8BB0\u5F97", "\u544A\u8BC9", "\u6211\u7684", "\u4E00\u4E0B", "\u4E4B\u524D", "\u8BB0\u5FC6", "\u5173\u4E8E"]) terms.delete(stop);
    const normalized = text.toLowerCase();
    const related = relatedTerms.filter((group) => group.some((term) => String(question).includes(term))).reduce((score, group) => score + (group.some((term) => normalized.includes(term)) ? 1 : 0), 0);
    return related + [...terms].reduce((score, term) => score + (text.toLowerCase().includes(term) ? term.length : 0), 0);
  }
  async function createMobileMemoryRuntime({ ownerUserId, storage, now = () => (/* @__PURE__ */ new Date()).toISOString() }) {
    if (typeof ownerUserId !== "string" || !ownerUserId || ownerUserId.length > 256) fail4("OWNER_SCOPE_REQUIRED");
    if (!storage?.load || !storage?.commit) fail4("LOCAL_MEMORY_UNAVAILABLE");
    const scope = hash(`memory-v2:personal:${ownerUserId}`);
    const loaded = await storage.load(scope);
    if (!Number.isSafeInteger(loaded.revision) || loaded.revision < 0 || loaded.revision > 0 && loaded.data === null) fail4("LOCAL_MEMORY_CORRUPT");
    let revision = loaded.revision;
    const restored = decodeSnapshot(ownerUserId, loaded.data);
    let lastCommittedAt = Math.max(0, ...[...restored.state.memories.values()].map((r) => Date.parse(r.updatedAt)));
    let transactionTime = null;
    const recordTime = () => transactionTime || now();
    let requests = restored.requests, pendingCommit = null, closed = false, tail = Promise.resolve();
    const confirmations = createMemoryCaptureStores({ now, pendingTtlMs: 3e5 }).pendingCandidates;
    const foundation = createInMemoryEntityFoundation({
      initialState: restored.state,
      now: recordTime,
      beforeCommit: async (state) => {
        const nextRequests = Object.assign(/* @__PURE__ */ Object.create(null), requests);
        if (pendingCommit) {
          const { requestId, digest: digest4, findRecord, status } = pendingCommit;
          const record = [...state.memories.values()].find(findRecord);
          if (!record) fail4("LOCAL_MEMORY_RECEIPT_MISSING");
          nextRequests[requestId] = { digest: digest4, memoryId: record.memoryId, version: record.version, status };
        }
        const committed = await storage.commit(scope, { expectedRevision: revision, data: encodeSnapshot(ownerUserId, state, nextRequests) });
        if (committed.revision !== revision + 1) fail4("LOCAL_MEMORY_RECEIPT_INVALID");
        revision = committed.revision;
        requests = nextRequests;
        lastCommittedAt = Math.max(lastCommittedAt, Date.parse(recordTime()));
      }
    });
    const self = foundation.repository.ensureSelfEntity(ownerUserId);
    const resolution = {
      ownerUserId,
      entityId: self.entityId,
      entityType: self.type,
      resolutionStatus: "exact",
      resolutionMethod: "authenticated_self",
      resolvedAt: now(),
      evidence: []
    };
    const inspector = createMemoryDuplicateConflictInspector({ memories: foundation.memories, now: recordTime });
    const writer = createMemorySafeWriteService({ foundation, inspector, now: recordTime, memoryIdFactory: () => `mem_${nativeCrypto_default.randomUUID()}` });
    const lifecycle = createMemoryLifecycleV2({ foundation, correctionSensitivity: (_current, command) => sensitive.evaluate(command.structuredValue.value).sensitivity, now: recordTime, memoryIdFactory: () => `mem_${nativeCrypto_default.randomUUID()}` });
    function records() {
      return foundation.memories.queryByEntityAndPredicate(ownerUserId, self.entityId, "fact_statement", { status: "confirmed" }).filter((r) => !r.supersededById && !r.conflictGroupId && (!r.expiresAt || Date.parse(r.expiresAt) > Date.parse(now())) && (!r.effectiveTo || Date.parse(r.effectiveTo) > Date.parse(now())));
    }
    function receipt(entry) {
      return {
        status: entry.status,
        memoryId: entry.memoryId,
        version: entry.version,
        receipt: { durable: true, revision, ownerUserId, spaceId: "personal", memoryId: entry.memoryId, version: entry.version }
      };
    }
    async function mutate(command, confirmed = false) {
      const { operation, requestId } = command;
      if (typeof requestId !== "string" || !requestId || requestId.length > 160) fail4("REQUEST_ID_REQUIRED");
      const digest4 = hash(JSON.stringify([operation, command.text || "", command.memoryId || "", command.expectedVersion || 0, command.source || null]));
      const replay = Object.hasOwn(requests, requestId) ? requests[requestId] : null;
      if (replay) {
        if (replay.digest !== digest4) fail4("IDEMPOTENCY_CONFLICT");
        const current = foundation.memories.getById(ownerUserId, replay.memoryId);
        if (!current || current.version !== replay.version || replay.status !== "deleted" && current.status !== "confirmed") fail4("MEMORY_REQUEST_OBSOLETE");
        return receipt(replay);
      }
      const value = operation === "remember" ? explicitMemoryText(command.text) : String(command.text || "").trim();
      if (operation === "remember" && command.source?.type !== "user_text" && command.source?.type !== "user_voice") return { status: "rejected", reason: "user_source_required" };
      if (operation === "remember" && (!command.source?.id || typeof command.source.id !== "string" || command.source.id.length > 200)) fail4("SOURCE_REQUIRED");
      if (operation !== "delete" && !value) return { status: "ignored" };
      if (value?.length > 2e3) fail4("MEMORY_TEXT_TOO_LONG");
      const policy = sensitive.evaluate(value);
      if (policy.prohibited) return { status: "rejected", reason: "secret_not_stored" };
      if (policy.sensitivity === "high" && !confirmed || operation !== "remember" && command.confirmed !== true) {
        const { confirmationToken } = confirmations.create(ownerUserId, { command });
        return { status: "confirmation_required", confirmationToken, text: value, operation };
      }
      try {
        transactionTime = new Date(Math.max(Date.parse(now()), lastCommittedAt + 1)).toISOString();
        if (operation === "remember") {
          const classifier = { classify: async () => ({
            proposedDecision: policy.sensitivity === "high" ? "confirm_before_store" : "store_silently",
            memoryType: "fact",
            predicate: "fact_statement",
            confidence: 1,
            importance: 0.8,
            sensitivity: policy.sensitivity,
            retentionPolicy: { mode: "long_term", expiresAt: null },
            reasonCodes: ["explicit_user_statement"],
            suggestedStructuredValue: { value },
            containsPersonalFact: true,
            needsClarification: false,
            explicitBusinessIntent: false
          }) };
          const decision = await createMemoryCaptureDecisionService({ classifier, inspector, now }).decide({ ownerUserId, text: command.text, entityResolution: resolution });
          if (!["store_silently", "confirm_before_store"].includes(decision.decision)) fail4("MEMORY_POLICY_REJECTED");
          pendingCommit = { requestId, digest: digest4, status: "stored", findRecord: (r) => r.status === "confirmed" && r.predicate === "fact_statement" && r.structuredValue.value === value };
          const result3 = await writer.write({
            ownerUserId,
            resolution,
            decision,
            idempotencyKey: `mobile:${requestId}`,
            confirmationStatus: "user_confirmed",
            sourceMessageId: command.source.id
          });
          if (result3.outcome === "duplicate_detected") await foundation.unitOfWork.run({ ownerUserId }, async () => null);
          else if (result3.outcome !== "memory_written") fail4("MEMORY_WRITE_NOT_COMPLETED");
        } else {
          const current = foundation.memories.getById(ownerUserId, command.memoryId);
          if (!current) fail4("MEMORY_NOT_FOUND");
          pendingCommit = {
            requestId,
            digest: digest4,
            status: operation === "delete" ? "deleted" : "corrected",
            findRecord: (r) => operation === "delete" ? r.memoryId === command.memoryId : r.supersedesId === command.memoryId && r.status === "confirmed"
          };
          await lifecycle.execute({ ownerUserId }, {
            schemaVersion: "v2",
            lifecycleAction: operation === "correct" ? "correction" : "delete",
            subjectEntityId: current.subjectEntityId,
            predicate: current.predicate,
            memoryId: current.memoryId,
            expectedVersion: command.expectedVersion,
            idempotencyKey: `mobile:${requestId}`,
            structuredValue: operation === "correct" ? { value } : null,
            confirmed: false,
            sourceMessageId: command.source?.id || `memory-management:${requestId}`
          });
        }
        return receipt(requests[requestId]);
      } finally {
        pendingCommit = null;
        transactionTime = null;
      }
    }
    async function execute(command) {
      if (closed) fail4("LOCAL_MEMORY_CLOSED");
      if (!command || typeof command !== "object") fail4("MEMORY_COMMAND_INVALID");
      if (command.ownerUserId && command.ownerUserId !== ownerUserId) fail4("OWNER_SCOPE_MISMATCH");
      if (command.spaceId && command.spaceId !== "personal") fail4("SPACE_SCOPE_MISMATCH");
      if (command.operation === "receipt") {
        const entry = Object.hasOwn(requests, command.requestId) ? requests[command.requestId] : null;
        if (!entry) return { status: "not_saved" };
        const current = foundation.memories.getById(ownerUserId, entry.memoryId);
        if (!current || current.version !== entry.version || current.status !== "confirmed") return { status: "withdrawn" };
        return receipt(entry);
      }
      if (command.operation === "get") {
        if (!Array.isArray(command.references) || command.references.length > 6) fail4("MEMORY_COMMAND_INVALID");
        const valid = new Map(records().map((record) => [record.memoryId, record]));
        return { status: "available", items: command.references.map((ref) => valid.get(ref.memoryId)).filter((record, index) => record && record.version === command.references[index].version).map(projection) };
      }
      if (command.operation === "list" || command.operation === "query") {
        const question = String(command.text || "").slice(0, 4e3);
        let items = records().map((record) => ({ record, score: relevance(question, record.structuredValue.value) }));
        if (question) items = items.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));
        else if (command.operation === "query") items = [];
        const limit = command.operation === "query" ? 6 : 50;
        const offset = command.operation === "list" && Number.isSafeInteger(command.offset) && command.offset > 0 ? command.offset : 0;
        let chars = 0;
        const selected = items.slice(offset, offset + limit).filter(({ record }) => (chars += record.structuredValue.value.length) <= (command.operation === "query" ? 3e3 : 1e5));
        const revoked = foundation.memories.listByEntityAndPredicateForLifecycle(ownerUserId, self.entityId, "fact_statement").filter((record) => record.status !== "confirmed").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100).map((record) => ({ memoryId: record.memoryId, sourceId: record.source.id }));
        return {
          status: "available",
          revision,
          items: selected.map(({ record }) => projection(record)),
          revoked,
          total: items.length,
          nextOffset: offset + selected.length < items.length ? offset + selected.length : null
        };
      }
      if (command.operation === "confirm") {
        let entry;
        try {
          entry = confirmations.get(ownerUserId, command.confirmationToken);
        } catch {
          fail4("MEMORY_CONFIRMATION_EXPIRED");
        }
        const result3 = await mutate({ ...entry.candidate.command, confirmed: true }, true);
        confirmations.consume(ownerUserId, command.confirmationToken);
        return result3;
      }
      if (!["remember", "correct", "delete"].includes(command.operation)) fail4("MEMORY_OPERATION_UNSUPPORTED");
      return mutate(command);
    }
    return Object.freeze({
      execute: (command) => {
        const scheduled = tail.then(() => execute(command));
        tail = scheduled.catch(() => {
        });
        return scheduled;
      },
      close() {
        closed = true;
        confirmations.clearOwner(ownerUserId);
      }
    });
  }

  // memory/mobile/nativeEntry.js
  if (!globalThis.structuredClone) globalThis.structuredClone = function copy2(value) {
    if (value instanceof Map) return new Map([...value].map(([k, v]) => [copy2(k), copy2(v)]));
    if (value instanceof Set) return new Set([...value].map(copy2));
    if (Array.isArray(value)) return value.map(copy2);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy2(v)]));
    return value;
  };
  var runtime;
  function unwrap(json) {
    const result3 = JSON.parse(json);
    if (result3.error) throw Object.assign(new Error(result3.error), { code: result3.error });
    return result3.value;
  }
  globalThis.MobileMemoryHost = {
    async initialize(ownerUserId) {
      runtime?.close();
      runtime = await createMobileMemoryRuntime({ ownerUserId, storage: {
        load: (scope) => unwrap(globalThis.__memoryLoad(scope)),
        commit: (scope, command) => unwrap(globalThis.__memoryCommit(scope, JSON.stringify(command)))
      } });
      return { ready: true };
    },
    invoke(id, commandJSON) {
      Promise.resolve().then(() => runtime.execute(JSON.parse(commandJSON))).then(
        (value) => globalThis.__memoryDone(id, JSON.stringify({ value })),
        (error) => globalThis.__memoryDone(id, JSON.stringify({ error: error.code || "LOCAL_MEMORY_FAILED" }))
      );
    },
    start(id, ownerUserId) {
      this.initialize(ownerUserId).then(
        (value) => globalThis.__memoryDone(id, JSON.stringify({ value })),
        (error) => globalThis.__memoryDone(id, JSON.stringify({ error: error.code || "LOCAL_MEMORY_FAILED" }))
      );
    },
    close() {
      runtime?.close();
      runtime = null;
    }
  };
})();

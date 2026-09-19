export const ATTACHMENT_TYPES = Object.freeze(['image', 'audio', 'document']);
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 10;

export const ATTACHMENT_FIELDS = Object.freeze([
  'id', 'type', 'mimeType', 'fileName', 'sizeBytes', 'storageRef', 'checksum',
  'width', 'height', 'durationMs', 'metadata'
]);

export const ATTACHMENT_SCHEMA_V1 = Object.freeze({
  schemaVersion: 'v1',
  required: Object.freeze(['id', 'type', 'mimeType', 'fileName', 'sizeBytes', 'storageRef']),
  fields: ATTACHMENT_FIELDS,
  maxSizeBytes: MAX_ATTACHMENT_SIZE_BYTES,
  payloadPolicy: 'reference-only'
});

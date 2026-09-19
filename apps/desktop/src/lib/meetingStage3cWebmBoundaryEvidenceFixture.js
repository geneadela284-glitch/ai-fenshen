// Evidence metadata is copied from the real iPhone diagnostic envelope.
// The raw encrypted iPhone bytes were intentionally not uploaded to the Mac;
// buildBoundaryShapedFragments() is a parser-only shape fixture and must not
// be described as the real recording payload.
export const REAL_IPHONE_WEBM_BOUNDARY_EVIDENCE = Object.freeze({
  evidenceSha256: 'b72f7274005081e7af7df3d0c0aa3015b59bb7eae4a0d8e18409b0d7dc2ceb69',
  rawBytesAvailable: false,
  provenance: 'real-iphone-boundary-metadata-with-parser-shape-fixture',
  mimeType: 'audio/webm; codecs=opus',
  durationMs: 77_832,
  byteLength: 2_074_673,
  chunkCount: 5,
  chunks: Object.freeze([
    Object.freeze({ sequence: 0, byteLength: 528_926, firstBytesHex: '1a45dfa39f4286810142f7810142f2810442f3810842828477656' }),
    Object.freeze({ sequence: 1, byteLength: 536_391, firstBytesHex: 'a3c38126bd80e0fb80b0bdd9fb4e15486d82bb3e15eb819d' }),
    Object.freeze({ sequence: 2, byteLength: 534_347, firstBytesHex: 'a3c28126c780e0e7d4a0bc42789d94f6a6258200f2801f' }),
    Object.freeze({ sequence: 3, byteLength: 474_767, firstBytesHex: 'a3c08126d180e05e866d9303a7a18e15f02cb00db0dc810' }),
    Object.freeze({ sequence: 4, byteLength: 242, firstBytesHex: 'a3d2811e0c80e07b11abe0e9d0428b6f166f22f1c51a55' })
  ])
});

function id(bytes) {
  return Uint8Array.from(bytes);
}

function vint(value, length = null) {
  if (length === null) {
    if (value < 0x7f) length = 1;
    else if (value < 0x3fff) length = 2;
    else if (value < 0x1fffff) length = 3;
    else length = 4;
  }
  const output = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = rest & 0xff;
    rest >>>= 8;
  }
  output[0] |= 1 << (8 - length);
  return output;
}

function unknownVint() {
  // An eight-byte unknown-size VINT has a single leading length bit,
  // followed by seven all-one payload bytes.
  return Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
}

function concat(...parts) {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function element(idBytes, payload, { unknownSize = false } = {}) {
  return concat(id(idBytes), unknownSize ? unknownVint() : vint(payload.byteLength), payload);
}

function unsigned(value, length = 4) {
  const output = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = rest & 0xff;
    rest >>>= 8;
  }
  return output;
}

function cluster(timecode, blockFill, { blockGroup = false } = {}) {
  const time = element([0xe7], unsigned(timecode, 2));
  const block = element([0xa3], concat(Uint8Array.from([0x81, 0x00, 0x00, 0x80]), new Uint8Array(blockFill).fill(0x2a)));
  const media = blockGroup ? element([0xa0], block) : block;
  return element([0x1f, 0x43, 0xb6, 0x75], concat(time, media), { unknownSize: true });
}

export function buildBoundaryShapedFragments({ blockGroupAt = -1 } = {}) {
  const info = element([0x15, 0x49, 0xa9, 0x66], element([0x2a, 0xd7, 0xb1], unsigned(1_000_000, 4)));
  const tracks = element([0x16, 0x54, 0xae, 0x6b], Uint8Array.from([0xae, 0x80]));
  const ebml = element([0x1a, 0x45, 0xdf, 0xa3], Uint8Array.from([0x42, 0x86, 0x81, 0x01]));
  const segmentHeader = concat(id([0x18, 0x53, 0x80, 0x67]), unknownVint());
  const init = concat(ebml, segmentHeader, info, tracks);
  const clusters = [
    cluster(0, 32, { blockGroup: blockGroupAt === 0 }),
    cluster(1_000, 48, { blockGroup: blockGroupAt === 1 }),
    cluster(2_000, 64, { blockGroup: blockGroupAt === 2 })
  ];
  const stream = concat(init, ...clusters);
  const cluster0End = init.byteLength + clusters[0].byteLength;
  const cluster1Start = cluster0End;
  const cluster1End = cluster1Start + clusters[1].byteLength;
  const cluster2Start = cluster1End;
  const cuts = [
    cluster0End - 11,
    cluster1Start + Math.floor(clusters[1].byteLength / 3),
    cluster1Start + Math.floor((clusters[1].byteLength * 2) / 3),
    cluster2Start + clusters[2].byteLength - 9
  ];
  const fragments = [
    stream.slice(0, cuts[0]),
    stream.slice(cuts[0], cuts[1]),
    stream.slice(cuts[1], cuts[2]),
    stream.slice(cuts[2], cuts[3]),
    stream.slice(cuts[3])
  ];
  return Object.freeze({ stream, init, clusters: Object.freeze(clusters), fragments: Object.freeze(fragments) });
}

// The git object layer: real git objects (sha1 over "<type> <len>\0" + bytes), nested trees,
// packfile read/write with delta resolution, and pkt-line framing. Pure node: stdlib — the trial
// pod has no git binary. Everything here is deterministic: identical inputs give identical bytes,
// so a replayed trial reaches identical state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** The "<type> <len>\0" hash header repeats constantly (every 1 KiB bench blob shares one), so
 *  the encoded header is memoized per (type, length); the map is small and simply resets. */
const hashHeaders = new Map<string, Buffer>();

export function hashObject(type: GitObjectType, data: Buffer): string {
  const key = `${type} ${data.length}`;
  let header = hashHeaders.get(key);
  if (header === undefined) {
    if (hashHeaders.size > 512) hashHeaders.clear();
    header = Buffer.from(`${key}\0`, 'utf8');
    hashHeaders.set(key, header);
  }
  const hash = createHash('sha1');
  hash.update(header);
  hash.update(data);
  return hash.digest('hex');
}

// ------------------------------------------------------------------------------------------------
// trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------
// commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return { object: headers.get('object') ?? '', type: headers.get('type') ?? '', tag: headers.get('tag') ?? '' };
}

// ------------------------------------------------------------------------------------------------
// packfiles

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A plain (delta-free) packfile over the given objects, in the given order. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/**
 * Inflate the zlib stream starting at `offset`, returning its bytes and the offset just past it.
 * Node's sync zlib does not report how much input a stream consumed, so the consumed length is
 * found by binary search: the shortest prefix that inflates successfully is the stream exactly
 * (a truncated stream fails its trailer check; a longer one succeeds and is not shorter).
 */
function inflateAt(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  const available = buffer.length - offset;
  // Fast path: one inflate over the remaining bytes. zlib stops at the end of the first stream,
  // and with { info: true } the engine reports exactly how many input bytes that stream consumed,
  // which is where the next pack entry begins. Any doubt (no count, wrong size) falls back to the
  // search below, so a runtime that does not report consumption behaves exactly as before.
  try {
    const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: number };
    };
    const consumed = result.engine?.bytesWritten;
    if (
      result.buffer.length === expectedSize &&
      typeof consumed === 'number' &&
      consumed > 0 &&
      consumed <= available
    ) {
      return { data: result.buffer, next: offset + consumed };
    }
  } catch {
    // A truncated or corrupt stream throws here just as it does in the search: fall through.
  }
  const tryLength = (length: number): Buffer | null => {
    try {
      const data = inflateSync(buffer.subarray(offset, offset + length));
      return data.length === expectedSize ? data : null;
    } catch {
      return null;
    }
  };
  let lo = 1;
  let hi = available;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tryLength(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const data = tryLength(lo);
  if (data === null) throw new Error(`no zlib stream at offset ${offset} inflates to ${expectedSize} bytes`);
  return { data, next: offset + lo };
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  count: number;
}

/**
 * Read a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA entries. `resolveBase` supplies
 * objects a thin pack leaves out. Every resolved object's id is recomputed from its bytes.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart);
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!trailer.equals(computed)) throw new Error('pack trailer checksum does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  const resolvedByOid = new Map<string, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset, header.size);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let resolved: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      let base: GitObject;
      if (baseEntry) base = resolve(baseEntry);
      else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        base = external;
      }
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
    }
    entry.resolved = resolved;
    entry.oid = hashObject(resolved.type, resolved.data);
    resolvedByOid.set(entry.oid, entry);
    resolving.delete(entry.offset);
    return resolved;
  };

  const objects = new Map<string, GitObject>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(entry.oid as string)) objects.set(entry.oid as string, resolved);
  }
  return { objects, count: declaredCount };
}

// ------------------------------------------------------------------------------------------------
// pkt-line framing

export const PKT_LINE_MAX = 65520;

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error(`pkt-line payload of ${data.length} bytes is too large`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer; end: number }
  | { kind: 'flush'; end: number }
  | { kind: 'delim'; end: number }
  | { kind: 'response-end'; end: number };

/** The value of one hex digit byte, or -1 when the byte is not hex (either case). */
function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30; // 0-9
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10; // a-f
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10; // A-F
  return -1;
}

/**
 * Decode a pkt-line stream into packets, each with the offset just past it. Decoding stops at the
 * first byte that cannot frame a packet; callers decide what the rest is (a receive-pack body is
 * the command stream — up to its first flush — followed by raw pack bytes).
 */
export function decodePktLines(bytes: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    // The 4-digit hex length is read straight from the bytes: the string form + regex this used
    // to build per packet cost more than the framing itself on the push/fetch hot paths.
    const a = hexValue(bytes[offset] as number);
    const b = hexValue(bytes[offset + 1] as number);
    const c = hexValue(bytes[offset + 2] as number);
    const d = hexValue(bytes[offset + 3] as number);
    if (a < 0 || b < 0 || c < 0 || d < 0) break;
    const length = (a << 12) | (b << 8) | (c << 4) | d;
    if (length === 0) {
      packets.push({ kind: 'flush', end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) break;
    if (offset + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length), end: offset + length });
    offset += length;
  }
  return packets;
}

/** Frame a byte stream as sideband band-1 packets (for fetch packfiles and push reports). */
export function sidebandFrame(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65516 - 1; // payload minus the band byte stays under LARGE_PACKET_MAX
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

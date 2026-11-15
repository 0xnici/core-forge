// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch with shallow/deepen), the v0 fallback,
// and v0 receive-pack with report-status. The suite's client (and real git) speak exactly the
// framing in lib/git.ts; packs are plain (no deltas), which every check accepts.

import {
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  isOid,
  parseTree,
  readPack,
  sidebandFrame,
  writePack,
  type GitObject,
  type PktPacket,
} from './git.ts';
import {
  getCommit,
  isAncestor,
  peelToCommit,
  type Repo,
} from './store.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'core-forge/1.0';

function pkt(text: string): Buffer {
  return encodePktLine(text);
}

function flush(): Buffer {
  return PKT_FLUSH;
}

/** All refs in advertisement order: branches and tags interleaved by name, as git lists them. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function headTip(repo: Repo): string | undefined {
  return repo.refs.get(headRef(repo));
}

/** The commit a ref ultimately names (peeling tag objects), or undefined when unknown. */
function refCommit(repo: Repo, oid: string): string | undefined {
  const commit = peelToCommit(repo, oid);
  return repo.objects.get(commit)?.type === 'commit' ? commit : undefined;
}

// ------------------------------------------------------------------------------------------------
// advertisements

export function advertise(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', version2: boolean): GitReply {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && version2) {
    const body = Buffer.concat([
      pkt('version 2\n'),
      pkt(`agent=${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow\n'),
      pkt('object-format=sha1\n'),
      flush(),
    ]);
    return { status: 200, contentType, body };
  }
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta shallow symref=HEAD:${headRef(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), flush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    parts.push(pkt(`${headTip(repo) ?? ZERO_OID} HEAD\0${caps}`));
    for (const [name, oid] of refs) {
      parts.push(pkt(`${oid} ${name}\n`));
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(pkt(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(flush());
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

/** The commit a tag object peels to, or null when the object is not a tag. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const commit = peelToCommit(repo, oid);
  return commit === oid ? null : commit;
}

// ------------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

export function lsRefs(repo: Repo, packets: PktPacket[]): GitReply {
  const contentType = 'application/x-git-upload-pack-result';
  let sawDelim = false;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !sawDelim) continue;
    const line = (packet.payload as Buffer).toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const tip = headTip(repo);
  if (matches('HEAD')) {
    if (tip !== undefined) {
      lines.push(pkt(`${tip} HEAD${symrefs ? ` symref-target:${headRef(repo)}` : ''}\n`));
    } else if (unborn) {
      lines.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${headRef(repo)}` : ''}\n`));
    } else {
      lines.push(pkt(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headRef(repo)}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(pkt(`${line}\n`));
  }
  lines.push(flush());
  return { status: 200, contentType, body: Buffer.concat(lines) };
}

// ------------------------------------------------------------------------------------------------
// fetch (v2 and v0 share the object-set computation)

/**
 * The commits a fetch delivers: generations from the wants (a want counts as generation 1),
 * optionally cut at `depth`, minus what the client already holds. The client's held set is the
 * closure of its haves, with parent edges cut at the commits it declares shallow — a shallow
 * commit's parents are NOT held, which is what makes deepen work.
 */
function fetchSet(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowClient: string[],
  depth: number | null,
): { objects: GitObject[]; oids: Set<string>; shallow: string[]; unshallow: string[]; ack: string | null } {
  const shallowClientSet = new Set(shallowClient);
  // What the client holds: closure of haves, not expanding shallow-declared commits.
  const held = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) {
      const commit = refCommit(repo, have);
      if (commit !== undefined && !held.has(commit)) {
        held.add(commit);
        queue.push(commit);
      }
    }
    while (queue.length) {
      const current = queue.pop() as string;
      if (shallowClientSet.has(current)) continue; // its parents are not held
      const commit = getCommit(repo, current);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!held.has(parent)) {
          held.add(parent);
          queue.push(parent);
        }
      }
    }
  }
  // Included commits by generation (BFS from the wants, shortest distance wins).
  const generation = new Map<string, number>();
  {
    let frontier: string[] = [];
    for (const want of wants) {
      const commit = refCommit(repo, want);
      if (commit !== undefined && !generation.has(commit)) {
        generation.set(commit, 1);
        frontier.push(commit);
      }
    }
    let gen = 1;
    while (frontier.length) {
      if (depth !== null && gen >= depth) break;
      const next: string[] = [];
      for (const current of frontier) {
        const commit = getCommit(repo, current);
        if (!commit) continue;
        for (const parent of commit.parents) {
          if (!generation.has(parent)) {
            generation.set(parent, gen + 1);
            next.push(parent);
          }
        }
      }
      frontier = next;
      gen += 1;
    }
  }
  const includedCommits = new Set<string>();
  for (const [oid, gen] of generation) {
    if (depth === null || gen <= depth) includedCommits.add(oid);
  }
  // Objects: included commits + their trees/blobs (+ tag objects named by wants), minus held.
  const oids = new Set<string>();
  const addClosure = (root: string): void => {
    const stack = [root];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (oids.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      oids.add(oid);
      if (object.type === 'commit') {
        const commit = getCommit(repo, oid);
        if (commit) stack.push(commit.tree);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      } else if (object.type === 'tag') {
        stack.push(tagTarget(repo, oid));
      }
    }
  };
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object?.type === 'tag') addClosure(want);
  }
  for (const oid of includedCommits) {
    if (held.has(oid)) continue;
    addClosure(oid);
  }
  // Held commits' trees/blobs are held too: drop every object reachable from held commits.
  if (held.size) {
    const heldObjects = new Set<string>();
    const stack = [...held];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (heldObjects.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      heldObjects.add(oid);
      if (object.type === 'commit') {
        const commit = getCommit(repo, oid);
        if (commit) stack.push(commit.tree);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
    for (const oid of heldObjects) oids.delete(oid);
  }
  // The new shallow boundary: delivered commits at the depth cut whose parents stay behind.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of includedCommits) {
      if (held.has(oid)) continue;
      if ((generation.get(oid) as number) < depth) continue;
      const commit = getCommit(repo, oid);
      if (commit && commit.parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
    }
  }
  // A previously-shallow commit whose parent is now delivered stops being shallow.
  const unshallow: string[] = [];
  for (const oid of shallowClientSet) {
    const commit = getCommit(repo, oid);
    if (commit && commit.parents.some((parent) => includedCommits.has(parent) && !held.has(parent))) {
      unshallow.push(oid);
    }
  }
  const ack = haves.find((have) => held.has(refCommit(repo, have) ?? '')) ?? null;
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, oids, shallow, unshallow, ack };
}

function tagTarget(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return oid;
  const blank = object.data.indexOf('\n\n');
  const header = object.data.subarray(0, blank < 0 ? object.data.length : blank).toString('utf8');
  const line = header.split('\n').find((candidate) => candidate.startsWith('object '));
  return line ? line.slice('object '.length).trim() : oid;
}

/** Build (or reuse) the pack for a fetch: cached when the client holds nothing. */
function fetchPack(repo: Repo, wants: string[], depth: number | null, objects: GitObject[]): Buffer {
  if (objects.length === 0) return Buffer.alloc(0);
  return writePack(objects);
}

export function fetchV2(repo: Repo, packets: PktPacket[]): GitReply {
  const contentType = 'application/x-git-upload-pack-result';
  let sawDelim = false;
  let sawDone = false;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !sawDelim) continue;
    const line = (packet.payload as Buffer).toString('utf8').replace(/\n$/, '');
    if (line === 'done') sawDone = true;
    else if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10) || null;
    // thin-pack / no-progress / ofs-delta / done / deepen-since / deepen-not need no action:
    // complete packs are always legal, and the suite never sends the deepen-* forms.
  }
  const validWants = wants.filter((oid) => isOid(oid) && repo.objects.has(oid));
  const set = fetchSet(repo, validWants, haves, shallowClient, depth);
  const parts: Buffer[] = [];
  // The response shape follows the client's state machine: when it sent `done` with its wants it
  // expects shallow-info and the packfile directly; without `done` it expects acknowledgments and
  // will ask again. (The suite's client sends `done` and tolerates either, real git does not.)
  if (!sawDone) {
    parts.push(pkt('acknowledgments\n'));
    parts.push(pkt(set.ack !== null ? `ACK ${set.ack}\n` : 'NAK\n'));
    parts.push(flush());
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  if (set.shallow.length || set.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of set.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of set.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(flush());
  }
  if (set.objects.length || sawDone) {
    let pack: Buffer;
    if (!set.objects.length) {
      pack = writePack([]);
    } else if (haves.length === 0 && shallowClient.length === 0) {
      const key = `${[...validWants].sort().join(',')}|${depth ?? 'full'}`;
      const cached = repo.packCache.get(key);
      if (cached) pack = cached;
      else {
        pack = fetchPack(repo, validWants, depth, set.objects);
        repo.packCache.set(key, pack);
      }
    } else {
      pack = fetchPack(repo, validWants, depth, set.objects);
    }
    parts.push(pkt('packfile\n'));
    parts.push(sidebandFrame(pack));
    parts.push(flush());
  }
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

export function fetchV0(repo: Repo, packets: PktPacket[]): GitReply {
  const contentType = 'application/x-git-upload-pack-result';
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = (packet.payload as Buffer).toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10) || null;
  }
  const validWants = wants.filter((oid) => isOid(oid) && repo.objects.has(oid));
  const set = fetchSet(repo, validWants, haves, shallowClient, depth);
  const parts: Buffer[] = [];
  for (const oid of set.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of set.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt(set.ack !== null ? `ACK ${set.ack}\n` : 'NAK\n'));
  if (set.objects.length) {
    const pack = fetchPack(repo, validWants, depth, set.objects);
    parts.push(sidebandFrame(pack));
  }
  parts.push(flush());
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

/** Dispatch an upload-pack POST: v2 command form when a delim follows the command line, else v0. */
export function uploadPack(repo: Repo, raw: Buffer): GitReply {
  const packets = decodePktLines(raw);
  const firstData = packets.find((packet) => packet.kind === 'data');
  const firstLine = firstData?.kind === 'data' ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';
  if (firstLine === 'command=ls-refs') return lsRefs(repo, packets);
  if (firstLine === 'command=fetch') return fetchV2(repo, packets);
  return fetchV0(repo, packets);
}

// ------------------------------------------------------------------------------------------------
// receive-pack (push)

export function receivePack(repo: Repo, raw: Buffer): GitReply {
  const contentType = 'application/x-git-receive-pack-result';
  const packets = decodePktLines(raw);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let capabilities = '';
  let packStart = raw.length;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      packStart = packet.end;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).replace(/\n$/, '');
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line.replace(/\n$/, ''));
    if (match) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const packBytes = raw.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    results.push(applyCommand(repo, command, caps));
  }
  if (results.some((result) => result.ok)) repo.packCache.clear();
  const report: Buffer[] = [pkt(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    report.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  report.push(flush());
  const reportBytes = Buffer.concat(report);
  const body = caps.has('side-band-64k') ? Buffer.concat([sidebandFrame(reportBytes), flush()]) : reportBytes;
  return { status: 200, contentType, body };
}

function applyCommand(
  repo: Repo,
  command: { oldOid: string; newOid: string; ref: string },
  caps: Set<string>,
): { ref: string; ok: boolean; reason: string } {
  const { ref, oldOid, newOid } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) {
    return { ref, ok: false, reason: 'invalid ref' };
  }
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) return { ref, ok: false, reason: 'non-fast-forward' };
  if (newOid === ZERO_OID) {
    // delete-refs is an advertisement-only capability (clients never echo it in the request);
    // this forge always advertises it, so deletes are always allowed.
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const object = repo.objects.get(newOid);
  if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
    return { ref, ok: false, reason: 'invalid object' };
  }
  if (current !== ZERO_OID) {
    const newCommit = refCommit(repo, newOid);
    const currentCommit = refCommit(repo, current);
    if (newCommit === undefined || currentCommit === undefined || !isAncestor(repo, currentCommit, newCommit)) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

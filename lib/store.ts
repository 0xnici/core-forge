// The forge's store: everything in memory, keyed deterministically. A repository holds real git
// objects (lib/git.ts) and refs; issues and pull requests share one number sequence per
// repository, as GitHub's do. Ids and timestamps come from counters and a logical clock, never
// from the wall clock or a random source, so a replayed trial reaches the same state.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './git.ts';

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  /** Store-wide sequence: the REST `id` and the GraphQL global id derive from it. */
  seq: number;
  repoName: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export interface Pull {
  seq: number;
  repoName: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** Branch tips recorded at creation: the three-way merge's base point. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeSha: string | null;
  mergedAt: string | null;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  /** oid -> object (commits, trees, blobs, tags), exactly as git stores them. */
  objects: Map<string, GitObject>;
  /** full ref name (refs/heads/…, refs/tags/…) -> oid */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  /** commit oid -> flattened path -> blob oid, memoized (objects are immutable). */
  flatTrees: Map<string, Map<string, string>>;
  /** pack bytes for a (tip, depth) fetch with no haves, memoized for the clone workload. */
  packCache: Map<string, Buffer>;
}

const EPOCH = Date.UTC(2026, 0, 1) / 1000;
/** The identity server-created commits carry (contents writes, squash merges). */
export const FORGE_IDENTITY = 'Forge <forge@example.invalid>';

export class Store {
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private entitySeq = 0;
  private commentSeq = 0;
  private tick = 0;
  /** GraphQL global-id resolution: entity sequence -> the issue or pull it names. */
  issueBySeq = new Map<number, Issue>();
  pullBySeq = new Map<number, Pull>();

  /** Logical timestamp: base epoch + one second per call, strictly increasing. */
  nowIso(): string {
    this.tick += 1;
    return new Date((EPOCH + this.tick) * 1000).toISOString();
  }

  /** Logical unix seconds, for commit timestamps. */
  nowSec(): number {
    this.tick += 1;
    return EPOCH + this.tick;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: 1000 + this.repoSeq,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      flatTrees: new Map(),
      packCache: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  repoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  nextEntitySeq(): number {
    this.entitySeq += 1;
    return this.entitySeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

// ------------------------------------------------------------------------------------------------
// object helpers over a Repo

export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getCommit(repo: Repo, oid: string): { tree: string; parents: string[]; message: string } | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  return { tree: view.tree, parents: view.parents, message: view.message };
}

/** Flatten a tree object (recursively) into path -> blob oid. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else if (entry.mode !== '160000') out.set(prefix + entry.name, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** The flattened tree at a commit, memoized per commit. Empty for an unknown/unborn sha. */
export function flatTreeOfCommit(repo: Repo, commitOid: string | undefined): Map<string, string> {
  if (commitOid === undefined) return new Map();
  const cached = repo.flatTrees.get(commitOid);
  if (cached) return cached;
  const commit = getCommit(repo, commitOid);
  const flat = commit ? flattenTree(repo, commit.tree) : new Map<string, string>();
  repo.flatTrees.set(commitOid, flat);
  return flat;
}

/** Store a flattened path -> blob map as nested tree objects; returns the root tree oid. */
export function storeFlatTree(repo: Repo, flat: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit from a flattened tree on a branch (parent = the branch's current tip). */
export function commitFlatTree(
  store: Store,
  repo: Repo,
  branch: string,
  flat: Map<string, string>,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const treeOid = storeFlatTree(repo, flat);
  const data = buildCommit({
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: FORGE_IDENTITY,
    committer: FORGE_IDENTITY,
    timestamp: store.nowSec(),
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(ref, oid);
  repo.packCache.clear();
  return oid;
}

/** The entries of one directory inside a tree (name -> entry), or null when the path is no directory. */
export function listTreeDir(repo: Repo, treeOid: string, dirPath: string): TreeEntry[] | null {
  let current = treeOid;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/** Peel a tag object to the commit it names (one level is all the suite creates); else the oid itself. */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = repo.objects.get(current);
    if (!object) return current;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return current;
    const blank = object.data.indexOf('\n\n');
    const header = object.data.subarray(0, blank < 0 ? object.data.length : blank).toString('utf8');
    const line = header.split('\n').find((candidate) => candidate.startsWith('object '));
    if (!line) return current;
    current = line.slice('object '.length).trim();
  }
  return current;
}

/** Whether `ancestor` is reachable from `descendant` through commit parents (both must be commits). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const current = queue.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = getCommit(repo, current);
    if (commit) for (const parent of commit.parents) queue.push(parent);
  }
  return false;
}

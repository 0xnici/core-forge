// The forge's store: everything in memory, keyed deterministically. Ids and timestamps come from
// counters and a logical clock, never from the wall clock or a random source, so a replayed trial
// reaches the same state. The git object layer (lib/git.ts, next phase) will hang commits and
// trees off the same Repo records; for now a repo's files live in `files` (path -> blob) and its
// history in `commits` (newest last), which is exactly the shape the contents API serves.

import { createHash } from 'node:crypto';

export interface Blob {
  /** Git blob sha1 of the content. */
  sha: string;
  content: Buffer;
}

export interface Commit {
  sha: string;
  message: string;
  /** Path -> blob sha at this commit (a flat tree snapshot; nested paths are just keys). */
  tree: Map<string, string>;
  parents: string[];
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
  pullRequest: boolean;
}

export interface Pull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergeSha: string | null;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssueNumber: number;
  /** branch name -> commit sha */
  branches: Map<string, string>;
  commits: Map<string, Commit>;
  /** blob sha -> blob */
  blobs: Map<string, Blob>;
}

const EPOCH = Date.UTC(2026, 0, 1) / 1000;

export class Store {
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private commentSeq = 0;
  private tick = 0;

  /** Logical timestamp: base epoch + one second per call, strictly increasing. */
  nowIso(): string {
    this.tick += 1;
    return new Date((EPOCH + this.tick) * 1000).toISOString();
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: 1000 + this.repoSeq,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssueNumber: 1,
      branches: new Map(),
      commits: new Map(),
      blobs: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

/** Git's blob identity: sha1 of "blob <len>\0" + content. */
export function blobSha(content: Buffer): string {
  const head = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(content).digest('hex');
}

/** Deterministic commit identity over tree, parents and message (git's commit object shape). */
export function commitSha(tree: Map<string, string>, parents: string[], message: string, whenIso: string): string {
  const lines: string[] = [];
  for (const [path, sha] of [...tree.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) lines.push(`${path} ${sha}`);
  const body = `tree ${lines.join(',')}\n${parents.map((p) => `parent ${p}\n`).join('')}author Forge <forge@example.invalid> ${whenIso}\n\n${message}`;
  return createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`, 'utf8').digest('hex');
}

/** The tree at a commit, or an empty tree for an unborn branch. */
export function treeOf(repo: Repo, sha: string | undefined): Map<string, string> {
  if (sha === undefined) return new Map();
  return repo.commits.get(sha)?.tree ?? new Map();
}

/** Record a commit on a branch from a full tree snapshot; returns the commit. */
export function commitOn(store: Store, repo: Repo, branch: string, tree: Map<string, string>, message: string): Commit {
  const parent = repo.branches.get(branch);
  const parents = parent === undefined ? [] : [parent];
  const sha = commitSha(tree, parents, message, store.nowIso());
  const commit: Commit = { sha, message, tree: new Map(tree), parents };
  repo.commits.set(sha, commit);
  repo.branches.set(branch, sha);
  return commit;
}

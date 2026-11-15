// Domain operations shared by the REST, GraphQL and MCP surfaces, so an object created on one
// surface is the same object on every other. Pull merges are three-way squashes: the base point
// is the base branch's tip recorded when the pull was created; a path both sides changed to
// different bytes since then is a conflict (the merge is refused, REST answers 405).

import {
  commitFlatTree,
  flatTreeOfCommit,
  isAncestor,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ------------------------------------------------------------------------------------------------
// JSON shapes (REST views)

export function repoJson(repo: Repo, viewer: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${viewer}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: viewer },
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.seq,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    comments: issue.comments.length,
  };
}

/** The branch tip a pull's head/base names right now (falling back to the creation-time tip). */
export function pullHeadSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
}

export function pullBaseSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.seq,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.head, sha: pullHeadSha(repo, pull) },
    base: { ref: pull.base, sha: pullBaseSha(repo, pull) },
  };
}

// ------------------------------------------------------------------------------------------------
// issues

export function createIssue(
  store: Store,
  repo: Repo,
  input: { title: string; body: string; labels?: string[] },
): Issue {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    seq: store.nextEntitySeq(),
    repoName: repo.name,
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels ?? [],
    comments: [],
  };
  repo.issues.set(number, issue);
  store.issueBySeq.set(issue.seq, issue);
  return issue;
}

// ------------------------------------------------------------------------------------------------
// pulls

export type CreatePullError = 'head-missing' | 'base-missing' | 'exists';

export function createPull(
  store: Store,
  repo: Repo,
  input: { title: string; body: string; head: string; base: string },
): { pull: Pull } | { error: CreatePullError } {
  const headSha = repo.refs.get(`refs/heads/${input.head}`);
  if (headSha === undefined) return { error: 'head-missing' };
  const baseSha = repo.refs.get(`refs/heads/${input.base}`);
  if (baseSha === undefined) return { error: 'base-missing' };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === input.head && existing.base === input.base) {
      return { error: 'exists' };
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    seq: store.nextEntitySeq(),
    repoName: repo.name,
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    head: input.head,
    base: input.base,
    headSha,
    baseSha,
    merged: false,
    mergeSha: null,
    mergedAt: null,
  };
  repo.pulls.set(number, pull);
  store.pullBySeq.set(pull.seq, pull);
  return { pull };
}

/** Paths whose blob differs between two flattened trees, with the before/after blob ids. */
export function changedPaths(
  before: Map<string, string>,
  after: Map<string, string>,
): Array<{ path: string; from: string | undefined; to: string | undefined }> {
  const out: Array<{ path: string; from: string | undefined; to: string | undefined }> = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(path);
    const to = after.get(path);
    if (from !== to) out.push({ path, from, to });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The three-way view of a pull: the paths the head changed since the base point, the paths the
 * base changed since then, and whether they collide on different bytes (a conflict).
 */
export function pullDiff(repo: Repo, pull: Pull): {
  files: Array<{ path: string; from: string | undefined; to: string | undefined }>;
  conflict: boolean;
} {
  const basePoint = flatTreeOfCommit(repo, pull.baseSha);
  const headTree = flatTreeOfCommit(repo, pullHeadSha(repo, pull));
  const currentBase = flatTreeOfCommit(repo, pullBaseSha(repo, pull));
  const headChanges = changedPaths(basePoint, headTree);
  const baseChanges = new Map(changedPaths(basePoint, currentBase).map((change) => [change.path, change.to]));
  let conflict = false;
  for (const change of headChanges) {
    if (baseChanges.has(change.path) && baseChanges.get(change.path) !== change.to) conflict = true;
  }
  return { files: headChanges, conflict };
}

export function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  return !pullDiff(repo, pull).conflict;
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'not-open' };

/** Squash-merge a pull into its base branch: head changes applied onto the current base tree. */
export function mergePull(store: Store, repo: Repo, pull: Pull): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, reason: 'not-open' };
  const { files, conflict } = pullDiff(repo, pull);
  if (conflict) return { ok: false, reason: 'conflict' };
  const currentBase = new Map(flatTreeOfCommit(repo, pullBaseSha(repo, pull)));
  const headTree = flatTreeOfCommit(repo, pullHeadSha(repo, pull));
  for (const file of files) {
    if (file.to === undefined) currentBase.delete(file.path);
    else currentBase.set(file.path, headTree.get(file.path) as string);
  }
  const sha = commitFlatTree(store, repo, pull.base, currentBase, `Squash merge pull request #${pull.number}: ${pull.title}`);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeSha = sha;
  pull.mergedAt = store.nowIso();
  return { ok: true, sha };
}

// ------------------------------------------------------------------------------------------------
// pull files with line counts

function linesOf(content: Buffer): string[] {
  const text = content.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** (additions, deletions) between two texts, by longest common subsequence over lines. */
export function lineDiff(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const a = before === null ? [] : linesOf(before);
  const b = after === null ? [] : linesOf(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS lengths over suffixes; the files this ever runs on are small (suite fixtures).
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The pull's changed files (base point -> head tip) with git-style line counts. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const { files } = pullDiff(repo, pull);
  return files.map((file) => {
    const before = file.from === undefined ? null : (repo.objects.get(file.from)?.data ?? null);
    const after = file.to === undefined ? null : (repo.objects.get(file.to)?.data ?? null);
    const { additions, deletions } = lineDiff(before, after);
    return {
      filename: file.path,
      status: file.from === undefined ? 'added' : file.to === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
}

/** Guard used by the GraphQL mergeable field: an already-merged pull is never mergeable. */
export function pullStateGraphQL(pull: Pull): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

export { isAncestor };

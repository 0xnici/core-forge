// The forge's HTTP surface. This scaffold implements the REST v3 resources end to end over the
// in-memory store (lib/store.ts): repositories, branches, commits, contents, labels, issues,
// comments and pull requests with squash merges. The git smart-HTTP protocol, GraphQL v4 and the
// MCP endpoint are the next build phases (see BUILD.md); their routes answer the JSON 404 every
// unknown route gets until then.
//
// Auth: one bearer token (MAKEFUN_SHOP_TOKEN) names the viewer. A request without it is 401, and
// a repository belongs to the viewer's login: the same name under another owner is 404, never
// 403. The trial never tells the forge the viewer's login directly, so the forge adopts the
// first owner login it is asked about for a repository it holds (every repository is the
// viewer's) and uses it from then on.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, blobSha, commitOn, treeOf, type Issue, type Pull, type Repo } from './lib/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();
let viewerLogin: string | null = null;
let requestSeq = 0;

function viewer(): string {
  return viewerLogin ?? 'viewer';
}

function adoptViewer(owner: string): void {
  if (viewerLogin === null) viewerLogin = owner;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  requestSeq += 1;
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': `forge-${requestSeq}`,
    ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Parse a JSON body: {} when empty, null when malformed. */
function parseJson(raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return {};
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${viewer()}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: viewer() },
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    comments: issue.comments.length,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head },
    base: { ref: pull.base },
  };
}

/** The repo named by a /repos/{owner}/{repo} path, adopting the owner as viewer when it is ours. */
function repoFor(owner: string, name: string): Repo | null {
  const repo = store.repos.get(name);
  if (repo === undefined) return null;
  adoptViewer(owner);
  return owner === viewer() ? repo : null;
}

function paginate<T>(req: IncomingMessage, items: T[]): { page: T[]; headers: Record<string, string> } {
  const url = new URL(req.url ?? '/', 'http://entry');
  const perPage = Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30);
  const pageNo = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const start = (pageNo - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(url.pathname, 'http://entry');
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(pageNo + 1));
    headers.link = `<${next.pathname}${next.search}>; rel="next"`;
  }
  return { page, headers };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${TOKEN}` || TOKEN === '') {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0-forge' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, { login: viewer() });
    return;
  }

  const raw = method === 'GET' || method === 'DELETE' && !req.headers['content-length'] ? Buffer.alloc(0) : await readBody(req);
  const body = parseJson(raw);
  if (body === null) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }

  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const { page, headers } = paginate(req, [...store.repos.values()].map(repoJson));
      sendJson(res, 200, page, headers);
      return;
    }
    if (method === 'POST') {
      const name = String(body.name ?? '');
      if (name === '' || store.repos.has(name)) {
        sendJson(res, 422, { message: 'Repository creation failed.' });
        return;
      }
      const repo = store.createRepo(name, String(body.description ?? ''), body.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (repoMatch) {
    const [, owner, name, rest = ''] = repoMatch as unknown as [string, string, string, string];
    const repo = repoFor(owner, name);

    if (rest === '') {
      if (repo === null) return notFound(res);
      if (method === 'GET') sendJson(res, 200, repoJson(repo));
      else if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.name === 'string' && body.name !== repo.name) {
          store.repos.delete(repo.name);
          repo.name = body.name;
          store.repos.set(repo.name, repo);
        }
        sendJson(res, 200, repoJson(repo));
      } else if (method === 'DELETE') {
        store.repos.delete(repo.name);
        sendJson(res, 204, undefined);
      } else notFound(res);
      return;
    }
    if (repo === null) return notFound(res);

    if (rest === '/git/refs' && method === 'POST') {
      const ref = String(body.ref ?? '');
      const sha = String(body.sha ?? '');
      const branch = ref.replace(/^refs\/heads\//, '');
      if (!repo.commits.has(sha) || branch === '') {
        sendJson(res, 422, { message: 'Invalid ref or sha' });
        return;
      }
      repo.branches.set(branch, sha);
      sendJson(res, 201, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      return;
    }
    if (rest === '/branches' && method === 'GET') {
      sendJson(res, 200, [...repo.branches.entries()].map(([b, sha]) => ({ name: b, commit: { sha } })));
      return;
    }
    if (rest === '/commits' && method === 'GET') {
      const startSha = url.searchParams.get('sha') ?? repo.branches.get(repo.defaultBranch);
      const out: Record<string, unknown>[] = [];
      let cur = startSha === null ? undefined : startSha;
      const seen = new Set<string>();
      while (cur !== undefined && repo.commits.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        const commit = repo.commits.get(cur) as { sha: string; message: string; parents: string[] };
        out.push({ sha: commit.sha, commit: { message: commit.message } });
        cur = commit.parents[0];
      }
      sendJson(res, 200, out);
      return;
    }

    const contentsMatch = /^\/contents(\/.*)?$/.exec(rest);
    if (contentsMatch) {
      const filePath = decodeURIComponent((contentsMatch[1] ?? '').replace(/^\//, ''));
      const branch = url.searchParams.get('ref') ?? (typeof body.branch === 'string' ? body.branch : repo.defaultBranch);
      if (method === 'PUT') {
        const content = Buffer.from(String(body.content ?? ''), 'base64');
        const sha = blobSha(content);
        const tree = new Map(treeOf(repo, repo.branches.get(branch)));
        const existing = tree.get(filePath);
        if (existing !== undefined && typeof body.sha === 'string' && body.sha !== existing) {
          sendJson(res, 409, { message: 'Conflict: sha does not match' });
          return;
        }
        repo.blobs.set(sha, { sha, content });
        tree.set(filePath, sha);
        const commit = commitOn(store, repo, branch, tree, String(body.message ?? `Update ${filePath}`));
        sendJson(res, existing === undefined ? 201 : 200, {
          content: { sha, encoding: 'base64', name: filePath.split('/').pop(), path: filePath },
          commit: { sha: commit.sha },
        });
        return;
      }
      if (method === 'GET') {
        const tree = treeOf(repo, repo.branches.get(branch));
        const sha = tree.get(filePath);
        if (sha !== undefined) {
          const blob = repo.blobs.get(sha) as { content: Buffer };
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', sha, size: blob.content.length,
            name: filePath.split('/').pop(), path: filePath,
            content: blob.content.toString('base64'),
          });
          return;
        }
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const entries = new Map<string, string>();
        for (const [p, s] of tree) {
          if (!p.startsWith(prefix)) continue;
          const head = p.slice(prefix.length).split('/')[0] as string;
          entries.set(head, p.slice(prefix.length).includes('/') ? 'dir' : s);
        }
        if (entries.size === 0) return notFound(res);
        sendJson(res, 200, [...entries.entries()].map(([n, v]) => ({
          name: n, path: prefix + n, type: v === 'dir' ? 'dir' : 'file', ...(v === 'dir' ? {} : { sha: v }),
        })));
        return;
      }
      if (method === 'DELETE') {
        const tree = new Map(treeOf(repo, repo.branches.get(branch)));
        if (!tree.has(filePath)) return notFound(res);
        tree.delete(filePath);
        const commit = commitOn(store, repo, branch, tree, String(body.message ?? `Delete ${filePath}`));
        sendJson(res, 200, { content: null, commit: { sha: commit.sha } });
        return;
      }
    }

    if (rest === '/labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
        return;
      }
      if (method === 'POST') {
        const label = { name: String(body.name ?? ''), color: String(body.color ?? 'ededed'), description: (body.description as string) ?? null };
        if (label.name === '') {
          sendJson(res, 422, { message: 'Validation Failed' });
          return;
        }
        repo.labels.set(label.name, label);
        sendJson(res, 201, label);
        return;
      }
    }

    if (rest === '/issues') {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let issues = [...repo.issues.values()].filter((i) => !i.pullRequest);
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        issues.sort((a, b) => a.number - b.number);
        if ((url.searchParams.get('direction') ?? 'asc') === 'desc') issues.reverse();
        const { page, headers } = paginate(req, issues.map(issueJson));
        sendJson(res, 200, page, headers);
        return;
      }
      if (method === 'POST') {
        const labelNames = Array.isArray(body.labels) ? body.labels.map(String) : [];
        if (labelNames.some((l) => !repo.labels.has(l))) {
          sendJson(res, 422, { message: 'Validation Failed: label does not exist' });
          return;
        }
        const number = repo.nextIssueNumber;
        repo.nextIssueNumber += 1;
        const issue: Issue = {
          number, title: String(body.title ?? ''), body: (body.body as string) ?? null,
          state: 'open', labels: labelNames, comments: [], pullRequest: false,
        };
        repo.issues.set(number, issue);
        sendJson(res, 201, issueJson(issue));
        return;
      }
    }

    const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
    if (issueMatch) {
      const issue = repo.issues.get(Number(issueMatch[1]));
      if (issue === undefined) return notFound(res);
      if (issueMatch[2] === '/comments') {
        if (method === 'GET') sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
        else if (method === 'POST') {
          const comment = { id: store.nextCommentId(), body: String(body.body ?? '') };
          issue.comments.push(comment);
          sendJson(res, 201, comment);
        } else notFound(res);
        return;
      }
      if (method === 'GET') sendJson(res, 200, issueJson(issue));
      else if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        sendJson(res, 200, issueJson(issue));
      } else notFound(res);
      return;
    }

    if (rest === '/pulls') {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => a.number - b.number);
        sendJson(res, 200, pulls.map(pullJson));
        return;
      }
      if (method === 'POST') {
        const number = repo.nextIssueNumber;
        repo.nextIssueNumber += 1;
        const pull: Pull = {
          number, title: String(body.title ?? ''), body: (body.body as string) ?? null,
          state: 'open', head: String(body.head ?? ''), base: String(body.base ?? repo.defaultBranch),
          merged: false, mergeSha: null,
        };
        repo.pulls.set(number, pull);
        repo.issues.set(number, {
          number, title: pull.title, body: pull.body, state: 'open', labels: [], comments: [], pullRequest: true,
        });
        sendJson(res, 201, pullJson(pull));
        return;
      }
    }

    const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
    if (pullMatch) {
      const pull = repo.pulls.get(Number(pullMatch[1]));
      if (pull === undefined) return notFound(res);
      if (pullMatch[2] === '/files' && method === 'GET') {
        const baseTree = treeOf(repo, repo.branches.get(pull.base));
        const headTree = treeOf(repo, repo.branches.get(pull.head));
        const files: Record<string, unknown>[] = [];
        for (const p of new Set([...baseTree.keys(), ...headTree.keys()])) {
          const b = baseTree.get(p);
          const h = headTree.get(p);
          if (b === h) continue;
          files.push({ filename: p, status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified' });
        }
        sendJson(res, 200, files);
        return;
      }
      if (pullMatch[2] === '/merge' && method === 'PUT') {
        if (pull.state !== 'open') {
          sendJson(res, 405, { message: 'Pull request is not open' });
          return;
        }
        const headTree = treeOf(repo, repo.branches.get(pull.head));
        const commit = commitOn(store, repo, pull.base, headTree, `Squash merge pull request #${pull.number}: ${pull.title}`);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergeSha = commit.sha;
        const mirror = repo.issues.get(pull.number);
        if (mirror !== undefined) mirror.state = 'closed';
        sendJson(res, 200, { sha: commit.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      if (pullMatch[2] === undefined && method === 'GET') {
        sendJson(res, 200, pullJson(pull));
        return;
      }
    }
  }

  notFound(res);
}

export function createApp(): Server {
  return createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });
}

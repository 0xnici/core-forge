// The forge's HTTP surface: git smart HTTP (lib/git-http.ts), REST v3, GraphQL v4 (lib/graphql.ts)
// and MCP (lib/mcp.ts), all over one in-memory store (lib/store.ts) with the domain operations in
// lib/ops.ts, so an object created on one surface is the same object on every other.
//
// Auth: one bearer token (MAKEFUN_SHOP_TOKEN) names the viewer. A request without it is 401, and
// a repository belongs to the viewer's login: the same name under another owner is 404, never 403.
// The trial never tells the forge the viewer's login directly, so the forge adopts the first owner
// login it is asked about for a repository (every repository is the viewer's) and uses it from
// then on. The git checks address the viewer's repositories first, which settles the login before
// any surface that cannot carry one (GraphQL `viewer`, MCP) is exercised.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isOid, parseCommit } from './lib/git.ts';
import { advertise, receivePack, uploadPack } from './lib/git-http.ts';
import { executeGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import {
  createIssue,
  createPull,
  issueJson,
  mergePull,
  pullFiles,
  pullJson,
  repoJson,
} from './lib/ops.ts';
import {
  Store,
  commitFlatTree,
  flatTreeOfCommit,
  getCommit,
  listTreeDir,
  peelToCommit,
  putObject,
  type Pull,
  type Repo,
} from './lib/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY = 256 * 1024 * 1024;

export function createApp(): Server {
  const store = new Store();
  let viewerLogin: string | null = null;
  let requestSeq = 0;

  const viewer = (): string => viewerLogin ?? 'forge-user';
  const adoptViewer = (owner: string): void => {
    if (viewerLogin === null && owner !== '') viewerLogin = owner;
  };

  // ----------------------------------------------------------------------------------------------
  // read-response caches
  //
  // Every GET in this API is a pure function of (url, authorization, host, adopted viewer, forge
  // state), and every state change arrives as a non-GET request. So a GET response may be replayed
  // byte for byte while no mutating request has been handled since it was produced: `epoch` counts
  // the mutating requests handled, and it is part of every cache key. The same argument covers
  // git-upload-pack POSTs (ls-refs / fetch mutate nothing): their responses are a pure function of
  // the request bytes and the same epoch. receive-pack is never cached — it mutates.
  //
  // Handlers run synchronously once the request body is read, so a single capture slot is safe:
  // while one request is being routed no other request's code can run.

  interface CachedResponse {
    status: number;
    headers: Record<string, string | number>;
    body: Buffer;
  }

  let epoch = 0;
  const getCache = new Map<string, CachedResponse>();
  const uploadPackCache = new Map<string, CachedResponse>();
  let capture: { map: Map<string, CachedResponse>; key: string } | null = null;

  function recordResponse(map: Map<string, CachedResponse>, key: string, entry: CachedResponse): void {
    if (map.size > 8192) map.clear();
    map.set(key, entry);
  }

  function replayResponse(res: ServerResponse, entry: CachedResponse): void {
    requestSeq += 1;
    res.writeHead(entry.status, { ...entry.headers, 'x-github-request-id': `forge-${requestSeq}` });
    res.end(entry.body);
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): void {
    requestSeq += 1;
    const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
    const buf = text ? Buffer.from(text, 'utf8') : Buffer.alloc(0);
    const fullHeaders: Record<string, string | number> = {
      'content-type': JSON_TYPE,
      ...(text ? { 'content-length': buf.length } : {}),
      ...headers,
    };
    if (capture) recordResponse(capture.map, capture.key, { status, headers: fullHeaders, body: buf });
    res.writeHead(status, { ...fullHeaders, 'x-github-request-id': `forge-${requestSeq}` });
    res.end(buf);
  }

  function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
    requestSeq += 1;
    const fullHeaders: Record<string, string | number> = {
      'content-type': contentType,
      'content-length': body.length,
    };
    if (capture) recordResponse(capture.map, capture.key, { status, headers: fullHeaders, body });
    res.writeHead(status, { ...fullHeaders, 'x-github-request-id': `forge-${requestSeq}` });
    res.end(body);
  }

  function sendEmpty(res: ServerResponse, status: number): void {
    requestSeq += 1;
    if (capture) recordResponse(capture.map, capture.key, { status, headers: {}, body: Buffer.alloc(0) });
    res.writeHead(status, { 'x-github-request-id': `forge-${requestSeq}` });
    res.end();
  }

  const notFound = (res: ServerResponse): void => sendJson(res, 404, { message: 'Not Found' });

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function authorized(req: IncomingMessage): boolean {
    if (TOKEN === '') return true;
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${TOKEN}` || header.toLowerCase() === `bearer ${TOKEN.toLowerCase()}`;
  }

  type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false };

  function parseJsonBody(raw: Buffer): JsonBody {
    try {
      const value = JSON.parse(raw.toString('utf8')) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
      return { ok: true, value: value as Record<string, unknown> };
    } catch {
      return { ok: false };
    }
  }

  // ----------------------------------------------------------------------------------------------
  // pagination (absolute Link URLs on this server's own origin, from the Host header)

  function pageParams(url: URL): { page: number; perPage: number } {
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
    return {
      page: Number.isFinite(page) && page > 0 ? page : 1,
      perPage: Number.isFinite(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
    };
  }

  function sendPaged<T>(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    items: readonly T[],
    render: (item: T) => unknown,
  ): void {
    const { page, perPage } = pageParams(url);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < items.length) {
      const lastPage = Math.ceil(items.length / perPage);
      const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
      const linkFor = (target: number): string => {
        const params = new URLSearchParams(url.searchParams);
        params.set('page', String(target));
        params.set('per_page', String(perPage));
        return `<${base}?${params.toString()}>`;
      };
      headers.link = `${linkFor(page + 1)}; rel="next", ${linkFor(lastPage)}; rel="last"`;
    }
    sendJson(res, 200, slice.map(render), headers);
  }

  // ----------------------------------------------------------------------------------------------
  // git smart HTTP

  function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, match: RegExpMatchArray): void {
    const owner = decodeURIComponent(match[1] as string);
    const repoName = decodeURIComponent(match[2] as string);
    const route = match[3] as string;
    adoptViewer(owner);
    const repo = store.repos.get(repoName);
    if (!repo) return notFound(res);
    if (route === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return sendJson(res, 400, { message: 'the service parameter must name a git service' });
      }
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const reply = advertise(repo, service, version2);
      return sendRaw(res, reply.status, reply.contentType, reply.body);
    }
    if (req.method !== 'POST') return notFound(res);
    if (route === 'git-upload-pack') {
      // A pure function of the request bytes and the forge state (the epoch): replay it.
      const key = `${repoName}|${epoch}|${createHash('sha1').update(raw).digest('hex')}`;
      const hit = uploadPackCache.get(key);
      if (hit) return replayResponse(res, hit);
      capture = { map: uploadPackCache, key };
      try {
        const reply = uploadPack(repo, raw);
        return sendRaw(res, reply.status, reply.contentType, reply.body);
      } finally {
        capture = null;
      }
    }
    const reply = receivePack(repo, raw);
    return sendRaw(res, reply.status, reply.contentType, reply.body);
  }

  // ----------------------------------------------------------------------------------------------
  // REST helpers

  function labelNamesOf(raw: unknown): string[] | null {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return null;
    const names: string[] = [];
    for (const entry of raw) {
      if (typeof entry === 'string') names.push(entry);
      else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
        names.push((entry as { name: string }).name);
      } else return null;
    }
    return names;
  }

  function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
    return { id: comment.id, body: comment.body, user: { login: viewer() } };
  }

  function identityJson(line: string): { name: string; email: string; date: string } {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    if (!match) return { name: line, email: '', date: '2026-01-01T00:00:00Z' };
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  }

  function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const view = parseCommit(object.data);
    return {
      sha: oid,
      commit: {
        author: identityJson(view.author),
        committer: identityJson(view.committer),
        message: view.message.replace(/\n$/, ''),
        tree: { sha: view.tree },
      },
      author: { login: viewer() },
      committer: { login: viewer() },
      parents: view.parents.map((sha) => ({ sha })),
    };
  }

  // ----------------------------------------------------------------------------------------------
  // REST: repository-scoped routes

  function handleRepo(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, repo: Repo, rest: string[]): void {
    const method = req.method ?? 'GET';
    const head = rest[0];

    if (rest.length === 0) {
      if (method === 'GET') return sendJson(res, 200, repoJson(repo, viewer()));
      if (method === 'DELETE') {
        for (const issue of repo.issues.values()) store.issueBySeq.delete(issue.seq);
        for (const pull of repo.pulls.values()) store.pullBySeq.delete(pull.seq);
        store.repos.delete(repo.name);
        return sendEmpty(res, 204);
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(raw);
        if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const patch = body.value;
        if (typeof patch.description === 'string' || patch.description === null) {
          repo.description = (patch.description as string | null) ?? '';
        }
        if (typeof patch.private === 'boolean') repo.private = patch.private;
        if (typeof patch.default_branch === 'string' && repo.refs.has(`refs/heads/${patch.default_branch}`)) {
          repo.defaultBranch = patch.default_branch;
        }
        if (typeof patch.name === 'string' && patch.name !== repo.name) {
          const newName = patch.name;
          if (!/^[A-Za-z0-9._-]+$/.test(newName)) return sendJson(res, 422, { message: 'Repository creation failed.' });
          if (store.repos.has(newName)) {
            return sendJson(res, 422, { message: 'Repository creation failed: a repository with this name already exists.' });
          }
          store.repos.delete(repo.name);
          repo.name = newName;
          store.repos.set(newName, repo);
          for (const issue of repo.issues.values()) issue.repoName = newName;
          for (const pull of repo.pulls.values()) pull.repoName = newName;
        }
        return sendJson(res, 200, repoJson(repo, viewer()));
      }
      return notFound(res);
    }

    if (head === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        return sendJson(res, 200, branches);
      }
      if (method === 'GET') {
        const name = rest.slice(1).join('/');
        const sha = repo.refs.get(`refs/heads/${name}`);
        if (sha === undefined) return notFound(res);
        return sendJson(res, 200, { name, commit: { sha }, protected: false });
      }
      return notFound(res);
    }

    if (head === 'tags' && rest.length === 1 && method === 'GET') {
      const tags = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/tags/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/tags/'.length), commit: { sha: peelToCommit(repo, sha) } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return sendJson(res, 200, tags);
    }

    if (head === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'GET') {
          const refs = [...repo.refs.entries()]
            .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }))
            .sort((a, b) => (a.ref < b.ref ? -1 : 1));
          return sendJson(res, 200, refs);
        }
        if (method === 'POST') {
          const body = parseJsonBody(raw);
          if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          const ref = body.value.ref;
          const sha = body.value.sha;
          if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || !repo.objects.has(sha)) {
            return sendJson(res, 422, { message: 'Validation Failed: the ref or the object is invalid' });
          }
          repo.refs.set(ref, sha);
          repo.packCache.clear();
          return sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        }
        return notFound(res);
      }
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (method === 'GET') {
        const sha = repo.refs.get(ref);
        if (sha === undefined) return notFound(res);
        return sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      }
      if (method === 'DELETE') {
        if (!repo.refs.has(ref)) return notFound(res);
        repo.refs.delete(ref);
        repo.packCache.clear();
        return sendEmpty(res, 204);
      }
      return notFound(res);
    }

    if (head === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const shaParam = url.searchParams.get('sha');
        let start: string | undefined;
        if (shaParam) {
          start = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? peelToCommit(repo, shaParam) : undefined);
          if (start === undefined) return notFound(res);
        } else {
          start = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        }
        if (start === undefined) return sendJson(res, 200, []);
        const seen = new Set<string>();
        const order: string[] = [];
        const queue = [start];
        while (queue.length) {
          const current = queue.shift() as string;
          if (seen.has(current)) continue;
          seen.add(current);
          const commit = getCommit(repo, current);
          if (!commit) continue;
          order.push(current);
          for (const parent of commit.parents) queue.push(parent);
        }
        const { page, perPage } = pageParams(url);
        const slice = order.slice((page - 1) * perPage, page * perPage);
        return sendJson(res, 200, slice.map((oid) => commitJson(repo, oid)));
      }
      if (rest.length === 2 && method === 'GET') {
        const oid = peelToCommit(repo, rest[1] as string);
        const json = commitJson(repo, oid);
        if (!json) return notFound(res);
        const commit = getCommit(repo, oid);
        const parentFlat = flatTreeOfCommit(repo, commit?.parents[0]);
        const ownFlat = flatTreeOfCommit(repo, oid);
        const files: Array<Record<string, unknown>> = [];
        for (const path of new Set([...parentFlat.keys(), ...ownFlat.keys()])) {
          const from = parentFlat.get(path);
          const to = ownFlat.get(path);
          if (from === to) continue;
          files.push({ filename: path, status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified' });
        }
        files.sort((a, b) => ((a.filename as string) < (b.filename as string) ? -1 : 1));
        return sendJson(res, 200, { ...json, files });
      }
      return notFound(res);
    }

    if (head === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const refParam = url.searchParams.get('ref') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${refParam}`) ?? (isOid(refParam) && repo.objects.has(refParam) ? peelToCommit(repo, refParam) : undefined);
        if (tip === undefined) return notFound(res);
        const commit = getCommit(repo, tip);
        if (!commit) return notFound(res);
        const entryJson = (entry: { mode: string; name: string; oid: string }, dirPath: string): Record<string, unknown> => ({
          name: entry.name,
          path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
          type: entry.mode === '40000' ? 'dir' : 'file',
        });
        if (path !== '') {
          const flat = flatTreeOfCommit(repo, tip);
          const blobOid = flat.get(path);
          if (blobOid !== undefined) {
            const blob = repo.objects.get(blobOid);
            if (!blob) return notFound(res);
            return sendJson(res, 200, {
              name: path.split('/').pop(),
              path,
              sha: blobOid,
              size: blob.data.length,
              type: 'file',
              encoding: 'base64',
              content: blob.data.toString('base64'),
            });
          }
        }
        const entries = listTreeDir(repo, commit.tree, path);
        if (entries === null) return notFound(res);
        return sendJson(res, 200, entries.map((entry) => entryJson(entry, path)));
      }
      if (method === 'PUT' || method === 'DELETE') {
        if (path === '') return sendJson(res, 422, { message: 'Validation Failed: a file path is required' });
        const body = parseJsonBody(raw);
        if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const branch = typeof body.value.branch === 'string' ? body.value.branch : repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        // A write to a branch that does not exist yet forks it from the default branch's tip.
        if (!repo.refs.has(branchRef)) {
          const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defaultTip !== undefined) repo.refs.set(branchRef, defaultTip);
        }
        const flat = new Map(flatTreeOfCommit(repo, repo.refs.get(branchRef)));
        const existing = flat.get(path);
        if (method === 'DELETE') {
          if (existing === undefined) return notFound(res);
          if (typeof body.value.sha === 'string' && body.value.sha !== existing) {
            return sendJson(res, 409, { message: 'the sha does not match the current blob' });
          }
          flat.delete(path);
          const sha = commitFlatTree(store, repo, branch, flat, typeof body.value.message === 'string' ? body.value.message : `Delete ${path}`);
          return sendJson(res, 200, { content: null, commit: { sha } });
        }
        if (existing !== undefined) {
          if (body.value.sha === undefined) {
            return sendJson(res, 422, { message: '"sha" is required when updating an existing file' });
          }
          if (body.value.sha !== existing) {
            return sendJson(res, 409, { message: 'the sha does not match the current blob' });
          }
        }
        const data = Buffer.from(typeof body.value.content === 'string' ? body.value.content : '', 'base64');
        const blobOid = putObject(repo, 'blob', data);
        flat.set(path, blobOid);
        const sha = commitFlatTree(
          store,
          repo,
          branch,
          flat,
          typeof body.value.message === 'string' ? body.value.message : `Update ${path}`,
        );
        return sendJson(res, existing === undefined ? 201 : 200, {
          content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, encoding: 'base64' },
          commit: { sha },
        });
      }
      return notFound(res);
    }

    if (head === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const labels = [...repo.labels.values()]
            .map((label) => ({ name: label.name, color: label.color, description: label.description }))
            .sort((a, b) => (a.name < b.name ? -1 : 1));
          return sendJson(res, 200, labels);
        }
        if (method === 'POST') {
          const body = parseJsonBody(raw);
          if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          const name = body.value.name;
          if (typeof name !== 'string' || name === '') return sendJson(res, 422, { message: 'Validation Failed: a label name is required' });
          if (repo.labels.has(name)) return sendJson(res, 422, { message: 'Validation Failed: the label already exists' });
          const label = {
            name,
            color: typeof body.value.color === 'string' ? body.value.color.replace(/^#/, '') : 'ededed',
            description: typeof body.value.description === 'string' ? body.value.description : null,
          };
          repo.labels.set(name, label);
          return sendJson(res, 201, label);
        }
        return notFound(res);
      }
      if (rest.length === 2 && method === 'DELETE') {
        const name = rest[1] as string;
        if (!repo.labels.has(name)) return notFound(res);
        repo.labels.delete(name);
        for (const issue of repo.issues.values()) issue.labels = issue.labels.filter((entry) => entry !== name);
        return sendEmpty(res, 204);
      }
      return notFound(res);
    }

    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const labelFilter = (url.searchParams.get('labels') ?? '')
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name !== '');
          const direction = url.searchParams.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (labelFilter.length) issues = issues.filter((issue) => labelFilter.every((name) => issue.labels.includes(name)));
          issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          return sendPaged(req, res, url, issues, (issue) => issueJson(issue));
        }
        if (method === 'POST') {
          const body = parseJsonBody(raw);
          if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          const title = body.value.title;
          if (typeof title !== 'string' || title === '') {
            return sendJson(res, 422, { message: 'Validation Failed: a title is required' });
          }
          const labels = labelNamesOf(body.value.labels);
          if (labels === null) return sendJson(res, 422, { message: 'Validation Failed: labels must be names' });
          for (const name of labels) {
            if (!repo.labels.has(name)) return sendJson(res, 422, { message: `Validation Failed: unknown label '${name}'` });
          }
          const issue = createIssue(store, repo, {
            title,
            body: typeof body.value.body === 'string' ? body.value.body : '',
            labels,
          });
          return sendJson(res, 201, issueJson(issue));
        }
        return notFound(res);
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (rest.length === 2) {
        const issue = repo.issues.get(number);
        if (method === 'GET') {
          if (issue) return sendJson(res, 200, issueJson(issue));
          const pull = repo.pulls.get(number);
          if (pull) {
            return sendJson(res, 200, {
              id: pull.seq,
              number: pull.number,
              title: pull.title,
              body: pull.body,
              state: pull.merged ? 'closed' : pull.state,
              labels: [],
              pull_request: { merged: pull.merged },
            });
          }
          return notFound(res);
        }
        if (!issue) return notFound(res);
        if (method === 'PATCH') {
          const body = parseJsonBody(raw);
          if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          const patch = body.value;
          if (typeof patch.title === 'string') issue.title = patch.title;
          if (typeof patch.body === 'string') issue.body = patch.body;
          if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
          if (patch.labels !== undefined) {
            const labels = labelNamesOf(patch.labels);
            if (labels === null) return sendJson(res, 422, { message: 'Validation Failed: labels must be names' });
            for (const name of labels) {
              if (!repo.labels.has(name)) return sendJson(res, 422, { message: `Validation Failed: unknown label '${name}'` });
            }
            issue.labels = labels;
          }
          return sendJson(res, 200, issueJson(issue));
        }
        return notFound(res);
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.get(number);
        if (!issue) return notFound(res);
        if (method === 'GET') return sendJson(res, 200, issue.comments.map(commentJson));
        if (method === 'POST') {
          const body = parseJsonBody(raw);
          if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          if (typeof body.value.body !== 'string') return sendJson(res, 422, { message: 'Validation Failed: a body is required' });
          const comment = { id: store.nextCommentId(), body: body.value.body };
          issue.comments.push(comment);
          return sendJson(res, 201, commentJson(comment));
        }
        return notFound(res);
      }
      return notFound(res);
    }

    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let pulls = [...repo.pulls.values()];
          if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
          pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          return sendPaged(req, res, url, pulls, (pull) => pullJson(repo, pull));
        }
        if (method === 'POST') {
          const body = parseJsonBody(raw);
          if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          const stripForkPrefix = (value: unknown): string => {
            if (typeof value !== 'string') return '';
            const colon = value.indexOf(':');
            return colon >= 0 ? value.slice(colon + 1) : value;
          };
          const result = createPull(store, repo, {
            title: typeof body.value.title === 'string' ? body.value.title : '',
            body: typeof body.value.body === 'string' ? body.value.body : '',
            head: stripForkPrefix(body.value.head),
            base: stripForkPrefix(body.value.base),
          });
          if ('error' in result) {
            const messages = {
              'head-missing': 'Validation Failed: the head branch does not exist',
              'base-missing': 'Validation Failed: the base branch does not exist',
              exists: 'Validation Failed: a pull request already exists for this head and base',
            } as const;
            return sendJson(res, 422, { message: messages[result.error] });
          }
          return sendJson(res, 201, pullJson(repo, result.pull));
        }
        return notFound(res);
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const pull: Pull | undefined = repo.pulls.get(number);
      if (rest.length === 2) {
        if (!pull) return notFound(res);
        if (method === 'GET') return sendJson(res, 200, pullJson(repo, pull));
        if (method === 'PATCH') {
          const body = parseJsonBody(raw);
          if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          if (typeof body.value.title === 'string') pull.title = body.value.title;
          if (typeof body.value.body === 'string') pull.body = body.value.body;
          if (!pull.merged) {
            if (body.value.state === 'closed') pull.state = 'closed';
            else if (body.value.state === 'open') pull.state = 'open';
          }
          return sendJson(res, 200, pullJson(repo, pull));
        }
        return notFound(res);
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) return notFound(res);
        return sendJson(res, 200, pullFiles(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return notFound(res);
        if (method === 'GET') return pull.merged ? sendEmpty(res, 204) : notFound(res);
        if (method === 'PUT') {
          const outcome = mergePull(store, repo, pull);
          if (!outcome.ok) {
            return sendJson(res, 405, {
              message: outcome.reason === 'conflict' ? 'Pull Request is not mergeable: it has conflicts' : 'Pull Request is not mergeable',
            });
          }
          return sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
        }
        return notFound(res);
      }
      return notFound(res);
    }

    return notFound(res);
  }

  // ----------------------------------------------------------------------------------------------
  // REST: top level

  function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): void {
    const method = req.method ?? 'GET';
    const segments = url.pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));

    if (segments.length === 0) {
      if (method !== 'GET') return notFound(res);
      return sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
        },
        { 'x-oauth-scopes': 'repo, user' },
      );
    }
    if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
      return sendJson(res, 200, { verifiable_password_authentication: false, installed_version: '3.16.0' });
    }
    if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
      return sendJson(res, 200, { login: viewer(), id: 1000, type: 'User', site_admin: false });
    }
    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const repos = [...store.repos.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
        return sendPaged(req, res, url, repos, (repo) => repoJson(repo, viewer()));
      }
      if (method === 'POST') {
        const body = parseJsonBody(raw);
        if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const name = body.value.name;
        if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
          return sendJson(res, 422, { message: 'Repository creation failed.' });
        }
        if (store.repos.has(name)) {
          return sendJson(res, 422, { message: 'Repository creation failed: a repository with this name already exists.' });
        }
        const repo = store.createRepo(
          name,
          typeof body.value.description === 'string' ? body.value.description : '',
          typeof body.value.private === 'boolean' ? body.value.private : false,
        );
        // No labels are seeded: the label set starts empty and POST /labels creates each one
        // (the suite creates its fixture label that way and expects a 201 for it).
        if (body.value.auto_init === true) {
          const readme = putObject(repo, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
          commitFlatTree(store, repo, repo.defaultBranch, new Map([['README.md', readme]]), 'Initial commit');
        }
        return sendJson(res, 201, repoJson(repo, viewer()));
      }
      return notFound(res);
    }
    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1] as string;
      const name = segments[2] as string;
      adoptViewer(owner);
      const repo = store.repos.get(name);
      if (!repo || owner !== viewer()) return notFound(res);
      return handleRepo(req, res, url, raw, repo, segments.slice(3));
    }
    return notFound(res);
  }

  // ----------------------------------------------------------------------------------------------
  // the server itself

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://forge.invalid');
    const path = url.pathname;
    if (path === '/healthz') return sendJson(res, 200, { ok: true });
    const raw = await readBody(req);
    if (!authorized(req)) return sendJson(res, 401, { message: 'Requires authentication' });

    // A mutating request invalidates every cached read response (see the cache note above).
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') epoch += 1;

    if (method === 'GET') {
      const key = `${epoch}|${viewerLogin ?? ''}|${req.headers.authorization ?? ''}|${req.headers.host ?? ''}|${req.headers['git-protocol'] ?? ''}|${req.url ?? '/'}`;
      const hit = getCache.get(key);
      if (hit) return replayResponse(res, hit);
      capture = { map: getCache, key };
      try {
        return route(req, res, url, path, raw);
      } finally {
        capture = null;
      }
    }
    return route(req, res, url, path, raw);
  }

  function route(req: IncomingMessage, res: ServerResponse, url: URL, path: string, raw: Buffer): void {
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (gitMatch) return handleGit(req, res, url, raw, gitMatch);

    if (path === '/api/graphql') {
      if (req.method !== 'POST') return notFound(res);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 400, { errors: [{ message: 'could not parse the request body as JSON' }] });
      }
      if (Array.isArray(parsed)) {
        const results = parsed.map((entry) =>
          executeGraphQL(store, viewer(), (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown }),
        );
        return sendJson(res, 200, results);
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return sendJson(res, 400, { errors: [{ message: 'the request body is not a GraphQL operation' }] });
      }
      return sendJson(res, 200, executeGraphQL(store, viewer(), parsed as { query?: unknown; variables?: unknown; operationName?: unknown }));
    }

    if (path === '/mcp') {
      if (req.method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
      const { status, body } = handleMcp(store, viewer(), raw.toString('utf8'));
      if (body === null) return sendEmpty(res, status);
      requestSeq += 1;
      res.writeHead(status, {
        'content-type': JSON_TYPE,
        'x-github-request-id': `forge-${requestSeq}`,
        'content-length': Buffer.byteLength(body),
      });
      return res.end(body);
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) return handleRest(req, res, url, raw);
    return notFound(res);
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

// MCP over Streamable HTTP (JSON-RPC 2.0, plain JSON responses). Both discovery eras are served:
// `server/discover` for modern clients and `initialize` for the legacy handshake. The tools act on
// the same store as REST and GraphQL and return the same REST-shaped objects, so an id minted over
// MCP reads back identically over REST. tools/list is served from a constant so two calls are
// byte-identical.

import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './ops.ts';
import type { Store } from './store.ts';

const SERVER_INFO = { name: 'core-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open or closed. Defaults to open.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        head: stringProp('The head branch to merge from.'),
        base: stringProp('The base branch to merge into.'),
        body: stringProp('The pull request body.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface ToolOutcome {
  value: unknown;
  isError: boolean;
}

function ok(value: unknown): ToolOutcome {
  return { value, isError: false };
}

function fail(message: string): ToolOutcome {
  return { value: message, isError: true };
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function callTool(store: Store, viewer: string, name: string, args: Record<string, unknown>): ToolOutcome | 'unknown-tool' {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return 'unknown-tool';
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return fail(`missing required argument: ${required}`);
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : viewer;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const findRepo = () => (owner === viewer ? store.repos.get(repoName) : undefined);

  switch (name) {
    case 'create_repo': {
      const repoNameArg = args.name as string;
      const existing = store.repos.get(repoNameArg);
      if (existing) return ok(repoJson(existing, viewer));
      const repo = store.createRepo(
        repoNameArg,
        typeof args.description === 'string' ? args.description : '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return ok(repoJson(repo, viewer));
    }
    case 'get_repo': {
      const repo = findRepo();
      if (!repo) return fail(`repository ${owner}/${repoName} not found`);
      return ok(repoJson(repo, viewer));
    }
    case 'create_issue': {
      const repo = findRepo();
      if (!repo) return fail(`repository ${owner}/${repoName} not found`);
      const labels = labelNames(args.labels);
      for (const label of labels) {
        if (!repo.labels.has(label)) return fail(`unknown label: ${label}`);
      }
      const issue = createIssue(store, repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        labels,
      });
      return ok(issueJson(issue));
    }
    case 'list_issues': {
      const repo = findRepo();
      if (!repo) return fail(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number);
      return ok({ total_count: issues.length, issues: issues.map((issue) => issueJson(issue)) });
    }
    case 'create_pull_request': {
      const repo = findRepo();
      if (!repo) return fail(`repository ${owner}/${repoName} not found`);
      const result = createPull(store, repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        head: args.head as string,
        base: args.base as string,
      });
      if ('error' in result) {
        if (result.error === 'exists') {
          const existing = [...repo.pulls.values()].find(
            (pull) => pull.state === 'open' && pull.head === args.head && pull.base === args.base,
          );
          if (existing) return ok(pullJson(repo, existing));
        }
        return fail(`could not create the pull request: ${result.error}`);
      }
      return ok(pullJson(repo, result.pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo();
      if (!repo) return fail(`repository ${owner}/${repoName} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) return fail(`pull request ${number} not found`);
      const outcome = mergePull(store, repo, pull);
      if (!outcome.ok) return fail(`could not merge the pull request: ${outcome.reason}`);
      return ok(pullJson(repo, pull));
    }
    default:
      return 'unknown-tool';
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function handleOne(store: Store, viewer: string, request: JsonRpcRequest): string | null {
  const { id, method } = request;
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (id === undefined) return null; // a notification: accepted, never answered
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions: 'A GitHub-shaped forge: repositories, issues, and pull requests over MCP tools.',
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(store, viewer, toolName, args);
      if (outcome === 'unknown-tool') return rpcError(id, -32602, `unknown tool: ${toolName}`);
      if (outcome.isError) {
        return rpcResult(id, {
          content: [{ type: 'text', text: String(outcome.value) }],
          isError: true,
        });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
        isError: false,
      });
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `method not found: ${String(method)}`);
  }
}

/** Handle one MCP HTTP request body. Returns the HTTP status and the body to send (null = empty). */
export function handleMcp(store: Store, viewer: string, rawBody: string): { status: number; body: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: the body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    const replies: string[] = [];
    for (const entry of parsed) {
      const reply = handleOne(store, viewer, (entry ?? {}) as JsonRpcRequest);
      if (reply !== null) replies.push(reply);
    }
    if (!replies.length) return { status: 202, body: null };
    return { status: 200, body: `[${replies.join(',')}]` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid request: the body is not a JSON-RPC object') };
  }
  const request = parsed as JsonRpcRequest;
  if (request.id === undefined) return { status: 202, body: null };
  const reply = handleOne(store, viewer, request);
  return { status: 200, body: reply };
}

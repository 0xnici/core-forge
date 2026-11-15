// GraphQL v4, the subset gh and github-mcp-server speak: queries and mutations with variables,
// aliases, inline fragments, input objects, enum lists, cursor pagination on issues, Relay global
// ids, batched operations (a JSON array body answers an array of results), and __type
// introspection for the types the clients feature-detect. An unknown field is a 200 with an
// `errors` array naming it; an unknown repository is data.repository = null with no errors.

import { pullFiles, pullMergeable, pullStateGraphQL, createIssue, createPull, mergePull } from './ops.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ------------------------------------------------------------------------------------------------
// global ids: base64("Type:seq"), opaque and stable across reads

export function globalId(type: string, seq: number): string {
  return Buffer.from(`${type}:${seq}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; seq: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.lastIndexOf(':');
    if (colon < 0) return null;
    const seq = Number.parseInt(text.slice(colon + 1), 10);
    if (!Number.isFinite(seq)) return null;
    return { type: text.slice(0, colon), seq };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// tokenizer

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'ellipsis' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!$=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const value = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1] as string;
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            i += 2;
          }
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1; // the closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------------------------------------------
// parser

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlFieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Map<string, GqlValue>;
  selection: GqlSelection[] | null;
}

type GqlSelection =
  | GqlFieldNode
  | { kind: 'inline'; typeCondition: string; selection: GqlSelection[] }
  | { kind: 'spread'; name: string };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: GqlSelection[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  fragments = new Map<string, GqlSelection[]>();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, found ${JSON.stringify(token.value)}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.skipBalanced('(', ')'); // variable definitions
        this.skipDirectives();
        operations.push({ type: token.value as 'query' | 'mutation', name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        this.next(); // the type condition
        this.skipDirectives();
        this.fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token.value)} at the top level`);
    }
    return operations;
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.value === open) depth += 1;
      else if (token.value === close) depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next(); // the directive name
      if (this.atPunct('(')) this.skipBalanced('(', ')');
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'ellipsis') {
        this.next();
        const token = this.peek();
        if (token.kind === 'name' && token.value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      selections.push(this.parseField());
    }
    this.expect('}');
    return selections;
  }

  private parseField(): GqlFieldNode {
    let name = this.next().value;
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = new Map<string, GqlValue>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next().value;
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selection };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, GqlValue>();
      while (!this.atPunct('}')) {
        const name = this.next().value;
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ------------------------------------------------------------------------------------------------
// schema surface (introspection + unknown-field validation)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergeCommit', 'url',
  ],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ------------------------------------------------------------------------------------------------
// execution

/** A typed value in the result tree: scalars pass through; objects carry their GraphQL type. */
interface GObj {
  __type: string;
  [key: string]: unknown;
}

function obj(type: string, fields: Record<string, unknown>): GObj {
  return { __type: type, ...fields };
}

interface Ctx {
  store: Store;
  viewer: string;
  variables: Record<string, unknown>;
  fragments: Map<string, GqlSelection[]>;
  errors: Array<{ message: string }>;
}

function resolveValue(ctx: Ctx, value: GqlValue | undefined): unknown {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'string':
    case 'enum':
      return value.value;
    case 'number':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(ctx, entry));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(ctx, entry);
      return out;
    }
  }
}

function arg(ctx: Ctx, field: GqlFieldNode, name: string): unknown {
  return resolveValue(ctx, field.args.get(name));
}

function repoObj(repo: Repo): GObj {
  return obj('Repository', { repo });
}

function issueObj(repo: Repo, issue: Issue): GObj {
  return obj('Issue', { repo, issue });
}

function pullObj(repo: Repo, pull: Pull): GObj {
  return obj('PullRequest', { repo, pull });
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const value = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** The issues connection: states filter, CREATED_AT order (ties by number), first/after paging. */
function issuesConnection(ctx: Ctx, repo: Repo, field: GqlFieldNode): GObj {
  const states = arg(ctx, field, 'states') as string[] | undefined;
  const orderBy = arg(ctx, field, 'orderBy') as { field?: string; direction?: string } | undefined;
  const first = (arg(ctx, field, 'first') as number | undefined) ?? 100;
  const after = arg(ctx, field, 'after') as string | null | undefined;
  let issues = [...repo.issues.values()];
  if (states && states.length) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy?.direction ?? 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  let start = 0;
  if (after) {
    const at = numberFromCursor(after);
    const index = at === null ? -1 : issues.findIndex((issue) => issue.number === at);
    if (index >= 0) start = index + 1;
  }
  const page = issues.slice(start, start + Math.max(0, first));
  const hasNextPage = start + page.length < issues.length;
  return obj('IssueConnection', {
    nodes: page.map((issue) => issueObj(repo, issue)),
    pageInfo: obj('PageInfo', {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length ? cursorFor((page[0] as Issue).number) : null,
      endCursor: page.length ? cursorFor((page[page.length - 1] as Issue).number) : null,
    }),
    totalCount: issues.length,
  });
}

function findRepoByGlobalId(ctx: Ctx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  return ctx.store.repoById(parsed.seq);
}

type Resolver = (ctx: Ctx, source: GObj, field: GqlFieldNode) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => obj('User', { login: ctx.viewer }),
    repository: (ctx, _source, field) => {
      const owner = arg(ctx, field, 'owner');
      const name = arg(ctx, field, 'name');
      if (owner !== ctx.viewer || typeof name !== 'string') return null;
      const repo = ctx.store.repos.get(name);
      return repo ? repoObj(repo) : null;
    },
    node: (ctx, _source, field) => {
      const id = arg(ctx, field, 'id');
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.type === 'Repository') {
        const repo = ctx.store.repoById(parsed.seq);
        return repo ? repoObj(repo) : null;
      }
      if (parsed.type === 'Issue') {
        const issue = ctx.store.issueBySeq.get(parsed.seq);
        if (!issue) return null;
        const repo = ctx.store.repos.get(issue.repoName);
        return repo ? issueObj(repo, issue) : null;
      }
      if (parsed.type === 'PullRequest') {
        const pull = ctx.store.pullBySeq.get(parsed.seq);
        if (!pull) return null;
        const repo = ctx.store.repos.get(pull.repoName);
        return repo ? pullObj(repo, pull) : null;
      }
      return null;
    },
    __type: (_ctx, _source, field) => {
      const name = field.args.get('name');
      const typeName = name?.kind === 'string' ? name.value : '';
      if (TYPE_FIELDS[typeName] || ENUM_VALUES[typeName]) return obj('__Type', { name: typeName });
      return null;
    },
  },
  Mutation: {
    createIssue: (ctx, _source, field) => {
      const input = (arg(ctx, field, 'input') ?? {}) as { repositoryId?: string; title?: string; body?: string };
      const repo = findRepoByGlobalId(ctx, input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'createIssue: the repository id does not name a repository' });
        return null;
      }
      const issue = createIssue(ctx.store, repo, { title: input.title ?? '', body: input.body ?? '' });
      return obj('CreateIssuePayload', { issue: issueObj(repo, issue), clientMutationId: null });
    },
    closeIssue: (ctx, _source, field) => {
      const input = (arg(ctx, field, 'input') ?? {}) as { issueId?: string };
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const issue = parsed ? ctx.store.issueBySeq.get(parsed.seq) : undefined;
      if (!issue) {
        ctx.errors.push({ message: 'closeIssue: the issue id does not name an issue' });
        return null;
      }
      issue.state = 'closed';
      const repo = ctx.store.repos.get(issue.repoName) as Repo;
      return obj('CloseIssuePayload', { issue: issueObj(repo, issue), clientMutationId: null });
    },
    createPullRequest: (ctx, _source, field) => {
      const input = (arg(ctx, field, 'input') ?? {}) as {
        repositoryId?: string;
        baseRefName?: string;
        headRefName?: string;
        title?: string;
        body?: string;
      };
      const repo = findRepoByGlobalId(ctx, input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'createPullRequest: the repository id does not name a repository' });
        return null;
      }
      const result = createPull(ctx.store, repo, {
        title: input.title ?? '',
        body: input.body ?? '',
        head: input.headRefName ?? '',
        base: input.baseRefName ?? '',
      });
      if ('error' in result) {
        if (result.error === 'exists') {
          const existing = [...repo.pulls.values()].find(
            (pull) => pull.state === 'open' && pull.head === input.headRefName && pull.base === input.baseRefName,
          );
          if (existing) return obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, existing), clientMutationId: null });
        }
        ctx.errors.push({ message: `createPullRequest: ${result.error}` });
        return null;
      }
      return obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, result.pull), clientMutationId: null });
    },
    mergePullRequest: (ctx, _source, field) => {
      const input = (arg(ctx, field, 'input') ?? {}) as { pullRequestId?: string };
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const pull = parsed ? ctx.store.pullBySeq.get(parsed.seq) : undefined;
      if (!pull) {
        ctx.errors.push({ message: 'mergePullRequest: the pull request id does not name a pull request' });
        return null;
      }
      const repo = ctx.store.repos.get(pull.repoName) as Repo;
      const outcome = mergePull(ctx.store, repo, pull);
      if (!outcome.ok) {
        ctx.errors.push({ message: `mergePullRequest: the pull request is ${outcome.reason}` });
        return null;
      }
      return obj('MergePullRequestPayload', { pullRequest: pullObj(repo, pull), clientMutationId: null });
    },
    addComment: (ctx, _source, field) => {
      const input = (arg(ctx, field, 'input') ?? {}) as { subjectId?: string; body?: string };
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const issue = parsed ? ctx.store.issueBySeq.get(parsed.seq) : undefined;
      if (!issue) {
        ctx.errors.push({ message: 'addComment: the subject id does not name an issue' });
        return null;
      }
      const comment = { id: ctx.store.nextCommentId(), body: input.body ?? '' };
      issue.comments.push(comment);
      const node = obj('IssueComment', { gid: globalId('IssueComment', comment.id), body: comment.body });
      return obj('AddCommentPayload', {
        commentEdge: obj('CommentEdge', { node, cursor: cursorFor(comment.id) }),
        subject: issueObj(ctx.store.repos.get(issue.repoName) as Repo, issue),
        clientMutationId: null,
      });
    },
  },
  User: {
    login: (_ctx, source) => source.login,
    id: (ctx) => globalId('User', 1000),
    name: () => null,
    email: () => null,
  },
  Repository: {
    id: (_ctx, source) => globalId('Repository', (source.repo as Repo).id),
    databaseId: (_ctx, source) => (source.repo as Repo).id,
    name: (_ctx, source) => (source.repo as Repo).name,
    nameWithOwner: (ctx, source) => `${ctx.viewer}/${(source.repo as Repo).name}`,
    owner: (ctx) => obj('User', { login: ctx.viewer }),
    defaultBranchRef: (_ctx, source) => {
      const repo = source.repo as Repo;
      if (repo.refs.size === 0) return null;
      const name = repo.refs.has(`refs/heads/${repo.defaultBranch}`)
        ? repo.defaultBranch
        : (repo.refs.keys().next().value as string).replace(/^refs\/heads\//, '');
      return obj('Ref', { name });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_ctx, source) => (source.repo as Repo).description,
    isPrivate: (_ctx, source) => (source.repo as Repo).private,
    createdAt: () => '2026-01-01T00:00:00Z',
    updatedAt: () => '2026-01-01T00:00:00Z',
    url: () => '',
    issue: (ctx, source, field) => {
      const repo = source.repo as Repo;
      const number = arg(ctx, field, 'number') as number;
      const issue = repo.issues.get(number);
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (ctx, source, field) => issuesConnection(ctx, source.repo as Repo, field),
    pullRequest: (ctx, source, field) => {
      const repo = source.repo as Repo;
      const number = arg(ctx, field, 'number') as number;
      const pull = repo.pulls.get(number);
      return pull ? pullObj(repo, pull) : null;
    },
    pullRequests: (ctx, source, field) => {
      const repo = source.repo as Repo;
      const first = (arg(ctx, field, 'first') as number | undefined) ?? 100;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, Math.max(0, first));
      return obj('PullRequestConnection', {
        nodes: pulls.map((pull) => pullObj(repo, pull)),
        pageInfo: obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
        totalCount: repo.pulls.size,
      });
    },
  },
  Issue: {
    id: (_ctx, source) => globalId('Issue', (source.issue as Issue).seq),
    number: (_ctx, source) => (source.issue as Issue).number,
    title: (_ctx, source) => (source.issue as Issue).title,
    state: (_ctx, source) => ((source.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (_ctx, source) => (source.issue as Issue).body,
    labels: (_ctx, source) =>
      obj('LabelConnection', {
        nodes: (source.issue as Issue).labels.map((name) => obj('Label', { name })),
      }),
    comments: (_ctx, source) =>
      obj('IssueCommentConnection', {
        nodes: (source.issue as Issue).comments.map((comment) =>
          obj('IssueComment', { gid: globalId('IssueComment', comment.id), body: comment.body }),
        ),
      }),
    author: (ctx) => obj('User', { login: ctx.viewer }),
    repository: (_ctx, source) => repoObj(source.repo as Repo),
    createdAt: () => '2026-01-01T00:00:00Z',
    updatedAt: () => '2026-01-01T00:00:00Z',
    closedAt: (_ctx, source) => ((source.issue as Issue).state === 'closed' ? '2026-01-01T00:00:00Z' : null),
    url: () => '',
  },
  PullRequest: {
    id: (_ctx, source) => globalId('PullRequest', (source.pull as Pull).seq),
    number: (_ctx, source) => (source.pull as Pull).number,
    title: (_ctx, source) => (source.pull as Pull).title,
    body: (_ctx, source) => (source.pull as Pull).body,
    state: (_ctx, source) => pullStateGraphQL(source.pull as Pull),
    merged: (_ctx, source) => (source.pull as Pull).merged,
    mergedAt: (_ctx, source) => (source.pull as Pull).mergedAt,
    headRefName: (_ctx, source) => (source.pull as Pull).head,
    baseRefName: (_ctx, source) => (source.pull as Pull).base,
    mergeable: (_ctx, source) => {
      const pull = source.pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullMergeable(source.repo as Repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (ctx, source, field) => {
      const repo = source.repo as Repo;
      const pull = source.pull as Pull;
      const first = (arg(ctx, field, 'first') as number | undefined) ?? 100;
      const files = pullFiles(repo, pull).slice(0, Math.max(0, first));
      return obj('PullRequestChangedFileConnection', {
        nodes: files.map((file) => obj('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions })),
        pageInfo: obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
        totalCount: files.length,
      });
    },
    author: (ctx) => obj('User', { login: ctx.viewer }),
    repository: (_ctx, source) => repoObj(source.repo as Repo),
    createdAt: () => '2026-01-01T00:00:00Z',
    updatedAt: () => '2026-01-01T00:00:00Z',
    mergeCommit: () => null,
    url: () => '',
  },
  Ref: {
    name: (_ctx, source) => source.name,
    target: () => null,
  },
  IssueConnection: {
    nodes: (_ctx, source) => source.nodes,
    edges: (_ctx, source) =>
      (source.nodes as GObj[]).map((node) => obj('IssueEdge', { node, cursor: cursorFor(((node as unknown as { issue: Issue }).issue).number) })),
    pageInfo: (_ctx, source) => source.pageInfo,
    totalCount: (_ctx, source) => source.totalCount,
  },
  PullRequestConnection: {
    nodes: (_ctx, source) => source.nodes,
    edges: (_ctx, source) => (source.nodes as GObj[]).map((node) => obj('PullRequestEdge', { node, cursor: '' })),
    pageInfo: (_ctx, source) => source.pageInfo,
    totalCount: (_ctx, source) => source.totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (_ctx, source) => source.nodes,
    edges: (_ctx, source) => (source.nodes as GObj[]).map((node) => obj('PullRequestChangedFileEdge', { node, cursor: '' })),
    pageInfo: (_ctx, source) => source.pageInfo,
    totalCount: (_ctx, source) => source.totalCount,
  },
  PullRequestChangedFile: {
    path: (_ctx, source) => source.path,
    additions: (_ctx, source) => source.additions,
    deletions: (_ctx, source) => source.deletions,
  },
  LabelConnection: {
    nodes: (_ctx, source) => source.nodes,
    edges: () => [],
    pageInfo: () => obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
    totalCount: (_ctx, source) => (source.nodes as unknown[]).length,
  },
  IssueCommentConnection: {
    nodes: (_ctx, source) => source.nodes,
    edges: () => [],
    pageInfo: () => obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
    totalCount: (_ctx, source) => (source.nodes as unknown[]).length,
  },
  IssueEdge: { node: (_ctx, source) => source.node, cursor: (_ctx, source) => source.cursor },
  PullRequestEdge: { node: (_ctx, source) => source.node, cursor: (_ctx, source) => source.cursor },
  PullRequestChangedFileEdge: { node: (_ctx, source) => source.node, cursor: (_ctx, source) => source.cursor },
  PageInfo: {
    hasNextPage: (_ctx, source) => source.hasNextPage,
    hasPreviousPage: (_ctx, source) => source.hasPreviousPage,
    startCursor: (_ctx, source) => source.startCursor,
    endCursor: (_ctx, source) => source.endCursor,
  },
  Label: {
    name: (_ctx, source) => source.name,
    color: () => 'ededed',
    description: () => null,
  },
  IssueComment: {
    id: (_ctx, source) => source.gid,
    body: (_ctx, source) => source.body,
    author: (ctx) => obj('User', { login: ctx.viewer }),
    createdAt: () => '2026-01-01T00:00:00Z',
  },
  CreateIssuePayload: { issue: (_ctx, source) => source.issue, clientMutationId: (_ctx, source) => source.clientMutationId },
  CloseIssuePayload: { issue: (_ctx, source) => source.issue, clientMutationId: (_ctx, source) => source.clientMutationId },
  CreatePullRequestPayload: { pullRequest: (_ctx, source) => source.pullRequest, clientMutationId: (_ctx, source) => source.clientMutationId },
  MergePullRequestPayload: { pullRequest: (_ctx, source) => source.pullRequest, clientMutationId: (_ctx, source) => source.clientMutationId },
  AddCommentPayload: {
    commentEdge: (_ctx, source) => source.commentEdge,
    subject: (_ctx, source) => source.subject,
    clientMutationId: (_ctx, source) => source.clientMutationId,
  },
  CommentEdge: { node: (_ctx, source) => source.node, cursor: (_ctx, source) => source.cursor },
  __Type: {
    name: (_ctx, source) => source.name,
    kind: (_ctx, source) => (ENUM_VALUES[source.name as string] ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (_ctx, source) => {
      const fields = TYPE_FIELDS[source.name as string];
      if (!fields) return null;
      return fields.map((name) => obj('__Field', { name }));
    },
    enumValues: (_ctx, source) => {
      const values = ENUM_VALUES[source.name as string];
      if (!values) return null;
      return values.map((name) => obj('__EnumValue', { name }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    interfaces: () => [],
    specifiedByURL: () => null,
  },
  __Field: {
    name: (_ctx, source) => source.name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_ctx, source) => source.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
};

function isGObj(value: unknown): value is GObj {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as GObj).__type === 'string';
}

function executeSelection(ctx: Ctx, typeName: string, source: GObj, selections: GqlSelection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === typeName) {
        Object.assign(out, executeSelection(ctx, typeName, source, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelection(ctx, typeName, source, fragment));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (selection.name === '__type' && (typeName === 'Query')) {
      const resolver = RESOLVERS.Query.__type as Resolver;
      out[key] = completeValue(ctx, resolver(ctx, source, selection), selection);
      continue;
    }
    const typeResolvers = RESOLVERS[typeName];
    const resolver = typeResolvers?.[selection.name];
    if (!resolver || !(TYPE_FIELDS[typeName]?.includes(selection.name) ?? false)) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, resolver(ctx, source, selection), selection);
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, field: GqlFieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, field));
  if (isGObj(value)) {
    if (!field.selection) return value;
    return executeSelection(ctx, value.__type, value, field.selection);
  }
  return value;
}

/** Execute one operation document; returns the {data, errors?} envelope. */
export function executeGraphQL(
  store: Store,
  viewer: string,
  body: { query?: unknown; variables?: unknown; operationName?: unknown },
): { data: unknown; errors?: Array<{ message: string }> } {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let operations: GqlOperation[];
  let fragments: Map<string, GqlSelection[]>;
  try {
    const parser = new Parser(query);
    operations = parser.parseDocument();
    fragments = parser.fragments;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'could not parse the document' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = operations.find((candidate) => operationName === null || candidate.name === operationName) ?? operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const ctx: Ctx = { store, viewer, variables, fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, obj(rootType, {}), operation.selection);
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

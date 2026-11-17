// The GitHub GraphQL v4 surface: a small parser and executor for the documents gh and
// github-mcp-server send (viewer, repository reads, issue/pull connections, the five
// mutations, __type introspection, node(id:) and operation batching). It reads and writes
// the same store as REST, so an object created on one surface is the same on the other.

import {
  VIEWER,
  branchTip,
  mergeBase,
  flattenTree,
  commitTree,
  mergeFlats,
  store,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { createIssue, createPull, globalId, issueJson, mergePull, parseGlobalId, pullFiles, pullJson } from './rest.ts';

// ---------------------------------------------------------------------------
// tokenizer and parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        tokens.push(`"${input.slice(i + 3, end < 0 ? input.length : end)}"`);
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          value += input[j + 1] === 'n' ? '\n' : input[j + 1] === 't' ? '\t' : input[j + 1]!;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(input.slice(i));
    if (match) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  tokens: string[];
  pos: number;

  constructor(tokens: string[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    }
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        const name = this.next();
        if (name === 'on') {
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Array<{ name: string; value: Value }> = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      if (this.peek() === '@') {
        // a directive: skip its name and any argument list
        this.next();
        this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
      }
      const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        const type = token === 'mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== undefined) name = this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
        if (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced('(', ')');
        }
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }
}

// ---------------------------------------------------------------------------
// values

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// schema surface

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'target'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'repository', 'labels',
    'comments', 'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'commits', 'author', 'repository', 'createdAt', 'updatedAt',
    'mergedAt', 'mergeCommit', 'url',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Label: ['name', 'color'],
  LabelConnection: ['nodes', 'pageInfo'],
};

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const ENUM_TYPES = new Set(Object.keys(TYPE_ENUMS));

// ---------------------------------------------------------------------------
// execution

interface Source {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  variables: Record<string, unknown>;
  document: DocumentNode;
  errors: Array<{ message: string }>;
}

const userSource = (): Source => ({ __typename: 'User', login: VIEWER.login });
const repoSource = (repo: RepoRec): Source => ({ __typename: 'Repository', repo });
const issueSource = (repo: RepoRec, issue: IssueRec): Source => ({ __typename: 'Issue', repo, issue });
const pullSource = (repo: RepoRec, pull: PullRec): Source => ({ __typename: 'PullRequest', repo, pull });

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : -1;
  } catch {
    return -1;
  }
}

function mergeableOf(repo: RepoRec, pull: PullRec): string {
  if (pull.merged) return 'UNKNOWN';
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  const merged = mergeFlats(
    flattenTree(repo, base ? commitTree(repo, base) : null),
    flattenTree(repo, commitTree(repo, baseTip)),
    flattenTree(repo, commitTree(repo, headTip)),
  );
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

function findByGlobalId(id: string): Source | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.kind === 'Repository') {
    const repo = store.byDbId.get(Number.parseInt(parsed.parts[0]!, 10));
    return repo ? repoSource(repo) : null;
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const repo = store.byDbId.get(Number.parseInt(parsed.parts[0]!, 10));
    if (!repo) return null;
    const number = Number.parseInt(parsed.parts[1]!, 10);
    if (parsed.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue ? issueSource(repo, issue) : null;
    }
    const pull = repo.pulls.get(number);
    return pull ? pullSource(repo, pull) : null;
  }
  if (parsed.kind === 'User') return userSource();
  return null;
}

function resolveField(source: Source, field: FieldNode, ctx: ExecContext): unknown {
  const args = argsOf(field, ctx.variables);
  const type = source.__typename;
  const repo = source.repo as RepoRec | undefined;
  const issue = source.issue as IssueRec | undefined;
  const pull = source.pull as PullRec | undefined;

  if (field.name === '__typename') return type;

  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') return userSource();
      if (field.name === 'repository') {
        if (args.owner !== VIEWER.login || typeof args.name !== 'string') return null;
        const found = store.getRepo(VIEWER.login, args.name);
        return found ? repoSource(found) : null;
      }
      if (field.name === 'node') return typeof args.id === 'string' ? findByGlobalId(args.id) : null;
      if (field.name === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        if (TYPE_FIELDS[name] || TYPE_ENUMS[name]) return { __typename: '__Type', name };
        return null;
      }
      if (field.name === '__schema') return { __typename: '__Schema' };
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const target = typeof input.repositoryId === 'string' ? findByGlobalId(input.repositoryId) : null;
        if (!target || target.__typename !== 'Repository') throw new Error('createIssue: repository not found');
        const targetRepo = target.repo as RepoRec;
        const created = createIssue(targetRepo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) throw new Error(created.error);
        return { __typename: 'CreateIssuePayload', issue: issueSource(targetRepo, created) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const target = typeof input.issueId === 'string' ? findByGlobalId(input.issueId) : null;
        if (!target || target.__typename !== 'Issue') throw new Error('closeIssue: issue not found');
        (target.issue as IssueRec).state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: target };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const target = typeof input.repositoryId === 'string' ? findByGlobalId(input.repositoryId) : null;
        if (!target || target.__typename !== 'Repository') throw new Error('createPullRequest: repository not found');
        const targetRepo = target.repo as RepoRec;
        const created = createPull(
          targetRepo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in created) throw new Error(created.error);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(targetRepo, created) };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const target = typeof input.pullRequestId === 'string' ? findByGlobalId(input.pullRequestId) : null;
        if (!target || target.__typename !== 'PullRequest') throw new Error('mergePullRequest: pull request not found');
        const targetRepo = target.repo as RepoRec;
        const targetPull = target.pull as PullRec;
        const outcome = mergePull(targetRepo, targetPull, input.mergeMethod === 'MERGE' ? 'merge' : 'squash');
        if (!outcome.ok && outcome.reason === 'conflict') throw new Error('mergePullRequest: pull request is not mergeable');
        return { __typename: 'MergePullRequestPayload', pullRequest: target };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const target = typeof input.subjectId === 'string' ? findByGlobalId(input.subjectId) : null;
        if (!target || target.__typename !== 'Issue') throw new Error('addComment: subject not found');
        const targetRepo = target.repo as RepoRec;
        const targetIssue = target.issue as IssueRec;
        const comment = { id: store.nextCommentId++, body: String(input.body ?? '') };
        targetIssue.comments.push(comment);
        const node: Source = {
          __typename: 'IssueComment',
          id: globalId('Comment', targetRepo.dbId, comment.id),
          body: comment.body,
        };
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node } };
      }
      break;
    }
    case 'User': {
      if (field.name === 'login') return VIEWER.login;
      if (field.name === 'id') return globalId('User', VIEWER.id);
      if (field.name === 'databaseId') return VIEWER.id;
      if (field.name === 'name') return VIEWER.name;
      if (field.name === 'email') return VIEWER.email;
      break;
    }
    case 'Repository': {
      if (!repo) break;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.dbId);
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userSource();
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.priv;
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip ? { __typename: 'Ref', name: repo.defaultBranch } : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const found = repo.issues.get(Number(args.number));
          return found ? issueSource(repo, found) : null;
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states && states.length) {
            list = list.filter((entry) => states.includes(entry.state === 'open' ? 'OPEN' : 'CLOSED'));
          }
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          if (orderBy && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
            list.sort((a, b) => b.number - a.number);
          } else if (orderBy && orderBy.direction === 'ASC') {
            list.sort((a, b) => a.number - b.number);
          } else {
            list.sort((a, b) => a.number - b.number);
          }
          const total = list.length;
          const afterIndex = args.after != null ? decodeCursor(args.after) : -1;
          const first = typeof args.first === 'number' ? args.first : total;
          const start = afterIndex + 1;
          const page = list.slice(start, start + first);
          const hasNext = start + page.length < total;
          const endCursor = page.length ? encodeCursor(start + page.length - 1) : null;
          return {
            __typename: 'IssueConnection',
            nodes: page.map((entry) => issueSource(repo, entry)),
            pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, endCursor, hasPreviousPage: start > 0, startCursor: page.length ? encodeCursor(start) : null },
            totalCount: total,
          };
        }
        case 'pullRequest': {
          const found = repo.pulls.get(Number(args.number));
          return found ? pullSource(repo, found) : null;
        }
        case 'pullRequests': {
          const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
          const first = typeof args.first === 'number' ? args.first : list.length;
          return {
            __typename: 'PullRequestConnection',
            nodes: list.slice(0, first).map((entry) => pullSource(repo, entry)),
            pageInfo: { __typename: 'PageInfo', hasNextPage: list.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
            totalCount: list.length,
          };
        }
      }
      break;
    }
    case 'Issue': {
      if (!issue || !repo) break;
      switch (field.name) {
        case 'id':
          return globalId('Issue', repo.dbId, issue.number);
        case 'databaseId':
          return repo.dbId * 1_000_000 + issue.number;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author':
          return userSource();
        case 'repository':
          return repoSource(repo);
      }
      break;
    }
    case 'PullRequest': {
      if (!pull || !repo) break;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', repo.dbId, pull.number);
        case 'databaseId':
          return repo.dbId * 1_000_000 + pull.number;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return mergeableOf(repo, pull);
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'author':
          return userSource();
        case 'repository':
          return repoSource(repo);
        case 'files': {
          const files = pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : files.length;
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: files.slice(0, first).map((file) => ({
              __typename: 'PullRequestChangedFile',
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
            })),
            totalCount: files.length,
          };
        }
      }
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return source.name;
      break;
    }
    case 'IssueComment':
    case 'Comment': {
      if (field.name === 'id') return source.id;
      if (field.name === 'body') return source.body;
      if (field.name === 'author') return userSource();
      break;
    }
    case '__Type': {
      const name = source.name as string;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return ENUM_TYPES.has(name) ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        return (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
      }
      if (field.name === 'enumValues') {
        return (TYPE_ENUMS[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value }));
      }
      if (field.name === 'description') return null;
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return source.name;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      break;
    }
    case '__Schema': {
      if (field.name === 'queryType') return { __typename: '__Type', name: 'Query' };
      if (field.name === 'mutationType') return { __typename: '__Type', name: 'Mutation' };
      break;
    }
    default: {
      // Connection and payload objects carry their fields directly on the source.
      if (field.name in source) return source[field.name];
      break;
    }
  }

  ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
  return null;
}

function executeSelectionSet(source: Source, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === source.__typename) {
        Object.assign(out, executeSelectionSet(source, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.document.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === null || fragment.typeCondition === source.__typename)) {
        Object.assign(out, executeSelectionSet(source, fragment.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(source, selection, ctx);
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (typeof value === 'object') {
    const source = value as Source;
    if (typeof source.__typename === 'string' && field.selectionSet) {
      return executeSelectionSet(source, field.selectionSet, ctx);
    }
    return value;
  }
  return value;
}

// ---------------------------------------------------------------------------
// the endpoint

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function runOperation(document: DocumentNode, operationName: string | undefined, variables: Record<string, unknown>): Record<string, unknown> {
  const operation =
    document.operations.find((op) => operationName !== undefined && op.name === operationName) ?? document.operations[0];
  if (!operation) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecContext = { variables, document, errors: [] };
  const root: Source = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  // Query fields resolve against the Query root; mutation fields against Mutation. The
  // resolveField switch keys on __typename, so give the root the operation's own type name
  // but route through the Query/Mutation cases.
  const rootTyped: Source = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  void root;
  const data = executeSelectionSet(rootTyped, operation.selectionSet, ctx);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length) body.errors = ctx.errors;
  return body;
}

export function handleGraphQL(rawBody: Buffer): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'the request body is not JSON' }] } };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'operation is not an object' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    try {
      const document = new Parser(tokenize(query)).parseDocument();
      return runOperation(document, operationName, variables);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}

// Kept for cross-surface parity checks in development: the REST JSON of the same objects.
export { issueJson, pullJson };

// The GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, with GitHub's response shapes and status codes. The merge
// engine and the serializers live here because GraphQL and MCP read and write the same store.

import {
  VIEWER,
  branchTip,
  commitFile,
  commitHistory,
  commitTree,
  diffTrees,
  flattenTree,
  forgeCommit,
  buildTreeFromFlat,
  mergeBase,
  mergeFlats,
  parseCommit,
  putObject,
  store,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestResult => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestResult => ({ status: 422, body: { message } });

// ---------------------------------------------------------------------------
// global ids (GraphQL node ids): opaque, stable, never the plain database id

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const pieces = text.split(':');
    if (pieces.length < 2) return null;
    return { kind: pieces[0]!, parts: pieces.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// serializers

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date(1_735_689_600_000 + repo.seq * 1000).toISOString(),
    updated_at: new Date(1_735_689_600_000 + repo.seq * 1000).toISOString(),
  };
}

function issueNumericId(repo: RepoRec, number: number): number {
  return repo.dbId * 1_000_000 + number;
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issueNumericId(repo, issue.number),
    node_id: globalId('Issue', repo.dbId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: new Date(1_735_689_600_000 + issue.number * 1000).toISOString(),
    updated_at: new Date(1_735_689_600_000 + issue.number * 1000).toISOString(),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.head) ?? '0'.repeat(40);
  const baseSha = branchTip(repo, pull.base) ?? '0'.repeat(40);
  return {
    id: issueNumericId(repo, pull.number),
    node_id: globalId('PullRequest', repo.dbId, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: new Date(1_735_689_600_000 + pull.number * 1000).toISOString(),
    updated_at: new Date(1_735_689_600_000 + pull.number * 1000).toISOString(),
  };
}

export function commentJson(repo: RepoRec, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('Comment', repo.dbId, comment.id),
    body: comment.body,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: new Date(1_735_689_600_000 + comment.id * 1000).toISOString(),
    updated_at: new Date(1_735_689_600_000 + comment.id * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// shared operations (REST, GraphQL and MCP all use these)

export function createIssue(repo: RepoRec, title: string, body: string, labelNames: string[]): IssueRec | { error: string } {
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return { error: `Validation Failed: label '${name}' does not exist` };
  }
  const issue: IssueRec = {
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(repo: RepoRec, title: string, body: string, head: string, base: string): PullRec | { error: string } {
  const cleanHead = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
  const cleanBase = base.includes(':') ? base.slice(base.indexOf(':') + 1) : base;
  if (!branchTip(repo, cleanHead)) return { error: `Validation Failed: head branch '${cleanHead}' does not exist` };
  if (!branchTip(repo, cleanBase)) return { error: `Validation Failed: base branch '${cleanBase}' does not exist` };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.head === cleanHead && pull.base === cleanBase) {
      return { error: `Validation Failed: a pull request already exists for '${cleanHead}' into '${cleanBase}'` };
    }
  }
  const pull: PullRec = {
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    head: cleanHead,
    base: cleanBase,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export interface MergeOutcome {
  ok: boolean;
  sha?: string;
  reason?: 'conflict' | 'already' | 'missing';
}

/** Merge a pull request into its base branch (squash unless the method says merge). */
export function mergePull(repo: RepoRec, pull: PullRec, method: string): MergeOutcome {
  if (pull.merged || pull.state === 'closed') return { ok: false, reason: 'already' };
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (!headTip || !baseTip) return { ok: false, reason: 'missing' };
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base ? commitTree(repo, base) : null;
  const merged = mergeFlats(
    flattenTree(repo, baseTree),
    flattenTree(repo, commitTree(repo, baseTip)),
    flattenTree(repo, commitTree(repo, headTip)),
  );
  if (merged === null) return { ok: false, reason: 'conflict' };
  const tree = buildTreeFromFlat(repo, merged);
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const message =
    method === 'merge'
      ? `Merge pull request #${pull.number} from ${pull.head}`
      : `${pull.title} (#${pull.number})`;
  const sha = forgeCommit(repo, tree, parents, message);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date(1_735_689_600_000 + store.commitClock * 1000).toISOString();
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** The changed files of a pull request, with line counts, as the files routes report them. */
export function pullFiles(repo: RepoRec, pull: PullRec): Array<Record<string, unknown>> {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(repo, headTip, baseTip);
  const changes = diffTrees(repo, base ? commitTree(repo, base) : null, commitTree(repo, headTip));
  return changes.map((change) => {
    const oldText = change.oldOid ? (repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = change.newOid ? (repo.objects.get(change.newOid)?.data.toString('utf8') ?? '') : '';
    const counts = lineDiffCounts(oldText, newText, change.status);
    return {
      filename: change.path,
      status: change.status === 'modified' ? 'modified' : change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: change.newOid ?? change.oldOid ?? '',
    };
  });
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiffCounts(oldText: string, newText: string, status: 'added' | 'removed' | 'modified'): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (status === 'added') return { additions: newLines.length, deletions: 0 };
  if (status === 'removed') return { additions: 0, deletions: oldLines.length };
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

// ---------------------------------------------------------------------------
// contents helpers

/** Resolve a ref name (branch, tag or sha) to a commit oid. */
export function resolveRef(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return tag;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** The blob oid at a path in a tree, or null. */
function blobAtPath(repo: RepoRec, treeOid: string | null, path: string): string | null {
  const flat = flattenTree(repo, treeOid);
  return flat.get(path)?.oid ?? null;
}

// ---------------------------------------------------------------------------
// the router

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  rawBody: Buffer;
  host: string;
}

function bodyObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function handleRest(req: RestRequest): RestResult {
  const { segments, method } = req;

  // API root and meta
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0', hooks: [], git: [] } };
  }

  // the token's user
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email },
    };
  }

  // the token's repositories
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const body = bodyObject(req.body);
      const name = str(body.name);
      if (name === '') return unprocessable('Validation Failed: name is required');
      const repo = store.createRepo(VIEWER.login, name, body.private === true, str(body.description));
      if (!repo) return unprocessable(`Validation Failed: a repository named '${name}' already exists`);
      return { status: 201, body: repoJson(repo) };
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
      const all = store.reposOf(VIEWER.login);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const lastPage = Math.max(1, Math.ceil(all.length / perPage));
      if (page < lastPage) {
        const base = `http://${req.host}/api/v3/user/repos?per_page=${perPage}`;
        headers.link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${lastPage}>; rel="last"`;
      }
      return { status: 200, body: slice.map(repoJson), headers };
    }
    return notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = segments[1]!;
  const repoName = segments[2]!;
  if (owner !== VIEWER.login) return notFound();
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  const rest = segments.slice(3);

  // the repository itself
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const body = bodyObject(req.body);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '') repo.name = body.name;
      if (typeof body.private === 'boolean') repo.priv = body.private;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return notFound();
  }

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (!sha) return notFound();
      return { status: 200, body: { name, commit: { sha }, protected: false } };
    }
    return notFound();
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, req.query.get('sha'));
    if (!tip) return { status: 200, body: [] };
    const history = commitHistory(repo, tip);
    return {
      status: 200,
      body: history.map((sha) => {
        const commit = parseCommit(repo.objects.get(sha)!.data);
        return {
          sha,
          commit: {
            message: commit.message,
            author: { name: commit.author, email: '', date: new Date(1_735_689_600_000).toISOString() },
            committer: { name: commit.committer, email: '', date: new Date(1_735_689_600_000).toISOString() },
            tree: { sha: commit.tree },
          },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        };
      }),
    };
  }

  // git data refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = bodyObject(req.body);
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return unprocessable('Validation Failed: ref and sha are required');
      if (repo.refs.has(ref)) return unprocessable(`Validation Failed: reference '${ref}' already exists`);
      if (!repo.objects.has(sha)) return unprocessable('Validation Failed: sha does not name an object');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: repo.objects.get(sha)!.type } } };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound();
      return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }
    return notFound();
  }

  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(req, repo, path);
  }

  // labels
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'POST') {
      const body = bodyObject(req.body);
      const name = str(body.name);
      if (name === '') return unprocessable('Validation Failed: name is required');
      if (repo.labels.has(name)) return unprocessable(`Validation Failed: label '${name}' already exists`);
      const color = str(body.color) || 'ededed';
      repo.labels.set(name, { name, color });
      return { status: 201, body: { name, color } };
    }
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
    }
    return notFound();
  }

  // issues and their comments
  if (rest[0] === 'issues') {
    return handleIssues(req, repo, rest.slice(1));
  }

  // pull requests
  if (rest[0] === 'pulls') {
    return handlePulls(req, repo, rest.slice(1));
  }

  return notFound();
}

function handleContents(req: RestRequest, repo: RepoRec, path: string): RestResult {
  const { method } = req;
  if (method === 'GET') {
    const ref = req.query.get('ref');
    const tip = resolveRef(repo, ref);
    if (!tip) return notFound();
    const tree = commitTree(repo, tip);
    if (!tree) return notFound();
    const flat = flattenTree(repo, tree);
    if (path === '') {
      return { status: 200, body: dirListing(repo, tree, '') };
    }
    const entry = flat.get(path);
    if (entry) {
      const blob = repo.objects.get(entry.oid);
      if (!blob) return notFound();
      return {
        status: 200,
        body: {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: entry.oid,
          size: blob.data.length,
          encoding: 'base64',
          content: blob.data.toString('base64'),
        },
      };
    }
    const listing = dirListing(repo, tree, path);
    if (listing) return { status: 200, body: listing };
    return notFound();
  }
  if (method === 'PUT') {
    const body = bodyObject(req.body);
    const message = str(body.message) || 'update';
    const contentText = str(body.content);
    const content = Buffer.from(contentText.replace(/[\r\n\t ]+/g, ''), 'base64');
    const branch = str(body.branch) || repo.defaultBranch;
    const tip = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
    const existing = tip ? blobAtPath(repo, commitTree(repo, tip), path) : null;
    const givenSha = str(body.sha);
    if (existing && givenSha && givenSha !== existing) {
      return { status: 409, body: { message: 'Conflict: the sha does not match the current content' } };
    }
    const result = commitFile(repo, branch, path, content, message);
    return {
      status: existing ? 200 : 201,
      body: {
        content: {
          name: path.split('/').pop(),
          path,
          sha: result.blobOid,
          size: content.length,
          encoding: 'base64',
        },
        commit: { sha: result.commitOid },
      },
    };
  }
  if (method === 'DELETE') {
    const body = bodyObject(req.body);
    const message = str(body.message) || 'delete';
    const branch = str(body.branch) || repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (!tip) return notFound();
    const existing = blobAtPath(repo, commitTree(repo, tip), path);
    if (!existing) return notFound();
    const givenSha = str(body.sha);
    if (givenSha && givenSha !== existing) {
      return { status: 409, body: { message: 'Conflict: the sha does not match the current content' } };
    }
    const result = commitFile(repo, branch, path, null, message);
    return { status: 200, body: { content: null, commit: { sha: result.commitOid } } };
  }
  return notFound();
}

/** A directory listing for `prefix` inside a tree, or null when the directory does not exist. */
function dirListing(repo: RepoRec, treeOid: string, prefix: string): Array<Record<string, unknown>> | null {
  const flat = flattenTree(repo, treeOid);
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  const head = prefix === '' ? '' : `${prefix}/`;
  for (const [path, entry] of flat) {
    if (prefix !== '' && !path.startsWith(head)) continue;
    const rest = path.slice(head.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', sha: entry.oid });
    } else {
      const dir = rest.slice(0, slash);
      if (!entries.has(dir)) entries.set(dir, { type: 'dir', sha: treeOidOf(repo, treeOid, `${head}${dir}`) ?? '' });
    }
  }
  if (entries.size === 0 && prefix !== '') return null;
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => ({ type: entry.type, name, path: `${head}${name}`, sha: entry.sha }));
}

/** Walk a tree to a subdirectory's tree oid. */
function treeOidOf(repo: RepoRec, rootTree: string, dirPath: string): string | null {
  let current = rootTree;
  for (const segment of dirPath.split('/')) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const text = object.data;
    let found: string | null = null;
    let offset = 0;
    while (offset < text.length) {
      const space = text.indexOf(0x20, offset);
      const nul = text.indexOf(0x00, space + 1);
      const name = text.subarray(space + 1, nul).toString('utf8');
      if (name === segment) {
        found = text.subarray(nul + 1, nul + 21).toString('hex');
        break;
      }
      offset = nul + 21;
    }
    if (!found) return null;
    current = found;
  }
  return current;
}

function handleIssues(req: RestRequest, repo: RepoRec, rest: string[]): RestResult {
  const { method } = req;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(req.body);
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      const labelNames = rawLabels.map((label) => (typeof label === 'string' ? label : str((label as Record<string, unknown>)?.name)));
      const created = createIssue(repo, str(body.title), str(body.body), labelNames);
      if ('error' in created) return unprocessable(created.error);
      return { status: 201, body: issueJson(repo, created) };
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const perPage = Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30;
      const page = Number.parseInt(req.query.get('page') ?? '1', 10) || 1;
      list = list.slice((page - 1) * perPage, page * perPage);
      return { status: 200, body: list.map((issue) => issueJson(repo, issue)) };
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0]!, 10);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH') {
      const body = bodyObject(req.body);
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const names = body.labels.map((label) => (typeof label === 'string' ? label : str((label as Record<string, unknown>)?.name)));
        for (const name of names) if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label '${name}' does not exist`);
        issue.labels = names;
      }
      return { status: 200, body: issueJson(repo, issue) };
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'POST') {
      const body = bodyObject(req.body);
      const comment = { id: store.nextCommentId++, body: str(body.body) };
      issue.comments.push(comment);
      return { status: 201, body: commentJson(repo, comment) };
    }
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(repo, comment)) };
    }
    return notFound();
  }
  return notFound();
}

function handlePulls(req: RestRequest, repo: RepoRec, rest: string[]): RestResult {
  const { method } = req;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(req.body);
      const created = createPull(repo, str(body.title), str(body.body), str(body.head), str(body.base));
      if ('error' in created) return unprocessable(created.error);
      return { status: 201, body: pullJson(repo, created) };
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const perPage = Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30;
      const page = Number.parseInt(req.query.get('page') ?? '1', 10) || 1;
      list = list.slice((page - 1) * perPage, page * perPage);
      return { status: 200, body: list.map((pull) => pullJson(repo, pull)) };
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0]!, 10);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1 && method === 'GET') {
    if (!pull) return notFound();
    return { status: 200, body: pullJson(repo, pull) };
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) return notFound();
    return { status: 200, body: pullFiles(repo, pull) };
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) return notFound();
    const body = bodyObject(req.body);
    const method2 = str(body.merge_method) || 'merge';
    const outcome = mergePull(repo, pull, method2 === 'merge' ? 'merge' : 'squash');
    if (!outcome.ok) {
      return { status: 405, body: { message: outcome.reason === 'conflict' ? 'Pull Request is not mergeable' : 'Pull Request is not open' } };
    }
    return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

// Re-exported for the contents commit path used by MCP setup parity checks.
export { putObject };

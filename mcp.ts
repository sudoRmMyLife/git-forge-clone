// The Model Context Protocol endpoint (POST /mcp, streamable HTTP, JSON answers): the modern
// server/discover revision and the legacy initialize handshake, tools/list and tools/call for
// the six forge tools, all over the same store REST and GraphQL use.

import { VIEWER, store, type RepoRec } from './store.ts';
import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository for the authenticated user.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request into its base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

const TOOLS_JSON = JSON.stringify(TOOLS);

export interface McpResult {
  status: number;
  body: string | null;
  contentType: string;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return {
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }),
    contentType: 'application/json',
  };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return {
    status,
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
    contentType: 'application/json',
  };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoFor(args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login || name === '') return null;
  return store.getRepo(owner, name);
}

type ToolOutcome = { result: Record<string, unknown> } | { rpc: [number, string] };

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const def = TOOLS.find((entry) => entry.name === name);
  if (!def) return { rpc: [-32602, `unknown tool: ${name}`] };
  const required = (def.inputSchema.required as string[]) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { rpc: [-32602, `missing required argument: ${key}`] };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const created = store.createRepo(
        VIEWER.login,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      if (!created) return { result: toolErr(`a repository named '${repoName}' already exists`) };
      return { result: toolOk(repoJson(created)) };
    }
    case 'get_repo': {
      const repo = repoFor(args);
      if (!repo) return { result: toolErr('repository not found') };
      return { result: toolOk(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = repoFor(args);
      if (!repo) return { result: toolErr('repository not found') };
      const created = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return { result: toolErr(created.error) };
      return { result: toolOk(issueJson(repo, created)) };
    }
    case 'list_issues': {
      const repo = repoFor(args);
      if (!repo) return { result: toolErr('repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return { result: toolOk(list.map((issue) => issueJson(repo, issue))) };
    }
    case 'create_pull_request': {
      const repo = repoFor(args);
      if (!repo) return { result: toolErr('repository not found') };
      const created = createPull(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if ('error' in created) return { result: toolErr(created.error) };
      return { result: toolOk(pullJson(repo, created)) };
    }
    case 'merge_pull_request': {
      const repo = repoFor(args);
      if (!repo) return { result: toolErr('repository not found') };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.get(number);
      if (!pull) return { result: toolErr('pull request not found') };
      const outcome = mergePull(repo, pull, 'squash');
      if (!outcome.ok) return { result: toolErr(outcome.reason === 'conflict' ? 'pull request is not mergeable' : 'pull request is not open') };
      return { result: toolOk({ number: pull.number, merged: true, sha: outcome.sha, state: 'closed' }) };
    }
  }
  return { rpc: [-32602, `unknown tool: ${name}`] };
}

export function handleMcp(rawBody: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  // notifications carry no id and are answered with an empty 202
  if (id === undefined) {
    return { status: 202, body: null, contentType: 'application/json' };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      // answered from the frozen serialization so two calls are byte-identical
      return {
        status: 200,
        body: `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":{"tools":${TOOLS_JSON}}}`,
        contentType: 'application/json',
      };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(name, args);
      if ('rpc' in outcome) return rpcError(id, outcome.rpc[0], outcome.rpc[1]);
      return rpcResult(id, outcome.result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

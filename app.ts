// The forge's HTTP server: one process routing the env's boot probe, the REST v3 API,
// GraphQL v4, the MCP endpoint and git smart HTTP, all over the store in store.ts.
// main.ts owns the lifecycle (bind, register, wait for done); this file is the surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER, store } from './store.ts';
import { advertisement, handleFetchV0, handleFetchV2, handleLsRefs, handleReceivePack, parseUploadPackRequest } from './git.ts';
import { handleRest, type RestResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(8, '0');
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, headers);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) {
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

function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.trim() !== '';
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- git smart HTTP: /<owner>/<repo>.git/...
  const gitMatch = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const service = gitMatch[3]!;
    const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : null;
    if (!repo) {
      sendBuffer(res, 404, Buffer.from('repository not found\n', 'utf8'), 'text/plain; charset=utf-8');
      return;
    }
    try {
      if (service === 'info/refs' && method === 'GET') {
        const serviceParam = url.searchParams.get('service');
        if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
          sendBuffer(res, 400, Buffer.from('missing service parameter\n', 'utf8'), 'text/plain; charset=utf-8');
          return;
        }
        const protocolHeader = req.headers['git-protocol'] ?? '';
        const v2 = serviceParam === 'git-upload-pack' && protocolHeader.includes('version=2');
        const body = advertisement(repo, serviceParam, v2);
        sendBuffer(res, 200, body, `application/x-${serviceParam}-advertisement`, { 'cache-control': 'no-cache' });
        return;
      }
      if (service === 'git-upload-pack' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseUploadPackRequest(raw);
        if (parsed.kind === 'ls-refs') {
          sendBuffer(res, 200, handleLsRefs(repo, parsed.args), 'application/x-git-upload-pack-result');
        } else if (parsed.v2) {
          sendBuffer(res, 200, handleFetchV2(repo, parsed.args), 'application/x-git-upload-pack-result');
        } else {
          sendBuffer(res, 200, handleFetchV0(repo, parsed.args), 'application/x-git-upload-pack-result');
        }
        return;
      }
      if (service === 'git-receive-pack' && method === 'POST') {
        const raw = await readBody(req);
        sendBuffer(res, 200, handleReceivePack(repo, raw), 'application/x-git-receive-pack-result');
        return;
      }
    } catch (err) {
      sendBuffer(res, 400, Buffer.from(`bad request: ${err instanceof Error ? err.message : String(err)}\n`, 'utf8'), 'text/plain; charset=utf-8');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- GraphQL v4
  if (path === '/api/graphql') {
    if (!hasAuth(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const result = handleGraphQL(raw);
    sendJson(res, result.status, result.body);
    return;
  }

  // ---- MCP
  if (path === '/mcp') {
    if (!hasAuth(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(raw);
    if (result.body === null) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendBuffer(res, result.status, Buffer.from(result.body, 'utf8'), result.contentType);
    return;
  }

  // ---- REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!hasAuth(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    let body: unknown;
    let rawBody = Buffer.alloc(0);
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      rawBody = await readBody(req);
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    const result: RestResult = handleRest({
      method,
      segments,
      query: url.searchParams,
      body,
      rawBody,
      host: req.headers.host ?? '127.0.0.1',
    });
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // the peer is gone; nothing more to do
      }
    });
  });
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  return server;
}

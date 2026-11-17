// main.ts — the forge's harness lifecycle.
//
// app.ts builds the HTTP surface (git smart HTTP, REST v3, GraphQL, MCP and
// the /healthz boot probe) but knows nothing about the trial around it. This
// file is the part that talks to the grading env, following the wire contract
// the kit's conformance sources settle:
//
//   1. bind the forge on an ephemeral port — listen(0), the kernel picks, so
//      the forge never collides with the env's own listener;
//   2. POST {"port": N} to the env's /register — the env takes the address
//      the request came from plus this port as the forge's base URL and
//      dials it from then on; the first register wins, a repeat is a 409;
//   3. long-poll GET /done — the env answers {"done": false} at once while
//      its suite runs and {"done": true} once the export is written; on
//      true, exit 0.
//
// The harness hands the entry the env's origin as MAKEFUN_ENV_URL. When that
// is unset (a plain local run), the origin is rebuilt from MAKEFUN_ENV_HOST
// and MAKEFUN_ENV_PORT, the variables the env itself listens on.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** The env route the entry announces its port on. */
const REGISTER_PATH = '/register';
/** The env route the entry polls until the suite is over. */
const DONE_PATH = '/done';
/** The pause between two register attempts while the env is coming up. */
const REGISTER_RETRY_MS = 500;
/** The pause between two /done polls; the env answers at once, never holds. */
const DONE_POLL_MS = 250;
/** One env call may take this long before it counts as a failed attempt. */
const ENV_CALL_TIMEOUT_MS = 5_000;

/** The env's origin, no trailing slash: MAKEFUN_ENV_URL, or the host/port pair. */
function envBaseUrl(): string {
  const handed = process.env.MAKEFUN_ENV_URL;
  if (handed !== undefined && handed !== '') return handed.replace(/\/+$/, '');
  const host = process.env.MAKEFUN_ENV_HOST ?? '127.0.0.1';
  const port = process.env.MAKEFUN_ENV_PORT ?? '8080';
  return `http://${host}:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Announce the forge's port until the env takes it. A 200 means this register
 * landed; a 409 means an earlier attempt of ours landed and the env kept it —
 * either way the env now dials this process. Anything else (a refused
 * connection while the env starts, a stray status) is retried: a register
 * that never lands scores the same whether this process waits or gives up,
 * so it waits.
 */
async function registerUntilAccepted(envUrl: string, port: number): Promise<void> {
  const url = `${envUrl}${REGISTER_PATH}`;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 200 || response.status === 409) return;
    } catch {
      // the env is not answering yet; fall through to the retry pause
    }
    await sleep(REGISTER_RETRY_MS);
  }
}

/**
 * Poll /done until the env reports the suite is over. Answers that are not a
 * clean {"done": true} — a false, a garbled body, a dropped connection while
 * the env writes its export — all mean the same thing: keep waiting.
 */
async function waitUntilDone(envUrl: string): Promise<void> {
  const url = `${envUrl}${DONE_PATH}`;
  for (;;) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      if (response.status === 200) {
        const body: unknown = await response.json().catch(() => null);
        if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) return;
      } else {
        await response.arrayBuffer().catch(() => undefined);
      }
    } catch {
      // a failed poll says nothing about the suite; poll again
    }
    await sleep(DONE_POLL_MS);
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => {
    server.removeListener('error', reject);
    resolve();
  });
});
const bound = server.address() as AddressInfo;
process.stderr.write(`forge: listening on port ${bound.port}\n`);

const envUrl = envBaseUrl();
await registerUntilAccepted(envUrl, bound.port);
process.stderr.write(`forge: registered with the env at ${envUrl}\n`);

await waitUntilDone(envUrl);
process.stderr.write('forge: the suite is done; exiting\n');
server.close();
process.exit(0);

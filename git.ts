// git smart HTTP: info/refs advertisements, protocol v2 ls-refs and fetch, protocol v0 fetch,
// and v0 receive-pack with report-status in sideband frames. Repositories exist only after a
// REST create; a missing one answers 404 on both services.

import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
  type RepoRec,
} from './store.ts';

export const PKT_MAX_PAYLOAD = 65516;

export function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktItem {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a buffer of pkt-lines; throws on malformed framing. Answers the items and the rest. */
export function decodePkts(buffer: Buffer, start = 0): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      items.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { items, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      items.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    items.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { items, rest: buffer.subarray(offset) };
}

/** The ref lines a v0 advertisement carries: HEAD first (with capabilities), then sorted refs. */
function v0RefLines(repo: RepoRec, capabilities: string): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    lines.push(encodePkt(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return lines;
  }
  const firstOid = headOid ?? repo.refs.get(names[0]!)!;
  lines.push(encodePkt(`${firstOid} HEAD\0${capabilities}\n`));
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    lines.push(encodePkt(`${oid} ${name}\n`));
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) lines.push(encodePkt(`${peeled} ${name}^{}\n`));
    }
  }
  return lines;
}

const AGENT = 'git-forge/1.0';

export function advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  if (service === 'git-upload-pack' && v2) {
    return Buffer.concat([
      encodePkt('version 2\n'),
      encodePkt(`agent=${AGENT}\n`),
      encodePkt('ls-refs=unborn\n'),
      encodePkt('fetch=shallow\n'),
      encodePkt('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
  }
  const preamble = encodePkt(`# service=${service}\n`);
  if (service === 'git-upload-pack') {
    const caps = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow object-format=sha1 symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
    return Buffer.concat([preamble, PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH]);
  }
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  return Buffer.concat([preamble, PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function handleLsRefs(repo: RepoRec, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid) {
      let line = `${headOid} HEAD`;
      if (args.symrefs) line += ` symref-target:${headRef}`;
      parts.push(encodePkt(`${line}\n`));
    } else if (args.unborn) {
      let line = 'unborn HEAD';
      if (args.symrefs) line += ` symref-target:${headRef}`;
      parts.push(encodePkt(`${line}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    parts.push(encodePkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Work out what a fetch sends: the want closure, cut by depth and by what the client holds. */
export function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  const shallowSet = new Set(args.shallow);
  // What the client already holds: everything reachable from its haves, except that a shallow
  // boundary commit's parents are NOT held (that is what makes a deepen deliver the parent).
  const haveObjects = new Set<string>();
  {
    const queue: string[] = [...args.haves];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      haveObjects.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTreeEntries(repo, oid)) queue.push(entry);
      }
    }
  }

  const send = new Set<string>();
  const addObjectClosure = (root: string): void => {
    for (const oid of collectReachable(repo, [root])) {
      if (!haveObjects.has(oid)) send.add(oid);
    }
  };

  let shallow: string[] = [];
  let unshallow: string[] = [];

  if (args.depth === null) {
    for (const want of args.wants) addObjectClosure(want);
    shallow = args.shallow.filter((oid) => repo.objects.has(oid));
  } else {
    const depth = args.depth;
    // Peel wants through tags to commits, keeping the tag chain itself in the send set.
    const startCommits: string[] = [];
    for (const want of args.wants) {
      let current = want;
      for (let i = 0; i < 16; i += 1) {
        const object = repo.objects.get(current);
        if (!object) break;
        if (!haveObjects.has(current)) send.add(current);
        if (object.type === 'tag') {
          current = parseTag(object.data).object;
          continue;
        }
        break;
      }
      const commitOid = peelToCommit(repo, want);
      if (commitOid) startCommits.push(commitOid);
    }
    const included = new Set<string>();
    let frontier = [...new Set(startCommits)];
    for (let layer = 0; layer < depth && frontier.length; layer += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (included.has(oid)) continue;
        included.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          if (!included.has(parent)) next.push(parent);
        }
      }
      frontier = next;
    }
    const boundary: string[] = [];
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      if (!haveObjects.has(oid)) {
        send.add(oid);
        const tree = parseCommit(object.data).tree;
        for (const entry of collectReachable(repo, [tree])) {
          if (!haveObjects.has(entry)) send.add(entry);
        }
      }
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !included.has(parent) && repo.objects.has(parent))) boundary.push(oid);
    }
    shallow = boundary;
    unshallow = args.shallow.filter((oid) => included.has(oid) && !boundary.includes(oid));
  }

  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

function parseTreeEntries(repo: RepoRec, treeOid: string): string[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  const out: string[] = [];
  let offset = 0;
  const data = object.data;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    out.push(data.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return out;
}

/** Chunk a pack into band-1 sideband pkt-lines. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    parts.push(encodePkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(encodePkt(Buffer.from([1])));
  return parts;
}

export function handleFetchV2(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(encodePkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePkt('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  parts.push(encodePkt('NAK\n'));
  parts.push(...sidebandPackets(pack));
  return Buffer.concat(parts);
}

/** Parse a git-upload-pack POST body (v2 command form or v0 want/have form). */
export function parseUploadPackRequest(body: Buffer): { kind: 'ls-refs'; args: LsRefsArgs } | { kind: 'fetch'; v2: boolean; args: FetchArgs } {
  const { items } = decodePkts(body);
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'data') lines.push(item.payload.toString('utf8'));
  }
  const first = lines[0] ?? '';
  if (first.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
    return { kind: 'ls-refs', args };
  }
  if (first.startsWith('command=fetch')) {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) args.depth = Number.parseInt(text.slice(7), 10);
    }
    return { kind: 'fetch', v2: true, args };
  }
  // v0: want lines (the first carries capabilities), a flush, then have/done lines.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) args.depth = Number.parseInt(text.slice(7), 10);
  }
  if (args.wants.length === 0) throw new Error('no wants in upload-pack request');
  return { kind: 'fetch', v2: false, args };
}

// ---------------------------------------------------------------------------
// receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: RepoRec, body: Buffer): Buffer {
  const { items, rest } = decodePkts(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const item of items) {
    if (item.kind !== 'data') continue;
    let text = item.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.split(' ').some((cap) => cap === 'side-band-64k' || cap === 'side-band')) sideband = true;
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  }

  let unpackLine = 'unpack ok\n';
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackLine = `unpack error: ${err instanceof Error ? err.message : String(err)}\n`;
    }
  }

  const reportLines: string[] = [unpackLine];
  const unpackOk = unpackLine === 'unpack ok\n';
  for (const command of commands) {
    const verdict = unpackOk ? validateAndApply(repo, command) : 'unpack failed';
    if (verdict === null) reportLines.push(`ok ${command.ref}\n`);
    else reportLines.push(`ng ${command.ref} ${verdict}\n`);
  }
  const report = Buffer.concat([...reportLines.map((line) => encodePkt(line)), PKT_FLUSH]);
  if (!sideband) return report;
  const parts: Buffer[] = [];
  const chunkSize = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < report.length; offset += chunkSize) {
    parts.push(encodePkt(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + chunkSize))])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Validate one push command against the store and apply it when valid; a reason string when not. */
function validateAndApply(repo: RepoRec, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || /[\s\x00-\x1f]/.test(ref)) return 'invalid ref';
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return 'reference does not exist';
    if (current !== oldOid) return 'stale info';
    repo.refs.delete(ref);
    return null;
  }
  const object = repo.objects.get(newOid);
  if (!object) return 'missing object';
  if (current !== oldOid) return 'stale info';
  if (oldOid !== ZERO_OID && ref.startsWith('refs/heads/')) {
    const target = peelToCommit(repo, newOid);
    if (target === null) return 'invalid object';
    if (!isAncestor(repo, oldOid, target)) return 'non-fast-forward';
  }
  repo.refs.set(ref, newOid);
  return null;
}

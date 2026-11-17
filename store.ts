// The forge's store and git object model: one in-memory store shared by the git smart-HTTP,
// REST v3, GraphQL and MCP surfaces, plus the object/pack/tree machinery every surface needs.
//
// Everything is plain Node built-ins (crypto for SHA-1, zlib for pack streams). Object ids are
// git's own: SHA-1 over "<type> <size>\0" + bytes. Trees, commits and tags are parsed and built
// byte-exactly the way git does, so anything pushed round-trips through a clone unchanged.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** The one user the trial token belongs to (the suite's seeded scenario viewer). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The identity forge-made commits (contents API, merges) carry. */
export const FORGE_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

// ---------------------------------------------------------------------------
// records

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface RepoRec {
  dbId: number;
  owner: string;
  name: string;
  priv: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  seq: number;
}

export class Store {
  repos = new Map<string, RepoRec>();
  byDbId = new Map<number, RepoRec>();
  nextRepoDbId = 1;
  nextCommentId = 1;
  commitClock = 1_735_689_600;

  createRepo(owner: string, name: string, priv: boolean, description: string): RepoRec | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo: RepoRec = {
      dbId: this.nextRepoDbId++,
      owner,
      name,
      priv,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.repos.size,
    };
    this.repos.set(key, repo);
    this.byDbId.set(repo.dbId, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(`${owner}/${name}`);
    this.byDbId.delete(repo.dbId);
    return true;
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.seq - b.seq);
  }

  /** A timestamp for a forge-made commit: monotonic, never the wall clock. */
  nextTimestamp(): number {
    this.commitClock += 1;
    return this.commitClock;
  }
}

export const store = new Store();

// ---------------------------------------------------------------------------
// object hashing, parsing, building

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer?: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${tz}`);
  lines.push(`committer ${fields.committer ?? fields.author} ${fields.timestamp} ${tz}`);
  lines.push('');
  // The message is stored exactly as given: the contents API's commits must read back with
  // the very message the caller sent, byte for byte.
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a ref target through tag objects to the commit it names (or the object itself). */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// reachability and history

/** Every object reachable from `roots` (commit->tree+parents, tree->entries, tag->target). */
export function collectReachable(repo: RepoRec, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** The commits reachable from `tip`, newest first (a breadth walk over parents). */
export function commitHistory(repo: RepoRec, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** A common ancestor of two commits (the best one a breadth walk from both finds), or null. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const depth = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    while (queue.length) {
      const [oid, d] = queue.shift()!;
      if (depth.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      depth.set(oid, d);
      for (const parent of parseCommit(object.data).parents) queue.push([parent, d + 1]);
    }
    return depth;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, d] of fromA) {
    const other = fromB.get(oid);
    if (other === undefined) continue;
    const score = d + other;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// trees as flat path maps, diffs and three-way merges

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (by oid) into a path -> {mode, oid} map of its files. */
export function flattenTree(repo: RepoRec, treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild nested tree objects from a flat path map; answers the root tree oid. */
export function buildTreeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Set (or delete, when blobOid is null) one path in a tree; answers the new root tree oid. */
export function setTreePath(repo: RepoRec, rootTreeOid: string | null, path: string, blob: FlatEntry | null): string {
  const flat = flattenTree(repo, rootTreeOid);
  if (blob === null) flat.delete(path);
  else flat.set(path, blob);
  return buildTreeFromFlat(repo, flat);
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two trees (by oid; either may be null for an empty tree). */
export function diffTrees(repo: RepoRec, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const changes: FileChange[] = [];
  for (const [path, entry] of head) {
    const before = base.get(path);
    if (!before) changes.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (before.oid !== entry.oid || before.mode !== entry.mode) {
      changes.push({ path, status: 'modified', oldOid: before.oid, newOid: entry.oid });
    }
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) changes.push({ path, status: 'removed', oldOid: entry.oid, newOid: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/**
 * A three-way merge of flat trees. A path changed on only one side takes that side; changed on
 * both to the same value takes it; changed on both differently (or deleted against changed) is
 * a conflict. Answers the merged flat map, or null on conflict.
 */
export function mergeFlats(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): Map<string, FlatEntry> | null {
  const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean =>
    a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode;
  const out = new Map<string, FlatEntry>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o) out.set(path, o);
    } else if (same(b, o)) {
      if (t) out.set(path, t);
    } else if (same(b, t)) {
      if (o) out.set(path, o);
    } else {
      return null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// commits the forge makes itself (contents API, merges)

/** Create a commit object on top of `parents` with `treeOid`, forge identity and message. */
export function forgeCommit(repo: RepoRec, treeOid: string, parents: readonly string[], message: string): string {
  const data = buildCommit({
    tree: treeOid,
    parents,
    message,
    author: FORGE_IDENTITY,
    timestamp: store.nextTimestamp(),
  });
  return putObject(repo, 'commit', data);
}

/**
 * Write (or delete, when content is null) one file on a branch, as a new commit. A branch that
 * does not exist yet starts from the default branch's tip (or from nothing). Answers the new
 * commit oid and, for a write, the blob oid.
 */
export function commitFile(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null } {
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref) ?? null;
  if (parent === null && branch !== repo.defaultBranch) {
    parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  let baseTree: string | null = null;
  if (parent !== null) {
    const object = repo.objects.get(parent);
    if (object && object.type === 'commit') baseTree = parseCommit(object.data).tree;
  }
  let blobOid: string | null = null;
  let blob: FlatEntry | null = null;
  if (content !== null) {
    blobOid = putObject(repo, 'blob', content);
    blob = { mode: '100644', oid: blobOid };
  }
  const tree = setTreePath(repo, baseTree, path, blob);
  const commitOid = forgeCommit(repo, tree, parent === null ? [] : [parent], message);
  repo.refs.set(ref, commitOid);
  return { commitOid, blobOid };
}

/** The tree oid a commit names, or null. */
export function commitTree(repo: RepoRec, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The tip commit of a branch, or null when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

// ---------------------------------------------------------------------------
// packfiles: write (plain objects) and read (with delta resolution)

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of plain (non-delta) objects, with its SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(writePackHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset]!;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset]!;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile into a map of resolved objects. `resolveBase` supplies objects a thin pack
 * leaves out (the receiving repo's own store). Throws on any structural problem.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject & { oid: string };
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  const byOid = new Map<string, Raw>();
  const resolve = (entry: Raw): GitObject & { oid: string } => {
    if (entry.resolved) return entry.resolved;
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error('ref-delta base is not available');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const resolved = { type, data, oid: hashObject(type, data) };
    entry.resolved = resolved;
    byOid.set(resolved.oid, entry);
    return resolved;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

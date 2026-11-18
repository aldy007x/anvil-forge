// gitcore.ts — the object layer of the forge.
//
// Everything git-shaped lives here: content-addressed objects (blob / tree /
// commit / tag), pack reading and writing, pkt-line framing, reachability
// walks, merge bases and the file-level three-way merge that both the REST
// merge endpoint and the GraphQL `mergeable` field rely on.
//
// The module is deliberately storage-agnostic: callers pass a plain
// Map<string, GitObject> ("the object database") around, so the forge store
// can keep one database per repository without this file knowing about repos.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectDb = Map<string, GitObject>;

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 of a buffer, hex encoded — the only hash git sha1 repositories use. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Hash an object's framed bytes without storing it. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  // Two update() calls hash the same framed bytes a Buffer.concat would,
  // without copying the payload first.
  return createHash('sha1').update(`${type} ${data.length}\0`, 'latin1').update(data).digest('hex');
}

/** Insert an object into the database and return its id. Idempotent. */
export function storeObject(db: ObjectDb, type: GitObjectType, data: Buffer): string {
  const id = hashObject(type, data);
  if (!db.has(id)) db.set(id, { type, data });
  return id;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  sha: string;
}

/**
 * Parsed views of stored object bodies, keyed by the body buffer itself.
 * Object bodies in a database are never mutated after being stored, so a
 * parse is a pure function of the buffer and can be shared by every walk
 * that touches the object (reachability, closures, listings). Callers must
 * treat the returned structures as read-only, as they already do.
 */
const treeParseCache = new WeakMap<Buffer, TreeEntry[]>();
const commitParseCache = new WeakMap<Buffer, CommitInfo>();

/** Parse a raw tree object body into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const cached = treeParseCache.get(data);
  if (cached !== undefined) return cached;
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('latin1', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    pos = nul + 21;
  }
  treeParseCache.set(data, entries);
  return entries;
}

/**
 * Serialize entries into a raw tree body. Git orders tree entries by name,
 * with subtrees compared as if their name ended in '/'; getting this wrong
 * changes tree ids, so the sort is part of the format, not a nicety.
 */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file (blob) under a tree, keyed by its slash-joined path. */
export function flattenTree(db: ObjectDb, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const tree = db.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(db, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Build (and store) the tree hierarchy for a flat path -> blob map. Returns the root tree id. */
export function buildTreeFromFiles(db: ObjectDb, files: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, info] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, info);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, info] of node.files) entries.push({ mode: info.mode, name, sha: info.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: emit(child) });
    return storeObject(db, 'tree', serializeTree(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a raw commit body. Header lines end at the first blank line. */
export function parseCommit(data: Buffer): CommitInfo {
  const cached = commitParseCache.get(data);
  if (cached !== undefined) return cached;
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  commitParseCache.set(data, info);
  return info;
}

/** Serialize and store a commit; returns its id. */
export function writeCommit(db: ObjectDb, info: CommitInfo): string {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '', info.message);
  return storeObject(db, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Follow tag objects until a commit (or anything else) shows up. */
export function peelToCommit(db: ObjectDb, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth++) {
    const object = db.get(current);
    if (object === undefined) return current;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return current;
    current = match[1]!;
  }
  return current;
}

// ---------------------------------------------------------------- reachability

/** All commits reachable from `tip` (inclusive), following parents. */
export function ancestorSet(db: ObjectDb, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [peelToCommit(db, tip)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    const object = db.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(current);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(db: ObjectDb, ancestor: string, tip: string): boolean {
  // The same membership question ancestorSet answers, but the walk stops
  // the moment the target turns up: a fast-forward check (the hot caller)
  // usually finds it one step below the tip instead of walking the whole
  // history to build a set it would only probe once.
  const target = peelToCommit(db, ancestor);
  const seen = new Set<string>();
  const stack = [peelToCommit(db, tip)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    const object = db.get(current);
    // ancestorSet only ever contains commits (it skips anything else
    // before adding), so only commits can match the target.
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(current);
    if (current === target) return true;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * The best common ancestor of two commits: breadth-first from `b` until a
 * commit that is also an ancestor of `a` turns up. Histories in this forge
 * are small and mostly linear, so the simple walk is the right tool.
 */
export function mergeBase(db: ObjectDb, a: string, b: string): string | null {
  const aAncestors = ancestorSet(db, a);
  const seen = new Set<string>();
  const queue = [peelToCommit(db, b)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (aAncestors.has(current)) return current;
    const object = db.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/**
 * The full object closure of the have tips: every commit, tree and blob the
 * client provably holds. Commits in `cutAt` (the client's shallow boundary)
 * count as held themselves, but their parents do not — a shallow client has
 * never seen them, so they stay deliverable.
 */
function haveClosure(db: ObjectDb, haves: string[], cutAt: Set<string>): Set<string> {
  const held = new Set<string>();
  const addTree = (treeSha: string): void => {
    if (held.has(treeSha)) return;
    const tree = db.get(treeSha);
    if (tree === undefined || tree.type !== 'tree') return;
    held.add(treeSha);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') addTree(entry.sha);
      else held.add(entry.sha);
    }
  };
  const seen = new Set<string>();
  const stack = haves.map((have) => peelToCommit(db, have));
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = db.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    held.add(current);
    addTree(parseCommit(object.data).tree);
    if (cutAt.has(current)) continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return held;
}

/**
 * The object closure needed to serve a fetch: everything reachable from the
 * want tips, minus what the client already holds. Commits listed in
 * `boundary` are included but their parents are not followed (shallow
 * clones). A held commit on the client's shallow boundary (`cutAt`) is not
 * re-sent, but the walk passes through it to its parents — those are
 * exactly what a deepen fetch asks for; such commits are reported through
 * `stats.unshallowed` when the walk traverses them without a boundary.
 */
export function collectClosure(
  db: ObjectDb,
  wants: string[],
  haves: string[],
  boundary: Set<string>,
  cutAt: Set<string> = new Set(),
  stats?: { unshallowed: Set<string> },
): Map<string, GitObject> {
  const excluded = haveClosure(db, haves, cutAt);
  const out = new Map<string, GitObject>();
  const addTree = (treeSha: string): void => {
    if (out.has(treeSha) || excluded.has(treeSha)) return;
    const tree = db.get(treeSha);
    if (tree === undefined || tree.type !== 'tree') return;
    out.set(treeSha, tree);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') addTree(entry.sha);
      else if (!out.has(entry.sha) && !excluded.has(entry.sha)) {
        const blob = db.get(entry.sha);
        if (blob !== undefined) out.set(entry.sha, blob);
      }
    }
  };
  const addObject = (oid: string): void => {
    // Generic entry point for non-commit tips (annotated tags).
    let current = oid;
    for (let depth = 0; depth < 16; depth++) {
      const object = db.get(current);
      if (object === undefined || out.has(current) || excluded.has(current)) return;
      out.set(current, object);
      if (object.type === 'commit') {
        addTree(parseCommit(object.data).tree);
        return;
      }
      if (object.type !== 'tag') return;
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null) return;
      current = match[1]!;
    }
  };
  const seenCommits = new Set<string>();
  const stack: string[] = [];
  for (const want of wants) {
    const object = db.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') stack.push(want);
    else addObject(want);
  }
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seenCommits.has(current)) continue;
    seenCommits.add(current);
    const object = db.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    if (boundary.has(current)) {
      if (!excluded.has(current)) {
        out.set(current, object);
        addTree(info.tree);
      }
      continue;
    }
    if (excluded.has(current)) {
      if (cutAt.has(current)) {
        stats?.unshallowed.add(current);
        for (const parent of info.parents) stack.push(parent);
      }
      continue;
    }
    out.set(current, object);
    addTree(info.tree);
    for (const parent of info.parents) stack.push(parent);
  }
  return out;
}

/**
 * Generations of commits below the wants, for `--deepen N` fetches: returns
 * the set of commits within N generations and the boundary commits whose
 * parents fall outside (the ones a shallow reply must name).
 */
export function deepenClosure(db: ObjectDb, wants: string[], depth: number): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  let frontier = wants.map((want) => peelToCommit(db, want)).filter((oid) => db.get(oid)?.type === 'commit');
  for (let generation = 0; generation < depth && frontier.length > 0; generation++) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid)) continue;
      included.add(oid);
      const object = db.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (generation === depth - 1) {
        if (parents.length > 0) boundary.add(oid);
      } else {
        for (const parent of parents) next.push(parent);
      }
    }
    frontier = next;
  }
  return { included, boundary };
}

// ---------------------------------------------------------------- three-way merge

export interface MergeOutcome {
  conflict: boolean;
  conflictPaths: string[];
  /** The merged file map (meaningful only when conflict is false). */
  files: Map<string, { sha: string; mode: string }>;
}

/**
 * File-level three-way merge of two tips against their merge base — the same
 * rule git applies per path: a path changed on only one side takes that
 * side's version; changed identically on both sides is fine; changed
 * differently (or deleted against modified) conflicts.
 */
export function threeWayMerge(db: ObjectDb, baseTip: string, headTip: string): MergeOutcome {
  const baseCommit = peelToCommit(db, baseTip);
  const headCommit = peelToCommit(db, headTip);
  const origin = mergeBase(db, baseCommit, headCommit);
  const filesAt = (commit: string | null): Map<string, { sha: string; mode: string }> => {
    if (commit === null) return new Map();
    const object = db.get(commit);
    if (object === undefined || object.type !== 'commit') return new Map();
    return flattenTree(db, parseCommit(object.data).tree);
  };
  const originFiles = filesAt(origin);
  const baseFiles = filesAt(baseCommit);
  const headFiles = filesAt(headCommit);
  const paths = new Set<string>([...originFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  const files = new Map<string, { sha: string; mode: string }>();
  const conflictPaths: string[] = [];
  for (const path of paths) {
    const o = originFiles.get(path);
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const same = (x: { sha: string } | undefined, y: { sha: string } | undefined): boolean => x?.sha === y?.sha;
    let chosen: { sha: string; mode: string } | undefined;
    if (same(b, h)) chosen = b;
    else if (same(o, b)) chosen = h;
    else if (same(o, h)) chosen = b;
    else {
      conflictPaths.push(path);
      continue;
    }
    if (chosen !== undefined) files.set(path, chosen);
  }
  return { conflict: conflictPaths.length > 0, conflictPaths, files };
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line. `null` is the flush packet; payloads cap at 65516 bytes. */
export function pktLine(payload: Buffer | string | null): Buffer {
  if (payload === null) return Buffer.from('0000', 'latin1');
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > 65516) throw new Error(`pkt-line payload too large: ${body.length}`);
  const header = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'latin1'), body]);
}

export const PKT_FLUSH = pktLine(null);
export const PKT_DELIM = Buffer.from('0001', 'latin1');
export const PKT_RESPONSE_END = Buffer.from('0002', 'latin1');

/** A side-band packet: one band byte followed by up to 65515 bytes of payload. */
export function sidebandPkt(band: number, chunk: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([band]), chunk]);
  const header = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'latin1'), body]);
}

/** Split a byte stream into side-band band-1 packets of at most 65515 payload bytes. */
export function sidebandWrap(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65515) {
    parts.push(sidebandPkt(band, data.subarray(offset, offset + 65515)));
  }
  return Buffer.concat(parts);
}

export interface PktRead {
  /** Payload bytes, or null for the flush packet. */
  payload: Buffer | null;
  /** Special packet kind: 'flush' | 'delim' | 'response-end' | 'data'. */
  kind: 'flush' | 'delim' | 'response-end' | 'data';
  next: number;
}

/** Read one pkt-line at `offset`. Throws on truncated or malformed input. */
export function readPktLine(buf: Buffer, offset: number): PktRead {
  if (offset + 4 > buf.length) throw new Error('pkt-line header runs past the buffer');
  const header = buf.toString('latin1', offset, offset + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`pkt-line header is not hex: ${JSON.stringify(header)}`);
  const length = parseInt(header, 16);
  if (length === 0) return { payload: null, kind: 'flush', next: offset + 4 };
  if (length === 1) return { payload: null, kind: 'delim', next: offset + 4 };
  if (length === 2) return { payload: null, kind: 'response-end', next: offset + 4 };
  if (length < 4 || offset + length > buf.length) throw new Error(`pkt-line length ${length} is impossible here`);
  return { payload: buf.subarray(offset + 4, offset + length), kind: 'data', next: offset + length };
}

// ---------------------------------------------------------------- packs

/** Serialize objects into a complete pack file (header, entries, SHA-1 trailer). */
export function buildPack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    // Variable-length header: type in bits 4-6 of the first byte, then the
    // size little-endian-style, 7 bits per byte after the first four.
    let size = object.data.length;
    const first = (TYPE_CODES[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes = [size > 0 ? first | 0x80 : first];
    while (size > 0) {
      const byte = size & 0x7f;
      size >>= 7;
      headBytes.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/**
 * Inflate exactly one zlib stream starting at `offset`, knowing where it
 * ends. The fast path inflates the rest of the buffer once with zlib's
 * `info` mode: the engine reports exactly how many input bytes the stream
 * consumed, so no window search is needed. (The search this replaces made
 * a dozen inflate attempts per object, and every truncated-window attempt
 * pays zlib's exception path — together they dominated pack parsing.)
 * The result is only trusted when it is fully consistent — the consumed
 * count lands inside the buffer and the inflated length equals the size
 * the pack header declared; anything else (a corrupt or truncated stream,
 * an engine that does not report) falls back to the window search, which
 * reproduces the original behavior and errors exactly.
 */
function inflateOne(buf: Buffer, offset: number, expectedSize?: number): { data: Buffer; next: number } {
  try {
    const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
      buffer?: Buffer;
      engine?: { bytesWritten?: unknown };
    };
    const consumed = result.engine?.bytesWritten;
    if (
      result.buffer !== undefined &&
      typeof consumed === 'number' &&
      Number.isSafeInteger(consumed) &&
      consumed > 0 &&
      offset + consumed <= buf.length &&
      (expectedSize === undefined || result.buffer.length === expectedSize)
    ) {
      return { data: result.buffer, next: offset + consumed };
    }
  } catch {
    // Not a readable stream here; the search below reports it properly.
  }
  return inflateOneBySearch(buf, offset);
}

/**
 * The window-search inflate: Node's inflateSync ignores trailing bytes, so
 * the consumed length is found by growing a window until inflation
 * succeeds and then binary-searching the cut point; a truncated stream
 * can never inflate, so the minimum that works is exact.
 */
function inflateOneBySearch(buf: Buffer, offset: number): { data: Buffer; next: number } {
  let lo = offset;
  let hi = Math.min(buf.length, offset + 64);
  for (;;) {
    try {
      inflateSync(buf.subarray(offset, hi));
      break;
    } catch {
      if (hi >= buf.length) throw new Error('pack holds a truncated zlib stream');
      lo = hi;
      hi = Math.min(buf.length, offset + (hi - offset) * 2);
    }
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buf.subarray(offset, hi)), next: hi };
}

/** Apply a git delta buffer to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  readVarint(); // source size; the base we resolved already guarantees it
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copyLength = 0;
      if (op & 0x01) copyOffset = delta[pos++]!;
      if (op & 0x02) copyOffset |= delta[pos++]! << 8;
      if (op & 0x04) copyOffset |= delta[pos++]! << 16;
      if (op & 0x08) copyOffset |= delta[pos++]! << 24;
      if (op & 0x10) copyLength = delta[pos++]!;
      if (op & 0x20) copyLength |= delta[pos++]! << 8;
      if (op & 0x40) copyLength |= delta[pos++]! << 16;
      if (copyLength === 0) copyLength = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copyLength));
      produced += copyLength;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(parts, produced);
  if (result.length !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

export interface ParsedPack {
  objects: Array<{ sha: string; type: GitObjectType; data: Buffer }>;
}

/**
 * Parse a pack received from a client. Deltas (both offset and ref style)
 * are resolved against objects earlier in the same pack or already in `db`,
 * so thin packs a real git client sends also land correctly.
 */
export function parsePack(buf: Buffer, db: ObjectDb): ParsedPack {
  if (buf.length < 12 + 20 || buf.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a pack file');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const checksum = Buffer.from(sha1Hex(buf.subarray(0, buf.length - 20)), 'hex');
  if (!trailer.equals(checksum)) throw new Error('pack checksum mismatch');
  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseSha?: string;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const start = offset;
    let byte = buf[offset++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset back to the base object's header.
      let b = buf[offset++]!;
      let back = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = buf[offset++]!;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeCode === 7) {
      baseSha = buf.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateOne(buf, offset, size);
    offset = inflated.next;
    raw.push({ offset: start, typeCode, data: inflated.data, baseOffset, baseSha });
  }
  const byOffset = new Map<number, { sha: string; type: GitObjectType; data: Buffer }>();
  const resolved = new Map<string, { type: GitObjectType; data: Buffer }>();
  const objects: ParsedPack['objects'] = [];
  for (const entry of raw) {
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      const base = entry.typeCode === 6 ? byOffset.get(entry.baseOffset!) : resolved.get(entry.baseSha!) ?? db.get(entry.baseSha!);
      if (base === undefined) throw new Error('delta base is not available');
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      const mapped = CODE_TYPES[entry.typeCode];
      if (mapped === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
      type = mapped;
      data = entry.data;
    }
    const sha = hashObject(type, data);
    const record = { sha, type, data };
    byOffset.set(entry.offset, record);
    resolved.set(sha, record);
    objects.push(record);
  }
  return { objects };
}

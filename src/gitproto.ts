// gitproto.ts — the git smart HTTP protocol, spoken directly.
//
// Three routes live here: the ref advertisement (with its protocol v0 and
// v2 shapes), git-upload-pack (ls-refs and fetch, including shallow and
// deepen semantics) and git-receive-pack (push, with per-ref report-status).
// The forge's object database does the heavy lifting; this file is framing,
// negotiation and ref bookkeeping.

import {
  ZERO_OID,
  type GitObjectType,
  buildPack,
  collectClosure,
  deepenClosure,
  isAncestor,
  parsePack,
  peelToCommit,
  pktLine,
  readPktLine,
  sidebandWrap,
  PKT_DELIM,
  PKT_FLUSH,
} from './gitcore.ts';
import type { RepoRec } from './forge.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'anvil-forge/1.0';
const UPLOAD_CAPS = `multi_ack_detailed side-band-64k thin-pack shallow ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** Every ref the repository holds, sorted by name (the advertisement order). */
function sortedRefs(repo: RepoRec): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** GET info/refs: the v2 capability list, or the v0 ref advertisement. */
export function infoRefs(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): GitReply {
  if (protocolV2) {
    // A v2 probe gets the v2 capability list for either service. Push is
    // not among the v2 capabilities (no `transport`), so a real git client
    // falls back to the v0 advertisement for receive-pack, as intended.
    const lines = ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
    const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body };
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? refs[0]!.oid;
    let first = true;
    const emit = (oid: string, name: string): void => {
      if (first) {
        parts.push(pktLine(`${oid} ${name}\0${caps}`));
        first = false;
      } else {
        parts.push(pktLine(`${oid} ${name}\n`));
      }
    };
    emit(headOid, 'HEAD');
    for (const ref of refs) {
      emit(ref.oid, ref.name);
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        parts.push(pktLine(`${peelToCommit(repo.objects, ref.oid)} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------- ls-refs

function lsRefs(repo: RepoRec, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    if (unborn) lines.push(`unborn HEAD symref-target:${headTarget(repo)}`);
  } else {
    // With ref-prefixes in play, HEAD is just another name to filter: a
    // prefix that does not match it leaves it out of the answer entirely.
    const headMatches = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
    if (headMatches) {
      const headOid = repo.refs.get(headTarget(repo)) ?? refs[0]!.oid;
      lines.push(symrefs ? `${headOid} HEAD symref-target:${headTarget(repo)}` : `${headOid} HEAD`);
    }
    for (const ref of refs) {
      if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const object = repo.objects.get(ref.oid);
        if (object !== undefined && object.type === 'tag') line += ` peeled:${peelToCommit(repo.objects, ref.oid)}`;
      }
      lines.push(line);
    }
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  deepen: number | null;
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const parsed: FetchArgs = { wants: [], haves: [], clientShallow: [], deepen: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.deepen = Number.parseInt(arg.slice(7), 10);
    else if (arg === 'done') parsed.done = true;
  }
  return parsed;
}

/** Pack cache: identical fetches (the bench's fifty clones) build once. */
const packCache = new Map<string, Buffer>();

function packFor(repo: RepoRec, objects: Map<string, { type: GitObjectType; data: Buffer }>): Buffer {
  const ids = [...objects.keys()].sort();
  const key = `${repo.id}:${ids.join(',')}`;
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = buildPack(ids.map((id) => objects.get(id)!));
  if (packCache.size > 64) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function fetchReply(repo: RepoRec, args: FetchArgs, v2: boolean): Buffer {
  const db = repo.objects;
  // Acknowledgments: NAK when nothing the client has is known here, else an
  // ACK per shared commit and a `ready`.
  const knownHaves = args.haves.filter((have) => db.has(have));
  const ackLines: string[] = [];
  if (knownHaves.length === 0) ackLines.push('NAK');
  else {
    for (const have of knownHaves) ackLines.push(`ACK ${have}`);
    ackLines.push('ready');
  }

  const cutAt = new Set(args.clientShallow);
  const stats = { unshallowed: new Set<string>() };
  let boundary = new Set<string>();
  let shallowLines: string[] = [];
  let objects: Map<string, { type: GitObjectType; data: Buffer }>;
  if (args.deepen !== null && Number.isFinite(args.deepen)) {
    const deepened = deepenClosure(db, args.wants, args.deepen);
    boundary = deepened.boundary;
    objects = collectClosure(db, args.wants, args.haves, boundary, cutAt, stats);
    shallowLines = [...boundary].map((oid) => `shallow ${oid}`);
    for (const oid of stats.unshallowed) {
      if (cutAt.has(oid) && !boundary.has(oid)) shallowLines.push(`unshallow ${oid}`);
    }
  } else {
    objects = collectClosure(db, args.wants, args.haves, new Set(), cutAt, stats);
    for (const oid of stats.unshallowed) {
      if (cutAt.has(oid)) shallowLines.push(`unshallow ${oid}`);
    }
  }
  const pack = packFor(repo, objects);

  if (!v2) {
    const parts: Buffer[] = shallowLines.map((line) => pktLine(`${line}\n`));
    parts.push(pktLine('NAK\n'), sidebandWrap(pack), PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // With `done` in the request the negotiation is over and the reply goes
  // straight to the pack sections — an acknowledgments section at that
  // point is a protocol error to a real git client. Without `done`, the
  // acknowledgments are the whole reply.
  if (!args.done) {
    return Buffer.concat([pktLine('acknowledgments\n'), ...ackLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  }
  const parts: Buffer[] = [];
  if (shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'), ...shallowLines.map((line) => pktLine(`${line}\n`)), PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'), sidebandWrap(pack), PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST git-upload-pack: a v2 command request, or a v0 want/have body. */
export function uploadPack(repo: RepoRec, body: Buffer, protocolV2: boolean): GitReply {
  try {
    if (protocolV2) {
      const commandLines: string[] = [];
      const argLines: string[] = [];
      let offset = 0;
      let section = 0;
      while (offset < body.length) {
        const read = readPktLine(body, offset);
        offset = read.next;
        if (read.kind === 'flush') break;
        if (read.kind === 'delim') {
          section += 1;
          continue;
        }
        const text = read.payload!.toString('utf8').replace(/\n$/, '');
        if (section === 0) commandLines.push(text);
        else argLines.push(text);
      }
      const command = commandLines.find((line) => line.startsWith('command='));
      if (command === 'command=ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, argLines) };
      }
      if (command === 'command=fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchReply(repo, parseFetchArgs(argLines), true) };
      }
      return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
    }
    // Protocol v0: want lines up to a flush, then have lines up to `done`.
    const wants: string[] = [];
    const haves: string[] = [];
    let offset = 0;
    let phase: 'want' | 'have' = 'want';
    while (offset < body.length) {
      const read = readPktLine(body, offset);
      offset = read.next;
      if (read.kind === 'flush') {
        phase = 'have';
        continue;
      }
      if (read.kind !== 'data') continue;
      const text = read.payload!.toString('utf8').replace(/\n$/, '');
      const plain = text.split('\0')[0]!;
      if (plain.startsWith('want ')) wants.push(plain.slice(5).trim());
      else if (plain.startsWith('have ')) haves.push(plain.slice(5).trim());
      else if (plain === 'done') break;
    }
    const args: FetchArgs = { wants, haves, clientShallow: [], deepen: null, done: true };
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchReply(repo, args, false) };
  } catch {
    return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
  }
}

// ---------------------------------------------------------------- receive-pack

interface RefCommand {
  oldId: string;
  newId: string;
  ref: string;
}

/** POST git-receive-pack: apply ref updates, then report per-ref status. */
export function receivePack(repo: RepoRec, body: Buffer): GitReply {
  const commands: RefCommand[] = [];
  let offset = 0;
  try {
    while (offset < body.length) {
      const read = readPktLine(body, offset);
      offset = read.next;
      if (read.kind === 'flush') break;
      if (read.kind !== 'data') continue;
      const text = read.payload!.toString('utf8').replace(/\n$/, '').split('\0')[0]!;
      const fields = text.split(' ');
      if (fields.length >= 3) commands.push({ oldId: fields[0]!, newId: fields[1]!, ref: fields[2]! });
    }
  } catch {
    return { status: 400, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const packBytes = body.subarray(offset);
  const report = (lines: string[]): GitReply => {
    const inner = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat([sidebandWrap(inner), PKT_FLUSH]) };
  };
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes, repo.objects);
      for (const object of parsed.objects) {
        if (!repo.objects.has(object.sha)) repo.objects.set(object.sha, { type: object.type, data: object.data });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return report([`unpack ${message}`, ...commands.map((command) => `ng ${command.ref} unpack failed`)]);
    }
  }
  const lines: string[] = ['unpack ok'];
  for (const command of commands) {
    const verdict = applyRefUpdate(repo, command);
    lines.push(verdict === null ? `ok ${command.ref}` : `ng ${command.ref} ${verdict}`);
  }
  return report(lines);
}

/** Apply one ref command; returns the failure reason, or null on success. */
function applyRefUpdate(repo: RepoRec, command: RefCommand): string | null {
  const db = repo.objects;
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newId === ZERO_OID) {
    // A deletion.
    if (current === ZERO_OID) return 'reference does not exist';
    if (current !== command.oldId) return 'stale info';
    repo.refs.delete(command.ref);
    return null;
  }
  if (!db.has(command.newId)) return 'invalid object';
  if (current === ZERO_OID) {
    if (command.oldId !== ZERO_OID) return 'stale info';
    repo.refs.set(command.ref, command.newId);
    return null;
  }
  if (command.oldId === ZERO_OID) return 'reference already exists';
  if (current !== command.oldId) return 'stale info';
  if (command.oldId === command.newId) return null;
  const oldCommit = peelToCommit(db, command.oldId);
  const newCommit = peelToCommit(db, command.newId);
  if (!isAncestor(db, oldCommit, newCommit)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newId);
  return null;
}

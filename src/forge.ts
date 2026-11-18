// forge.ts — the in-memory state of the forge and the operations on it.
//
// One Forge instance is one universe: the seeded accounts, every repository
// (with its own git object database), issues, pull requests, labels and
// comments. REST, GraphQL, MCP and the git protocol are all thin views over
// this store, which is what keeps object ids identical across surfaces.
//
// Time is deliberately not wall-clock: responses derive their timestamps
// from MAKEFUN_TRIAL_NOW when the harness provides it, else from a fixed
// base, advanced by a monotonic tick. A replayed request sequence therefore
// produces byte-identical answers.

import {
  type ObjectDb,
  type MergeOutcome,
  buildTreeFromFiles,
  flattenTree,
  mergeBase,
  parseCommit,
  peelToCommit,
  storeObject,
  threeWayMerge,
  writeCommit,
} from './gitcore.ts';

/** An error that maps straight onto an HTTP status and a {"message"} body. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Actor {
  login: string;
  id: number;
  name: string;
  email: string;
}

/** The seeded accounts the trial scenario knows about. */
export const VIEWER: Actor = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE: Actor = { login: 'quinnkeller', id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER: Actor = { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid' };
export const ORG_LOGIN = 'faint-meadow-org';

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: ObjectDb;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

const FALLBACK_BASE_ISO = '2026-01-01T00:00:00.000Z';

export class Forge {
  private tick = 0;
  private readonly baseMs: number;
  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private commentSeq = 0;
  private requestSeq = 0;
  readonly repos = new Map<string, RepoRec>();

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = trialNow !== undefined ? Date.parse(trialNow) : Number.NaN;
    this.baseMs = Number.isNaN(parsed) ? Date.parse(FALLBACK_BASE_ISO) : parsed;
  }

  /** The next deterministic timestamp (ISO 8601, UTC). */
  nowIso(): string {
    const ms = this.baseMs + this.tick * 1000;
    this.tick += 1;
    return new Date(ms).toISOString();
  }

  /** A git author/committer line stamped with the deterministic clock. */
  stampLine(actor: Actor = VIEWER): string {
    const unix = Math.floor(this.baseMs / 1000) + this.tick;
    this.tick += 1;
    return `${actor.name} <${actor.email}> ${unix} +0000`;
  }

  /** A fresh, non-empty request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `anvil-${this.requestSeq.toString(36)}-${(this.baseMs + this.requestSeq).toString(36)}`;
  }

  // -------------------------------------------------------------- repositories

  private key(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
    const key = this.key(owner, name);
    if (this.repos.has(key)) throw new HttpError(422, 'name already exists on this account');
    this.repoSeq += 1;
    const stamp = this.nowIso();
    const repo: RepoRec = {
      id: this.repoSeq,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** A user's repositories, newest first (the order the list endpoint serves). */
  listRepos(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner.toLowerCase() === owner.toLowerCase()).sort((a, b) => b.id - a.id);
  }

  requireRepo(owner: string, name: string): RepoRec {
    const repo = this.getRepo(owner, name);
    if (repo === undefined) throw new HttpError(404, 'Not Found');
    return repo;
  }

  // -------------------------------------------------------------- git plumbing

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a branch name or raw commit id to a commit sha, if it exists. */
  resolveCommit(repo: RepoRec, ref: string | undefined): string | undefined {
    if (ref === undefined || ref === '') {
      const tip = this.branchTip(repo, repo.defaultBranch);
      return tip === undefined ? undefined : peelToCommit(repo.objects, tip);
    }
    const branchTip = this.branchTip(repo, ref);
    if (branchTip !== undefined) return peelToCommit(repo.objects, branchTip);
    const object = repo.objects.get(ref);
    if (object !== undefined && (object.type === 'commit' || object.type === 'tag')) return peelToCommit(repo.objects, ref);
    return undefined;
  }

  /** The file map at a commit (empty map for an unborn or unknown commit). */
  filesAt(repo: RepoRec, commitSha: string | undefined): Map<string, { sha: string; mode: string }> {
    if (commitSha === undefined) return new Map();
    const object = repo.objects.get(commitSha);
    if (object === undefined || object.type !== 'commit') return new Map();
    return flattenTree(repo.objects, parseCommit(object.data).tree);
  }

  /** Create a commit holding `files` on `branch` and advance the branch. */
  commitFiles(repo: RepoRec, branch: string, files: Map<string, { sha: string; mode: string }>, message: string, extraParents: string[] = []): string {
    const tree = buildTreeFromFiles(repo.objects, files);
    const parents: string[] = [];
    const tip = this.branchTip(repo, branch);
    if (tip !== undefined) parents.push(peelToCommit(repo.objects, tip));
    for (const extra of extraParents) {
      const peeled = peelToCommit(repo.objects, extra);
      if (!parents.includes(peeled)) parents.push(peeled);
    }
    const stamp = this.stampLine();
    const sha = writeCommit(repo.objects, { tree, parents, author: stamp, committer: stamp, message });
    repo.refs.set(`refs/heads/${branch}`, sha);
    repo.updatedAt = this.nowIso();
    return sha;
  }

  // -------------------------------------------------------------- contents API

  /**
   * Create or update one file through the contents rules: a file that
   * already exists demands its current blob sha (409 without it), a write to
   * a branch that does not exist yet starts that branch from the default
   * branch (or as a root commit in an empty repository).
   */
  putContent(repo: RepoRec, input: { branch?: string; path: string; content: Buffer; message: string; sha?: string }): { created: boolean; blobSha: string; commitSha: string } {
    const branch = input.branch ?? repo.defaultBranch;
    let tip = this.branchTip(repo, branch);
    if (tip === undefined) {
      const fallback = this.branchTip(repo, repo.defaultBranch);
      if (fallback !== undefined) repo.refs.set(`refs/heads/${branch}`, fallback);
      tip = fallback;
    }
    const files = this.filesAt(repo, tip === undefined ? undefined : peelToCommit(repo.objects, tip));
    const existing = files.get(input.path);
    if (existing !== undefined) {
      if (input.sha === undefined || input.sha !== existing.sha) {
        throw new HttpError(409, `"sha" wasn't supplied or doesn't match the file's current sha`);
      }
    }
    const blobSha = storeObject(repo.objects, 'blob', input.content);
    files.set(input.path, { sha: blobSha, mode: existing?.mode ?? '100644' });
    const commitSha = this.commitFiles(repo, branch, files, input.message);
    return { created: existing === undefined, blobSha, commitSha };
  }

  /** Remove one file through the contents rules. */
  deleteContent(repo: RepoRec, input: { branch?: string; path: string; message: string; sha?: string }): { commitSha: string } {
    const branch = input.branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    const files = this.filesAt(repo, tip === undefined ? undefined : peelToCommit(repo.objects, tip));
    const existing = files.get(input.path);
    if (existing === undefined) throw new HttpError(404, 'Not Found');
    if (input.sha !== undefined && input.sha !== existing.sha) throw new HttpError(409, `"sha" doesn't match the file's current sha`);
    files.delete(input.path);
    const commitSha = this.commitFiles(repo, branch, files, input.message);
    return { commitSha };
  }

  // -------------------------------------------------------------- issues

  createIssue(repo: RepoRec, input: { title: string; body?: string | null; labels?: string[] }): IssueRec {
    const labels = input.labels ?? [];
    for (const label of labels) {
      if (!repo.labels.has(label)) throw new HttpError(422, `Validation Failed: label "${label}" does not exist`);
    }
    this.issueSeq += 1;
    const stamp = this.nowIso();
    const issue: IssueRec = {
      id: this.issueSeq,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(target: IssueRec | PullRec, body: string): CommentRec {
    this.commentSeq += 1;
    const comment: CommentRec = { id: this.commentSeq, body, createdAt: this.nowIso() };
    target.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------- pull requests

  createPull(repo: RepoRec, input: { title: string; body?: string | null; head: string; base: string }): PullRec {
    const headTip = this.branchTip(repo, input.head);
    if (headTip === undefined) throw new HttpError(422, `Validation Failed: head branch "${input.head}" does not exist`);
    const baseTip = this.branchTip(repo, input.base);
    if (baseTip === undefined) throw new HttpError(422, `Validation Failed: base branch "${input.base}" does not exist`);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
        throw new HttpError(422, `A pull request already exists for ${input.head} -> ${input.base}`);
      }
    }
    this.pullSeq += 1;
    const stamp = this.nowIso();
    const pull: PullRec = {
      id: this.pullSeq,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headShaAtCreate: peelToCommit(repo.objects, headTip),
      baseShaAtCreate: peelToCommit(repo.objects, baseTip),
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The three-way merge outcome for a pull request's current tips. */
  pullMergePreview(repo: RepoRec, pull: PullRec): MergeOutcome | null {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return null;
    return threeWayMerge(repo.objects, baseTip, headTip);
  }

  /**
   * Merge a pull request. Squash lands one commit with the merged tree on
   * the base branch; a true merge commit keeps both parents. Conflicts and
   * already-settled pull requests are refused the way GitHub refuses them.
   */
  mergePull(repo: RepoRec, pull: PullRec, method: 'merge' | 'squash'): { sha: string } {
    if (pull.merged || pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) throw new HttpError(405, 'Pull Request is not mergeable');
    const headCommit = peelToCommit(repo.objects, headTip);
    const baseCommit = peelToCommit(repo.objects, baseTip);
    if (headCommit === baseCommit) throw new HttpError(405, 'Pull Request is not mergeable: there are no commits to merge');
    const outcome = threeWayMerge(repo.objects, baseCommit, headCommit);
    if (outcome.conflict) throw new HttpError(405, 'Pull Request is not mergeable: it has conflicts that must be resolved');
    let sha: string;
    if (method === 'merge') {
      const baseFiles = outcome.files;
      const tree = buildTreeFromFiles(repo.objects, baseFiles);
      const stamp = this.stampLine();
      sha = writeCommit(repo.objects, {
        tree,
        parents: [baseCommit, headCommit],
        author: stamp,
        committer: stamp,
        message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
      });
      repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
      repo.updatedAt = this.nowIso();
    } else {
      const message = pull.body !== null && pull.body !== '' ? `${pull.title}\n\n${pull.body}` : pull.title;
      sha = this.commitFiles(repo, pull.baseRef, outcome.files, message);
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return { sha };
  }

  /** The changed-file list of a pull request: merge base tree against head tree. */
  pullFiles(repo: RepoRec, pull: PullRec): FileDiff[] {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return [];
    const headCommit = peelToCommit(repo.objects, headTip);
    const baseCommit = peelToCommit(repo.objects, baseTip);
    const origin = mergeBase(repo.objects, baseCommit, headCommit);
    const before = this.filesAt(repo, origin ?? undefined);
    const after = this.filesAt(repo, headCommit);
    const paths = new Set<string>([...before.keys(), ...after.keys()]);
    const diffs: FileDiff[] = [];
    for (const path of [...paths].sort()) {
      const from = before.get(path);
      const to = after.get(path);
      if (from?.sha === to?.sha) continue;
      const fromLines = from === undefined ? [] : blobLines(repo, from.sha);
      const toLines = to === undefined ? [] : blobLines(repo, to.sha);
      const common = lcsLength(fromLines, toLines);
      const additions = toLines.length - common;
      const deletions = fromLines.length - common;
      diffs.push({
        filename: path,
        status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return diffs;
  }
}

/** A blob's text lines (a trailing newline does not invent an empty line). */
export function blobLines(repo: RepoRec, sha: string): string[] {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'blob') return [];
  const text = object.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest-common-subsequence length — the core of a line diff. */
export function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

// ------------------------------------------------------------ global node ids

/** Opaque GraphQL node ids: base64 of `Type:key`, never the bare database id. */
export function encodeGlobalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split <= 0) return null;
    return { type: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return null;
  }
}

/** The repository global id (keyed by database id, so it survives renames). */
export function repoGlobalId(repo: RepoRec): string {
  return encodeGlobalId('Repository', String(repo.id));
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return encodeGlobalId('Issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return encodeGlobalId('PullRequest', `${repo.id}:${pull.number}`);
}

export function commentGlobalId(comment: CommentRec): string {
  return encodeGlobalId('IssueComment', String(comment.id));
}

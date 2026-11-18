// httpapi.ts — the HTTP front door.
//
// One node:http server routes everything: the trial lifecycle's /healthz,
// the REST v3 surface under /api/v3, the GraphQL endpoint, the MCP
// endpoint, and the git smart-HTTP routes at /<owner>/<repo>.git. Cross-
// cutting rules live here so the surfaces cannot drift apart: every API
// request is authenticated against the process's own shop token, every JSON
// answer carries an X-GitHub-Request-Id, and every error body is
// {"message": ...} — never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, HttpError, VIEWER } from './forge.ts';
import { parseCommit, parseTree } from './gitcore.ts';
import { infoRefs, receivePack, uploadPack, type GitReply } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { commentJson, issueJson, pullJson, repoJson, userJson } from './serializers.ts';
import type { IssueRec, PullRec, RepoRec } from './forge.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const OAUTH_SCOPES = 'repo, read:org';
const INSTALLED_VERSION = '1.0.0';

interface Ctx {
  forge: Forge;
  token: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Buffer;
}

function sendJson(ctx: Ctx, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const text = value === null || value === undefined ? '' : JSON.stringify(value);
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': ctx.forge.nextRequestId(),
    ...extra,
  });
  ctx.res.end(text);
}

function sendRaw(ctx: Ctx, reply: GitReply): void {
  ctx.res.writeHead(reply.status, {
    'content-type': reply.contentType,
    'x-github-request-id': ctx.forge.nextRequestId(),
  });
  ctx.res.end(reply.body);
}

function jsonBody(ctx: Ctx): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'Problems parsing JSON');
  return parsed as Record<string, unknown>;
}

function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const rawPer = Number.parseInt(ctx.url.searchParams.get('per_page') ?? '', 10);
  const rawPage = Number.parseInt(ctx.url.searchParams.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(rawPer) && rawPer > 0 ? Math.min(rawPer, 100) : 10,
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

/** Slice one page out of a list and add a rel="next" Link when more remain. */
function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const { page, perPage } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + slice.length < items.length) {
    const host = ctx.req.headers.host ?? 'localhost';
    const next = new URL(`http://${host}${ctx.url.pathname}`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    ctx.res.setHeader('link', `<${next.toString()}>; rel="next"`);
  }
  return slice;
}

// ---------------------------------------------------------------- REST: repositories

function createRepo(ctx: Ctx): void {
  const body = jsonBody(ctx);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
  const repo = ctx.forge.createRepo(
    VIEWER.login,
    name,
    typeof body.description === 'string' ? body.description : '',
    typeof body.private === 'boolean' ? body.private : false,
  );
  sendJson(ctx, 201, repoJson(repo));
}

function getRepo(ctx: Ctx, owner: string, name: string): void {
  sendJson(ctx, 200, repoJson(ctx.forge.requireRepo(owner, name)));
}

function patchRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = ctx.forge.requireRepo(owner, name);
  const body = jsonBody(ctx);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  repo.updatedAt = ctx.forge.nowIso();
  sendJson(ctx, 200, repoJson(repo));
}

function deleteRepo(ctx: Ctx, owner: string, name: string): void {
  ctx.forge.requireRepo(owner, name);
  ctx.forge.deleteRepo(owner, name);
  sendJson(ctx, 204, null);
}

// ---------------------------------------------------------------- REST: branches & refs

function listBranches(ctx: Ctx, repo: RepoRec): void {
  const branches: Array<{ name: string; commit: { sha: string } }> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
  }
  branches.sort((a, b) => (a.name < b.name ? -1 : 1));
  sendJson(ctx, 200, branches);
}

function getBranch(ctx: Ctx, repo: RepoRec, branch: string): void {
  const tip = ctx.forge.branchTip(repo, branch);
  if (tip === undefined) throw new HttpError(404, 'Branch not found');
  sendJson(ctx, 200, { name: branch, commit: { sha: tip } });
}

function listRefs(ctx: Ctx, repo: RepoRec): void {
  const refs = [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
  sendJson(ctx, 200, refs);
}

function getRef(ctx: Ctx, repo: RepoRec, ref: string): void {
  const sha = repo.refs.get(ref);
  if (sha === undefined) throw new HttpError(404, 'Not Found');
  sendJson(ctx, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
}

function createRef(ctx: Ctx, repo: RepoRec): void {
  const body = jsonBody(ctx);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/')) throw new HttpError(422, 'Validation Failed: ref must start with refs/');
  if (!repo.objects.has(sha)) throw new HttpError(422, `Validation Failed: sha ${sha} does not name an object`);
  if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  sendJson(ctx, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
}

// ---------------------------------------------------------------- REST: commits

function authorJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number.parseInt(match[3]!, 10) * 1000).toISOString() };
}

function listCommits(ctx: Ctx, repo: RepoRec): void {
  const shaParam = ctx.url.searchParams.get('sha') ?? undefined;
  const start = ctx.forge.resolveCommit(repo, shaParam === null ? undefined : shaParam);
  const commits: Array<Record<string, unknown>> = [];
  if (start !== undefined) {
    const seen = new Set<string>();
    const queue = [start];
    const ordered: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      ordered.push(current);
      const object = repo.objects.get(current);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    }
    for (const sha of ordered) {
      const object = repo.objects.get(sha)!;
      const info = parseCommit(object.data);
      commits.push({
        sha,
        commit: {
          message: info.message.replace(/\n$/, ''),
          author: authorJson(info.author),
          committer: authorJson(info.committer),
          tree: { sha: info.tree },
        },
        parents: info.parents.map((parent) => ({ sha: parent })),
      });
    }
  }
  sendJson(ctx, 200, paginate(ctx, commits));
}

// ---------------------------------------------------------------- REST: contents

function contentsGet(ctx: Ctx, repo: RepoRec, path: string): void {
  const ref = ctx.url.searchParams.get('ref') ?? undefined;
  const commit = ctx.forge.resolveCommit(repo, ref);
  if (commit === undefined) throw new HttpError(404, 'Not Found');
  const commitObject = repo.objects.get(commit)!;
  let treeSha = parseCommit(commitObject.data).tree;
  const parts = path === '' ? [] : path.split('/');
  for (let depth = 0; depth < parts.length; depth++) {
    const tree = repo.objects.get(treeSha);
    if (tree === undefined || tree.type !== 'tree') throw new HttpError(404, 'Not Found');
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[depth]);
    if (entry === undefined) throw new HttpError(404, 'Not Found');
    if (depth === parts.length - 1) {
      if (entry.mode === '40000') {
        sendJson(ctx, 200, dirListing(ctx, repo, entry.sha, path));
        return;
      }
      const blob = repo.objects.get(entry.sha);
      if (blob === undefined) throw new HttpError(404, 'Not Found');
      sendJson(ctx, 200, {
        type: 'file',
        name: entry.name,
        path,
        sha: entry.sha,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
      return;
    }
    if (entry.mode !== '40000') throw new HttpError(404, 'Not Found');
    treeSha = entry.sha;
  }
  sendJson(ctx, 200, dirListing(ctx, repo, treeSha, ''));
}

function dirListing(ctx: Ctx, repo: RepoRec, treeSha: string, prefix: string): Array<Record<string, unknown>> {
  const tree = repo.objects.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') throw new HttpError(404, 'Not Found');
  return parseTree(tree.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.objects.get(entry.sha);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.sha,
      size: blob?.data.length ?? 0,
    };
  });
}

function contentsPut(ctx: Ctx, repo: RepoRec, path: string): void {
  if (path === '') throw new HttpError(422, 'Validation Failed: a file path is required');
  const body = jsonBody(ctx);
  const content = Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64');
  const result = ctx.forge.putContent(repo, {
    branch: typeof body.branch === 'string' ? body.branch : undefined,
    path,
    content,
    message: typeof body.message === 'string' ? body.message : '',
    sha: typeof body.sha === 'string' ? body.sha : undefined,
  });
  const name = path.split('/').pop()!;
  sendJson(ctx, result.created ? 201 : 200, {
    content: { name, path, sha: result.blobSha, size: content.length, encoding: 'base64' },
    commit: { sha: result.commitSha },
  });
}

function contentsDelete(ctx: Ctx, repo: RepoRec, path: string): void {
  const body = jsonBody(ctx);
  const result = ctx.forge.deleteContent(repo, {
    branch: typeof body.branch === 'string' ? body.branch : undefined,
    path,
    message: typeof body.message === 'string' ? body.message : '',
    sha: typeof body.sha === 'string' ? body.sha : undefined,
  });
  sendJson(ctx, 200, { content: null, commit: { sha: result.commitSha } });
}

// ---------------------------------------------------------------- REST: labels

function createLabel(ctx: Ctx, repo: RepoRec): void {
  const body = jsonBody(ctx);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
  if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: name has already been taken');
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  repo.labels.set(name, { name, color });
  sendJson(ctx, 201, { name, color, description: null, default: false });
}

function listLabels(ctx: Ctx, repo: RepoRec): void {
  const labels = [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: null, default: false }));
  sendJson(ctx, 200, labels);
}

// ---------------------------------------------------------------- REST: issues & comments

function labelNamesOf(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.labels)) return [];
  const names: string[] = [];
  for (const entry of body.labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') names.push((entry as { name: string }).name);
  }
  return names;
}

function createIssue(ctx: Ctx, repo: RepoRec): void {
  const body = jsonBody(ctx);
  if (typeof body.title !== 'string' || body.title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const issue = ctx.forge.createIssue(repo, {
    title: body.title,
    body: typeof body.body === 'string' ? body.body : null,
    labels: labelNamesOf(body),
  });
  sendJson(ctx, 201, issueJson(repo, issue));
}

function listIssues(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  sendJson(ctx, 200, paginate(ctx, issues).map((issue) => issueJson(repo, issue)));
}

function requireIssue(repo: RepoRec, number: number): IssueRec {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, 'Not Found');
  return issue;
}

function patchIssue(ctx: Ctx, repo: RepoRec, number: number): void {
  const issue = requireIssue(repo, number);
  const body = jsonBody(ctx);
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string' || body.body === null) issue.body = body.body;
  if (body.labels !== undefined) {
    const names = labelNamesOf(body);
    for (const name of names) if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
    issue.labels = names;
  }
  if (body.state !== undefined) {
    if (body.state !== 'open' && body.state !== 'closed') throw new HttpError(422, 'Validation Failed: state must be open or closed');
    issue.state = body.state;
  }
  issue.updatedAt = ctx.forge.nowIso();
  sendJson(ctx, 200, issueJson(repo, issue));
}

function commentTarget(repo: RepoRec, number: number): IssueRec | PullRec {
  const issue = repo.issues.get(number);
  if (issue !== undefined) return issue;
  const pull = repo.pulls.get(number);
  if (pull !== undefined) return pull;
  throw new HttpError(404, 'Not Found');
}

function listComments(ctx: Ctx, repo: RepoRec, number: number): void {
  const target = commentTarget(repo, number);
  sendJson(ctx, 200, target.comments.map((comment) => commentJson(comment)));
}

function createComment(ctx: Ctx, repo: RepoRec, number: number): void {
  const target = commentTarget(repo, number);
  const body = jsonBody(ctx);
  if (typeof body.body !== 'string') throw new HttpError(422, 'Validation Failed: body is required');
  const comment = ctx.forge.addComment(target, body.body);
  sendJson(ctx, 201, commentJson(comment));
}

// ---------------------------------------------------------------- REST: pull requests

function refNameOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.includes(':') ? value.split(':').pop()! : value;
}

function createPull(ctx: Ctx, repo: RepoRec): void {
  const body = jsonBody(ctx);
  if (typeof body.title !== 'string' || body.title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const pull = ctx.forge.createPull(repo, {
    title: body.title,
    body: typeof body.body === 'string' ? body.body : null,
    head: refNameOf(body.head),
    base: refNameOf(body.base),
  });
  sendJson(ctx, 201, pullJson(ctx.forge, repo, pull));
}

function listPulls(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  sendJson(ctx, 200, paginate(ctx, pulls).map((pull) => pullJson(ctx.forge, repo, pull)));
}

function requirePull(repo: RepoRec, number: number): PullRec {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, 'Not Found');
  return pull;
}

function mergePullRoute(ctx: Ctx, repo: RepoRec, number: number): void {
  const pull = requirePull(repo, number);
  const body = ctx.body.length === 0 ? {} : jsonBody(ctx);
  const method = body.merge_method === 'merge' ? 'merge' : 'squash';
  const result = ctx.forge.mergePull(repo, pull, method);
  sendJson(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------- routing

function routeRepo(ctx: Ctx, owner: string, name: string, rest: string[]): void {
  const method = ctx.req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') return getRepo(ctx, owner, name);
    if (method === 'PATCH') return patchRepo(ctx, owner, name);
    if (method === 'DELETE') return deleteRepo(ctx, owner, name);
    throw new HttpError(404, 'Not Found');
  }
  const repo = ctx.forge.requireRepo(owner, name);
  const [head, ...tail] = rest as [string, ...string[]];
  if (head === 'branches') {
    if (method === 'GET' && tail.length === 0) return listBranches(ctx, repo);
    if (method === 'GET') return getBranch(ctx, repo, tail.join('/'));
  }
  if (head === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) return createRef(ctx, repo);
    if (method === 'GET' && tail.length === 1) return listRefs(ctx, repo);
    if (method === 'GET') return getRef(ctx, repo, `refs/${tail.slice(1).join('/')}`);
  }
  if (head === 'commits' && method === 'GET' && tail.length === 0) return listCommits(ctx, repo);
  if (head === 'contents') {
    const path = tail.join('/');
    if (method === 'GET') return contentsGet(ctx, repo, path);
    if (method === 'PUT') return contentsPut(ctx, repo, path);
    if (method === 'DELETE') return contentsDelete(ctx, repo, path);
  }
  if (head === 'labels') {
    if (method === 'POST' && tail.length === 0) return createLabel(ctx, repo);
    if (method === 'GET' && tail.length === 0) return listLabels(ctx, repo);
  }
  if (head === 'issues') {
    if (method === 'POST' && tail.length === 0) return createIssue(ctx, repo);
    if (method === 'GET' && tail.length === 0) return listIssues(ctx, repo);
    const number = Number.parseInt(tail[0] ?? '', 10);
    if (Number.isFinite(number)) {
      if (method === 'GET' && tail.length === 1) return sendJson(ctx, 200, issueJson(repo, requireIssue(repo, number)));
      if (method === 'PATCH' && tail.length === 1) return patchIssue(ctx, repo, number);
      if (method === 'GET' && tail[1] === 'comments') return listComments(ctx, repo, number);
      if (method === 'POST' && tail[1] === 'comments') return createComment(ctx, repo, number);
    }
  }
  if (head === 'pulls') {
    if (method === 'POST' && tail.length === 0) return createPull(ctx, repo);
    if (method === 'GET' && tail.length === 0) return listPulls(ctx, repo);
    const number = Number.parseInt(tail[0] ?? '', 10);
    if (Number.isFinite(number)) {
      if (method === 'GET' && tail.length === 1) return sendJson(ctx, 200, pullJson(ctx.forge, repo, requirePull(repo, number)));
      if (method === 'GET' && tail[1] === 'files') {
        const files = ctx.forge.pullFiles(repo, requirePull(repo, number));
        return sendJson(ctx, 200, files);
      }
      if (method === 'PUT' && tail[1] === 'merge') return mergePullRoute(ctx, repo, number);
    }
  }
  throw new HttpError(404, 'Not Found');
}

function routeGit(ctx: Ctx, owner: string, repoSegment: string, rest: string[]): void {
  const method = ctx.req.method ?? 'GET';
  const name = repoSegment.slice(0, -'.git'.length);
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  const protocolV2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = ctx.url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(400, 'Unsupported service');
    return sendRaw(ctx, infoRefs(repo, service, protocolV2));
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    return sendRaw(ctx, uploadPack(repo, ctx.body, protocolV2));
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    return sendRaw(ctx, receivePack(repo, ctx.body));
  }
  throw new HttpError(404, 'Not Found');
}

function route(ctx: Ctx): void {
  const method = ctx.req.method ?? 'GET';
  const segments = ctx.url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));

  if (segments.length === 1 && segments[0] === 'healthz') {
    return sendJson(ctx, 200, { ok: true });
  }

  // Authentication: everything except /healthz needs the shop token. When
  // the process was started without one (local development), a presented
  // token still has to be the empty one — i.e. absent.
  const presented = ctx.req.headers.authorization;
  if (ctx.token !== '') {
    if (presented !== `Bearer ${ctx.token}`) throw new HttpError(401, 'Bad credentials');
  } else if (presented !== undefined && presented !== 'Bearer ') {
    throw new HttpError(401, 'Bad credentials');
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (segments.length === 2) {
      if (method !== 'GET') throw new HttpError(404, 'Not Found');
      const host = ctx.req.headers.host ?? 'localhost';
      return sendJson(
        ctx,
        200,
        {
          current_user_url: `http://${host}/api/v3/user`,
          repository_url: `http://${host}/api/v3/repos/{owner}/{repo}`,
          issue_url: `http://${host}/api/v3/repos/{owner}/{repo}/issues`,
        },
        { 'x-oauth-scopes': OAUTH_SCOPES },
      );
    }
    if (segments.length === 3 && segments[2] === 'meta' && method === 'GET') {
      return sendJson(ctx, 200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: false });
    }
    if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
      return sendJson(ctx, 200, { ...userJson(VIEWER.login, VIEWER.id), name: VIEWER.name, email: VIEWER.email });
    }
    if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
      if (method === 'POST') return createRepo(ctx);
      if (method === 'GET') {
        const repos = ctx.forge.listRepos(VIEWER.login);
        return sendJson(ctx, 200, paginate(ctx, repos).map((repo) => repoJson(repo)));
      }
    }
    if (segments.length >= 5 && segments[2] === 'repos') {
      return routeRepo(ctx, segments[3]!, segments[4]!, segments.slice(5));
    }
    throw new HttpError(404, 'Not Found');
  }

  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') throw new HttpError(404, 'Not Found');
    const reply = handleGraphQL(ctx.forge, ctx.body.toString('utf8'));
    ctx.res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'x-github-request-id': ctx.forge.nextRequestId() });
    ctx.res.end(reply.body);
    return;
  }

  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method !== 'POST') throw new HttpError(404, 'Not Found');
    const reply = handleMcp(ctx.forge, ctx.body.toString('utf8'));
    if (reply.body === '') {
      ctx.res.writeHead(reply.status, { 'x-github-request-id': ctx.forge.nextRequestId() });
      ctx.res.end();
      return;
    }
    ctx.res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'x-github-request-id': ctx.forge.nextRequestId() });
    ctx.res.end(reply.body);
    return;
  }

  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    return routeGit(ctx, segments[0]!, segments[1]!, segments.slice(2));
  }

  throw new HttpError(404, 'Not Found');
}

/** Build the HTTP server for a forge. The lifecycle lives in main.ts. */
export function createForgeServer(forge: Forge, token: string): Server {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const ctx: Ctx = {
        forge,
        token,
        req,
        res,
        url: new URL(req.url ?? '/', 'http://localhost'),
        body: Buffer.concat(chunks),
      };
      try {
        route(ctx);
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof HttpError) {
          sendJson(ctx, error.status, { message: error.message });
        } else {
          console.error('unhandled request error', error);
          sendJson(ctx, 500, { message: 'Internal Server Error' });
        }
      }
    });
    req.on('error', () => {
      if (!res.headersSent) sendJson({ forge, token, req, res, url: new URL('/', 'http://localhost'), body: Buffer.alloc(0) }, 400, { message: 'Bad Request' });
    });
  });
  return server;
}

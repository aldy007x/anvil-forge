// demo.mjs — an end-to-end walkthrough of the forge, offline.
//
// Boots the entry against the stub harness (tools/stubenv.mjs), then drives
// one full story through every surface: create a repository, write files
// with the contents API, branch, open an issue, comment, open a pull
// request, read its file diff, squash-merge it, verify the merged content —
// then cross-check the same objects over GraphQL and MCP, and finally push
// and clone with the real `git` binary when one is on PATH.
//
// Run it twice: the summary lines are identical, because the forge's clock
// is deterministic. Usage: node tools/demo.mjs

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'demo-token';
const results = [];
let failures = 0;

function check(label, condition, extra = '') {
  results.push(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === '' ? '' : ` — ${extra}`}`);
  if (!condition) failures += 1;
}

function waitForStdout(child, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = pattern.exec(buffer);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match);
      }
    });
  });
}

async function until(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const stub = spawn(process.execPath, [join(ROOT, 'tools/stubenv.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });

try {
  const stubPort = Number((await waitForStdout(stub, /STUBENV_PORT (\d+)/))[1]);
  const entry = spawn(process.execPath, ['--experimental-strip-types', 'main.ts'], {
    cwd: ROOT,
    env: { ...process.env, MAKEFUN_SHOP_TOKEN: TOKEN, MAKEFUN_ENV_URL: `http://127.0.0.1:${stubPort}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const registered = await until(async () => {
      const answer = await fetch(`http://127.0.0.1:${stubPort}/port`);
      const body = await answer.json();
      return typeof body.port === 'number' ? body.port : null;
    });
    const base = `http://127.0.0.1:${registered}`;
    const api = async (method, path, body, token = TOKEN) => {
      const answer = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await answer.text();
      return { status: answer.status, json: text === '' ? null : JSON.parse(text), headers: answer.headers };
    };
    const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

    // --- boot & protocol surface
    const health = await api('GET', '/healthz', undefined, '');
    check('healthz answers without auth', health.status === 200 && health.json.ok === true);
    const root = await api('GET', '/api/v3');
    check('REST root carries the OAuth scopes header', root.headers.get('x-oauth-scopes') === 'repo, read:org');
    const refused = await api('GET', '/api/v3/user', undefined, 'wrong-token');
    check('a wrong token is a JSON 401', refused.status === 401 && typeof refused.json.message === 'string');

    // --- repository + contents
    const repo = await api('POST', '/api/v3/user/repos', { name: 'demo-forge', private: false, description: 'demo repository' });
    check('repository created', repo.status === 201 && repo.json.default_branch === 'main', `id ${repo.json.id}`);
    const R = '/api/v3/repos/adaiversen/demo-forge';
    const readme = await api('PUT', `${R}/contents/README.md`, { message: 'add readme', content: b64('# demo-forge\n') });
    check('first contents write lands on the unborn default branch', readme.status === 201);
    const configV1 = await api('PUT', `${R}/contents/config/app.css`, { message: 'add stylesheet', content: b64('body { color: black; }\n') });
    check('nested file created', configV1.status === 201);
    const readBack = await api('GET', `${R}/contents/config/app.css`);
    check('contents read-back decodes to the same bytes', Buffer.from(readBack.json.content, 'base64').toString() === 'body { color: black; }\n');
    const stale = await api('PUT', `${R}/contents/config/app.css`, { message: 'sneaky update', content: b64('body { color: red; }\n') });
    check('update without the current sha is a 409', stale.status === 409);

    // --- branch, issue, pull request, merge
    const branch = await api('POST', `${R}/git/refs`, { ref: 'refs/heads/recolor', sha: configV1.json.commit.sha });
    check('branch created through the git refs API', branch.status === 201);
    const recolor = await api('PUT', `${R}/contents/config/app.css`, { message: 'recolor', content: b64('body { color: green; }\n'), branch: 'recolor', sha: configV1.json.content.sha });
    check('update on the branch with the right sha is a 200', recolor.status === 200);
    const label = await api('POST', `${R}/labels`, { name: 'bug', color: 'd73a4a' });
    check('label created', label.status === 201);
    const issue = await api('POST', `${R}/issues`, { title: 'The stylesheet should be green', body: 'Black is too dark.', labels: ['bug'] });
    check('issue created with its label', issue.status === 201 && issue.json.number === 1 && issue.json.labels[0].name === 'bug');
    const comment = await api('POST', `${R}/issues/1/comments`, { body: 'Working on it in the recolor branch.' });
    check('comment posted', comment.status === 201 && comment.json.id >= 1);
    const pull = await api('POST', `${R}/pulls`, { title: 'Recolor the stylesheet', body: 'Fixes the issue.', head: 'recolor', base: 'main' });
    check('pull request opened', pull.status === 201 && pull.json.head.ref === 'recolor' && pull.json.base.ref === 'main');
    const files = await api('GET', `${R}/pulls/${pull.json.number}/files`);
    check('pull request files show the stylesheet change', files.json.length === 1 && files.json[0].filename === 'config/app.css' && files.json[0].status === 'modified');
    const merged = await api('PUT', `${R}/pulls/${pull.json.number}/merge`, { merge_method: 'squash' });
    check('squash merge succeeds', merged.status === 200 && merged.json.merged === true);
    const after = await api('GET', `${R}/pulls/${pull.json.number}`);
    check('merged pull reads closed with a merge sha', after.json.state === 'closed' && after.json.merged === true && after.json.merge_commit_sha === merged.json.sha);
    const onMain = await api('GET', `${R}/contents/config/app.css?ref=main`);
    check('merged content is on the default branch', Buffer.from(onMain.json.content, 'base64').toString() === 'body { color: green; }\n');

    // --- GraphQL sees the same objects
    const gql = async (query, variables) => {
      const answer = await fetch(`${base}/api/graphql`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      return answer.json();
    };
    const viewer = await gql('{ viewer { login } }');
    check('GraphQL viewer is the token owner', viewer.data.viewer.login === 'adaiversen');
    const gqlIssue = await gql(
      'mutation ($input: CreateIssueInput!) { createIssue(input: $input) { issue { number title } } }',
      { input: { repositoryId: (await gql('{ repository(owner: "adaiversen", name: "demo-forge") { id } }')).data.repository.id, title: 'GraphQL-made issue' } },
    );
    check('GraphQL createIssue lands in the shared store', gqlIssue.data.createIssue.issue.title === 'GraphQL-made issue');
    const restIssues = await api('GET', `${R}/issues?state=all`);
    check('REST lists the GraphQL issue too', restIssues.json.some((entry) => entry.title === 'GraphQL-made issue'));

    // --- MCP sees the same objects
    const rpc = async (method, params, id) => {
      const answer = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      return answer.json();
    };
    const discover = await rpc('server/discover', {}, 1);
    check('MCP server/discover names the current revision', discover.result.supportedVersions.includes('2026-07-28'));
    const mcpTools = await rpc('tools/list', {}, 2);
    check('MCP lists the six forge tools', ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((name) => mcpTools.result.tools.some((t) => t.name === name)));
    const mcpIssue = await rpc('tools/call', { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'demo-forge', title: 'MCP-made issue' } }, 3);
    check('MCP create_issue lands in the shared store', mcpIssue.result.structuredContent.title === 'MCP-made issue');

    // --- real git: push and clone
    let gitAvailable = true;
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      gitAvailable = false;
    }
    if (gitAvailable) {
      const work = mkdtempSync(join(tmpdir(), 'anvil-demo-'));
      try {
        const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${TOKEN}` };
        execFileSync('git', ['clone', '-q', `${base}/adaiversen/demo-forge.git`, join(work, 'clone')], { env, stdio: 'pipe' });
        const cloned = execFileSync('git', ['-C', join(work, 'clone'), 'log', '--format=%s', 'main'], { encoding: 'utf8' });
        check('real git clones the forge repository', cloned.includes('Recolor the stylesheet') && cloned.includes('add stylesheet'));
        writeFileSync(join(work, 'clone', 'pushed.txt'), 'pushed by real git\n');
        execFileSync('git', ['-C', join(work, 'clone'), 'config', 'user.email', 'adaiversen@example.invalid']);
        execFileSync('git', ['-C', join(work, 'clone'), 'config', 'user.name', 'ada iversen']);
        execFileSync('git', ['-C', join(work, 'clone'), 'add', '-A']);
        execFileSync('git', ['-C', join(work, 'clone'), 'commit', '-qm', 'push from the demo']);
        execFileSync('git', ['-C', join(work, 'clone'), 'push', '-q', 'origin', 'main'], { env, stdio: 'pipe' });
        const commits = await api('GET', `${R}/commits`);
        check('the real-git push is visible over REST', commits.json.some((entry) => entry.commit.message === 'push from the demo'));
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    } else {
      results.push('SKIP real git interop (no git binary on PATH)');
    }

    // --- shutdown: the harness says done, the entry exits 0
    const exitCode = new Promise((resolve) => entry.on('exit', (code) => resolve(code)));
    await fetch(`http://127.0.0.1:${stubPort}/finish`);
    check('entry exits 0 when the trial ends', (await exitCode) === 0);
  } finally {
    entry.kill('SIGKILL');
  }
} finally {
  stub.kill('SIGKILL');
}

for (const line of results) console.log(line);
console.log(failures === 0 ? `DEMO OK (${results.length} checks)` : `DEMO FAILED (${failures} of ${results.length})`);
process.exit(failures === 0 ? 0 : 1);

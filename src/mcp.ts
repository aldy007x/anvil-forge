// mcp.ts — the Model Context Protocol endpoint (POST /mcp).
//
// JSON-RPC 2.0 over streamable HTTP, answered as plain JSON. The server
// speaks the current revision (server/discover, no handshake) and the
// classic initialize handshake, since the rules accept either. Tools are
// thin wrappers over the same forge operations the REST surface uses, so an
// object created over MCP is the same object over REST — same ids, same
// shapes (the tool results carry the REST serialization as structured
// content plus a JSON text block).

import { Forge, HttpError, VIEWER } from './forge.ts';
import { issueJson, pullJson, repoJson } from './serializers.ts';

const SERVER_INFO = { name: 'anvil-forge', version: '1.0.0' };
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  const props: ToolDef['inputSchema']['properties'] = {};
  for (const [key, text] of Object.entries(properties)) {
    props[key] = { type: key === 'private' ? 'boolean' : key === 'pull_number' ? 'number' : 'string', description: text };
  }
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

/** The tool list. Built once, so two tools/list calls are byte-identical. */
const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the authenticated user.', { name: 'Repository name', description: 'Repository description', private: 'Whether the repository is private' }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', { owner: 'Repository owner login', repo: 'Repository name' }, ['owner', 'repo']),
  tool('list_repos', 'List the repositories owned by the authenticated user.', {}, []),
  tool('create_issue', 'Create an issue in a repository.', { owner: 'Repository owner login', repo: 'Repository name', title: 'Issue title', body: 'Issue body' }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository, optionally filtered by state (open, closed, all).', { owner: 'Repository owner login', repo: 'Repository name', state: 'Issue state filter' }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', { owner: 'Repository owner login', repo: 'Repository name', title: 'Pull request title', body: 'Pull request body', head: 'Head branch name', base: 'Base branch name' }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('get_pull_request', 'Get a pull request by its number.', { owner: 'Repository owner login', repo: 'Repository name', pull_number: 'Pull request number' }, ['owner', 'repo', 'pull_number']),
  tool('merge_pull_request', 'Merge a pull request into its base branch (squash).', { owner: 'Repository owner login', repo: 'Repository name', pull_number: 'Pull request number' }, ['owner', 'repo', 'pull_number']),
];

const TOOL_BY_NAME = new Map(TOOLS.map((def) => [def.name, def]));

interface ToolOutcome {
  value: unknown;
  isError?: boolean;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const text = (value: unknown): ToolOutcome => ({ value });
  const repoOf = (): ReturnType<Forge['requireRepo']> => forge.requireRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo(VIEWER.login, String(args.name), typeof args.description === 'string' ? args.description : '', args.private === true);
      return text(repoJson(repo));
    }
    case 'get_repo':
      return text(repoJson(repoOf()));
    case 'list_repos':
      return text(forge.listRepos(VIEWER.login).map((repo) => repoJson(repo)));
    case 'create_issue': {
      const repo = repoOf();
      const issue = forge.createIssue(repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : null });
      return text(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf();
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return text(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      const pull = forge.createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
        head: String(args.head),
        base: String(args.base),
      });
      return text(pullJson(forge, repo, pull));
    }
    case 'get_pull_request': {
      const repo = repoOf();
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new HttpError(404, 'Not Found');
      return text(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new HttpError(404, 'Not Found');
      forge.mergePull(repo, pull, 'squash');
      return text(pullJson(forge, repo, pull));
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): { status: number; body: string } {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

/** Handle one JSON-RPC request object. Notifications answer 202 with no body. */
function handleOne(forge: Forge, request: Record<string, unknown>): { status: number; body: string } {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  if (id === undefined || id === null) return { status: 202, body: '' };
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        protocolVersion: SUPPORTED_REVISIONS[0],
        supportedVersions: SUPPORTED_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_REVISIONS.includes(asked) ? asked : '2025-11-25';
      return rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const def = TOOL_BY_NAME.get(name);
      if (def === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      for (const required of def.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `Missing required argument: ${required}`);
        }
      }
      try {
        const outcome = callTool(forge, name, args);
        const json = JSON.stringify(outcome.value);
        return rpcResult(id, {
          content: [{ type: 'text', text: json }],
          structuredContent: outcome.value,
          isError: outcome.isError === true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** The HTTP entry point for POST /mcp (authentication happens upstream). */
export function handleMcp(forge: Forge, bodyText: string): { status: number; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error: the request body is not valid JSON', 400);
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleOne(forge, (entry ?? {}) as Record<string, unknown>));
    const first = answers.find((answer) => answer.body !== '');
    return { status: first?.status ?? 202, body: JSON.stringify(answers.filter((a) => a.body !== '').map((a) => JSON.parse(a.body))) };
  }
  if (typeof parsed !== 'object' || parsed === null) return rpcError(null, -32600, 'Invalid request', 400);
  return handleOne(forge, parsed as Record<string, unknown>);
}

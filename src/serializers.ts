// serializers.ts — how forge records look on the wire.
//
// REST, MCP tool results and the test fixtures all read the same shapes, so
// the shapes live in exactly one place. Pull request head/base shas are read
// live from the branch tips (falling back to the creation snapshot when a
// branch has since been deleted), which keeps every surface in agreement
// after pushes and merges move the branches.

import { VIEWER, type CommentRec, type Forge, type IssueRec, type PullRec, type RepoRec } from './forge.ts';
import { peelToCommit } from './gitcore.ts';

export function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', site_admin: false };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
    owner: userJson(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 0),
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    fork: false,
    archived: false,
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: null, default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(VIEWER.login, VIEWER.id),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  const headSha = headTip === undefined ? pull.headShaAtCreate : peelToCommit(repo.objects, headTip);
  const baseSha = baseTip === undefined ? pull.baseShaAtCreate : peelToCommit(repo.objects, baseTip);
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

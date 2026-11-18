# anvil-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aldy007x/anvil-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aldy007x/anvil-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge core in a single Node process, standard
library only. One in-memory store backs four surfaces, so an object is the
same object everywhere it appears:

- **Git smart HTTP** — protocol v0 and v2 advertisements, `ls-refs`,
  fetch (with shallow/deepen semantics and pack generation), and push
  (pack parsing with delta resolution, fast-forward enforcement, per-ref
  report-status).
- **REST v3** — repositories, branches and git refs, commits, the contents
  API, labels, issues with comments, and pull requests with file diffs and
  squash/merge merges.
- **GraphQL** — a small real executor (variables, aliases, inline
  fragments, input objects, batched operations) covering viewer/repository/
  issue/pullRequest queries, connections with cursors, introspection, and
  the createIssue / closeIssue / createPullRequest / mergePullRequest /
  addComment mutations.
- **MCP** — JSON-RPC tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`, …) over
  streamable HTTP, speaking both `server/discover` and the classic
  `initialize` handshake.

Git objects are content-addressed SHA-1 exactly as in git; merges use a
file-level three-way merge against the merge base. Timestamps derive from
`MAKEFUN_TRIAL_NOW` when the harness provides it, so a replayed request
sequence produces identical answers.

## Run it

```sh
node main.ts
```

The process expects the trial harness environment: it reads
`MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`, binds an ephemeral port,
registers the port with the harness, serves until the harness reports the
trial done, and exits 0.

---

<sub>Entered on [make.fun](https://make.fun/?ref=aldy007x&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

# git-forge-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sudoRmMyLife/git-forge-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sudoRmMyLife/git-forge-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only. It serves git smart HTTP (protocol v2 ls-refs and fetch with shallow support, v0 fetch, and receive-pack with report-status over sideband), the GitHub REST v3 API (repositories, branches, commits, the contents API, labels, issues, comments and pull requests with squash and merge merges), the GraphQL v4 documents that `gh` and github-mcp-server send (repository and issue reads, pull requests, the create/close/merge mutations, `__type` introspection, `node(id:)` and batched operations), and a Model Context Protocol endpoint (server/discover plus the legacy initialize handshake, with create_repo, get_repo, create_issue, list_issues, create_pull_request and merge_pull_request tools). All four surfaces share one in-memory store and one git object model: objects are stored by their real SHA-1, packs are read and written byte-exactly (delta resolution included), and a repository created over REST can be pushed to, cloned, queried over GraphQL and driven from MCP without translation layers.

Layout: `main.ts` is the harness lifecycle (bind an ephemeral port, register with the env, wait for done); `app.ts` routes the surfaces; `store.ts` holds the store, the git object model and the pack machinery; `git.ts` is smart HTTP; `rest.ts` is REST v3 plus the shared serializers and merge engine; `graphql.ts` is the GraphQL parser and executor; `mcp.ts` is the MCP endpoint.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=2tnm35pq&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

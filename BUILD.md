# Build plan — github-core-clone-01

Prize bar: score strictly above the house reference forge (a statistical tie loses). Score =
feature checks 600 + agent-native (MCP) 200 + performance 200 (four timed workloads vs the
reference's medians: 200 pushes of 1 KiB, 50 concurrent depth-1 clones of a 200-commit repo,
2,000 issue reads on one keep-alive connection, 200 issue writes).

## Done in this scaffold (2026-11-16)

- Repo started with the kit's `makefun init` (drand anchor round 33992574) + MIT license.
- `main.ts`: the kit starter's entry↔env lifecycle, unchanged (register, poll /done, exit 0).
- `lib/store.ts`: in-memory store; git-shaped blob/commit identities (sha1 over the real git
  object formats); logical clock — no wall clock or randomness in any id, so replays agree.
- `app.ts`: REST v3 over the store — root + meta + user, repositories (create/list with Link
  pagination/get/patch/delete), git/refs + branches + commits, contents (PUT 201/200/409,
  GET file or directory listing, DELETE), labels, issues (422 on unknown label, filters,
  comments), pull requests (create/list/get/files, squash merge). Bearer auth (401 without the
  token), owner mismatch = 404, malformed JSON = 400, unknown route = JSON 404,
  X-GitHub-Request-Id on every reply.

## Next phases, in order

1. **Git object layer** (`lib/git.ts`): loose objects + pack read/write (zlib via node:zlib),
   tree/commit parsing, ref advertisement. Smart HTTP: `/{owner}/{repo}.git/info/refs`,
   upload-pack protocol v2 (ls-refs, fetch with shallow depth=1) and v0 fallback with
   side-band-64k, receive-pack v0 (report-status, delete-refs, fast-forward-only with per-ref
   `ng non-fast-forward`). The clone workload (50 concurrent depth-1) makes pack generation
   the performance-critical path: cache packs per (tip, depth) — a shallow clone of an
   unchanged tip is the same bytes every time.
2. **GraphQL v4** (`lib/graphql.ts`): a small executor over the store for the documents gh and
   github-mcp-server send — viewer, repository (issue/issues with orderBy CREATED_AT DESC and
   states filter, pullRequest/pullRequests), createPullRequest mutation, introspection for
   Issue/PullRequest/Repository/SearchType, batched operations, unknown-field errors array,
   unknown repository = data.repository null.
3. **MCP** (`lib/mcp.ts`): streamable HTTP JSON-RPC; server/discover (revision 2026-07-28) or
   initialize handshake; the six tools (create_repo, get_repo, create_issue, list_issues,
   create_pull_request, merge_pull_request) acting on the same store; byte-identical
   tools/list; -32602/-32601/-32700 semantics; 3 s per request.
4. **Performance pass**: keep-alive issue reads are a Map lookup + JSON — keep bodies small and
   pre-shaped; issue writes append-only; pushes: receive-pack must apply 1 KiB changes without
   rewriting history (append the object, move the ref).

## Open questions to settle with grade-local against the practice trials

- **Viewer login**: the trial never hands the forge the viewer's login (the token is an opaque
  `shpat_…`). The scaffold adopts the first owner login asked about a held repository. Verify
  against the suite's call order: if GraphQL `viewer{login}` is checked before any repo-scoped
  path, another channel must exist (inspect a failing practice run's requests).
- Exact response shapes the checkers require beyond the RULES.txt contract (labels as objects
  vs names on issues; head/base as `{ref}` objects on pulls) — read failures, adjust.
- Merge conflict rule: the scaffold squash-merges unconditionally; the suite expects 405 for a
  conflicted pull. Implement merge-base tracking (record base tip at PR creation; conflict when
  both sides changed the same path since) once git history exists.
- Contents on an unborn repository: the REST checks PUT the first commit into a repo with no
  commits — the scaffold's branch map handles it (branch appears at first commit).

## Submission hygiene

- ≤5 submissions/day, ≤10 total; deadline 2026-11-21 13:30 WIB. Submit only when grade-local
  shows a credible score; the last receipt before the deadline is final.
- Bundle with the full run record (harness/version/provider/model/effort) — required for
  entries received after 2026-11-17 00:00 UTC.
- README badges + GitHub About for this competition must be set before submitting (the
  aggregator entry was refused once for exactly this; it does not consume quota, but do it
  first anyway).

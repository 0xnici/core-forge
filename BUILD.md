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

## Build completed (2026-11-16, second session)

All four phases below are DONE and verified end to end:

- **Git layer** (`lib/git.ts` + `lib/git-http.ts`): real nested git objects and packfiles
  (plain packs out; OFS_DELTA/REF_DELTA + thin-pack bases resolved on the way in; the zlib
  stream length is found by binary search because Node 24's sync zlib does not report input
  consumption). Smart HTTP: v2 advertisement + ls-refs (strict prefix filtering, unborn HEAD)
  + fetch (held-set closure with shallow-edge cuts, generation-depth shallowing, ACK/NAK,
  acknowledgments only when the client did not send `done`), v0 fetch fallback, receive-pack
  with per-ref fast-forward enforcement (`ng … non-fast-forward`), create/delete refs.
  Verified against the real git 2.43 client: push (create/FF/delete/non-FF), clone v0 + v2,
  shallow clone, deepen, incremental fetch. The store now holds real trees, so contents,
  commits and pull diffs all read the same objects git pushed.
- **GraphQL** (`lib/graphql.ts`): a small parser + typed executor — variables, aliases, inline
  fragments, input objects, batched operations, Relay global ids (base64 `Type:seq`),
  `node(id:)`, issues connection with states filter + CREATED_AT order + cursor pagination,
  the five mutations interoperating with REST, `__type` introspection for the probed types,
  unknown field → 200 with an `errors` array naming it, unknown repository → null, no errors.
- **MCP** (`lib/mcp.ts`): `server/discover` (2026-07-28) and legacy `initialize`, the six
  tools over the shared store via `lib/ops.ts`, a constant tools array (byte-identical
  tools/list), structuredContent + text results, -32700 with HTTP 400 on unparseable bodies,
  -32601 unknown method, -32602 unknown tool, notifications → 202.
- **Domain ops** (`lib/ops.ts`): one implementation of repo/issue/pull JSON and of create /
  merge for all three surfaces; pull merges are three-way squashes off the base point recorded
  at creation, with the both-sides-changed-same-path rule answering 405.
- **REST fixes the suite pinned down**: pull JSON carries current head/base tips and
  `merged_at`/`merge_commit_sha`; issue/pull `body` is always a string; duplicate repo create
  is a 422 whose body says "already exists"; pagination Link URLs are absolute on the
  request's own origin; repositories start with NO labels (the suite creates its fixture
  label via POST /labels and expects 201 — seeding GitHub's defaults broke every issue
  check until this was removed).

### Local grade (kit grade-local, process driver, this machine)

| column | score | note |
| --- | --- | --- |
| feature | 600/600 | **120/120 conformance checks pass** |
| agent (MCP) | 200/200 | 15/15 |
| perf | 181/200 | push 44, clone 43, read 50, write 44 |
| **total** | **981/1000** | house reference ≈ 900 (120/120 + ~100 perf) |

Workload medians vs the house reference medians (T_ref): push 574 ms vs 1641 ms,
clone 96 ms vs 267 ms, read 639 ms vs 2760 ms, write 123 ms vs 349 ms — 2.8–4.3× faster
on every workload, so the margin over the house bar is ~+81 points and does not depend on
any single workload. Replay determinism: the grade-local cassette/state hashes are stable
across runs (logical clock everywhere; no wall clock or unseeded randomness in state).

## Submission hygiene

- ≤5 submissions/day, ≤10 total; deadline 2026-11-21 13:30 WIB. Submit only when grade-local
  shows a credible score; the last receipt before the deadline is final.
- Bundle with the full run record (harness/version/provider/model/effort) — required for
  entries received after 2026-11-17 00:00 UTC.
- README badges + GitHub About for this competition must be set before submitting (the
  aggregator entry was refused once for exactly this; it does not consume quota, but do it
  first anyway).

## Submission status (2026-11-16 ~06:35 WIB) — NOT YET SUBMITTED, packaging gates remain

- Code state: commit `0727c04` (this BUILD.md update rides one commit on top; submit the
  HEAD of `main` on https://github.com/Dimzy14/core-forge). Quota used: **0 of 10**.
- grade-local (process driver): **981/1000, 120/120 checks** — credibly above the ~900
  house bar, so the entry SHOULD be submitted once the bundle check is green.
- `makefun check` on the subagent-built bundle (`forge-transcripts.tar.gz`): **14 passed,
  2 failed** — both failures are transcript-packaging gates, not code:
  1. `thinking_priced`: 0 usage rows attached. The bundled sessions are the two subagents
     (337405f6…, e78cbf96…); a subagent's usage rows are written only when its run
     completes. Remedy (the kit's own prescribed flow): the top-level agent re-runs the
     PLACEHOLDER §1 SELECT for agent ids `d3f9c810-e7ec-4d44-8c1d-7acc5e45e664`,
     `337405f6-52c5-4b16-8f85-729788d8285b`, `e78cbf96-0c39-4ab9-aeba-a73b48d3e1ad`,
     merges the rows into `~/workspace/makefun/submission/forge-usage.jsonl`
     (221 rows for other agents are already staged there), re-bundles from its own
     session (so the parent session is discovered too) and re-checks.
  2. `thinking_reproduces`: the entrypoint `main.ts` has 0 authored lines — it is the kit
     starter's lifecycle file, arrived via `makefun init` and deliberately kept unchanged,
     so its lines first appear as tool output in every bundled session. Remedy per the
     check's own fix text: in a bundled session, the agent writes `main.ts` again with its
     exact current content (a write, not a read); if the class still does not flip, bundle
     with `--session` limited to the parent session + 337405f6 (the session that authored
     app.ts and lib/*).
- After both: `submit --competition github-core-clone-01 --repo-url
  https://github.com/Dimzy14/core-forge --commit <HEAD sha> --bundle
  ~/workspace/makefun/submission/forge-transcripts.tar.gz --keypair
  ~/workspace/makefun/kit/makefun-keypair.json`.

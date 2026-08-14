# Proof of Work


An application asset, not a client gig. It exists to close two gaps at once, Airtable and n8n, by
building something real on both, and to be the strongest exhibit attached to an AI Product Engineer
application. Full design: `docs/DESIGN.md`.

Airtable is the DATABASE and n8n is the BACKEND. Zapier was evaluated for the notification step and cut
before v2 because n8n already had the trigger, the branching and the code nodes; there is no
notification step and no `zapier/` directory. Say this correctly anywhere a reader will see it — the
seed's own project summary claimed "one Zap sends the notification" long after the Zap was removed, and
that stale sentence is what a client-facing note was then written from.

Global standards load from `~/.claude/CLAUDE.md`.

## Non-negotiables

- **Seven tables, and no JSON blobs.** The rule is legibility, not a count: serialising structure into a
  long-text field to avoid a table disables everything Airtable is for. Candidates earned the seventh
  tab the same way Results earned the sixth — a person is real structure, not a property dodging a tab.
  `tests/schema-parity.test.ts` pins the count and fails on a field whose name or description mentions
  JSON.
- **The Gaps section stays.** It is the load-bearing claim. A scoring system that only reports its hits is
  a flattery generator and a reader can tell. `tests/vocabulary.test.ts` enforces it.
- **The evidence gate stays.** A capability with no linked evidence can never score proven.
  `tests/evidence-gate.test.ts` pins it at a perfect 1.0 match score.
- **Weighing can only lower a verdict.** Every requirement is resolved twice — once with no model,
  once with the weighing model's numbers — and the worse status wins (`worseOf`). There is no channel
  by which a model raises a score. `tests/judge.test.ts` attacks the app lane with the reply a
  dishonest model would send and `tests/workflow-rationale.test.ts` attacks the n8n lane the same way;
  DESIGN.md §v3.8 has the reasoning.
- **Both lanes run the same rules, and it is proven by running them.** Every decision rule lives in
  `src/pipeline/portable.ts`, which `n8n/build.ts` type-strips and emits into the Code nodes, so a
  workflow does not contain a copy of a rule — it contains the rule. `tests/workflow-parity.test.ts`
  lifts the JavaScript out of the COMMITTED json and compares it to the app's own functions;
  `tests/workflow-rationale.test.ts` executes whole nodes. The drift check alone cannot see this: it
  compares committed json to what build.ts regenerates, which is build.ts against itself.
- **Every number traces to a real artifact.** `tests/seed-integrity.test.ts` transcribes the metrics by
  hand from the portfolio ledger and compares. A wrong test count is worse than no test count.
- **Generic vocabulary.** Candidate, Evidence, Coverage, record. Never "my skills", "About me", "resume".
  `tests/vocabulary.test.ts` greps the UI source.
- **Never a silent fallback.** Every degradation is visible in the header and in `pnpm doctor`.

## Stack and commands

- React 19 + TypeScript + Vite. Hand-written CSS, no framework. Two runtime dependencies.
- Install: `pnpm install`
- Run: `pnpm dev` (port 5273)
- Test: `pnpm test` (439 passing across 19 files, 3 skipped behind `LIVE_OPENROUTER=1`)
- Typecheck: `pnpm typecheck`
- Everything: `pnpm verify` (typecheck, tests, n8n drift check)
- Credentials: `pnpm doctor`
- Workflows: `pnpm n8n:build` / `pnpm n8n:build --check`
- Airtable: `pnpm airtable:provision` then `pnpm airtable:push`

## Where things live

- `raw/` — 12 committed artifacts. Stage 0, deliberately messy.
- `src/openrouter/` — protocol (model tiers, both traps), schemas, chat client, embeddings.
- `src/pipeline/` — **portable** (every rule both lanes run; read its header before editing), extract,
  resume (paste-a-resume intake), validate, link, match, judge (weighing, §v3.8), jd, score, rationale,
  index (orchestrator). `text.ts` is gone: it held exactly the six functions that moved to portable.
- `src/store/` — types (the seven tables), seed, local adapter, Airtable adapter, mode detection.
- `src/server/handlers.ts` — the `/api` surface, mounted by a Vite plugin in `vite.config.ts`. Holds
  `POW_APP_TOKEN` and proxies to the n8n webhooks; the browser never sees the secret.
- `src/ui/` — App, Applicants (landing: roster + resume intake), Score (the posting shelf), FitReport,
  Intake, Records, ModeBanner, sample-posting.
- `n8n/build.ts` — generates both workflows. Do not hand-edit the JSON.
- `airtable/` — schema, provision, push, VIEWS.md, INTERFACE.md.
- `docs/` — DESIGN.md (the end-to-end design), WRITEUP.md (what it does and what it does not).

## Gotchas

- **The dev server caches its store.** `src/server/handlers.ts` holds one LocalStore per credential set,
  backed by `data/session.json`. Editing the seed needs the server restarted and that file deleted, or
  you will test against stale data and chase a phantom bug.
- **`pkill -f vite` does not work here.** Kill by port: `Get-NetTCPConnection -LocalPort 5273`.
- **Node aborts if you `process.exit()` while fetch keep-alive sockets are open.** Every script uses
  `process.exitCode` instead. Reverting that turns a readable error into a libuv crash dump on Windows.
- **`pnpm-workspace.yaml` holds the build allowlist**, not `package.json`. pnpm 11 ignores
  `onlyBuiltDependencies` there, which presents as esbuild never installing its binary.
- **Hyphen boundaries in matching.** A single-word alias must not match inside a compound, or `react`
  matches `react-three-fiber` and the report cites a Unity game as React experience. See
  `containsTerm` in `src/pipeline/portable.ts`.
- **No bare backticks inside a node's template string in `n8n/build.ts`.** The node bodies are TS
  template literals, so a backtick in a comment closes the literal and the error surfaces dozens of
  lines away. Write the identifier plain.
- **n8n only evaluates a parameter as an expression when it starts with `=`.** A `jsonBody` built with
  `JSON.stringify({...})` begins with `{`, so any nested `{{ }}` is sent as literal text. Build the
  request in a Code node and pass `={{ JSON.stringify($json.request) }}`; a test enforces it.
- **n8n orders sibling branches by node POSITION.** Under `executionOrder: v1` the topmost runs first,
  so a Respond node above a write branch answers before the write happens. The connections look
  identical either way — only the coordinates differ. Pinned in `tests/workflow.test.ts`.
- **An Airtable node runs once per input item, AND a fan-in target runs before its other sources have.**
  Chaining loads multiplies the calls; fanning them means the consumer executes with four of five inputs
  missing. Chain them and set `executeOnce` on each. Pinned in `tests/workflow.test.ts`.
- **A webhook node needs a `webhookId` or it has no production URL.** Without one n8n registers a
  composite key nothing serves and the webhook 404s as "not registered", which looks like a workflow
  nobody activated.
- **Airtable nodes must be typeVersion >= 2.2.** Below that `legacyFlattenOutput` hoists `fields` to the
  top level and every `r.fields.X` in a Code node reads undefined.
- **`N8N_PORT=5679` collides with n8n's task broker.** Presents as `/healthz` answering 200 while every
  other route, including the editor, returns 404.
- **The Airtable credential field is `accessToken`,** not `apiToken`, for `airtableTokenApi`.
- **Airtable link fields need a second pass.** `linkedTableId` does not exist until the base is created.
- **Deploy is `pnpm build`, with no prefix.** `VITE_MODEL_PROXY_BASE` lives in the committed
  `.env.production` (it is an address, never a key). It used to be passed inline at build time and
  lived nowhere, so a plain `pnpm build` on 2026-08-05 silently shipped the keyless lane: the header
  went from `live models` to `no key` and nothing failed. Check the banner after every deploy.

## Acceptance criteria

- [x] Runs end to end with no credentials
- [x] Three ingest branches demonstrable: new record, dedup, validation failure to Needs Review
- [x] Fit report with citations and a truthful Gaps section
- [x] Both OpenRouter traps have regression tests asserting real request bodies
- [x] Two n8n workflows committed, generated from source, drift-checked, verified to import and
      round-trip, and RUN END TO END on n8n 2.31.7 against the live Airtable base and OpenRouter
      (2026-08-14): 401 without the token, a full scored report with the row written, and `retrieval`
      and `weighing` reported in the response
- [x] Airtable base created and seeded against a real account from one token, idempotent
      (migrated 2026-08-14 for `Roles.Candidate`; one Roles row, 75% / 10 / 4 / 2, Verdict Summary
      arithmetically coherent)
- [x] Resume intake: a pasted resume becomes a Candidate plus receiptless claims (`pnpm test`,
      tests/resume.test.ts)
- [x] Claim promotion: a supporting document's receipts attach to the claims they match, and only
      claims that predate the document
- [x] Candidate isolation: matching and scoring are scoped to one candidate's rows before anything
      reads the snapshot, in the app and in both workflows
- [x] Token-gated endpoints: the n8n webhooks and the server proxy require `POW_APP_TOKEN` and fail
      closed when it is unset
- [x] README through the `technical-writing` skill with its grep pass re-run
- [x] Nine screenshots captured by `pnpm screenshots`; three more need Joel's live accounts (the
      committed set predates the v3 tabs and wants a reshoot)
- [x] One-click recruiter demo with zero dependencies: the static build hosted live at
      proof.viralhostdigital.com (S3 + CloudFront + WAF, Terraform-managed, keyless in-browser
      pipeline)

# Compact instructions
When compacting, keep: the non-negotiables above, the current task, the list of modified files, and any
failing test output.

# Proof of Work

@NOTES.md

An application asset, not a client gig. It exists to close three gaps at once (Airtable, n8n, Zapier) by
building something that uses all three, and to be the strongest exhibit attached to an AI Product Engineer
application. Full design: `docs/DESIGN.md`.

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
- **Weighing can only lower a verdict.** `matchRole` resolves every requirement twice — once with no
  model, once with the weighing model's numbers — and keeps the worse (`worseOf` in score.ts). There
  is no channel by which a model raises a score. `tests/judge.test.ts` attacks it with the reply a
  dishonest model would send; DESIGN.md §v3.8 has the reasoning.
- **Every number traces to a real artifact.** `tests/seed-integrity.test.ts` transcribes the metrics by
  hand from the portfolio ledger and compares. A wrong test count is worse than no test count.
- **Generic vocabulary.** Candidate, Evidence, Coverage, record. Never "my skills", "About me", "resume".
  `tests/vocabulary.test.ts` greps the UI source.
- **Never a silent fallback.** Every degradation is visible in the header and in `pnpm doctor`.

## Stack and commands

- React 19 + TypeScript + Vite. Hand-written CSS, no framework. Two runtime dependencies.
- Install: `pnpm install`
- Run: `pnpm dev` (port 5273)
- Test: `pnpm test` (272 passing across 17 files, 3 skipped behind `LIVE_OPENROUTER=1`)
- Typecheck: `pnpm typecheck`
- Everything: `pnpm verify` (typecheck, tests, n8n drift check)
- Credentials: `pnpm doctor`
- Workflows: `pnpm n8n:build` / `pnpm n8n:build --check`
- Airtable: `pnpm airtable:provision` then `pnpm airtable:push`

## Where things live

- `raw/` — 12 committed artifacts. Stage 0, deliberately messy.
- `src/openrouter/` — protocol (model tiers, both traps), schemas, chat client, embeddings.
- `src/pipeline/` — text, extract, resume (paste-a-resume intake), validate, link, match, judge
  (weighing, §v3.8), score, rationale, index (orchestrator).
- `src/store/` — types (the seven tables), seed, local adapter, Airtable adapter, mode detection.
- `src/server/handlers.ts` — the `/api` surface, mounted by a Vite plugin in `vite.config.ts`. Holds
  `POW_APP_TOKEN` and proxies to the n8n webhooks; the browser never sees the secret.
- `src/ui/` — App, Applicants (landing: roster + resume intake), Score (the posting shelf), FitReport,
  Intake, Records, ModeBanner, sample-posting.
- `n8n/build.ts` — generates both workflows. Do not hand-edit the JSON.
- `airtable/` — schema, provision, push, VIEWS.md, INTERFACE.md.
- `docs/` — DESIGN.md, WRITEUP.md, SHOTLIST.md, DEMO-SCRIPT.md.

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
  `containsTerm` in `src/pipeline/text.ts`.
- **Airtable link fields need a second pass.** `linkedTableId` does not exist until the base is created.

## Acceptance criteria

- [x] Runs end to end with no credentials
- [x] Three ingest branches demonstrable: new record, dedup, validation failure to Needs Review
- [x] Fit report with citations and a truthful Gaps section
- [x] Both OpenRouter traps have regression tests asserting real request bodies
- [x] Two n8n workflows committed, generated from source, drift-checked, and verified to import and
      round-trip in a real self-hosted n8n
- [x] Airtable base created and seeded against a real account from one token, idempotent
- [x] Zap documented with a testable sample payload
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
- [ ] 60 to 90 second recording — OPTIONAL since the live demo URL shipped; its remaining value is
      the LinkedIn Featured thumbnail and interview rehearsal (script: docs/DEMO-SCRIPT.md)

# Compact instructions
When compacting, keep: the non-negotiables above, the current task, the list of modified files, and any
failing test output.

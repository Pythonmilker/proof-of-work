# NOTES — Proof of Work

Progress anchor. Update at the end of each session.

## Current status

**Code complete and green.** 180 tests passing across 12 files, 3 skipped behind `LIVE_OPENROUTER=1`,
`tsc --noEmit` clean, `pnpm verify` passes including the n8n drift check. Branch `feat/proof-of-work`,
not pushed. The bundled posting keeps the real posting's requirement bullets byte-for-byte under an
invented company (Northwind Systems), with the About blurb, headcounts, learn-more URL and AI-in-hiring
disclosure removed — the demo ships publicly at proof.viralhostdigital.com and a named company in a
shipped fixture reads as leftover data. The record scores 75 percent against it: 10 proven, 4 partial,
2 gaps, 16 requirements, all of them required. The two gaps are the degree line and the collaborate-with-vendors line — both
genuinely true — and Claude Code lands proven.

**The Airtable base is live, seeded, and scored against the real posting.** One Roles row
(`role-arootah-2026-07-28`, 75%), 16 Results rows with real citation links, stale rows deleted, and
Joel's shared view returns all 16 with no filter repoint needed. Outstanding: Joel's Interface pages,
the three SaaS screenshots, re-shot demo screenshots, and the recording.

**Full live mode since 2026-07-28.** OPENROUTER_API_KEY in `.env.local` is North Star's capped,
disposable demo key (Joel's choice — the main key stays in AWS untouched). `pnpm doctor`: all green,
`live · Airtable · Claude + embeddings`. The base's rationales are model-written where the
fabrication guard passed them, hybrid retrieval, same 75% — verdict-identical to the deterministic
run, verified row for row before writing.

## Done

- `docs/DESIGN.md` — full end-to-end design, written before the build and kept current.
- Six tables in `src/store/types.ts`, seeded from `src/store/seed.ts` with 7 projects, 44 technologies,
  23 capabilities, 23 evidence rows. Every metric traced to the portfolio ledger.
- OpenRouter layer with both traps guarded and tested against real request bodies.
- Pipeline: extract, validate, link/dedup, match, score, rationale, orchestrator. Deterministic floor
  under every model call.
- React app: intake with a live stage list, before/after, fit report with citations and Gaps, record
  browser. Runs in the browser with no server on the static build.
- Two n8n workflows generated from source, 36 nodes, drift-checked in `pnpm verify`, and verified to
  import and round-trip in a real self-hosted n8n.
- Airtable provisioning and seeding from one token, idempotent, plus view and Interface click-scripts.
- Zap recipe with a testable sample payload.
- README through the `technical-writing` skill; grep pass re-run and clean.

## Verified externally, not from memory

- `POST https://openrouter.ai/api/v1/embeddings` exists (401 with a control path returning 404).
  Embedding models list at `GET /api/v1/embeddings/models`.
- `qwen/qwen3-embedding-8b` is $0.01 per million, as expected.
- `meta-llama/llama-3.1-8b-instruct` supports `structured_outputs` at $0.05/$0.08 per million.
- `qwen/qwen3-8b` reports `structured_outputs: false` while reporting `response_format: true`. Kept in
  the code as a named negative example.
- n8n node types and versions read from real published workflows via the template API: webhook v2,
  code v2, if v2.2, airtable v2.1, httpRequest v4.2, stickyNote v1.
- Airtable Meta API: `POST /v0/meta/bases`, scope `schema.bases:write`, `multipleRecordLinks` needs
  `linkedTableId` and therefore a second pass.

## Decisions and rationale (do not re-litigate)

- **Six projects, not five.** The brief listed five; Proof of Work itself is the sixth, and it is what
  makes the Gaps section honest. Rows are free. The five-TABLE constraint is untouched.
- **No embeddings on the keyless path.** A hashed pseudo-embedding would look like semantic retrieval and
  would not be one. Lexical plus token overlap is worse and is honestly labelled.
- **Airtable Interface cannot expand `Results`.** Splitting results into their own table would fix the
  Interface and break the five-table rule. Documented in `airtable/INTERFACE.md` with the recommendation
  to show the React report alongside.
- **Zapier does the notification, n8n does the pipeline.** Saying so is more convincing than pretending
  one tool covers both.
- **Plain CSS, no Tailwind.** The screenshots are a deliverable and a build that cannot break is worth
  more than utility classes.
- **Posting parse routed on shape, not on count (2026-07-28, re-measured 2026-07-30).** With a key
  live, gpt-4o-mini scored the real posting 66% over 18 paraphrased rows, including "strong
  problem-solving skills" as a minted gap. Code reads it verbatim: 75%, 16 rows. The original gate was
  "the deterministic reader found >= 4 requirements, so skip the model" — which stopped being the right
  test the moment passes 2 and 3 landed, because unstructured text now clears 4 on sentence heuristics
  and the model never ran on prose, the one shape it reads better. The gate is now the PASS that
  answered: bulleted or unmarked → code, no model call; prose or nothing → model when a key is set,
  deterministic as the fallback. Re-measured on five fixtures — details in the header of
  `src/pipeline/jd.ts`, pinned in `tests/jd.test.ts`. Anchor unmoved: 75 / 10 / 4 / 2 / 16.

## Bugs found and fixed during the build

- **The posting reader dead-ended on real postings (2026-07-30).** `parseRoleDeterministically` only
  recognised lines opening with an explicit bullet marker, so a typical LinkedIn paste (headings, then
  plain unmarked lines) and a prose-only posting both parsed to ZERO requirements — measured, not
  guessed. On the hosted static build there is no key to fall through to, so zero meant the visitor got
  "parsed without a model" over an empty report: a dead end in the deployed product. The reader now has
  three passes (bulleted → unmarked-list-under-a-heading → prose sentences, capped at 20), sharing one
  noise filter / splitList / marker helper, with section state tracked across all three. Pass 1 is
  untouched, so the anchor is untouched. Nothing is silent: the outcome's note names the pass whenever
  it was not the bulleted primary ("read as an unmarked list", "read from prose"), and a posting all
  passes fail on raises `UnreadablePostingError` (status 400) instead of rendering a blank report.
  Probe counts: LinkedIn-style 0 → 11, `•` bulleted 4 → 4, prose-only 0 → 5, sample 16 → 16.
  `tests/jd.test.ts`.

- **React matched `react-three-fiber`**, so the fit report cited a Unity game as React experience. Fixed
  with asymmetric hyphen boundaries in `containsTerm`; multi-word terms fold hyphens to spaces,
  single-word terms treat a hyphen as part of the word. `tests/match.test.ts`.
- **"structured output" did not match "structured outputs".** Plural suffix added to `containsTerm`.
  It was silently costing several requirements a match.
- **The deterministic extractor read "Test Files 24 passed" as 24 tests.** A real number, in the output,
  and the wrong one. Fixed with a line-anchored vitest summary pattern ordered ahead of the loose one.
- **Bullet splitting mangled prose.** "Documented, maintainable systems that someone else can pick up"
  became two requirements, one of them "Documented", which then scored as a fabricated gap. `splitList`
  now only splits when every part reads like a name.
- **`numbersIn` counted the 2 inside "e2e"**, producing phantom figures the fabrication guard then hunted
  for and rejected good sentences over.
- **`process.exit()` after a fetch aborted Node with a libuv assertion on Windows**, turning "your key is
  wrong" into a crash dump. All scripts use `process.exitCode`.
- **Created technologies and capabilities were never written to the store.** Caught while wiring the
  server; on Airtable this would have produced links to record ids that do not exist, resolving to an
  empty field with no error.
- **`tests/schema-parity.test.ts` caught a reverse link** (`Evidence.Capabilities`) that Airtable creates
  and the type layer does not carry. Documented as a deliberate asymmetry rather than papered over.

## Found by the adversarial audit (6 lenses, 54 findings, 19 survived refutation)

The ones that mattered, all fixed:

- **The evidence gate was leaky.** `resolve()` used `caps.every(c => c.tier === 'stretch')`, so a posting
  bullet naming a stretch capability alongside any incidentally-matched proven one was promoted to
  `proven` and then dropped out of the Gaps section entirely. That is the exact over-claim the file exists
  to prevent. Now it reads the top-scoring capabilities and any tie at that score counts: an ambiguous
  best match resolves to partial. `some` would have been wrong the other way, dragging down requirements
  something evidenced genuinely covers. Two tests pin both directions.
- **A guard test asserted nothing.** `tests/workflow.test.ts` looked for a literal `"models"` array in
  each HTTP node's `jsonBody`, but `extract-project.json` builds its body in a Code node and passes
  `={{ JSON.stringify($json.request) }}`, so the node was skipped silently and the extract workflow was
  never checked. Rewritten to scan Code nodes too and to fail if either workflow contributed zero
  assertions. Proved by injecting a real four-model chain: the test now fails with
  `expected 4 to be less than or equal to 3`.
- **The structured-output filter was an allowlist in disguise.** Every registry entry reported
  `structuredOutputs: true`, so the filter had only ever rejected slugs it did not recognise, never one
  for the reason its name gives. `qwen/qwen3-8b` now lives in the registry with the flag set to `false`,
  verified against the live API, and a test asserts at least one registered model is rejected on the flag.
- **`cap-billing` said "three shipped products"** while the seed's own status field marks Parastoria
  `in-development`. Reworded to the ledger's "three separate products". One-word inflation, in the
  project that claims to be immune to it.
- **README said the Genestrata sample links 5 technologies.** It links 4, because the `threejs` row's
  aliases fold `react-three-fiber` into it. That is the most reproducible number in the repo, since a
  reader clicks the button and counts the chips.
- Stale numbers: `9,011` lines of TypeScript (no counting method produced it), `100 records per write`
  in DESIGN.md against 10 everywhere else, DESIGN.md mockups showing 5 projects / 31 tech / 74 percent,
  and the shot list claiming two screenshots when nine exist.
- Prose: the write-up had no Known issues section, opened on a pronoun, carried two headers over four
  words, and repeated several README paragraphs near-verbatim. Rewritten; the grep pass is clean on both.

## v2 IMPLEMENTED (2026-07-27, signed off: grid link, name on)

The delivery architecture pivoted to Airtable-led after the base went live: the recruiter gets a
no-login shared VIEW link (verified free-plan capability), the Interface page is the application
screenshot and the paid-tier upgrade target, n8n stays the only engine with ZERO Airtable automations
(script actions are not on the free plan; no plan has a native webhook action), and React shrinks to
the ingestion surface plus score trigger. Full spec with verified platform facts: docs/DESIGN.md v2.
Implemented: env split + honest n8n probe + live-mode gating (confirmation card, base link-outs,
no second fit report, no fixture counts over live data), VIEWS.md/INTERFACE.md rewritten as v2
click-scripts with exact formulas, README/WRITEUP lead with Airtable, live screenshots captured.
DONE by Joel 2026-07-27: all VIEWS.md §A fields (Receipt, Verdict, Receipts rollup, three counting
rollups (now reading 10/4/2 against the real posting), Verdict Summary) and the §B shared view. Share link verified ANONYMOUSLY by
Claude from a never-logged-in browser: no login wall, six columns only, proven-first sort, live data.
Link wired into .env.local; the confirmation card now shows the real Open-the-fit-report button.
Remaining: the 1-hidden-field chip check in incognito (cosmetic), VIEWS.md §C operator views (3 min),
INTERFACE.md pages (~1 h), three SaaS screenshots, the 75s film. A reusable skill pack from this build landed at
_reference/skill-packs/airtable-n8n-backend/.

## v3 RECRUITER SEAT (2026-07-28)

The seat turned around: the recruiter sits at the machine, and resumes drop into the intake slot.
Full spec docs/DESIGN.md §v3. Branch `feat/recruiter-seat`. 209 tests across 13 files, `pnpm verify`
green, Joel × Arootah still 75% (10 proven · 4 partial · 2 gaps) — the pinned regression anchor held
through the whole migration (tests/resume.test.ts).

What landed:

- **Store: seven tables.** `Candidates` joins; Projects, Capabilities and Evidence carry a
  `candidate` stamp; Results keys are `{candidateKey}-{roleKey}-req-N`. Seed wraps the whole record
  as `candidate-joel`. cap-brownfield was cut from the seed the same day: in the recruiter frame an
  evidence-less seeded claim read as a claim Joel never backed, so the seed now carries zero
  receiptless capabilities and `tests/seed-integrity.test.ts` pins that. Unverified rows now enter
  only through resume intake, which is the gate's visible example.
- **Resume path.** `ingestResume` in src/pipeline/index.ts plus src/pipeline/resume.ts:
  deterministic-first (resumes are bullet lists, the jd.ts lesson reapplied), model lane for prose
  resumes, fixture `raw/08-joel-resume.md`. Claims land as stretch capabilities with empty evidence;
  supporting documents promote only claims that predate them.
- **UI reseat.** Tabs are Applicants / Score / Fit report. Applicants is the landing: roster,
  claim chips (verified vs unverified), resume paste, supporting-document slot. Score is the posting
  shelf — any applicant against any posting, button names whose fit it scores. Records demoted to a
  demo-mode footer link; live mode links out to the base.
- **Security boundary (§v3.7).** `POW_APP_TOKEN` server-side only, never `VITE_`-prefixed. The server
  proxy attaches it; both n8n webhooks check it constant-time in a Code node ahead of everything and
  fail closed (unset = 401 with the reason named). n8n mode now requires the app server.
- **n8n candidates.** Both workflows take an optional `candidateId` (default `candidate-joel`), load
  the Candidates table, fail loudly on an unknown id (typecast would otherwise mint a candidate out
  of a typo), scope capabilities/projects/evidence to the candidate before scoring, and stamp every
  written row — project, evidence, review stub, results — with the Candidate link. Results keys match
  the adapter format exactly. Regenerated: extract 25 nodes, match 22. Import re-verified on n8n
  2.31.7: both import and `export:workflow --all` round-trips 25/25 and 22/22 nodes, 17 and 16
  connection sources, no node type dropped.

What remains:

1. **Live-base migration.** The real Airtable base is still the pre-v3 six-table shape. Re-run
   `pnpm airtable:provision` + `pnpm airtable:push` (idempotent) to add Candidates and the ownership
   links, then re-check the shared view.
2. **Screenshots.** The three SaaS shots still need Joel's accounts, and the eleven committed shots
   predate the v3 tabs — reshoot after the live-base migration.
3. **The film.** 75 seconds, script rewritten for the recruiter seat in docs/DEMO-SCRIPT.md, every
   beat verified against the credential-free path (including the promotion beat's exact paste texts).

## v3.8 WEIGHING (2026-08-05)

Joel: "deterministic just sorts data, it cannot weigh it properly correct?" Correct, and the cause was
a conflation: `match()` returned a word-overlap score and `resolve()` read it as a coverage score, so a
lexical hit went straight to proven. `src/pipeline/judge.ts` now asks a model how much the retrieved
rows actually prove, and four guards bound the answer — echoed ids, a receipts clamp, a named-receipt
check, and `worseOf`, which resolves every requirement twice and keeps the lower status. Weighing can
only ever lower a verdict. Full reasoning and the measured result: DESIGN.md §v3.8. 273 tests, 17
files, `pnpm verify` green.

### The over-claim it caught, and how it was resolved

On its first run against the real posting the pass demoted **"Familiarity with Claude Code"** to
partial, taking the report to 72%. Its reason: `Uses Claude API in shipped projects but does not
demonstrate Claude Code specifically.` That was correct. There was no Claude Code row in the record —
the requirement was matching `'claude code'` as an **alias on the Claude API technology row**, the
`react` / `react-three-fiber` bug class again. The line further up this file celebrating "Claude Code
lands proven" had been recording an alias, not a receipt.

Resolved 2026-08-05 (Joel's call, both parts):

- **The alias is gone.** `claude-api` no longer answers to `'claude code'`. Calling the model
  programmatically is not driving the agentic CLI.
- **`cap-claude-code` is a real row** with a real receipt, `ev-pow-claude-code` — the repo's operating
  contract, checkable on a screen share rather than from a URL, which is stated as the limit it is.
  Its `matchTerms` deliberately exclude `claude api`; folding one into the other is the exact
  over-claim that created this.

Re-measured after the change: **deterministic 75%, weighed 75%, zero demotions, verdicts identical.**
The model rated the new row 0.9 and named `"Claude Code operating contract"` to justify it, which is
what the named-receipt guard requires. It also correctly scored `claude-api` at 0.1 for this
requirement and `cap-multi-agent` at 0 — the latter matching the ledger's own standing warning not to
describe Tendril as running Claude Code.

So the anchor is unmoved at **75 / 10 / 4 / 2 / 16**, and it is now carried by a receipt instead of an
alias.

### Three more faults, found by reading the live base rather than trusting the fix

Fixing the seed did not fix the base: Results rows are written once, at scoring time, so the base kept
displaying the old sentence. Re-scoring surfaced three real bugs the offline suite could not have.

1. **`worseOf` was discarding the model's relevance judgment.** It returned the deterministic object on
   a tie, and ties are nearly every requirement — so the pruned citation list was thrown away and the
   Claude Code row still cited Tendril through `cap-multi-agent`, which the weighing model had scored
   relevance **0**. The rationale writer then produced a sentence about Microsoft Store certification.
   A tie now goes to the weighed object: equal statuses mean no verdict moved, so citations only narrow.
2. **The adjective ban was a prompt with nothing behind it.** A live run wrote *"The candidate has
   extensive experience with Claude Code"* — "extensive" is the prompt's own first banned example, and
   the guard only ever checked numbers. `gradesTheCandidate()` enforces it now, with hyphen boundaries,
   because a bare `\bdeep\b` fires inside "deep-link".
3. **`demotedCount` compared object identity**, so after (1) the UI read "16 of 16 lowered" on a run
   that lowered nothing.

Also: `ev-pow-claude-code` ended with a dangling "34 commits" and a rationale read it as "34 commits to
`.claude/`". The fabrication guard passed it because 34 **is** in the corpus — it catches invented
numbers, not misattributed ones — so the fix is wording the model cannot misread.

**Live base reconciled 2026-08-05.** One Roles row `role-arootah-2026-08-06` at 75%, 16 Results,
10/4/2, zero rationales grading the candidate, zero Tendril citations under Claude Code. The
superseded `role-arootah-2026-07-29` and its 16 Results were deleted after the replacement was read
and checked. The base is the seven-table v3 shape and has been for some time — the migration item
below was stale.

## Open

1. **Screenshots 1, 2 and 3.** The base and n8n are both up now, so this is framing rather than setup.
   `docs/SHOTLIST.md` has the exact shots. Create the views first (`airtable/VIEWS.md`) or shot 2 has
   nothing to show.
2. **The recording**, 60 to 90 seconds. Script in `docs/DEMO-SCRIPT.md`.
3. **Arootah statistics — rule replaced 2026-07-30.** The old rule allowed "700+ vetted advisors" and
   "600+ coaches" inside the posting text (the company quoting itself) while banning them from our own
   prose. The public demo killed that rationale: the bundled sample is now anonymised, so the figures
   are banned everywhere, including the sample. `tests/seed-integrity.test.ts` asserts the inverse it
   used to, plus a new test pinning all 16 requirement bullets byte-identical through the change.

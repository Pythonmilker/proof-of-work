# NOTES — Proof of Work

Progress anchor. Update at the end of each session.

## Current status

**Code complete and green.** 180 tests passing across 12 files, 3 skipped behind `LIVE_OPENROUTER=1`,
`tsc --noEmit` clean, `pnpm verify` passes including the n8n drift check. Branch `feat/proof-of-work`,
not pushed. Sample posting scores 78 percent: 9 proven, 3 partial, 2 gaps, 6 of 9 required proven.

**The Airtable base is live and seeded**, and both n8n workflows import into a real self-hosted instance.
A match run against the real base scores 78% in 6.2s and writes 14 Results rows with their citations as
real links. Outstanding: the Airtable views and Interface (click-scripts, ~17 min), the three SaaS
screenshots, and the recording.

## Done

- `docs/DESIGN.md` — full end-to-end design, written before the build and kept current.
- Five tables in `src/store/types.ts`, seeded from `src/store/seed.ts` with 6 projects, 44 technologies,
  23 capabilities, 24 evidence rows, 158 links. Every metric traced to the portfolio ledger.
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

## Bugs found and fixed during the build

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

## v2 direction (2026-07-27, designed and signed-off pending)

The delivery architecture pivoted to Airtable-led after the base went live: the recruiter gets a
no-login shared VIEW link (verified free-plan capability), the Interface page is the application
screenshot and the paid-tier upgrade target, n8n stays the only engine with ZERO Airtable automations
(script actions are not on the free plan; no plan has a native webhook action), and React shrinks to
the ingestion surface plus score trigger. Full spec with verified platform facts: docs/DESIGN.md v2.
Implementation is gated on sign-off. A reusable skill pack from this build landed at
_reference/skill-packs/airtable-n8n-backend/.

## Open

1. **Screenshots 1, 2 and 3.** The base and n8n are both up now, so this is framing rather than setup.
   `docs/SHOTLIST.md` has the exact shots. Create the views first (`airtable/VIEWS.md`) or shot 2 has
   nothing to show.
2. **The recording**, 60 to 90 seconds. Script in `docs/DEMO-SCRIPT.md`.
3. **Arootah statistics.** "700+ vetted advisors" and "600+ coaches" could not be found on their site and
   are used nowhere. "18 functional disciplines" is confirmed and is used. Their site says "time-to-hire",
   not "time-to-fill". Worth checking before repeating either figure in a cover letter.
4. **The real posting** should be pasted over `src/ui/sample-posting.ts` before filming. What is there now
   is a reconstruction, labelled as one in the file and in the UI.

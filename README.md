# Proof of Work

Proof of Work is a pipeline that turns messy evidence of what someone has built into a structured
capability record, then scores that record against a pasted job description.

The product is generic. The dataset it ships with belongs to one candidate, the way a CRM demo ships with
sample contacts.

You paste a job description, click one button, and get a coverage score where every claim links to
something a stranger can check, plus a Gaps section listing what the record does not cover.

## Requirements

**Node 20.19** or newer (Vite 7 requires it) and pnpm. No API keys, no accounts.

## Run it

```bash
pnpm install
pnpm dev
```

Open http://localhost:5273. The header reads `demo · local store · no key`.

```
$ pnpm doctor

Proof of Work: demo · local store · no key

  · models       No OPENROUTER_API_KEY. Deterministic extraction and lexical matching
  · embeddings   No key. Retrieval is lexical only
  · airtable     No Airtable credentials. Using the local store
  · store        local JSON, seeded from src/store/seed.ts
  · pipeline     running in-process (no n8n webhook configured)

Nothing is configured, and that is a supported way to run this.
Everything works: deterministic extraction, lexical matching, the local store.
```

Extraction reads artifacts with pattern matching instead of a model, retrieval is lexical instead of
hybrid, and every stage still runs.

## Try it

On the Intake screen, click a sample and press Ingest. Three of the eleven files in `raw/` show different
branches:

| Sample | What happens | Where it lands |
|---|---|---|
| `10-genestrata-unity.md` | Not in the record yet | New Project row, 4 technologies linked |
| `01-tendril-readme.md` | Already on file | Dedup fires, the existing row updates |
| `11-broken-fragment.txt` | Nothing checkable in it | Validation fails, row parked in Needs Review |

Then open Match and press "Score this role". Against the sample posting the record scores 78 percent:
9 requirements proven, 3 partial, 2 gaps, and 6 of the 9 required items proven.

## Going live

Copy `.env.example` to `.env.local`. The three credentials are independent, and `pnpm doctor` reports each
one separately.

```bash
OPENROUTER_API_KEY=sk-or-...      # real models, embeddings-backed retrieval
AIRTABLE_PAT=pat...               # swaps the local store for a real base
VITE_PIPELINE_ENDPOINT=https://...  # moves the pipeline into n8n
```

To create the Airtable base:

```bash
pnpm airtable:provision   # 6 tables and 9 link fields, from one token
pnpm airtable:push        # 6 projects, 44 technologies, 23 capabilities, 24 evidence rows
```

Provisioning needs a token with `schema.bases:write` and a workspace id. Both are idempotent, so a run
that dies halfway is safe to repeat. Two views and one Interface still need clicking: `airtable/VIEWS.md`
and `airtable/INTERFACE.md`.

A credential that is set but rejected reports as rejected. `pnpm doctor` exits 1 and names the specific
failure, and the header in the app reads `key rejected`.

## The six tables

Projects hold the work. Technologies and Capabilities describe it. Evidence proves it. Roles hold every
posting scored against the record, and Results hold one row per requirement of each posting.

It was five. Results used to be escaped JSON inside a long-text field on Roles, to hold the count down.
That disabled filtering, grouping, colouring and Interfaces on the one table holding the output, and
Airtable renders tables as horizontal tabs, so six versus five looks identical. The constraint is
legibility, not arithmetic. `tests/schema-parity.test.ts` pins the count and fails on a JSON blob.

One rule in that schema does most of the work: a Capability with nothing in its Evidence link cannot score
as proven, however cleanly a requirement matches it. Adding a capability row is easy. Making it count
requires attaching something checkable. `tests/evidence-gate.test.ts` pins this at a perfect 1.0 match
score, where the gate is the only thing deciding the outcome.

The seed carries 1 capability with no evidence and 5 marked as stretch. Those 6 rows account for the
3 partial verdicts in the sample report.

## The workflows

Two n8n workflows are committed as JSON in `n8n/`, generated from the TypeScript in `src/`:

```bash
pnpm n8n:build           # writes both files
pnpm n8n:build --check   # fails if the committed JSON has drifted
```

`extract-project.json` has 19 nodes. Webhook, build request, OpenRouter call, deterministic validation,
then a branch: valid records go to dedup and three Airtable writes, invalid ones become a row in Needs
Review with the validator's problem list attached.

`match-role.json` has 17 nodes. The one to read is `Retrieve and score`, a Code node that ranks Airtable
rows and computes every verdict and the coverage number in arithmetic. Only after that is a model asked to
describe each outcome in one sentence, from the rows retrieval returned. It receives no access to the base,
so it cannot cite a project that did not match. `tests/workflow.test.ts` asserts the scoring node contains
no HTTP call and that it runs before the rationale node.

`tests/workflow.test.ts` also parses every Code node with `new Function` to catch a syntax error before
someone imports the canvas.

## Model tiering

| Job | Model | Price per million |
|---|---|---|
| Extraction | anthropic/claude-haiku-4.5 | $1.00 in, $5.00 out |
| Posting parsing | openai/gpt-4o-mini | $0.15 in, $0.60 out |
| Retrieval | qwen/qwen3-embedding-8b | $0.01 |
| Rationale writing | meta-llama/llama-3.1-8b-instruct | $0.05 in, $0.08 out |
| Scoring and gaps | none | free |

Prices read from `https://openrouter.ai/api/v1/models` on 2026-07-27. Run
`LIVE_OPENROUTER=1 pnpm test` to re-check them against the live API; `tests/model-registry.test.ts`
compares every registry entry to what OpenRouter reports.

Extraction stays on a capable model. Every claim downstream rests on the metrics surviving intact, and a
small model that rounds 536 to "over 500" costs the record its credibility. Rationale writing runs on an
8B because the status and the citations are already decided before the call.

## Two OpenRouter traps

Both cost a debugging session on an earlier project. Both have a regression test.

Structured-output support is a property of the endpoint, not the model. Two providers serving the same
slug can disagree about whether they honour `response_format`. The fix has two halves: send
`provider: { require_parameters: true }`, and filter the model chain on a registry of models that report
`structured_outputs`. Skip either and the call returns HTTP 200 containing prose. `qwen/qwen3-8b` is kept
in `src/openrouter/protocol.ts` as a named example: it reports `response_format: true` and
`structured_outputs: false`, so it looks like a sensible cheap fallback and is not.

OpenRouter rejects a `models` array longer than three items with `400 "'models' array must have 3 items or
fewer."` A 400 is a malformed request, so it does not fall through to the next model. On a previous
project a four-model chain 400'd on every request while graceful degradation hid it: the deterministic
path answered, the offline suite stayed green, and the LLM was dead for days.
`tests/model-chain.test.ts` asserts the length of every built request body for all three tiers, including
when a caller supplies an override that is not already in the chain.

## Tests

```bash
pnpm test        # 180 passing, 3 skipped, 12 files
pnpm typecheck
pnpm verify      # typecheck, tests, and the workflow drift check
```

The three skipped tests hit the live OpenRouter catalogue. Enable them with `LIVE_OPENROUTER=1`. They need
no key, because `/api/v1/models` is public.

`tests/seed-integrity.test.ts` transcribes every metric by hand from the source artifacts and compares it
to the seed. It also checks the 11 files in `raw/` state the same figures, so a live ingest cannot produce
a record that contradicts the one already on screen.

## Known issues

The rationale model is called once per report rather than once per requirement, so with a key set the
generated sentences are less specific than the deterministic templates they replace on some rows. The
guard in `src/pipeline/rationale.ts` discards any sentence containing a number that is not in the records
it was written from, and that row falls back to the template.

The Airtable Interface cannot expand the `Results` field into a table, because results are stored as JSON
in one long-text field. Splitting them into their own table would fix the Interface and break the
five-table constraint. `airtable/INTERFACE.md` documents the three options and recommends showing the
React report alongside.

Retrieval without a key is lexical plus token overlap. It matches technologies a posting names literally
and misses capabilities a posting only describes. The header says `lexical` when this is what ran.

The Zap polls on Zapier's schedule, up to 15 minutes on the free plan. A webhook trigger would be
immediate and needs a paid plan.

The sample posting in `src/ui/sample-posting.ts` is a reconstruction, not a copy. Its requirement list is
real; its company paragraph is assembled from public site copy. Paste the actual posting over it before
using a fit report for anything.

## Why Airtable

Because the people who own this data are not engineers.

The schema is small, relational, and edited by whoever is looking at it. Someone adds a capability, links
a receipt, moves a row out of Needs Review. Airtable gives that person a spreadsheet they already know how
to use, plus views, plus an Interface, plus a REST API, with no infrastructure to run.

Where it stops: no transactions, roughly 5 requests per second per base, 10 records per write, and the
schema is as stable as the last person who clicked in it. `src/store/airtable.ts` treats it as a remote
API with throttling and batching rather than as a database. The `Store` interface in
`src/store/types.ts` has two implementations already, so replacing it with Postgres is one file.

## Layout

```
raw/          11 committed artifacts: READMEs, a package manifest, test output, a store listing
src/openrouter/  protocol, schemas, chat client, embeddings
src/pipeline/    extract, validate, link, match, score, rationale
src/store/       types, seed, local adapter, Airtable adapter, mode detection
src/ui/          intake, before and after, fit report, record browser
n8n/          two workflows plus the generator that writes them
airtable/     schema, provisioning, seeding, the view and Interface scripts
zapier/       one Zap and a sample payload
docs/DESIGN.md   the end-to-end design, including what was cut
```

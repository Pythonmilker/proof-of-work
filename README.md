# Proof of Work

Proof of Work is a pipeline that turns messy evidence of what someone has built into a structured
capability record, then scores that record against a pasted job description.

The delivered product is an Airtable base: seven linked tables, recruiter views, and a fit-report
Interface, shared as a link that opens with no login. This repo holds everything that fills it: the
extraction and scoring pipeline, the n8n workflows that run it, the React app that writes to it, and
the scripts that build the base itself from one access token.

The seat is the recruiter's. Paste an applicant's resume and every claim lands unverified, because a
resume asserts and does not prove. Ingest the applicant's supporting documents and the claims they
back earn receipts. Score any applicant against any posting and every verdict cites the rows behind
it, plus a section listing what the record does not cover. The roster ships with one worked example,
the way a CRM demo ships with sample contacts.

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

The app lands on Applicants. The roster ships with one worked example, the record of the person who
built this, every one of its 22 claims carrying a receipt.

Paste a resume into New applicant (`raw/08-joel-resume.md` is the bundled fixture) and press "Read the
resume". Identity, positions and claims are read out of the text, and every claim lands unverified.
That is the honest default: nothing this system ingests gets credit for describing itself. The
evidence gate caps a receiptless claim at partial until a document backs it.

Supporting documents go in the slot below, attributed to whichever applicant is selected. Their
receipts attach to the claims they match, and the claim chips flip from unverified to verified as they
land. Three of the twelve files in `raw/` show different pipeline branches:

| Sample | What happens | Where it lands |
|---|---|---|
| `10-genestrata-unity.md` | Not in the record yet | New Project row, 4 technologies linked |
| `01-tendril-readme.md` | Already on file | Dedup fires, the existing row updates |
| `11-broken-fragment.txt` | Nothing checkable in it | Validation fails, row parked in Needs Review |

Then open Score, pick an applicant, and press the button, which names whose fit it scores. The bundled
posting carries a real posting's requirements under an invented company name, and the seeded record
scores 75 percent against it: 10 of its 16 requirements proven, 4 partial, 2 gaps. That posting marks
everything as required, so the required tally is the whole tally.

## Going live

Copy `.env.example` to `.env.local`. The three credentials are independent, and `pnpm doctor` reports each
one separately.

```bash
OPENROUTER_API_KEY=sk-or-...      # real models, embeddings-backed retrieval
AIRTABLE_PAT=pat...               # swaps the local store for a real base
VITE_PIPELINE_ENDPOINT=https://...  # moves the pipeline into n8n
POW_APP_TOKEN=...                 # shared secret the n8n webhooks require
```

`POW_APP_TOKEN` stays server-side. The app server attaches it to every webhook call; the browser sends
plain requests to `/api/pipeline/*` and never holds the secret, which is why the variable has no
`VITE_` prefix. Set the same value in the n8n environment, where the gate fails closed: unset there,
every request answers 401 with the reason named. n8n mode therefore requires the app server, since the
static build has no process to hold the token.

To create the Airtable base:

```bash
pnpm airtable:provision   # 7 tables and 14 link fields, from one token
pnpm airtable:push        # 1 candidate, 7 projects, 44 technologies, 23 capabilities, 24 evidence rows
```

Provisioning needs a token with `schema.bases:write` and a workspace id. Both are idempotent, so a run
that dies halfway is safe to repeat. Add `--prune` to remove rows the seed no longer has; without the
flag it only reports them.

The display fields, the shared recruiter view and the Interface pages have no API and are click-built:
`airtable/VIEWS.md` (about 25 minutes, includes the exact formulas) then `airtable/INTERFACE.md`
(about an hour). The shared view link goes into `.env.local` as `VITE_AIRTABLE_REPORT_URL`, and
`VITE_AIRTABLE_BASE_URL` points at the base. With those set, the app links out instead of rendering
its own copy of the record.

A credential that is set but rejected reports as rejected. `pnpm doctor` exits 1 and names the specific
failure, and the header in the app reads `key rejected`.

## The seven tables

Candidates hold the people. Projects hold the work. Technologies and Capabilities describe it. Evidence
proves it. Roles hold every posting scored against the record, and Results hold one row per candidate,
posting and requirement.

It was five. Results used to be escaped JSON inside a long-text field on Roles, to hold the count down.
That disabled filtering, grouping, colouring and Interfaces on the one table holding the output, and
Airtable renders tables as horizontal tabs, so six versus five looks identical. The constraint is
legibility, not arithmetic, and Candidates earned the seventh tab the same way Results earned the
sixth: a person is real structure, with Projects, Capabilities, Evidence and Results all hanging off
one, not a property serialised into a field. `tests/schema-parity.test.ts` pins the count and fails on
a JSON blob.

One rule in that schema does most of the work: a Capability with nothing in its Evidence link cannot score
as proven, however cleanly a requirement matches it. Adding a capability row is easy. Making it count
requires attaching something checkable. `tests/evidence-gate.test.ts` pins this at a perfect 1.0 match
score, where the gate is the only thing deciding the outcome.

The seed itself makes no claim it cannot back: every seeded capability has evidence linked, and
`tests/seed-integrity.test.ts` pins that. Receiptless rows enter through resume intake, where every
pasted claim is born unverified until a supporting document promotes it. In the bundled report the
gate shows as the 4 partial verdicts, which all carry the same shortfall: the matching capability is
recorded as a stretch, not as shipped work.

## The workflows

Two n8n workflows are committed as JSON in `n8n/`, generated from the TypeScript in `src/`:

```bash
pnpm n8n:build           # writes both files
pnpm n8n:build --check   # fails if the committed JSON has drifted
```

Both webhooks require a shared app token in an `x-pow-app-token` header, checked constant-time in a
Code node that fails closed, and both take an optional `candidateId` defaulting to the seeded
candidate. Every row they write carries its Candidate link, and Results keys lead with the candidate,
the same shapes `src/store/airtable.ts` writes.

`extract-project.json` has 26 nodes. Webhook, token gate, build request, OpenRouter call, deterministic
validation, then a branch: valid records go to dedup and three Airtable writes, invalid ones become a
row in Needs Review with the validator's problem list attached.

`match-role.json` has 33 nodes and runs the same five stages the app does: read the posting in code and
only call a model if it is prose, embed the record for hybrid retrieval, score in arithmetic, weigh the
result with a model that can lower a verdict but never raise one, then write one sentence per requirement
from the rows retrieval returned.

The one to read is `Retrieve and score`, a Code node that computes every verdict and the coverage number
before any model sees the result. The rationale model gets no access to the base, so it cannot cite a
project that did not match. `tests/workflow.test.ts` asserts the scoring node contains no HTTP call and
runs before the rationale node.

Neither workflow contains a copy of a scoring rule. `src/pipeline/portable.ts` holds every rule both
lanes run, and `n8n/build.ts` type-strips it into the Code nodes, so a workflow contains the rule rather
than a transcription of it. `tests/workflow-parity.test.ts` lifts the JavaScript back out of the
committed JSON and compares its answers to the app's own functions; `tests/workflow-rationale.test.ts`
executes whole nodes against stubbed n8n globals. The drift check alone cannot see this, because it
compares committed JSON to what the generator regenerates.

`tests/workflow.test.ts` also parses every Code node with `new Function` to catch a syntax error before
someone imports the canvas, and pins the three runtime facts that cost the most to learn: a webhook node
needs a `webhookId` or it has no production URL, an Airtable node below typeVersion 2.2 flattens `fields`
to the top level, and a node with two inbound connections runs before both have delivered.

## Model tiering

| Job | Model | Price per million |
|---|---|---|
| Extraction and resume parsing | anthropic/claude-haiku-4.5 | $1.00 in, $5.00 out |
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
pnpm test        # 439 passing, 3 skipped, 19 files
pnpm typecheck
pnpm verify      # typecheck, tests, and the workflow drift check
```

The three skipped tests hit the live OpenRouter catalogue. Enable them with `LIVE_OPENROUTER=1`. They need
no key, because `/api/v1/models` is public.

`tests/seed-integrity.test.ts` transcribes every metric by hand from the source artifacts and compares it
to the seed. It also checks the 12 files in `raw/` state the same figures, so a live ingest cannot produce
a record that contradicts the one already on screen.

## Known issues

The rationale model is called once per report rather than once per requirement, so with a key set the
generated sentences are less specific than the deterministic templates they replace on some rows. The
guard in `src/pipeline/rationale.ts` discards any sentence containing a number that is not in the records
it was written from, and that row falls back to the template.

The Airtable views and Interface pages have to be created by hand. Airtable has no API for either, so
`airtable/VIEWS.md` and `airtable/INTERFACE.md` are click-scripts, and the display-formula fields they
call for cannot be created via the API either.

Retrieval without a key is lexical plus token overlap. It matches technologies a posting names literally
and misses capabilities a posting only describes. The header says `lexical` when this is what ran.

There is no notification step. Zapier was evaluated for one and cut: n8n already has the trigger, the
branching and the code nodes, so a second automation tool would have been a logo rather than a feature.
Nothing in the pipeline sends a message when a role is scored.

The bundled posting in `src/ui/sample-posting.ts` keeps a real posting's requirement bullets word for
word and nothing else. The company is Northwind Systems, which does not exist, and the "About" blurb is
gone — headcounts, industry description, learn-more URL and all. The demo is public, so a named company
sitting in a shipped fixture reads as leftover data rather than as a sample. Scoring a different posting
means pasting it into the box.

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
raw/          12 committed artifacts: READMEs, a package manifest, test output, a resume, a store listing
src/openrouter/  protocol, schemas, chat client, embeddings
src/pipeline/    extract, resume, validate, link, match, score, rationale
src/store/       types, seed, local adapter, Airtable adapter, mode detection
src/ui/          applicants, score, fit report, record browser
n8n/          two workflows plus the generator that writes them
airtable/     schema, provisioning, seeding, the view and Interface scripts
docs/DESIGN.md   the end-to-end design, including what was cut
```

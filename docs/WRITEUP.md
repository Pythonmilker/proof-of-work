# Proof of Work

Proof of Work is a pipeline that turns messy evidence of what someone has built into a structured record
where every claim links to something checkable, then scores that record against a pasted job description.

The delivered product is the Airtable base. A recruiter opens a shared view link, with no login and no account,
and reads the fit report: a verdict per requirement with citations, and a section listing what the
record does not cover. The React app in this repo is the write surface: it runs the ingestion pipeline
with every stage visible, which is the one job a spreadsheet cannot do, and writes the results back to
the base.

The dataset it ships with belongs to one candidate. The product is generic, the same way a CRM demo ships
with sample contacts.

## Stack

Airtable is the application: seven linked tables, recruiter views, and a fit-report Interface, all built
from a single access token by `pnpm airtable:provision`, so the schema is version-controlled code
rather than clicks. Two n8n workflows carry the pipeline, committed as JSON, generated from the same TypeScript
that runs locally, and verified to import into a real self-hosted instance. React and TypeScript
provide the write surface. Zapier was considered and cut: n8n does the same job with branching, code
nodes and version control, and a tool kept to tick a checkbox would be decoration.

## Models

Tiered by how much judgement each job needs.

| Job | Model | Price per million |
|---|---|---|
| Extraction | anthropic/claude-haiku-4.5 | $1.00 in, $5.00 out |
| Posting parsing | openai/gpt-4o-mini | $0.15 in, $0.60 out |
| Retrieval | qwen/qwen3-embedding-8b | $0.01 |
| Rationale writing | meta-llama/llama-3.1-8b-instruct | $0.05 in, $0.08 out |
| Scoring and gaps | none | free |

Extraction stays on a capable model because every claim downstream rests on the metrics surviving intact.
Rationale writing runs on an 8B because by then the status and the citations are already decided.

Prices and capability flags are re-checked against the live OpenRouter catalogue by
`LIVE_OPENROUTER=1 pnpm test`.

## The architecture claim

Matching is deterministic. The model only writes sentences.

Retrieval ranks rows that already exist. Scoring is arithmetic. Gap detection is arithmetic. A language
model is called only after the verdict is fixed and the citations are chosen, and it is handed those rows
and asked to describe them in one line. Its whole input is the retrieval result.

A guard reads every generated sentence and discards any containing a number that is not in those records.
That row falls back to a deterministic template, and the report labels which of the two wrote each line.

One schema rule does the rest: a capability with nothing linked to it is capped at partial credit,
however cleanly a requirement matches it. Adding a capability row is easy. Making it count requires
attaching something a stranger can check.

v3 turned the seat around without touching that machinery. A resume is an artifact whose claims arrive
with no receipts, and the gate was built for exactly that shape: paste one and every claim lands
unverified, capped at partial. Ingest the applicant's supporting documents and the receipts attach to
the claims they match, one promotion at a time. The scorer needed no changes to become a
claim-verification engine, and the claims that never earn a receipt are the interview questions.

Against the bundled posting — a real one's requirements, the company anonymised because the demo ships
publicly — the record scores 75 percent. Airtable and n8n come out partial, with this
project named as their only evidence, because that is what the record contains.

## Why Airtable

Because the people who own this data are not engineers.

The schema is small, relational, and edited by whoever is looking at it. Someone adds a capability, links
a receipt, moves a row out of Needs Review. Airtable hands that person a spreadsheet they already know,
plus filtered views, plus an Interface, plus a REST API, with nothing to deploy. For a dataset of this
size and this edit pattern, Postgres would be a worse product and more work.

Where it stops: no transactions, roughly 5 requests per second per base, 10 records per write, and a
schema as stable as the last person who clicked in it. Record ids are opaque, so every table carries a
`Key` field holding a stable slug and `src/store/airtable.ts` maintains the translation in both
directions, throttling and batching as a remote API rather than a database.

The `Store` interface in `src/store/types.ts` has two implementations, so swapping in Postgres is one
file. Airtable is chosen for who edits the data, and the seam is there for when that changes.

## Running it

`pnpm install && pnpm dev` with no credentials runs the whole pipeline: pattern-matching extraction
instead of a model, lexical retrieval instead of hybrid, a local JSON store instead of Airtable. Every
stage runs and the header names the mode.

Credentials are independent per service and `pnpm doctor` reports each separately. A credential that is
set but rejected reports as rejected. Full setup is in the README.

## Known issues

The rationale model is called once per report rather than once per requirement, so with a key set the
generated sentences are less specific than the deterministic templates they replace on some rows.

The three views and the Interface dashboard still have to be created by hand. Airtable has no API for
either, so `airtable/VIEWS.md` and `airtable/INTERFACE.md` are click-scripts rather than code.

Retrieval without a key is lexical plus token overlap. It matches technologies a posting names literally
and misses capabilities a posting only describes.

The Zap polls on Zapier's schedule, up to 15 minutes on the free plan.

Eleven screenshots are committed; the three that need live n8n and Airtable accounts are not.
`docs/SHOTLIST.md` has the framing for each, and the committed set predates the v3 tab names, so the
app shots want a reshoot.

## Numbers

209 tests across 13 files, typecheck clean. 11,650 lines of TypeScript across 51 files, counted with
`git ls-files "*.ts" "*.tsx" | xargs wc -l`. 1 candidate, 7 projects, 44 technologies, 22 capabilities,
23 evidence rows, every capability evidenced. Two workflows, 47 nodes between them, verified to import
and round-trip in a real n8n. 12 raw artifacts committed so the before-and-after is reproducible. The
static build ships 342 kB of JavaScript, 108 kB gzipped.

# Proof of Work

Proof of Work is a pipeline that turns messy evidence of what someone has built into a structured record
where every claim links to something checkable, then scores that record against a pasted job description.

Paste a posting, click one button, get a coverage number, a verdict per requirement with citations, and a
Gaps section listing what the record does not cover.

The dataset it ships with belongs to one candidate. The product is generic, the same way a CRM demo ships
with sample contacts.

## Stack

React and TypeScript on the front. Airtable as the application backend: six tables, three views,
one Interface dashboard, created from a single access token by `pnpm airtable:provision`. Two n8n
workflows carry the pipeline, committed as JSON and generated from the TypeScript that also runs them
locally. One Zap sends a Slack notification when a new fit report is written.

n8n carries the pipeline and Zapier carries the notification. The pipeline needs branching, code nodes
and version control; a channel message needs none of those.

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

Against the sample posting the record scores 78 percent. Airtable, n8n and Zapier come out partial, with
this project named as their only evidence, because that is what the record contains.

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

Three of the eight screenshots need live n8n and Airtable accounts, so they are not in the repository.
`docs/SHOTLIST.md` has the framing for each.

## Numbers

180 tests across 12 files, typecheck clean. 9,354 lines of TypeScript across 47 files, counted with
`git ls-files "*.ts" "*.tsx" | xargs wc -l`. 6 projects, 44 technologies, 23 capabilities, 24 evidence
rows, 158 links. Two workflows, 36 nodes between them, verified to import and round-trip in a real n8n. 11 raw artifacts committed so the before-and-after
is reproducible. The static build is 304 kB, 98 kB gzipped.

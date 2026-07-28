# Proof of Work — end-to-end design

Status: design frozen 2026-07-27. Build in progress; §16 tracks what exists.

---

## 1. What it is

A pipeline that takes messy evidence of what someone has built, turns it into a structured
receipt-backed capability record, and scores that record against any job description pasted into it.

The product is generic. Joel Brannan is the seed dataset, the same way a CRM demo ships with sample
contacts. Every string a reviewer sees says **Candidate**, **Evidence**, **Coverage** — never "my
skills" or "About me". If it reads as a resume with extra steps it has failed, and that failure is a
copy problem, not an architecture problem, so §9 pins the vocabulary.

### The one moment

Everything is built backward from this:

> A reviewer pastes a job description into a box, clicks one button, and gets a scored fit report where
> every claim links to something they can verify — plus a Gaps section that tells them what is missing.

Anything that does not serve that moment is cut.

### Why it exists

It is an application asset for an AI Product Engineer role that requires React, Airtable as an
application backend, n8n and/or Zapier, and LLM integration. Three of those four are absent from the
candidate's record. Rather than claim them, the demo produces them — and then reports honestly that
this project is the only evidence for them. A system that tells the truth about its own subject is the
argument. A flattering score would prove nothing, because a flattering score is what everyone expects a
tool like this to produce.

---

## 2. Non-goals

| Not doing | Why |
|---|---|
| An ATS, or anything that ranks multiple candidates | One candidate, one role, one report. Multi-candidate needs auth, tenancy, and a permissions model, none of which improves the screenshot. |
| More than five Airtable tables | Every extra table makes the Airtable screenshot worse. If something feels like a sixth table it is a field or a view. |
| A hosted deployment | It runs locally in one command. Hosting adds a domain, a secret manager, and a bill, and proves nothing the local run does not. |
| Resume generation, cover letters, application tracking | Different product. Scope creep here is the most likely way this ends up unfinished. |
| Chat | There is no conversational surface anywhere. The model is a component, not an interface. |

---

## 3. System map

```
STAGE 0   raw/*.md, *.json, *.txt          messy real artifacts, committed
             │
STAGE 1   React intake screen              paste box + drop zone + source type + one button
             │  POST /api/ingest      ─or─  n8n webhook  (one env var switches it)
             ▼
STAGE 2   EXTRACT WORKFLOW
             ├─ 1  webhook / handler
             ├─ 2  LLM extract      claude-haiku-4.5, strict json_schema
             ├─ 3  validate         deterministic. schema + type + range + ceiling
             │        └── fail ────────────────────┐
             ├─ 4  dedup            slug + name overlap against existing rows
             ├─ 5  link             stack strings → Technology ids, claims → Capability ids
             ├─ 6  write            Project row + Evidence rows + links
             └─ 7  respond          { project, created, warnings, via }
                                                    │
                                          NEEDS REVIEW row  ◄──┘   (a real row, never a dropped record)
             ▼
STAGE 3   AIRTABLE — six tables
             Projects · Technologies · Capabilities · Evidence · Roles · Results
             views: Proven Capabilities · Needs Review
             one Interface dashboard
             ▲
             │  read
STAGE 4   MATCH WORKFLOW
             ├─ 1  webhook / handler        job description text in
             ├─ 2  LLM parse                gpt-4o-mini → requirements[]
             ├─ 3  retrieve      CODE       lexical + embeddings, cosine, threshold
             ├─ 4  score         CODE       status per requirement, weighted coverage, gaps
             ├─ 5  LLM rationale            llama-3.1-8b, one line each, records only
             ├─ 6  guard         CODE       reject any sentence containing an unsourced number
             ├─ 7  write                    Role row with the whole report
             └─ 8  respond                  { role, coverage, results, gaps }
             │
             ├────────────────────────────► STAGE 5  Zapier: new Role row → Slack
             ▼
STAGE 6   THE FINISH
             a) Airtable Interface: role header, coverage gauge, requirement table, expandable evidence
             b) React fit report: score, cited requirements, live links, Gaps section
```

The important structural claim, and the one to make loudly in the README:

**Matching is deterministic. The model only writes sentences.** Steps 3, 4 and 6 of the match workflow
are pure code. By the time a language model is called, the score is already computed and immutable. The
model receives a decision and a list of record ids, and is asked to describe them in one line. It
cannot change a status, cannot move the score, and cannot cite a project that retrieval did not return —
it never sees the store, only the rows retrieval handed it.

---

## 4. Data model — the six tables

Types live in `src/store/types.ts`. Airtable field definitions in `airtable/schema.ts`. They are checked
against each other by `tests/schema-parity.test.ts`.

### 4.1 Projects

| Field | Type | Notes |
|---|---|---|
| `id` / `slug` | text | slugified name; the dedup key |
| `name` | text | primary field |
| `role` | text | what the person did |
| `started` / `ended` | text `YYYY-MM` | text, not date — a half-known date is honest, `new Date()` is not |
| `status` | single select | shipped · live · delivered · in-development |
| `summary` | long text | |
| `metrics` | number ×4 | `loc`, `tests`, `commits`, `files`. Only counts that came from an artifact |
| `technologies` | link → Technologies | |
| `capabilities` | link → Capabilities | |
| `evidence` | link → Evidence | |
| `reviewStatus` | single select | `ok` · `needs-review` — drives the Needs Review view |
| `reviewReason` | long text | the validator's problem list, verbatim |
| `source` | text | which file in `raw/` produced this row |
| `ingestedAt` | text ISO | |

Seeded with five: Tendril, Parastoria, Viral Host Digital, North Star Support Bot, Client & early web
work.

### 4.2 Technologies

| Field | Type | Notes |
|---|---|---|
| `name` | text | primary |
| `aliases` | long text, comma-separated | **the reason lexical matching works.** A posting says "React.js", "AWS Lambda", "Zapier and/or n8n". Widening a match is a row edit, not a code change |
| `category` | single select | language · framework · cloud · data · automation · ai · payments · tooling |
| `projects` | link → Projects | Airtable maintains the reverse side; the local store does it in code |

~30 rows. Includes Airtable, n8n and Zapier — linked only to this project, which is the point.

### 4.3 Capabilities

| Field | Type | Notes |
|---|---|---|
| `name` | text | primary |
| `statement` | long text | one line, written to be read aloud in a report |
| `tier` | single select | `proven` · `stretch` |
| `matchTerms` | long text | JD phrasings for this capability |
| `projects` | link → Projects | |
| `evidence` | link → Evidence | **an empty link here is meaningful** |

> **The evidence gate.** A capability with nothing in `evidence` is rendered as unverified and is capped
> at partial credit no matter how cleanly it matched. This is the single rule that keeps the record from
> drifting into a resume: adding a capability row is easy and buys nothing until you also link something
> a stranger can check. Enforced in `src/pipeline/score.ts`, pinned by `tests/evidence-gate.test.ts`.

### 4.4 Evidence

| Field | Type | Notes |
|---|---|---|
| `label` | text | primary |
| `kind` | single select | store-listing · live-url · test-count · repo-metric · infra-metric · video · certification · client-review · artifact |
| `value` | text | the receipt itself, exactly as written |
| `url` | url | nullable |
| `verifiedOn` | text ISO | when a human last looked at the thing |
| `projects` | link → Projects | |

Seeded receipts include the Microsoft Store product id `9NRC4P6JQ962`, `tendrilapp.ai`,
`viralhostdigital.com`, `parastoria.app`, `dewdropkc.com`, `mywindowssparkle.com`, the test counts, the
Terraform resource count, the commit counts, the AWS CCP certification, and the 5.0 Upwork review.

Every number is taken from `PORTFOLIO.md`, and `tests/seed-integrity.test.ts` fails the build if one
drifts. A wrong test count is worse than no test count, because the entire argument is that the numbers
are verifiably real.

### 4.5 Roles

| Field | Type | Notes |
|---|---|---|
| `title` | text | primary |
| `company` | text | |
| `postedText` | long text | the JD **verbatim**, so any result can be re-derived |
| `requirements` | long text JSON | parsed requirement list |
| `results` | long text JSON | per-requirement status, score, cited ids, rationale |
| `score` | number | 0–100, computed in code |
| `matchedAt` | text ISO | |
| `model` | text | which model wrote the rationales, or `none` |

Roles and Matches share one table on purpose. A match without a role does not exist, a role is matched
exactly once per run, and splitting them would be the sixth table.

---

## 5. Pipeline — extraction path

### 5.1 The model call

`claude-haiku-4.5`, strict `json_schema`, temperature 0, ~1600 max tokens.

The system prompt is reproduced in `src/pipeline/extract.ts`. Its first rule is the one that matters:

> Never invent a number. If the source says 536 tests, record 536. If it does not give a count, record
> null. A rounded or guessed metric is worse to us than a missing one, because a missing one is honest.

The schema forbids free-text opinion fields. `achievements` is specified as *things that happened and
could be checked by someone else* — "well architected" is explicitly excluded as an opinion.

### 5.2 The validator — `src/pipeline/validate.ts`

Runs on every reply regardless of how confident the schema request was. Structured output is a strong
hint, not a guarantee: whether `response_format` was honoured depends on which provider OpenRouter
routed to.

Checks, in order:

1. **Shape** — is it an object; are `name` and `summary` present.
2. **Dates** — `YYYY-MM` or a warning; never coerced into a `Date`.
3. **Status** — must be in the enum, else recorded as `in-development` with a warning.
4. **Metric types** — finite numbers or null. A string where a number belongs is a rejection.
5. **Metric ranges** — negative is a rejection. Above the plausible ceiling
   (`loc` 5,000,000 · `tests` 100,000 · `commits` 100,000 · `files` 200,000) is a rejection, loudly,
   because an inflated metric is the most damaging thing this pipeline could publish.
6. **Evidence rows** — a row without a label or a value is skipped with a warning; an unknown `kind`
   becomes `artifact`; a `url` that is not `http(s)` becomes null.
7. **Substance** — no technologies *and* no evidence means the blob described nothing checkable.

> Range checks live here rather than in the JSON schema because Anthropic's structured outputs reject
> `minimum`/`maximum` on a number with a 400 from every provider — which, behind a fallback chain, looks
> exactly like the model being unavailable. It is also simply their right home: the reply is untrusted
> input no matter what was asked for.

**Retry policy.** `retryable: true` for malformed JSON and missing or mistyped fields — asking again may
work. `retryable: false` when the source contained no project — asking again spends money to fail
identically. n8n retries once on a retryable failure, then routes to Needs Review.

### 5.3 The error branch

A rejection becomes a **real Project row** with `reviewStatus: 'needs-review'` and the problem list in
`reviewReason`. It is not logged and dropped.

This is a deliberate design choice and worth defending in the write-up: a pipeline that discards what it
cannot parse produces output that *looks* complete and is not, and the omission is invisible — the report
simply never mentions the thing. A visible bad row is worth more than a clean-looking gap.

`raw/07-broken-fragment.txt` is committed specifically so this branch can be demonstrated on camera.

### 5.4 Dedup — `src/pipeline/link.ts`

Slug equality catches the same file pasted twice. Name overlap ≥ 0.8 catches "Tendril" against
"Tendril — agent-first IDE", which is what happens when two different artifacts describe one project.

Getting this wrong permissively merges two real projects. Getting it wrong strictly splits one project's
evidence across two rows — and *that* is the failure that makes a capability look unverified when it is
not. So the threshold leans permissive and the merge is non-destructive: `mergeProject` prefers newly
supplied concrete values and unions all three link arrays.

### 5.5 Linking

Loose extraction strings become row ids. Bidirectional matching, because both directions occur in real
input: extraction says "React 19" where the row is "React", and says "Lambda" where the row is
"AWS Lambda".

**Unmatched entries create new rows rather than being dropped.** A pipeline that silently discards
anything outside its taxonomy stops learning the moment it ships.

New capabilities are created as **`stretch` with no evidence**, and that is the safety property. A model
reading a README will happily assert the project demonstrates "scalable architecture". Arriving as an
unverified stretch capability means it shows up that way in the views and stays there until a person
links something checkable.

---

## 6. Pipeline — match path

### 6.1 Parse the posting

`gpt-4o-mini`, strict schema. Splits bundled bullets apart, rewrites each as a short noun phrase, and
tags `required` vs `preferred` and one of eight categories.

Keyless fallback: split on bullets and lines, classify by marker words (`must`, `required` → required;
`preferred`, `nice to have`, `bonus`, `plus` → preferred).

### 6.2 Retrieve — code, no model

Hybrid, because postings do both things:

- **Lexical** — alias containment, word-boundary aware. A JD naming "React", "Airtable", "n8n" is
  exactly what this is for, and embeddings would be waste. Score 1.0 on a hit.
- **Dense** — `qwen/qwen3-embedding-8b` at $0.01/M (OpenRouter's rate, read 2026-07-27). Cosine
  similarity, normalised from the useful band 0.30–0.85 into 0–1 so the threshold reads as a percentage
  instead of a tuned magic number. Catches "build internal tools that connect our systems" against
  *workflow automation*, which lexical cannot reach.
- **Combined** — `max(lexical, dense × 0.95)`. The 0.95 stops a semantically-adjacent row outranking a
  literal name hit, which would make the citation confusing.
- **Fallback** — no key means lexical plus token-overlap only. The UI says so; it does not pretend the
  result is equivalent.

Same retrieval shape as Tendril's sqlite-vec code knowledge graph: embed the corpus, embed the query,
rank by cosine, cut at a threshold. Different storage, same idea.

Projects are **derived, never matched directly** — a project is relevant because something in it is.
Rows with `reviewStatus: needs-review` are excluded; a parked record is not evidence of anything yet.

Citations are trimmed to those within 0.2 of the best score, max 4. A requirement that matches eleven
things has matched two, plus nine rows that share a word, and a citation list nobody trusts is worse
than a short one.

### 6.3 Score — code, no model

```
proven   best ≥ 0.70  AND  evidence linked  AND  not all-stretch  AND  not all-unevidenced
partial  best ≥ 0.45  otherwise
gap      best < 0.45
```

Four ways to fall short of proven, and each produces its own sentence in the report:

| Condition | Sentence |
|---|---|
| `best < 0.70` | matched, but not closely enough to call it a direct hit |
| no evidence reachable | matched, but nothing verifiable is linked to it |
| every matched capability is `stretch` | the matching capability is recorded as a stretch, not as shipped work |
| every matched capability has empty evidence | the matching capability has no evidence linked, so it reads as unverified |

**Coverage** is weighted, not a count:

```
weight   required 1.0 · preferred 0.5
value    proven 1.0 · partial 0.5 · gap 0.0
score    round(100 × Σ(weight × value) / Σ weight)
```

Weighted because a posting with three must-haves and eleven nice-to-haves should not score 79% while
missing every must-have. Partial counts at half, because scoring a partial as zero understates as badly
as scoring it as a pass overstates.

### 6.4 Rationale — the model's only writing job

`meta-llama/llama-3.1-8b-instruct`, $0.05/$0.08 per M. An 8B is genuinely correct here and it is not a
cost compromise: the status is already decided, the evidence is already selected, and the model is
choosing words for a single sentence from records it was handed.

It receives: the requirement text, the computed status, and the matched rows. It does not receive the
store. It cannot cite what retrieval did not return.

**The fabrication guard.** Every number in a generated rationale must appear in the records passed to
it. A sentence containing an unsourced digit is discarded and the deterministic template answers that
row instead. This is carried over from an earlier project where a model wrote a policy claim that
contradicted the data it was summarising — prose-level contradiction that a substring check missed.

### 6.5 Gaps

Every requirement not `proven`, sorted required-gaps → required-partials → preferred. Each carries the
shortfall sentence, the closest real evidence on file even when it did not clear the bar, and the
projects it came nearest to.

When the closest evidence is this project itself, it says so:

> **Airtable** — no prior production experience. Closest evidence: this demo, which uses Airtable as its
> application backend (6 tables, provisioned through the Meta API).

**The Gaps section is not removable.** It is the load-bearing claim.

---

## 7. AI stack

OpenRouter throughout. Tiered by how much judgement the job needs, which is the cost-discipline story:

| Job | Difficulty | Model | Price /M in-out | Why |
|---|---|---|---|---|
| Extraction | hard | `anthropic/claude-haiku-4.5` | $1.00 / $5.00 | Long messy input, nested schema, numbers that must survive intact |
| JD parsing | medium | `openai/gpt-4o-mini` | $0.15 / $0.60 | Short clean input, flat schema |
| Matching | none | `qwen/qwen3-embedding-8b` | $0.01 /M | Not a chat model. Retrieval is a similarity problem |
| Rationale | easy | `meta-llama/llama-3.1-8b-instruct` | $0.05 / $0.08 | One sentence from records already chosen |
| Scoring, gaps | none | — | $0 | Arithmetic |

Fallback chains, primary first, cross-vendor, `openrouter/auto` last as a floating router that never
404s:

```
extraction   claude-haiku-4.5 → gpt-4o-mini → openrouter/auto
jd-parsing   gpt-4o-mini → gemini-2.5-flash → openrouter/auto
rationale    llama-3.1-8b-instruct → gpt-4o-mini → openrouter/auto
```

Claude sits in the primary slot on the extraction path deliberately. The posting names Anthropic's
Claude twice, and a demo that never calls it wastes the signal — but it also happens to be the right
model for the hardest job here, which is why it is defensible rather than decorative.

Extraction does **not** drop to an 8B. Everything this project claims rests on the numbers being real,
and a small model that drops a field or rounds 536 to "over 500" destroys the argument.

All prices read from `https://openrouter.ai/api/v1/models` on 2026-07-27. These are OpenRouter's rates
for OpenRouter's slugs; a vendor's own first-party card is not what this bills against.

### 7.1 Two traps, each with a regression test

**Trap 1 — structured-output support is per-endpoint, not per-model.**

Two providers serving the same slug can disagree about whether they honour `response_format`. Both
halves are required:

- `provider: { require_parameters: true }` on every request, so OpenRouter refuses to route a suitable
  slug to an unsuitable endpoint rather than routing anyway;
- filtering the chain on a registry of `supported_parameters` containing `structured_outputs`, so an
  unsuitable slug never enters the chain in the first place.

Skip either and the call returns HTTP 200 containing prose. No error, no retry — just unstructured text
where a schema was promised.

`qwen/qwen3-8b` is kept in the code as a named negative: it reports `response_format: true` and
`structured_outputs: false`, so it looks like a reasonable cheap fallback and is not.
`tests/model-registry.test.ts` proves the chain builder rejects it, and with `LIVE_OPENROUTER=1`
re-checks every registry flag against the live API so the registry cannot silently rot.

**Trap 2 — the `models` array is capped at 3.**

OpenRouter answers a longer array with:

```
400  "'models' array must have 3 items or fewer."
```

A 400 is a malformed request, so it does **not** fall through to the next model — it kills the call.
This exact bug shipped in North Star: a four-model chain 400'd on every request while graceful
degradation hid it perfectly. The deterministic path answered, the offline suite stayed green, and the
LLM was dead.

`MAX_CHAIN_MODELS = 3`, the chain builder truncates rather than trusting the caller to count, and
`tests/model-chain.test.ts` asserts the length of every built request body for every tier.

Both tests assert against real request bodies, not comments.

---

## 8. Run modes and credentials

Detected independently, reported out loud. This is the design's response to the failure mode that has
bitten this codebase's author twice: the failure was never the problem, the *invisibility* was.

| Mode | Needs | Store | LLM | Matching |
|---|---|---|---|---|
| `demo` | nothing | local JSON | deterministic reader | lexical + overlap |
| `live` | `OPENROUTER_API_KEY` | local JSON | real models | lexical + embeddings |
| `airtable` | `AIRTABLE_PAT` + `AIRTABLE_BASE_ID` | real base | whatever the key allows | as above |

The two axes are independent — real Airtable with no LLM key, or real models against the local store,
both work. `pnpm doctor` prints the same matrix from the CLI before you film.

Rules:

- **Never a silent fallback.** Every degradation is visible in the UI header and in the ingest result.
- **Dummy credentials do not crash.** A rejected key resolves to `demo` with "credential present but
  rejected by OpenRouter (HTTP 401)", not a stack trace and not a lie.
- **The key never reaches the browser.** It lives in `.env.local`, is read by the Vite dev server, and
  the pipeline runs in Node behind `/api/*`. `pnpm build` still produces a working static site because
  the pipeline is isomorphic and the browser runs the deterministic path.
- **Provisioning is one command from one PAT.** `pnpm airtable:provision` creates the base from scratch
  through the Meta API — a stranger needs a token with `schema.bases:write` and nothing else. No
  hand-built base, no template import, no matching field names by hand. Idempotent.

---

## 9. UI

React 19 + TypeScript + Vite. Hand-written CSS with design tokens — no Tailwind, no component library.
Two dependencies total. The screenshots are a deliverable, so the visual bar is "looks like a product",
and a build that cannot break is worth more here than a utility class system.

Dark by default with a light theme; the first screenshot anyone sees is the intake screen.

### 9.1 Vocabulary — enforced, not suggested

| Say | Never say |
|---|---|
| Candidate | Me, Joel, I |
| Evidence, receipt | Portfolio |
| Coverage, requirement | Qualification |
| Record, row | Resume, CV |
| Gaps | Weaknesses, areas for growth |

`tests/vocabulary.test.ts` greps the UI source for the banned column and fails the build. Copy drift is
the most likely way this turns back into a resume, and copy drift is exactly the kind of thing a test
can catch cheaply.

### 9.2 Screens

**A · Intake** — the first screenshot.

```
┌──────────────────────────────────────────────────────────────────┐
│ Proof of Work                      ● demo · local store · no key │
├──────────────────────────────────────────────────────────────────┤
│  Ingest evidence                                                 │
│  ┌────────────────────────────────┐ ┌──────────────────────────┐ │
│  │                                │ │ Source type              │ │
│  │  Paste a README, a package     │ │ ○ readme  ○ manifest     │ │
│  │  manifest, raw test output,    │ │ ○ test output            │ │
│  │  a store listing, a resume…    │ │ ○ listing  ○ resume      │ │
│  │                                │ │ ○ infra summary          │ │
│  │            ⌁ or drop a file    │ ├──────────────────────────┤ │
│  │                                │ │ Samples                  │ │
│  └────────────────────────────────┘ │ · Tendril README         │ │
│  ┌──────────┐                       │ · package.json           │ │
│  │  Ingest  │  ▸ extract · validate │ · vitest output          │ │
│  └──────────┘    · dedup · link     │ · Terraform summary      │ │
│                                     │ · broken fragment ⚠      │ │
│  Records  6 projects · 44 tech      └──────────────────────────┘ │
│           23 capabilities · 24 evidence · 1 needs review          │
└──────────────────────────────────────────────────────────────────┘
```

Live status while it runs, one line per stage, each resolving to a tick or a cross with a reason.
Three demonstrable outcomes and all three are on camera:

1. a sample not in the store → new record appears
2. a sample already in the store → dedup fires, row updates rather than duplicating
3. `broken fragment` → validation fails → Needs Review row, with the reason shown

**B · Before / after** — screenshot 4, and a real part of the product rather than a mockup.

Split view, raw blob left with its ugliness intact, structured record right. Fields that came from the
blob highlight on hover with the source line. Header reads `2,847 characters of prose → 14 fields, 9
evidence rows, 6 links`.

**C · Fit report** — the payoff.

```
┌──────────────────────────────────────────────────────────────────┐
│  AI Product Engineer · Arootah                    ╭─────────╮    │
│  matched 2026-07-27 · deterministic + code        │   78%   │    │
│                                                   │ coverage│    │
│  ██████████████████░░░░  9 proven · 3 partial     ╰─────────╯    │
│                          · 2 gaps                                │
├──────────────────────────────────────────────────────────────────┤
│ ● React                                              proven      │
│   Shipped in 3 projects; 660 test cases across the two largest.  │
│   ▸ Tendril · Parastoria · North Star   ▸ 4 receipts             │
│                                                                  │
│ ◐ Airtable as an application backend                partial      │
│   Used as this project's backend; no prior production record.    │
│   ▸ Proof of Work   ▸ 1 receipt                                  │
│                                                                  │
│ ○ Alternative-investment domain experience              gap      │
│   Nothing in the record matches this.                            │
├──────────────────────────────────────────────────────────────────┤
│  GAPS — what this record does not cover                          │
│                                                                  │
│  Airtable   No prior production experience. Closest evidence:    │
│             this demo, which uses Airtable as its application    │
│             backend (6 tables, provisioned via the Meta API).    │
│  …                                                               │
└──────────────────────────────────────────────────────────────────┘
```

Rows expand to the full citation list: every matched row, every evidence receipt, live links that open.
Each rationale is tagged `model` or `template` so a reader can tell prose from arithmetic.

The Gaps section is visually equal to the matched section — not a footnote, not collapsed by default.

**D · Record browser** — Projects, Technologies, Capabilities, Evidence as tables, with unverified
capabilities marked. Mirrors what Airtable shows, so the demo still reads if Airtable is not connected.

### 9.3 States

Every screen handles: empty, working, degraded (key rejected / no key / Airtable unreachable), and
failed. Degraded is a first-class state with its own copy, not an error toast.

---

## 10. n8n

Two workflows, committed as JSON in `n8n/`. Version-controlled workflows are a deliberate signal — the
posting asks for documented, maintainable systems, and a workflow that exists only inside a SaaS tenant
is neither.

Node types and versions were read from real published workflows via the n8n template API, not from
memory: `webhook` v2, `code` v2, `if` v2.2, `airtable` v2.1, `httpRequest` v4.2, `stickyNote` v1,
`switch` v3.2. Top-level keys `meta` / `nodes` / `connections` / `pinData`; connections keyed by node
*name*.

**`extract-project.json`** — Webhook → Build request (Code) → OpenRouter (HTTP) → Validate (Code) →
IF valid → [Dedup search (Airtable) → Merge or create (Code) → Write project (Airtable) → Write evidence
(Airtable) → Respond] / [false branch → Build review row (Code) → Write Needs Review (Airtable)].

**`match-role.json`** — Webhook → Parse JD (HTTP) → Load store (Airtable ×3) → Retrieve + score (Code) →
Rationale (HTTP) → Guard (Code) → Write role (Airtable) → Respond.

`responseMode: "lastNode"` throughout, so no Respond-to-Webhook node is needed.

Sticky notes on the canvas explain each branch, because the canvas is screenshot #1 and a reviewer reads
it before they read anything else.

**Keeping the JSON honest.** The Code nodes contain logic that also lives in `src/pipeline/`. `n8n/build.ts`
generates the workflow JSON from those modules and `pnpm n8n:build --check` fails if the committed JSON
has drifted from the source. Two copies of a validator that disagree is exactly the bug that would
embarrass this project.

---

## 11. Airtable

Base created by `pnpm airtable:provision` — `POST /v0/meta/bases` with the six tables, then a second
pass adding `multipleRecordLinks` fields, because a link field needs `linkedTableId` and the target
table does not exist until the first call returns. Then `pnpm airtable:push` seeds rows and resolves
links.

**Views:**

- *Proven Capabilities* — Capabilities where `tier = proven` and evidence is not empty, grouped by
  category. The recruiter view.
- *Needs Review* — Projects where `reviewStatus = needs-review`, showing `reviewReason` and `source`.
  The operator view, and the proof that the error branch is real.

**Interface dashboard** — role header, coverage gauge, requirement-by-requirement table coloured
green/amber/red, rows expanding to evidence. Built by hand from `airtable/INTERFACE.md`, which is a
click-by-click script, because Interfaces have no API.

### Why Airtable instead of a real database

The honest answer, which goes in the write-up: because the humans who own this data are not engineers.
The schema here is small, relational, and edited by whoever is looking at it — someone adds a capability,
links a receipt, moves a row out of Needs Review. Airtable gives that person a spreadsheet they already
know how to use, plus views, plus an Interface, plus a REST API, for zero infrastructure.

Where it stops: no transactions, rate limits around 5 requests/second per base, 10 records per write,
and the schema is only as safe as the last person who clicked in it. `src/store/airtable.ts` therefore
treats it as a remote API with retries and batching, not as a database — and the `Store` interface means
swapping in Postgres is one file, which is the correct place for that seam to sit.

---

## 12. Zapier

One Zap, roughly thirty minutes, and it exists to satisfy a stated requirement rather than to carry
architecture:

**New record in Airtable `Roles` → Filter (`score` is set) → Slack message.**

```
New fit report — {{title}} at {{company}}
Coverage {{score}}%  ·  {{proven}} proven, {{partial}} partial, {{gap}} gaps
```

Documented in `zapier/ZAP.md` with the field mapping and a screenshot. `zapier/sample-payload.json`
lets it be tested without waiting for a real run.

The write-up says plainly that n8n carries the pipeline and Zapier carries the notification, and why:
the pipeline needs branching, code nodes, and version control, and Zapier is not the tool for that. A
demo that pretended otherwise would be less convincing, not more.

---

## 13. Testing

Vitest. No network in the default run.

| File | Pins |
|---|---|
| `model-chain.test.ts` | ≤ 3 models in every built body, every tier; primary leads; `openrouter/auto` last |
| `model-registry.test.ts` | chain filtered to `structured_outputs`; `qwen/qwen3-8b` rejected; `require_parameters` present. `LIVE_OPENROUTER=1` re-checks against the live API |
| `schema-strict.test.ts` | no `minimum`/`maximum` anywhere; every property in `required`; `additionalProperties: false` throughout |
| `validate.test.ts` | each rejection path; retryable vs not; ceilings; the review stub |
| `evidence-gate.test.ts` | **a capability with no evidence can never score proven**, at any match score |
| `score.test.ts` | thresholds, weighting, the four shortfall reasons, gap ordering |
| `match.test.ts` | alias hits incl. `c#`, `node.js`, `ci/cd`, `n8n`; dense never outranks literal |
| `dedup.test.ts` | same slug, overlapping name, non-destructive merge |
| `seed-integrity.test.ts` | every seeded number matches `PORTFOLIO.md` |
| `workflow-parity.test.ts` | committed n8n JSON matches generated; both workflows have an error branch |
| `schema-parity.test.ts` | `airtable/schema.ts` matches `src/store/types.ts` |
| `vocabulary.test.ts` | no first-person or resume vocabulary in UI source |
| `no-secrets.test.ts` | no credential in any file git can see |

---

## 14. File layout

```
clients/proof-of-work/
├── raw/                     Stage 0 — committed messy artifacts
├── data/
│   ├── taxonomy.json        Technologies + Capabilities
│   └── records.json         Projects + Evidence + Roles
├── src/
│   ├── openrouter/          protocol · schemas · client · embeddings
│   ├── pipeline/            text · extract · validate · link · match · score · rationale · index
│   ├── store/               types · local · airtable · index (mode detection)
│   ├── server/              handlers.ts — the /api surface
│   └── ui/                  App · Intake · BeforeAfter · FitReport · Records · ModeBanner
├── n8n/                     extract-project.json · match-role.json · build.ts · README.md
├── airtable/                schema.ts · provision.ts · push.ts · INTERFACE.md
├── zapier/                  ZAP.md · sample-payload.json
├── scripts/                 doctor.ts · seed.ts
├── tests/
└── docs/                    DESIGN.md · WRITEUP.md · SHOTLIST.md · DEMO-SCRIPT.md · screenshots/
```

---

## 15. Deliverables

1. Working app — React intake + fit report, Airtable base, two n8n workflows, one Zap
2. Five screenshots — n8n canvas · Airtable Projects with a record expanded showing linked Technologies
   and Evidence · the Interface dashboard · raw blob vs structured record · the React fit report scored
   against the Arootah posting with Gaps visible
3. A 60–90 second screen recording of one full run
4. One-page write-up — what it does, what it is built on, why Airtable instead of a real database
5. README, written through the `technical-writing` skill with its grep pass re-run on the result

---

## 16. Build status

| # | Component | State |
|---|---|---|
| 1 | Repo, config, TS strict | done |
| 2 | External API verification | done — embeddings endpoint, Airtable Meta, n8n node versions, model flags |
| 3 | `src/store/types.ts` | done |
| 4 | `src/openrouter/*` | done — protocol, schemas, client, embeddings |
| 5 | `src/pipeline/` text · match · score · validate · link · extract | done |
| 6 | `src/pipeline/` rationale · jd · index | next |
| 7 | `raw/` fixtures + `data/` seed | next |
| 8 | `src/store/` local · airtable · mode detection | next |
| 9 | `src/server/handlers.ts` | next |
| 10 | React UI | next |
| 11 | n8n workflows + build/check | next |
| 12 | Airtable provision/push + Interface script | next |
| 13 | Zap recipe | next |
| 14 | Tests | alongside each of the above |
| 15 | README, write-up, shot list, demo script | last |
| 16 | Screenshots, video | needs live accounts (Joel) |

---

## 17. Risks

| Risk | Mitigation |
|---|---|
| Reads as a resume | Enforced vocabulary + a test; generic product framing; Gaps section |
| A wrong number ships | Every metric traced to `PORTFOLIO.md`; `seed-integrity.test.ts`; validator ceilings |
| Silent LLM degradation | Typed failures, visible mode banner, `pnpm doctor`, both regression tests |
| Committed workflow JSON rots | Generated from source; `pnpm n8n:build --check` in `pnpm verify` |
| Serialising structure to dodge a table | The five-table rule produced JSON-in-long-text and was corrected to six. `tests/schema-parity.test.ts` now fails on a JSON blob rather than on a table count |
| Screenshots depend on Joel's accounts | Everything code-side runs with zero credentials; SaaS steps reduced to one command plus a click-script |
| Unverifiable claims about Arootah | Only site-verified vocabulary used. "18 functional disciplines" is confirmed; "700+ advisors" and "600+ coaches" were **not** found on the site and are not used anywhere |

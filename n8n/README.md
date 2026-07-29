# The workflows

Two workflows, generated from `build.ts` and committed as JSON.

```bash
pnpm n8n:build           # write both files
pnpm n8n:build --check   # fail if the committed JSON has drifted from src/
```

Do not hand-edit the JSON. `pnpm verify` runs the drift check.

## Run n8n

You do not need an n8n Cloud trial. The self-hosted community edition is free, needs no account and no
licence key:

```bash
N8N_BLOCK_ENV_ACCESS_IN_NODE=false npx -y n8n
```

Editor at http://localhost:5678.

**That environment variable matters.** Both workflows read `{{ $env.AIRTABLE_BASE_ID }}`,
`{{ $env.OPENROUTER_API_KEY }}` and `{{ $env.POW_APP_TOKEN }}`, and recent n8n versions block `$env`
inside nodes by default. Without it the expressions resolve empty and the Airtable node fails with a
confusing base-not-found error.

**POW_APP_TOKEN gates both webhooks.** Every request must carry it in an `x-pow-app-token` header; the
gate fails closed, so with the variable unset every call answers 401 with the reason named. The app
server attaches the header from its own environment.

## Import them

```bash
npx -y n8n import:workflow --input=n8n/extract-project.json
npx -y n8n import:workflow --input=n8n/match-role.json
```

Verified on n8n 2.31.7: both import, and `n8n export:workflow --all` round-trips them at 25/25 and
22/22 nodes with 17 and 16 connection sources and no node type dropped.

The CLI needs a top-level `id` on the workflow, which `build.ts` derives from the workflow name. Without
one the import fails with `SQLITE_CONSTRAINT: NOT NULL constraint failed: workflow_entity.id`. The editor
generates an id when you paste or upload, so a workflow can look importable in the UI and be unusable
from the command line.

Then add one credential named **Airtable Personal Access Token** and activate both.

## extract-project.json

25 nodes. Webhook, token gate, build request, OpenRouter, deterministic validation, then a branch. An
optional `candidateId` in the body names who owns the rows; the default is the seeded candidate, and an
unknown id fails loudly rather than letting typecast mint a Candidates row out of a typo.

The true side loads the Candidates, Technologies and Capabilities tables, resolves the extraction's
loose strings against the candidate's own record, writes the Project with its links, fans the receipts
out to one Airtable record each, and answers 200. The false side writes a Project row with
`Review Status = needs-review` and the validator's problem list attached, then answers 422. Every row
either side writes carries its Candidate link.

## match-role.json

22 nodes. The one to read is **Retrieve and score**, a Code node that ranks Airtable rows and computes
every verdict and the coverage number in arithmetic. Only after that is a model asked for one sentence
per requirement, from the rows retrieval returned. **Guard rationales** discards any generated sentence
containing a number that is not in those records.

`Load the record` scopes projects, capabilities and evidence to the requested `candidateId` before
anything scores, the same guarantee `src/pipeline/index.ts` makes. Results are written as rows in the
`Results` table, one per requirement, with the citations as real links and a Key that leads with the
candidate (the exact format `src/store/airtable.ts` writes). They used to be an escaped JSON string in
a long-text field.

## Things worth knowing before you edit

**Every write is an upsert matched on `Key`.** That maps to Airtable's native `performUpsert`, so the
dedup is the write itself rather than a separate lookup node.

**Linked-record fields are written as the target's primary-field name**, not its record id, because the
nodes run with `typecast: true`. Verified against the installed node source: `options.typecast` becomes
`body.typecast`, and Airtable resolves the string to a record.

**`autoMapInputData` maps top-level keys only.** A Code node feeding an Airtable write must emit the row
itself, flat. Emitting `{ valid, sourceName, project: {...} }` produces a write that succeeds and stores
nothing, with no error anywhere. `tests/workflow.test.ts` asserts the shape of every node that feeds a
write, because this exact bug shipped.

**A node returning zero items stops its branch.** The evidence fan-out can legitimately be empty, which
is why the HTTP response is its own branch ending in a Respond node rather than `responseMode: lastNode`.

**Deliberate difference from `src/pipeline/`.** The application creates a taxonomy row it has never seen;
these workflows do not. They link what exists and return the rest as `unresolved`. Creating and linking
in one run risks writing the link before the row, which leaves a duplicate keyless record.

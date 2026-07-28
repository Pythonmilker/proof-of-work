/**
 * Generates the two n8n workflows from source, and checks the committed copies for drift.
 *
 *     pnpm n8n:build          write n8n/*.json
 *     pnpm n8n:build --check  fail if the committed JSON no longer matches the source
 *
 * ## Why generate them at all
 *
 * A workflow that exists only inside a SaaS tenant is not a maintainable system. It cannot be reviewed,
 * cannot be diffed, and cannot be rebuilt if someone deletes it. Committing the JSON fixes that, and
 * generating the JSON fixes the next problem: two copies of the same logic drifting apart. Every prompt,
 * schema, model chain and threshold below is imported from `src/`, so a change to
 * `MAX_CHAIN_MODELS` or to the extraction prompt changes these files, and `--check` in `pnpm verify`
 * fails until they are regenerated.
 *
 * The Code-node bodies are hand-written JavaScript rather than a bundle of the TypeScript modules. That
 * is a deliberate trade: n8n Code nodes are small, and a reviewer opening the canvas should be able to
 * read what a node does without unpacking a bundle. `tests/workflow-parity.test.ts` pins the constants
 * that matter so the port cannot silently diverge on the parts that would actually break.
 *
 * Node types and versions were read from real published workflows via the n8n template API, not from
 * memory: webhook v2, code v2, if v2.2, airtable v2.1, httpRequest v4.2, stickyNote v1.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CHAIN_MODELS, modelChain } from '../src/openrouter/protocol';
import { PROJECT_EXTRACTION_SCHEMA, ROLE_PARSE_SCHEMA, RATIONALE_SCHEMA } from '../src/openrouter/schemas';
import { EXTRACTION_SYSTEM } from '../src/pipeline/extract';
import { JD_SYSTEM } from '../src/pipeline/jd';
import { RATIONALE_SYSTEM } from '../src/pipeline/rationale';
import { THRESHOLD_PARTIAL, THRESHOLD_PROVEN } from '../src/pipeline/score';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Node builders
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type Position = [number, number];

interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: Position;
  parameters: Record<string, unknown>;
  credentials?: Record<string, unknown>;
}

/**
 * Deterministic ids.
 *
 * n8n accepts any unique string. Deriving them from the node name keeps the generated JSON stable
 * across runs, which is the only reason a drift check can work at all — random uuids would make every
 * regeneration look like a change.
 */
function idFor(name: string): string {
  let hash = 0x811c9dc5;
  for (const ch of name) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${hex}0000`;
}

function node(
  name: string,
  type: string,
  typeVersion: number,
  position: Position,
  parameters: Record<string, unknown>,
  credentials?: Record<string, unknown>,
): N8nNode {
  return { id: idFor(name), name, type, typeVersion, position, parameters, ...(credentials ? { credentials } : {}) };
}

/**
 * `responseNode` rather than `lastNode`, and the difference matters once the workflow branches.
 *
 * With `lastNode` the HTTP response is whatever node happened to finish last, which in a workflow with a
 * success path and an error path is ambiguous. `responseNode` names the responder explicitly, so both
 * branches can answer with their own shape and neither depends on execution order.
 *
 * Value verified against the installed Webhook node source, which offers exactly:
 * onReceived | lastNode | responseNode | streaming.
 */
const webhook = (name: string, path: string, position: Position) =>
  node(name, 'n8n-nodes-base.webhook', 2, position, {
    path,
    options: {},
    httpMethod: 'POST',
    responseMode: 'responseNode',
  });

/** Version 1.5, the newest the installed n8n-nodes-base offers ([1, 1.1, 1.2, 1.3, 1.4, 1.5]). */
const respond = (name: string, position: Position, body: string, code = 200) =>
  node(name, 'n8n-nodes-base.respondToWebhook', 1.5, position, {
    respondWith: 'json',
    responseBody: body,
    options: { responseCode: code },
  });

const code = (name: string, position: Position, jsCode: string) =>
  node(name, 'n8n-nodes-base.code', 2, position, { jsCode });

const http = (name: string, position: Position, jsonBody: string) =>
  node(name, 'n8n-nodes-base.httpRequest', 4.2, position, {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    method: 'POST',
    sendBody: true,
    specifyBody: 'json',
    jsonBody,
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Authorization', value: '=Bearer {{ $env.OPENROUTER_API_KEY }}' }],
    },
    options: { timeout: 45000 },
  });

const AIRTABLE_CREDENTIALS = {
  airtableTokenApi: { id: 'airtable-pat', name: 'Airtable Personal Access Token' },
};

const airtable = (name: string, position: Position, parameters: Record<string, unknown>) =>
  node(
    name,
    'n8n-nodes-base.airtable',
    2.1,
    position,
    {
      base: { __rl: true, mode: 'id', value: '={{ $env.AIRTABLE_BASE_ID }}' },
      // typecast lets a linked-record field be written as the target's primary-field string rather than
      // its opaque record id, which is the only thing that makes linking practical inside a workflow.
      options: { typecast: true },
      ...parameters,
    },
    AIRTABLE_CREDENTIALS,
  );

/** An upsert keyed on our stable slug. Every write in these workflows is one of these. */
const upsert = (name: string, table: string, position: Position) =>
  airtable(name, position, {
    operation: 'upsert',
    table: { __rl: true, mode: 'name', value: table },
    columns: { mappingMode: 'autoMapInputData', matchingColumns: ['Key'], value: {} },
  });

const loadAll = (name: string, table: string, position: Position) =>
  airtable(name, position, {
    operation: 'search',
    table: { __rl: true, mode: 'name', value: table },
    returnAll: true,
  });

const ifNode = (name: string, position: Position, leftValue: string) =>
  node(name, 'n8n-nodes-base.if', 2.2, position, {
    options: {},
    conditions: {
      options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' },
      combinator: 'and',
      conditions: [
        {
          id: idFor(`${name}-condition`),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          leftValue,
          rightValue: '',
        },
      ],
    },
  });

const sticky = (name: string, position: Position, size: [number, number], content: string) =>
  node(name, 'n8n-nodes-base.stickyNote', 1, position, {
    width: size[0],
    height: size[1],
    content,
  });

type Connections = Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }>;

function connect(pairs: Array<[from: string, to: string, outputIndex?: number]>): Connections {
  const out: Connections = {};
  for (const [from, to, outputIndex = 0] of pairs) {
    out[from] ??= { main: [] };
    const main = out[from].main;
    while (main.length <= outputIndex) main.push([]);
    main[outputIndex]?.push({ node: to, type: 'main', index: 0 });
  }
  return out;
}

/**
 * A stable 16-character workflow id, in n8n's nanoid alphabet.
 *
 * Not decoration. `n8n import:workflow --input=file.json` fails outright without one:
 *
 *     SQLITE_CONSTRAINT: NOT NULL constraint failed: workflow_entity.id
 *
 * The editor generates an id when you paste or upload, so a workflow can look perfectly importable in
 * the UI and be unusable from the command line. Deriving it from the name rather than randomising keeps
 * the drift check meaningful and makes re-importing update the same workflow instead of creating a
 * second copy.
 */
function workflowId(name: string): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let hash = 0x811c9dc5;
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    for (const ch of `${name}:${i}`) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += ALPHABET[hash % ALPHABET.length];
  }
  return out;
}

function workflow(name: string, nodes: N8nNode[], connections: Connections): Record<string, unknown> {
  return {
    id: workflowId(name),
    name,
    nodes,
    connections,
    pinData: {},
    settings: { executionOrder: 'v1' },
    active: false,
    meta: { templateCredsSetupCompleted: false },
  };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Workflow 1 — extraction
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const EXTRACTION_MODELS = modelChain('extraction');
const JD_MODELS = modelChain('jd-parsing');
const RATIONALE_MODELS = modelChain('rationale');

function buildExtractRequest(): string {
  return `// Builds the OpenRouter request. Every constant here is generated from src/openrouter and
// src/pipeline/extract.ts — see n8n/build.ts. Do not hand-edit: pnpm n8n:build --check will fail.
//
// Two guards are load-bearing and neither is optional:
//   provider.require_parameters  stops OpenRouter routing to an endpoint that ignores response_format
//                                and answers in prose with a 200
//   models.length <= ${MAX_CHAIN_MODELS}           OpenRouter 400s on a longer array, and a 400 does not fall through
const MODELS = ${JSON.stringify(EXTRACTION_MODELS)};
const MAX_CHAIN_MODELS = ${MAX_CHAIN_MODELS};

const body = $input.first().json.body || $input.first().json;
const blob = String(body.blob || '').slice(0, 24000);
const sourceName = String(body.sourceName || 'pasted-input');

if (!blob.trim()) {
  throw new Error('nothing to ingest');
}
if (MODELS.length > MAX_CHAIN_MODELS) {
  throw new Error("'models' array must have " + MAX_CHAIN_MODELS + ' items or fewer');
}

return [{
  json: {
    sourceName,
    blob,
    request: {
      models: MODELS,
      max_tokens: 1600,
      temperature: 0,
      messages: [
        { role: 'system', content: ${JSON.stringify(EXTRACTION_SYSTEM)} },
        { role: 'user', content: 'Source file: ' + sourceName + '\\n\\n---\\n' + blob + '\\n---' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'project_extraction', strict: true, schema: ${JSON.stringify(PROJECT_EXTRACTION_SCHEMA)} },
      },
      provider: { require_parameters: true },
    },
  },
}];`;
}

function validateNode(): string {
  return `// The deterministic validation node. A port of src/pipeline/validate.ts.
//
// Structured output is a strong hint, not a guarantee — whether response_format was honoured depends on
// which provider OpenRouter routed to. So every field is re-checked here as untrusted input, and the
// range checks that could not live in the schema (Anthropic rejects minimum/maximum on a number with a
// 400 from every provider) live here instead, which is their right home anyway.
//
// A rejection is NOT a dropped record. It goes down the false branch and becomes a row in Needs Review.
const METRIC_CEILING = { loc: 5000000, tests: 100000, commits: 100000, files: 200000 };
const VALID_STATUS = ['shipped', 'live', 'delivered', 'in-development'];
const VALID_EVIDENCE_KIND = ['store-listing','live-url','test-count','repo-metric','infra-metric','video','certification','client-review','artifact'];
const YEAR_MONTH = /^\\d{4}-(0[1-9]|1[0-2])$/;

const item = $input.first().json;
const sourceName = $('Build extraction request').first().json.sourceName;
const problems = [];
const warnings = [];

let parsed = null;
try {
  parsed = JSON.parse(item.choices[0].message.content);
} catch (err) {
  // Reaching here means a provider ignored response_format and answered in prose. That is exactly what
  // require_parameters exists to prevent, so it is worth naming rather than retrying blindly.
  return [{ json: { valid: false, retryable: true, sourceName, problems: ['model returned prose, not JSON'] } }];
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const strArray = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

const metric = (v, key) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !isFinite(v)) { problems.push('metrics.' + key + ' is not a number'); return null; }
  if (v < 0) { problems.push('metrics.' + key + ' is negative (' + v + ')'); return null; }
  // An inflated metric is the most damaging thing this pipeline could publish, because the entire
  // argument is that the numbers are real.
  if (v > METRIC_CEILING[key]) { problems.push('metrics.' + key + ' of ' + v + ' exceeds the plausible ceiling of ' + METRIC_CEILING[key]); return null; }
  return Math.round(v);
};

const name = str(parsed.name);
const summary = str(parsed.summary);
if (!name) problems.push('name is missing');
if (!summary) problems.push('summary is missing');

const started = str(parsed.started);
if (started && !YEAR_MONTH.test(started)) warnings.push('started "' + started + '" is not YYYY-MM; kept as written');

let status = str(parsed.status);
if (VALID_STATUS.indexOf(status) === -1) {
  warnings.push('status "' + (status || '(empty)') + '" is not a known status; recorded as in-development');
  status = 'in-development';
}

const m = parsed.metrics || {};
const metrics = {
  loc: metric(m.loc, 'loc'),
  tests: metric(m.tests, 'tests'),
  commits: metric(m.commits, 'commits'),
  files: metric(m.files, 'files'),
};

const stack = strArray(parsed.stack);
const capabilities = strArray(parsed.capabilities);

const evidence = [];
for (const e of Array.isArray(parsed.evidence) ? parsed.evidence : []) {
  if (!e || typeof e !== 'object') continue;
  const label = str(e.label);
  const value = str(e.value);
  if (!label || !value) { warnings.push('an evidence row had no label or value; skipped'); continue; }
  const kind = VALID_EVIDENCE_KIND.indexOf(str(e.kind)) === -1 ? 'artifact' : str(e.kind);
  const url = /^https?:\\/\\//i.test(str(e.url)) ? str(e.url) : '';
  evidence.push({ label, value, url, kind });
}

// A record with no stack and no evidence describes nothing checkable. Retrying will not conjure detail
// the source never had, so it is parked rather than re-asked.
if (!stack.length && !evidence.length) {
  problems.push('no technologies and no evidence could be read from the source');
  return [{ json: { valid: false, retryable: false, sourceName, problems } }];
}

if (problems.length) {
  const structural = problems.some((p) => /is missing|not a number/.test(p));
  return [{ json: { valid: false, retryable: structural, sourceName, problems } }];
}

const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

return [{
  json: {
    valid: true,
    sourceName,
    warnings,
    project: {
      key: slug,
      Name: name,
      Role: str(parsed.role) || 'Developer',
      Started: started,
      Ended: str(parsed.ended),
      Status: status,
      Summary: summary,
      LOC: metrics.loc,
      Tests: metrics.tests,
      Commits: metrics.commits,
      Files: metrics.files,
      'Review Status': 'ok',
      Source: sourceName,
      'Ingested At': new Date().toISOString(),
    },
    stack,
    capabilities,
    evidence,
  },
}];`;
}

/**
 * Resolve the extraction's loose strings against the taxonomy already in the base.
 *
 * Without this the workflow creates a duplicate row for every technology whose slug does not happen to
 * equal its seeded Key: `slugify('Node.js')` is `node-js` while the seeded row is `nodejs`, so an upsert
 * matching on Key would miss and write a second Node.js. The local pipeline resolves through the alias
 * table; this is the same job with the aliases read out of Airtable.
 */
function resolveTaxonomyNode(): string {
  return `const validated = $('Validate extraction').first().json;

const rows = (name) => $(name).all().map((i) => i.json).filter((r) => r && r.fields);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#./\\s-]+/g, ' ').replace(/\\s+/g, ' ').trim();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-\$/g, '');
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const techRows = rows('Load technologies');
const capRows = rows('Load capabilities');

// Existing row wins. A name that matches an existing row by name OR by alias links to it; anything left
// over is genuinely new and gets created with a proper Key so the record stays readable.
const matchTech = (raw) => techRows.find((r) =>
  [r.fields.Name].concat(csv(r.fields.Aliases)).some((a) => norm(a) === norm(raw)));
const matchCap = (raw) => capRows.find((r) =>
  [r.fields.Name].concat(csv(r.fields['Match Terms'])).some((a) => norm(a) === norm(raw)));

// DELIBERATE DIFFERENCE FROM THE APPLICATION PATH, and worth knowing before you compare them.
//
// src/pipeline/link.ts creates a row for a technology or capability the taxonomy has never seen. This
// workflow does not: it links what already exists and returns the rest under 'unresolved' for a person
// to add. The reason is ordering. Creating a row and linking to it in the same run means the link write
// can land before the row write, at which point typecast creates a second, keyless row and you have a
// duplicate that read() then skips. Reporting instead of guessing is the smaller, more honest surface.
const techNames = [];
const capNames = [];
const unresolved = [];

for (const raw of validated.stack || []) {
  const hit = matchTech(raw);
  if (!hit) { if (!unresolved.includes(raw)) unresolved.push(raw); continue; }
  if (!techNames.includes(hit.fields.Name)) techNames.push(hit.fields.Name);
}

for (const raw of validated.capabilities || []) {
  const hit = matchCap(raw);
  if (!hit) { if (!unresolved.includes(raw)) unresolved.push(raw); continue; }
  if (!capNames.includes(hit.fields.Name)) capNames.push(hit.fields.Name);
}

return [{ json: { techNames, capNames, unresolved, projectName: validated.project.Name, slugOf: slug('') } }];`;
}

/**
 * One n8n item per Evidence row, each carrying its Projects link.
 *
 * Two separate bugs lived here. n8n writes one Airtable record per ITEM, so a single item carrying an
 * `evidence` array wrote exactly one row however many receipts the extraction found. And the rows had no
 * Projects link at all, so they landed in the base as orphans — in a base whose entire point is the link
 * graph, and whose "Proven Capabilities" view filters on `COUNTA({Evidence}) > 0`.
 *
 * The link is written as the project's NAME, not its record id, and the Airtable node runs with
 * `typecast: true`. Airtable then resolves a linked-record value given as a primary-field string, which
 * removes the need to thread record ids through the workflow.
 */
function fanOutEvidenceNode(): string {
  return `const validated = $('Validate extraction').first().json;
const projectKey = validated.project.key;
const projectName = validated.project.Name;
const today = new Date().toISOString().slice(0, 10);

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-\$/g, '');

return (validated.evidence || []).map((e) => ({
  json: {
    Key: ('ev-' + projectKey + '-' + slug(e.label) + '-' + slug(e.value).slice(0, 24)).slice(0, 96),
    Label: e.label,
    Kind: e.kind,
    Value: e.value,
    URL: e.url || '',
    'Verified On': today,
    Projects: [projectName],
  },
}));`;
}

/**
 * The Project row, with its taxonomy links attached in the same write.
 *
 * Linked-record fields are given as primary-field strings and the node runs with `typecast: true`;
 * Airtable resolves them to record ids, which removes any need to thread opaque ids through the
 * workflow. Verified against the installed node source: `options.typecast` becomes `body.typecast`, and
 * `matchingColumns: ['Key']` becomes Airtable's native `performUpsert.fieldsToMergeOn`.
 */
function projectRowNode(): string {
  return `const validated = $('Validate extraction').first().json;
const resolved = $('Resolve taxonomy').first().json;

const { key, ...fields } = validated.project;

return [{
  json: {
    Key: key,
    ...fields,
    Technologies: resolved.techNames,
    Capabilities: resolved.capNames,
  },
}];`;
}

function reviewStubNode(): string {
  return `// The error branch. A rejection becomes a REAL ROW with the reason attached, not a log line.
//
// A pipeline that discards what it cannot parse produces output that looks complete and is not, and the
// omission is invisible — the report simply never mentions the thing. A visible bad row is worth more
// than a clean-looking gap. This is what the "Needs Review" view lists.
const failure = $input.first().json;
const label = 'Unparsed: ' + failure.sourceName;

return [{
  json: {
    // 'Key', not 'key'. autoMapInputData matches Airtable column names exactly and matchingColumns is
    // ["Key"], so a lower-case key never matches and the parked record is never written. The error
    // branch would itself have failed silently, which would have been a particularly bad joke.
    Key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    Name: label,
    Status: 'in-development',
    Summary: 'Extraction did not produce a usable record from ' + failure.sourceName + '.',
    'Review Status': 'needs-review',
    'Review Reason': (failure.problems || []).join('; ') + (failure.retryable ? ' (retryable)' : ''),
    Source: failure.sourceName,
    'Ingested At': new Date().toISOString(),
  },
}];`;
}

const extractWorkflow = (() => {
  const nodes: N8nNode[] = [
    sticky('Overview', [-620, -180], [520, 640],
      `## Extract a project from raw evidence\n\n` +
      `POST a blob of text — a README, a package manifest, raw test output, a store listing — and this\n` +
      `writes a Project row with its Technology, Capability and Evidence links.\n\n` +
      `### The two things worth reading on this canvas\n\n` +
      `**Validation is deterministic.** The model's reply is re-checked field by field as untrusted\n` +
      `input, including range checks the JSON schema could not carry (Anthropic rejects minimum and\n` +
      `maximum on a number). An implausible metric is rejected loudly.\n\n` +
      `**Failures are stored, not dropped.** The false branch writes a real row with the reason attached,\n` +
      `which the Needs Review view lists. A pipeline that silently discards what it cannot parse produces\n` +
      `output that looks complete and is not.\n\n` +
      `### Setup\n` +
      `- Environment: OPENROUTER_API_KEY, AIRTABLE_BASE_ID\n` +
      `- Credential: an Airtable personal access token with data.records read and write\n` +
      `- Generated by \`pnpm n8n:build\`. Do not hand-edit; \`--check\` fails on drift.`),

    webhook('Evidence received', 'proof-of-work/extract', [-40, 260]),
    code('Build extraction request', [180, 260], buildExtractRequest()),
    http('Extract with Claude', [400, 260], '={{ JSON.stringify($json.request) }}'),
    code('Validate extraction', [620, 260], validateNode()),
    ifNode('Usable record?', [840, 260], '={{ $json.valid }}'),

    loadAll('Load technologies', 'Technologies', [1080, 60]),
    loadAll('Load capabilities', 'Capabilities', [1300, 60]),
    code('Resolve taxonomy', [1520, 60], resolveTaxonomyNode()),
    code('Build project row', [1740, 60], projectRowNode()),
    upsert('Write project', 'Projects', [1960, 60]),

    code('Fan out evidence', [2180, 180], fanOutEvidenceNode()),
    upsert('Write evidence rows', 'Evidence', [2400, 180]),

    respond('Respond', [2180, -40],
      `={{ {\n` +
      `  ok: true,\n` +
      `  project: $('Build project row').first().json.Name,\n` +
      `  key: $('Build project row').first().json.Key,\n` +
      `  technologiesLinked: $('Resolve taxonomy').first().json.techNames.length,\n` +
      `  capabilitiesLinked: $('Resolve taxonomy').first().json.capNames.length,\n` +
      `  unresolved: $('Resolve taxonomy').first().json.unresolved,\n` +
      `  evidenceWritten: ($('Validate extraction').first().json.evidence || []).length,\n` +
      `  warnings: $('Validate extraction').first().json.warnings\n` +
      `} }}`),

    code('Build review row', [1080, 420], reviewStubNode()),
    upsert('Write Needs Review', 'Projects', [1300, 420]),
    respond('Rejected', [1520, 420],
      `={{ {\n` +
      `  ok: false,\n` +
      `  parked: $('Build review row').first().json.Name,\n` +
      `  reason: $('Build review row').first().json['Review Reason']\n` +
      `} }}`, 422),

    sticky('Error branch note', [1040, 560], [480, 210],
      `### Needs Review — the error branch\n\n` +
      `Nothing is dropped here. A failed extraction becomes a Project row with \`Review Status\`\n` +
      `set to \`needs-review\` and the validator's problem list in \`Review Reason\`, then answers 422.\n\n` +
      `\`retryable\` distinguishes a malformed reply (worth asking again) from a source that simply\n` +
      `contained no project (asking again spends money to fail identically).`),

    sticky('Linking note', [1900, 320], [520, 250],
      `### How the links get written\n\n` +
      `Every write is an **upsert matched on \`Key\`**, which is Airtable's own \`performUpsert\`\n` +
      `— so the dedup is the write, not a separate lookup node.\n\n` +
      `Linked-record fields are written as the target's **primary-field name**, not its record id,\n` +
      `because these nodes run with \`typecast: true\`. That is what lets a Project link to\n` +
      `"React" and an Evidence row link back to its Project without threading \`rec…\` ids around.\n\n` +
      `**Deliberate difference from the app:** \`src/pipeline/link.ts\` creates a taxonomy row it has\n` +
      `never seen. This does not — it links what exists and returns the rest as \`unresolved\`, because\n` +
      `creating and linking in one run can write the link before the row and leave a duplicate.`),
  ];

  const connections = connect([
    ['Evidence received', 'Build extraction request'],
    ['Build extraction request', 'Extract with Claude'],
    ['Extract with Claude', 'Validate extraction'],
    ['Validate extraction', 'Usable record?'],
    ['Usable record?', 'Load technologies', 0],
    ['Usable record?', 'Build review row', 1],
    ['Load technologies', 'Load capabilities'],
    ['Load capabilities', 'Resolve taxonomy'],
    ['Resolve taxonomy', 'Build project row'],
    ['Build project row', 'Write project'],
    // Two branches off the write. The evidence branch may legitimately be empty (a project with no
    // receipts), and an empty branch stops there — which is why the response is its own branch and a
    // Respond node rather than whichever node happened to finish last.
    ['Write project', 'Fan out evidence'],
    ['Write project', 'Respond'],
    ['Fan out evidence', 'Write evidence rows'],
    ['Build review row', 'Write Needs Review'],
    ['Write Needs Review', 'Rejected'],
  ]);

  return workflow('Proof of Work — extract project', nodes, connections);
})();

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Workflow 2 — matching
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

function retrieveAndScoreNode(): string {
  return `// RETRIEVAL AND SCORING — pure code, no model.
//
// This node is the architectural claim of the whole system. It ranks rows that already exist in
// Airtable and computes a verdict. By the time the rationale model is called, the score is fixed and
// the citations are chosen, so the model cannot change an outcome — only describe one.
//
// Thresholds generated from src/pipeline/score.ts.
const THRESHOLD_PROVEN = ${THRESHOLD_PROVEN};
const THRESHOLD_PARTIAL = ${THRESHOLD_PARTIAL};
const MAX_CITED = 4;
const MAX_CITED_PROJECTS = 3;

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#./\\s-]+/g, ' ').replace(/\\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');

// Plurals matter ("structured output" vs "structured outputs") and so do hyphens: a single-word term
// must not match inside a compound, or "react" matches "react-three-fiber" and the report cites a
// Unity game as React experience.
const containsTerm = (haystack, needle) => {
  const term = normalize(needle);
  if (!term) return false;
  if (term.indexOf(' ') !== -1) {
    return new RegExp('(?<![a-z0-9])' + escapeRe(term) + '(?:e?s)?(?![a-z0-9])', 'i').test(haystack.replace(/-/g, ' '));
  }
  return new RegExp('(?<![a-z0-9-])' + escapeRe(term) + '(?:e?s)?(?![a-z0-9-])', 'i').test(haystack);
};

const parsed = JSON.parse($('Parse the posting').first().json.choices[0].message.content);
const rows = $('Load the record').first().json;

const requirements = (parsed.requirements || []).map((r, i) => ({
  id: 'req-' + (i + 1),
  text: String(r.text || ''),
  kind: r.kind === 'preferred' ? 'preferred' : 'required',
  category: r.category || 'process',
})).filter((r) => r.text);

const results = [];
for (const req of requirements) {
  const haystack = normalize(req.text);
  const candidates = [];

  for (const tech of rows.technologies) {
    const aliases = [tech.name].concat(tech.aliases || []);
    if (aliases.some((a) => containsTerm(haystack, a))) {
      candidates.push({ kind: 'technology', id: tech.key, name: tech.name, score: 1 });
    }
  }
  for (const cap of rows.capabilities) {
    const terms = [cap.name].concat(cap.matchTerms || []);
    if (terms.some((t) => containsTerm(haystack, t))) {
      candidates.push({ kind: 'capability', id: cap.key, name: cap.name, score: 1 });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const cited = candidates.slice(0, MAX_CITED);
  const best = cited.length ? cited[0].score : 0;

  const caps = cited.filter((c) => c.kind === 'capability').map((c) => rows.capabilities.find((x) => x.key === c.id)).filter(Boolean);

  // Projects are derived, never matched directly, and ranked by how many matched rows each contains.
  const hits = {};
  const credit = (ids) => (ids || []).forEach((id) => {
    const p = rows.projects.find((x) => x.key === id);
    if (!p || p.reviewStatus === 'needs-review') return;   // a parked record proves nothing yet
    hits[id] = (hits[id] || 0) + 1;
  });
  cited.filter((c) => c.kind === 'technology').forEach((c) => credit((rows.technologies.find((t) => t.key === c.id) || {}).projects));
  caps.forEach((c) => credit(c.projects));

  const matchedProjects = Object.keys(hits).sort((a, b) => hits[b] - hits[a] || a.localeCompare(b)).slice(0, MAX_CITED_PROJECTS);

  const evidenceIds = {};
  caps.forEach((c) => (c.evidence || []).forEach((e) => (evidenceIds[e] = true)));
  matchedProjects.forEach((id) => ((rows.projects.find((p) => p.key === id) || {}).evidence || []).forEach((e) => (evidenceIds[e] = true)));
  const evidence = Object.keys(evidenceIds);

  // THE EVIDENCE GATE. A capability with nothing linked to it cannot score as proven, however cleanly
  // it matched. Adding a capability row is easy; making it count should not be.
  let status, shortfall = null;
  if (best < THRESHOLD_PARTIAL) {
    status = 'gap';
    shortfall = 'nothing in the record matches this closely enough to claim';
  } else if (best < THRESHOLD_PROVEN) {
    status = 'partial';
    shortfall = 'matched, but not closely enough to call it a direct hit';
  } else if (!evidence.length) {
    status = 'partial';
    shortfall = 'matched, but nothing verifiable is linked to it';
  } else if (caps.length && caps.every((c) => c.tier === 'stretch')) {
    status = 'partial';
    shortfall = 'the matching capability is recorded as a stretch, not as shipped work';
  } else if (caps.length && caps.every((c) => !(c.evidence || []).length)) {
    status = 'partial';
    shortfall = 'the matching capability has no evidence linked, so it reads as unverified';
  } else {
    status = 'proven';
  }

  results.push({
    requirementId: req.id,
    requirement: req,
    status,
    score: Number(best.toFixed(3)),
    shortfall,
    matchedTechnologies: cited.filter((c) => c.kind === 'technology').map((c) => c.id),
    matchedCapabilities: cited.filter((c) => c.kind === 'capability').map((c) => c.id),
    matchedProjects,
    evidence,
  });
}

// Weighted coverage: a required item is worth twice a preferred one, and a partial counts as half.
// Weighted rather than counted, because a posting with three must-haves and eleven nice-to-haves should
// not score 79% while missing every must-have.
const WEIGHT = { required: 1, preferred: 0.5 };
const VALUE = { proven: 1, partial: 0.5, gap: 0 };
let earned = 0, possible = 0;
const tally = { proven: 0, partial: 0, gap: 0 };
let requiredCovered = 0, requiredTotal = 0;

for (const r of results) {
  const w = WEIGHT[r.requirement.kind];
  earned += w * VALUE[r.status];
  possible += w;
  tally[r.status] += 1;
  if (r.requirement.kind === 'required') { requiredTotal += 1; if (r.status === 'proven') requiredCovered += 1; }
}

return [{
  json: {
    title: parsed.title || 'Untitled role',
    company: parsed.company || '',
    requirements,
    results,
    coverage: {
      score: possible ? Math.round((earned / possible) * 100) : 0,
      proven: tally.proven, partial: tally.partial, gap: tally.gap,
      requiredCovered, requiredTotal,
    },
  },
}];`;
}

function loadRecordNode(): string {
  return `// Flatten the four Airtable reads into one object, translating record ids back into our slugs.
//
// Airtable identifies rows with opaque recXXXX ids that do not exist until a row is written, while
// everything else here identifies them by slug. Every table carries a Key field for exactly this
// reason, and this node is where the translation happens.
const table = (name) => $(name).all().map((i) => i.json);

const byRecord = {};
const collect = (rows) => rows.forEach((r) => { if (r.fields && r.fields.Key) byRecord[r.id] = r.fields.Key; });
const projectRows = table('Load projects');
const techRows = table('Load technologies');
const capRows = table('Load capabilities');
const evidenceRows = table('Load evidence');
[projectRows, techRows, capRows, evidenceRows].forEach(collect);

const links = (fields, field) => (fields[field] || []).map((id) => byRecord[id]).filter(Boolean);
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

return [{
  json: {
    projects: projectRows.map((r) => ({
      key: r.fields.Key, name: r.fields.Name, status: r.fields.Status,
      reviewStatus: r.fields['Review Status'] || 'ok',
      evidence: links(r.fields, 'Evidence'),
    })),
    technologies: techRows.map((r) => ({
      key: r.fields.Key, name: r.fields.Name, aliases: csv(r.fields.Aliases),
      projects: links(r.fields, 'Projects'),
    })),
    capabilities: capRows.map((r) => ({
      key: r.fields.Key, name: r.fields.Name, tier: r.fields.Tier,
      matchTerms: csv(r.fields['Match Terms']),
      projects: links(r.fields, 'Projects'), evidence: links(r.fields, 'Evidence'),
    })),
    evidence: evidenceRows.map((r) => ({
      key: r.fields.Key, label: r.fields.Label, value: r.fields.Value, url: r.fields.URL || null,
    })),
  },
}];`;
}

function guardNode(): string {
  return `// THE FABRICATION GUARD.
//
// Every number in a generated rationale must appear in the records that rationale was written from. A
// sentence containing an unsourced figure is discarded whole and replaced by the deterministic template
// — not repaired, because a half-trusted sentence is worse than a plain one.
//
// Numbers are the tripwire for two reasons: they are where a small model reaches for a total or a
// rounding, and they are the only claim in a fit report a reader will actually go and check.
const scored = $('Retrieve and score').first().json;
const rows = $('Load the record').first().json;
const generated = $input.all().map((i) => {
  try { return JSON.parse(i.json.choices[0].message.content).rationale; } catch (e) { return null; }
});

const numbersIn = (s) => (String(s || '').match(/(?<![a-z0-9])\\d[\\d,]*(?![a-z])/gi) || []).map((n) => n.replace(/,$/, ''));

const results = scored.results.map((r, i) => {
  const receipts = r.evidence.map((id) => rows.evidence.find((e) => e.key === id)).filter(Boolean);
  const projects = r.matchedProjects.map((id) => rows.projects.find((p) => p.key === id)).filter(Boolean);
  const corpus = [
    r.requirement.text,
    r.shortfall || '',
    projects.map((p) => p.name + ' ' + (p.status || '')).join(' '),
    receipts.map((e) => e.label + ' ' + e.value).join(' '),
  ].join('\\n');

  const where = projects.length
    ? (projects.length === 1 ? projects[0].name : projects.slice(0, -1).map((p) => p.name).join(', ') + ' and ' + projects[projects.length - 1].name)
    : 'the record';
  const subject = (rows.technologies.find((t) => t.key === r.matchedTechnologies[0]) || {}).name
    || (rows.capabilities.find((c) => c.key === r.matchedCapabilities[0]) || {}).name
    || 'This';
  const receiptText = receipts.length
    ? receipts.length + ' linked receipt' + (receipts.length === 1 ? '' : 's')
    : 'nothing verifiable linked';

  const template = r.status === 'gap'
    ? 'Nothing in the record matches this requirement.'
    : r.status === 'proven'
      ? subject + ' — shipped in ' + where + ', with ' + receiptText + '.'
      : subject + ' appears in ' + where + ' with ' + receiptText + ', but ' + (r.shortfall || 'coverage is partial') + '.';

  const written = generated[i];
  const allowed = numbersIn(corpus);
  const unsourced = written
    ? numbersIn(written).some((n) => allowed.indexOf(n) === -1 && Number(n.replace(/,/g, '')) > 12)
    : true;

  const usable = written && written.length <= 400 && !unsourced;
  return { ...r, rationale: usable ? written : template, rationaleSource: usable ? 'model' : 'template' };
});

// Everything that is not proven, required first. The Gaps section is the load-bearing claim: a scoring
// system that only reports its hits is a flattery generator, and a reader can tell.
const rank = (r) => (r.requirement.kind === 'required' ? 0 : 2) + (r.status === 'gap' ? 0 : 1);
const gaps = results.filter((r) => r.status !== 'proven').sort((a, b) => rank(a) - rank(b)).map((r) => {
  const closest = rows.evidence.find((e) => e.key === r.evidence[0]) || null;
  return {
    requirement: r.requirement,
    status: r.status,
    note: (r.shortfall || 'no match in the record').replace(/^./, (c) => c.toUpperCase()) + '.',
    closestEvidence: closest ? { label: closest.label, value: closest.value, url: closest.url } : null,
  };
});

const key = 'role-' + String(scored.company || scored.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + new Date().toISOString().slice(0, 10);

// Everything the rest of the workflow needs, in one item. The next node narrows it to the Airtable
// columns; nothing here is written directly, because autoMapInputData turns every top-level key into a
// column and would try to make one out of 'results'.
return [{ json: { key, results, gaps, coverage: scored.coverage } }];`;
}

/** Narrow the guard's output to exactly the Roles columns, and nothing else. */
function roleRowNode(): string {
  return `const scored = $('Retrieve and score').first().json;
const guarded = $('Guard rationales').first().json;
const now = new Date().toISOString();

return [{
  json: {
    Key: guarded.key,
    Title: scored.title,
    Company: scored.company,
    'Posted Text': String(($('Role received').first().json.body || {}).text || '').slice(0, 90000),
    Score: scored.coverage.score,
    'Requirement Count': scored.requirements.length,
    'Matched At': now,
    Model: ${JSON.stringify(JD_MODELS[0])},
    Source: 'n8n',
    'Ingested At': now,
  },
}];`;
}

/**
 * One Results row per requirement, citations written as links.
 *
 * Links are given as the target's primary-field value (Technology.Name, Capability.Name, Project.Name,
 * Evidence.Label, Role.Title) and the node runs with typecast, so Airtable resolves them to record ids.
 * This is the payoff of the sixth table: the citations become traversable rows instead of slugs inside
 * a string, and the Gaps view becomes a filter rather than an impossibility.
 */
function fanOutResultsNode(): string {
  return `const scored = $('Retrieve and score').first().json;
const rows = $('Load the record').first().json;
const guarded = $('Guard rationales').first().json;
const roleKey = guarded.key;
const results = guarded.results || [];

const nameOf = (table, key) => (rows[table].find((r) => r.key === key) || {}).name;
const labelOf = (key) => (rows.evidence.find((e) => e.key === key) || {}).label;

return results.map((r) => ({
  json: {
    Key: roleKey + '-' + r.requirementId,
    Requirement: r.requirement.text,
    Kind: r.requirement.kind,
    Category: r.requirement.category,
    Status: r.status,
    Shortfall: r.shortfall || '',
    'Match Score': r.score,
    Rationale: r.rationale,
    'Rationale Source': r.rationaleSource,
    Role: [scored.title],
    Technologies: r.matchedTechnologies.map((k) => nameOf('technologies', k)).filter(Boolean),
    Capabilities: r.matchedCapabilities.map((k) => nameOf('capabilities', k)).filter(Boolean),
    Projects: r.matchedProjects.map((k) => nameOf('projects', k)).filter(Boolean),
    Evidence: r.evidence.map(labelOf).filter(Boolean),
  },
}));`;
}

const matchWorkflow = (() => {
  const loadTable = (name: string, table: string, position: Position) =>
    airtable(name, position, {
      operation: 'search',
      table: { __rl: true, mode: 'name', value: table },
      returnAll: true,
    });

  const nodes: N8nNode[] = [
    sticky('Overview', [-640, -220], [520, 700],
      `## Score a job description against the record\n\n` +
      `POST \`{ "text": "<the posting>" }\` and get back a coverage score, a verdict per requirement\n` +
      `with citations, and a Gaps section.\n\n` +
      `### The claim this canvas makes\n\n` +
      `**Matching is deterministic. The model only writes sentences.**\n\n` +
      `\`Retrieve and score\` is a Code node. It ranks rows that already exist in Airtable and computes\n` +
      `every verdict and the coverage number in arithmetic. Only then is a model asked to describe each\n` +
      `outcome in one line, from the rows retrieval returned — it never sees the base, so it cannot cite\n` +
      `a project that did not match, and it cannot move a status it was told.\n\n` +
      `\`Guard rationales\` discards any generated sentence containing a number that is not in the records\n` +
      `it was written from, and falls back to the deterministic template for that row.\n\n` +
      `### Model tiering\n` +
      `- parse the posting: ${JD_MODELS[0]} (medium difficulty, short clean input)\n` +
      `- write rationales: ${RATIONALE_MODELS[0]} (easy — the facts are already chosen)\n` +
      `- score and detect gaps: no model at all\n\n` +
      `Generated by \`pnpm n8n:build\`. Do not hand-edit; \`--check\` fails on drift.`),

    webhook('Role received', 'proof-of-work/match', [-40, 320]),

    http('Parse the posting', [200, 320], JSON.stringify({
      models: JD_MODELS,
      max_tokens: 1200,
      temperature: 0,
      messages: [
        { role: 'system', content: JD_SYSTEM },
        { role: 'user', content: '={{ $json.body.text }}' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'role_parse', strict: true, schema: ROLE_PARSE_SCHEMA },
      },
      provider: { require_parameters: true },
    })),

    loadTable('Load projects', 'Projects', [440, 120]),
    loadTable('Load technologies', 'Technologies', [440, 260]),
    loadTable('Load capabilities', 'Capabilities', [440, 400]),
    loadTable('Load evidence', 'Evidence', [440, 540]),

    code('Load the record', [680, 320], loadRecordNode()),
    code('Retrieve and score', [900, 320], retrieveAndScoreNode()),

    http('Write rationales', [1120, 320], JSON.stringify({
      models: RATIONALE_MODELS,
      max_tokens: 160,
      temperature: 0.2,
      messages: [
        { role: 'system', content: RATIONALE_SYSTEM },
        { role: 'user', content: '={{ JSON.stringify($json.results) }}' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'rationale', strict: true, schema: RATIONALE_SCHEMA },
      },
      provider: { require_parameters: true },
    })),

    code('Guard rationales', [1340, 320], guardNode()),
    code('Build role row', [1560, 320], roleRowNode()),
    upsert('Write the role', 'Roles', [1780, 320]),

    code('Fan out results', [2000, 420], fanOutResultsNode()),
    upsert('Write results', 'Results', [2220, 420]),

    respond('Respond', [2000, 200],
      `={{ {\n` +
      `  ok: true,\n` +
      `  role: $('Build role row').first().json.Title,\n` +
      `  company: $('Build role row').first().json.Company,\n` +
      `  coverage: $('Guard rationales').first().json.coverage,\n` +
      `  gaps: $('Guard rationales').first().json.gaps\n` +
      `} }}`),

    sticky('Scoring note', [860, 560], [500, 250],
      `### Scored in code, not by a model\n\n` +
      `\`\`\`\n` +
      `proven   best >= ${THRESHOLD_PROVEN} AND evidence linked AND not all-stretch\n` +
      `partial  best >= ${THRESHOLD_PARTIAL} otherwise\n` +
      `gap      best <  ${THRESHOLD_PARTIAL}\n` +
      `\n` +
      `weight   required 1.0 | preferred 0.5\n` +
      `value    proven 1.0 | partial 0.5 | gap 0.0\n` +
      `score    round(100 * sum(weight*value) / sum(weight))\n` +
      `\`\`\`\n\n` +
      `**The evidence gate:** a capability with nothing linked to it cannot score proven, however well it\n` +
      `matched. That single rule is the difference between a capability record and a resume bullet.`),
  ];

  const connections = connect([
    ['Role received', 'Parse the posting'],
    ['Parse the posting', 'Load projects'],
    ['Parse the posting', 'Load technologies'],
    ['Parse the posting', 'Load capabilities'],
    ['Parse the posting', 'Load evidence'],
    ['Load projects', 'Load the record'],
    ['Load technologies', 'Load the record'],
    ['Load capabilities', 'Load the record'],
    ['Load evidence', 'Load the record'],
    ['Load the record', 'Retrieve and score'],
    ['Retrieve and score', 'Write rationales'],
    ['Write rationales', 'Guard rationales'],
    ['Guard rationales', 'Build role row'],
    ['Build role row', 'Write the role'],
    // The Role has to exist before a Result can link to it, so the results branch hangs off the write.
    // The response is its own branch for the same reason as in the extract workflow.
    ['Write the role', 'Fan out results'],
    ['Write the role', 'Respond'],
    ['Fan out results', 'Write results'],
  ]);

  return workflow('Proof of Work — match role', nodes, connections);
})();

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Write, or check
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

export const WORKFLOWS: Array<{ file: string; content: Record<string, unknown> }> = [
  { file: 'extract-project.json', content: extractWorkflow },
  { file: 'match-role.json', content: matchWorkflow },
];

function serialize(content: Record<string, unknown>): string {
  return `${JSON.stringify(content, null, 2)}\n`;
}

function main(): void {
  const check = process.argv.includes('--check');
  let drifted = 0;

  for (const { file, content } of WORKFLOWS) {
    const path = join(HERE, file);
    const next = serialize(content);

    if (check) {
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (current !== next) {
        drifted += 1;
        console.error(`✕ ${file} has drifted from the source. Run: pnpm n8n:build`);
      } else {
        console.log(`✓ ${file} matches the source`);
      }
      continue;
    }

    writeFileSync(path, next, 'utf8');
    const nodes = (content['nodes'] as unknown[]).length;
    console.log(`wrote ${file} — ${nodes} nodes`);
  }

  if (check && drifted > 0) process.exit(1);
}

// Only run when invoked directly, so tests can import WORKFLOWS without writing files.
if (process.argv[1] && process.argv[1].includes('build')) main();

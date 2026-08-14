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
import ts from 'typescript';
import { MAX_CHAIN_MODELS, modelChain } from '../src/openrouter/protocol';
import {
  JUDGMENT_SCHEMA,
  PROJECT_EXTRACTION_SCHEMA,
  ROLE_PARSE_SCHEMA,
  RATIONALE_SCHEMA,
} from '../src/openrouter/schemas';
import { EXTRACTION_SYSTEM } from '../src/pipeline/extract';
import { JD_SYSTEM } from '../src/pipeline/jd';
import { WEIGHING_SYSTEM } from '../src/pipeline/judge';
import { EMBEDDING_MODEL } from '../src/openrouter/embeddings';
import { EMBEDDINGS_ENDPOINT } from '../src/openrouter/protocol';
import { RATIONALE_SYSTEM } from '../src/pipeline/rationale';
import { THRESHOLD_PARTIAL, THRESHOLD_PROVEN } from '../src/pipeline/score';
import { DEFAULT_CANDIDATE_ID } from '../src/store/types';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Shared rules
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The scoring rules, emitted from `src/pipeline/portable.ts` rather than restated here.
 *
 * This is the fix for a whole class of defect. The evidence gate was corrected in score.ts after an
 * adversarial audit and the hand-typed copy in the Code node below was not, so the app and the workflow
 * disagreed about which requirements were proven — while `--check` stayed green, because it compares the
 * committed JSON to what THIS FILE regenerates. A hand-mirrored rule can drift from its original without
 * any check in the repo noticing. A generated one cannot: change portable.ts and the next build carries
 * it, and `tests/workflow-parity.test.ts` fails if a committed workflow was built from an older copy.
 *
 * `transpileModule` only erases the types — comments and formatting survive, so the reader of a Code node
 * sees the same annotated source the app runs, not a minified blob. The `export` keywords come off
 * because an n8n Code node is a plain script, not a module.
 */
function sharedRules(): string {
  const source = readFileSync(join(HERE, '..', 'src', 'pipeline', 'portable.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  }).outputText;

  return js
    .replace(/^export\s+/gm, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

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
  /** Run once regardless of how many items arrive. See `loadAll`. */
  executeOnce?: boolean;
  /** Present on webhook nodes; without it the production URL is never registered. */
  webhookId?: string;
  /** Node-level settings n8n reads as siblings of `parameters`: onError, retryOnFail, maxTries, … */
  onError?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  alwaysOutputData?: boolean;
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
  /** Node-level settings (onError, retryOnFail, …) — siblings of `parameters`, not members of it. */
  settings?: Record<string, unknown>,
): N8nNode {
  return {
    id: idFor(name),
    name,
    type,
    typeVersion,
    position,
    parameters,
    ...(credentials ? { credentials } : {}),
    ...(settings ?? {}),
  };
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
/**
 * `webhookId` is not decoration: without it the production URL does not exist.
 *
 * n8n registers a webhook under `{workflowId}/{node name}/{path}` when the node carries no webhookId,
 * and nothing serves that composite key — `POST /webhook/proof-of-work/match` answers 404 with "the
 * requested webhook is not registered", which reads exactly like a workflow someone forgot to activate.
 * Both workflows were activated. Import, round-trip and every structural test passed throughout, because
 * none of them ask the running server for a URL.
 *
 * Derived from the node name by the same hash as `idFor`, so it is stable across rebuilds and the drift
 * check still compares equal.
 */
const webhook = (name: string, path: string, position: Position) => ({
  ...node(name, 'n8n-nodes-base.webhook', 2, position, {
    path,
    options: {},
    httpMethod: 'POST',
    responseMode: 'responseNode',
  }),
  webhookId: idFor(`webhook:${name}`),
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

/**
 * `degrades` marks a call the pipeline is designed to survive without.
 *
 * Default is to abort, and that is the right default: if the posting parse or the extraction fails there
 * is nothing to fall back to, and the app throws in the same place. The rationale call is the one
 * exception — the app treats a failed sentence as a template sentence and carries on, so the workflow
 * must too. It matters more since the fan-out: sixteen calls where there was one means sixteen chances
 * to hit a 502, and without this a single one of them would abort a run that had already computed every
 * verdict correctly and written nothing.
 *
 * `onError` values are from n8n's own node schema (packages/workflow/src/schemas.ts).
 */
const http = (name: string, position: Position, jsonBody: string, degrades = false, url = 'https://openrouter.ai/api/v1/chat/completions') =>
  node(name, 'n8n-nodes-base.httpRequest', 4.2, position, {
    url,
    method: 'POST',
    sendBody: true,
    specifyBody: 'json',
    jsonBody,
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Authorization', value: '=Bearer {{ $env.OPENROUTER_API_KEY }}' }],
    },
    options: { timeout: 45000 },
  }, undefined, degrades
    ? {
        onError: 'continueRegularOutput',
        // Bounded and safe to repeat: the request carries no state and writes nothing. Retrying a
        // transient 502 costs a second; not retrying costs a template sentence for the rest of the run.
        retryOnFail: true,
        maxTries: 3,
        waitBetweenTries: 1000,
        // The guard needs an item per requirement to stay aligned, including for the ones that failed.
        alwaysOutputData: true,
      }
    : undefined);

const AIRTABLE_CREDENTIALS = {
  airtableTokenApi: { id: 'airtable-pat', name: 'Airtable Personal Access Token' },
};

const airtable = (name: string, position: Position, parameters: Record<string, unknown>) =>
  node(
    name,
    'n8n-nodes-base.airtable',
    // 2.2, NOT 2.1, and the difference is the whole record shape. `legacyFlattenOutput` in the node's
    // own source returns the record untouched at >= 2.2 and hoists `fields` to the top level below it:
    //
    //     if (nodeVersion >= 2.2) return record;
    //     const { fields, ...rest } = record;  return { ...rest, ...fields };
    //
    // Every Code node in these workflows reads `r.fields.Key`, so at 2.1 each one read undefined and the
    // first candidate lookup threw "candidateId is not in the Candidates table" against a table that
    // plainly contained it. 2.2 is also the installed node's defaultVersion.
    2.2,
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

/**
 * A table read that runs EXACTLY ONCE and hands its rows on.
 *
 * Two n8n behaviours collide here and `executeOnce` is what resolves both.
 *
 * An Airtable node runs once per INPUT ITEM, so chaining `Load technologies` into `Load capabilities`
 * fired the second one once per technology row — 44 sequential searches past Airtable's 5 req/s cap.
 *
 * Fanning them off a common parent instead looks like the fix and is not: a node with several incoming
 * connections executes as soon as the FIRST one delivers, so `Load the record` ran while four of its
 * five sources were still pending and threw "Node 'Load projects' hasn't been executed". Both workflows
 * were shaped that way and neither could complete a request; import, round-trip and every structural
 * test passed regardless, because none of them run the graph.
 *
 * Chained plus `executeOnce` gives ordering AND one call per table.
 */
const loadAll = (name: string, table: string, position: Position) => ({
  ...airtable(name, position, {
    operation: 'search',
    table: { __rl: true, mode: 'name', value: table },
    returnAll: true,
  }),
  executeOnce: true,
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
 * Shared auth gate
 *
 * docs/DESIGN.md §v3.7: the webhooks are not public utilities. Both workflows run the same Code node
 * immediately after their trigger, and nothing downstream — no model call, no Airtable read or write —
 * executes until the caller has presented the shared app token.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

function verifyTokenNode(): string {
  return `// THE AUTH GATE. Nothing downstream runs — no model call, no Airtable read or write — until the
// caller proves it holds the shared app token (docs/DESIGN.md §v3.7).
//
// FAIL CLOSED. If POW_APP_TOKEN is not set in the n8n environment, every request is rejected with the
// reason named, rather than waved through. An auth check that disables itself when unconfigured is
// exactly the silent fallback this repo exists to argue against.
//
// The webhook item is passed through unchanged apart from the verdict fields, so the happy path keeps
// reading body and headers exactly as it did before the gate existed.
const item = $input.first().json;

const expected = typeof $env.POW_APP_TOKEN === 'string' ? $env.POW_APP_TOKEN : '';
// HTTP header names arrive lower-cased.
const presented = String((item.headers || {})['x-pow-app-token'] || '');

// Constant-time comparison: every character is inspected regardless of where the first mismatch sits,
// so response timing does not leak how much of a guess was right.
let diff = expected.length === presented.length ? 0 : 1;
for (let i = 0; i < expected.length; i += 1) {
  diff |= expected.charCodeAt(i) ^ (presented.charCodeAt(i) || 0);
}

const configured = expected.length > 0;
const authorized = configured && presented.length > 0 && diff === 0;

return [{
  json: {
    ...item,
    authorized,
    authDetail: authorized
      ? ''
      : configured
        ? 'missing or invalid x-pow-app-token header'
        : 'POW_APP_TOKEN not configured',
  },
}];`;
}

const AUTH_STICKY =
  `### The token gate\n\n` +
  `Every request must carry the shared app token in an \`x-pow-app-token\` header, compared\n` +
  `constant-time against \`POW_APP_TOKEN\` from the n8n environment.\n\n` +
  `**It fails closed.** If the env var is unset, every request is rejected — 401 with the reason\n` +
  `named — never waved through. Someone who extracts the webhook URL from a bundle gets a door\n` +
  `that does not open.`;

const unauthorizedRespond = (position: Position) =>
  respond('Unauthorized', position,
    `={{ {\n` +
    `  error: 'unauthorized',\n` +
    `  detail: $('Verify app token').first().json.authDetail\n` +
    `} }}`, 401);

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Workflow 1 — extraction
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const EXTRACTION_MODELS = modelChain('extraction');
const JD_MODELS = modelChain('jd-parsing');
const RATIONALE_MODELS = modelChain('rationale');
const WEIGHING_MODELS = modelChain('weighing');

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
const DEFAULT_CANDIDATE_ID = ${JSON.stringify(DEFAULT_CANDIDATE_ID)};

const body = $input.first().json.body || $input.first().json;
const blob = String(body.blob || '').slice(0, 24000);
const sourceName = String(body.sourceName || 'pasted-input');
// Who owns what this ingest writes. Optional in the body; the default is the seeded candidate — the
// same default src/pipeline/index.ts applies — so every existing caller keeps working unchanged.
const candidateId = String(body.candidateId || '').trim() || DEFAULT_CANDIDATE_ID;

if (!blob.trim()) {
  throw new Error('nothing to ingest');
}
if (MODELS.length > MAX_CHAIN_MODELS) {
  throw new Error("'models' array must have " + MAX_CHAIN_MODELS + ' items or fewer');
}

return [{
  json: {
    sourceName,
    candidateId,
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
  return `/* ── generated from src/pipeline/portable.ts ─ edit that file, then run \`pnpm n8n:build\` ──
 *
 * Only normalize is called here, but the block is emitted whole: a curated subset would be a second
 * thing to keep in step, which is the problem this file exists to remove.
 */
${sharedRules()}
/* ── end generated ── */

const validated = $('Validate extraction').first().json;
const candidateId = $('Build extraction request').first().json.candidateId;

const rows = (name) => $(name).all().map((i) => i.json).filter((r) => r && r.fields);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-\$/g, '');
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// The candidate must already exist. Writing the link by name under typecast would CREATE a Candidates
// row out of a typo — the silent fallback this repo argues against — so an unknown id fails loudly
// here, before anything is written.
const candidateRow = rows('Load candidates').find((r) => r.fields.Key === candidateId);
if (!candidateRow) throw new Error('candidateId "' + candidateId + '" is not in the Candidates table');

const techRows = rows('Load technologies');
// Capabilities are owned per-candidate (docs/DESIGN.md §v3.2). Another person's claim with the same
// wording is a different row, so only this candidate's rows are on the table for matching.
const capRows = rows('Load capabilities').filter((r) => ((r.fields.Candidate || [])[0]) === candidateRow.id);

// Existing row wins, resolved with the app's own two-pass matchers — matchTechnologyRow and
// matchCapabilityRow, generated above from src/pipeline/portable.ts. This node used to compare
// normalised strings for EQUALITY and nothing else, so "Node.js 20+" and "AWS Lambda functions" —
// both verbatim in raw/01-tendril-readme.md, and both exactly what the extraction prompt asks the
// model to produce — resolved in the app and landed in 'unresolved' here. Same blob, different links,
// therefore different citations at score time.
const asTech = techRows.map((r) => ({ row: r, name: r.fields.Name, aliases: csv(r.fields.Aliases) }));
const asCap = capRows.map((r) => ({ row: r, name: r.fields.Name, matchTerms: csv(r.fields['Match Terms']) }));
const matchTech = (raw) => (matchTechnologyRow(raw, asTech) || {}).row;
const matchCap = (raw) => (matchCapabilityRow(raw, asCap) || {}).row;

// DELIBERATE DIFFERENCE FROM THE APPLICATION PATH, and worth knowing before you compare them.
//
// src/pipeline/link.ts creates a row for a technology or capability the taxonomy has never seen. This
// workflow does not: it links what already exists and returns the rest under 'unresolved' for a person
// to add. The reason is ordering. Creating a row and linking to it in the same run means the link write
// can land before the row write, at which point typecast creates a second, keyless row and you have a
// duplicate that read() then skips. Reporting instead of guessing is the smaller, more honest surface.
// Which existing row this ingest lands on, by the app's own rule — slug first, then name overlap at
// 0.8. This node had only the slug arm through the upsert Key, so "Tendril — agent-first IDE" merged in
// the app and created a second row here: one project split across two, its evidence divided.
const projectRows = rows('Load projects').filter((r) => ((r.fields.Candidate || [])[0]) === candidateRow.id);
const existingProject = duplicateProjectOf(
  // slug from the NAME, not the Key. A non-seed candidate's Key is candidate-prefixed, so
  // slugOf('candidate-jane-tendril') never equals slugOf('Tendril') and the cheap exact arm was dead
  // exactly where key collisions were the concern — dedup fell through to name overlap every time.
  projectRows.map((r) => ({ row: r, name: r.fields.Name, slug: slugOf(r.fields.Name), reviewStatus: r.fields['Review Status'] || 'ok' })),
  validated.project.Name,
).duplicate;

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

return [{ json: {
  techNames, capNames, unresolved,
  // RECORD IDS, not names. Airtable resolves a link given as a primary-field string by that string, and
  // Name is not unique: two candidates can both be "Joel Brannan" (the bundled fixture makes exactly that
  // pair), and two people can both own a project called "Acme CRM". Writing by name under typecast means
  // a link can silently land on the wrong person's row, which no candidate-scoped READ can undo. Record
  // ids are unique by construction, so ownership and citations are written to the row they were resolved
  // from. Names ride along only for the human-readable payload.
  techIds: (validated.stack || []).map(matchTech).filter(Boolean).map((r) => r.id).filter((v, i, a) => a.indexOf(v) === i),
  capIds: (validated.capabilities || []).map(matchCap).filter(Boolean).map((r) => r.id).filter((v, i, a) => a.indexOf(v) === i),
  candidateRecId: candidateRow.id,
  projectName: validated.project.Name, candidateKey: candidateId, candidateName: candidateRow.fields.Name, slugOf: slug('') } }];`;
}

/**
 * One n8n item per Evidence row, each carrying its Projects link.
 *
 * Two separate bugs lived here. n8n writes one Airtable record per ITEM, so a single item carrying an
 * `evidence` array wrote exactly one row however many receipts the extraction found. And the rows had no
 * Projects link at all, so they landed in the base as orphans — in a base whose entire point is the link
 * graph, and whose "Proven Capabilities" view filters on `COUNTA({Evidence}) > 0`.
 *
 * Links are written as RECORD IDS. Writing them as primary-field strings under `typecast` was simpler
 * and wrong: Airtable resolves such a value by matching the target's primary field, and Name is not
 * unique. Two candidates can share a name and two people can each own an "Acme CRM", so a receipt could
 * attach to the wrong person's project — a cross-candidate leak written at insert time, which no
 * candidate-scoped read can detect or undo afterwards.
 */
function fanOutEvidenceNode(): string {
  return `const validated = $('Validate extraction').first().json;
const resolved = $('Resolve taxonomy').first().json;
const DEFAULT_CANDIDATE_ID = ${JSON.stringify(DEFAULT_CANDIDATE_ID)};
const projectKey = validated.project.key;
const projectName = validated.project.Name;
// The row 'Write project' just created or updated. Airtable returns the record it wrote, so this is the
// exact row these receipts belong to rather than whichever row happens to share its Name.
const projectRecId = $('Write project').first().json.id;
const today = new Date().toISOString().slice(0, 10);

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-\$/g, '');

// Same scoping src/pipeline/index.ts applies: the seed candidate's receipts keep their established
// ids, anyone else's carry the candidate so two people's identical receipts never share a row.
const scope = resolved.candidateKey === DEFAULT_CANDIDATE_ID
  ? projectKey
  : resolved.candidateKey.replace(/^candidate-/, '') + '-' + projectKey;

return (validated.evidence || []).map((e) => ({
  json: {
    Key: ('ev-' + scope + '-' + slug(e.label) + '-' + slug(e.value).slice(0, 24)).slice(0, 96),
    // Links by record id. The project row was just written by 'Write project', which is why that node
    // comes first in the graph; its id is exact where its Name is merely probable.
    Candidate: [resolved.candidateRecId],
    Label: e.label,
    Kind: e.kind,
    Value: e.value,
    URL: e.url || '',
    'Verified On': today,
    Projects: [projectRecId],
  },
}));`;
}

/**
 * The Project row, with its taxonomy links attached in the same write.
 *
 * Linked-record fields are given as record ids, resolved in `Resolve taxonomy` from the rows it matched.
 * `typecast` stays on for the non-link fields (a select option written as its label), but no link
 * depends on it any more. Verified against the installed node source: `options.typecast` becomes
 * `body.typecast`, and `matchingColumns: ['Key']` becomes Airtable's native
 * `performUpsert.fieldsToMergeOn`.
 */
function projectRowNode(): string {
  return `/* ── generated from src/pipeline/portable.ts — edit that file, then run \`pnpm n8n:build\` ── */
${sharedRules()}
/* ── end generated ── */

const validated = $('Validate extraction').first().json;
const resolved = $('Resolve taxonomy').first().json;
const DEFAULT_CANDIDATE_ID = ${JSON.stringify(DEFAULT_CANDIDATE_ID)};

const { key, ...fields } = validated.project;
// The rule is scopedKey, generated above from src/pipeline/portable.ts. This line used to state it
// by hand — and when the shared function arrived the two collided by name, which is constraint 2 in
// that file's header doing its job rather than a coincidence.
const projectKey = scopedKey(resolved.candidateKey, key, DEFAULT_CANDIDATE_ID);

return [{
  json: {
    Key: projectKey,
    ...fields,
    // Links by record id, resolved in 'Resolve taxonomy' from the rows it actually matched, UNIONED
    // with whatever the existing row already carried. An Airtable upsert replaces a linked-record cell
    // rather than appending, so writing only this run's links erased the rest: on the documented dedup
    // demo, a second ingest of Tendril dropped React, Vite, Tailwind, Electron, SQLite, Stripe and
    // Cognito from the seeded row — and with them the reverse technology.projects entries that
    // resolution credits when it decides which projects a requirement cites. The app has always merged
    // before writing (mergeProject in src/pipeline/link.ts).
    Candidate: [resolved.candidateRecId],
    Technologies: unionLinks(resolved.existingTechIds, resolved.techIds),
    Capabilities: unionLinks(resolved.existingCapIds, resolved.capIds),
  },
}];`;
}

function reviewStubNode(): string {
  return `const DEFAULT_CANDIDATE_ID = ${JSON.stringify(DEFAULT_CANDIDATE_ID)};
/* ── generated from src/pipeline/portable.ts — edit that file, then run \`pnpm n8n:build\` ── */
${sharedRules()}
/* ── end generated ── */

// The error branch. A rejection becomes a REAL ROW with the reason attached, not a log line.
//
// A pipeline that discards what it cannot parse produces output that looks complete and is not, and the
// omission is invisible — the report simply never mentions the thing. A visible bad row is worth more
// than a clean-looking gap. This is what the "Needs Review" view lists.
const failure = $('Validate extraction').first().json;
const candidateId = $('Build extraction request').first().json.candidateId;
const label = 'Unparsed: ' + failure.sourceName;

// Parked rows carry their owner too, exactly as the app's error branch stamps its stub — and the same
// loud failure on an unknown id, so typecast can never invent a Candidates row on the error path.
const candidateRow = $('Load candidates for review').all().map((i) => i.json)
  .find((r) => r && r.fields && r.fields.Key === candidateId);
if (!candidateRow) throw new Error('candidateId "' + candidateId + '" is not in the Candidates table');

return [{
  json: {
    // 'Key', not 'key'. autoMapInputData matches Airtable column names exactly and matchingColumns is
    // ["Key"], so a lower-case key never matches and the parked record is never written. The error
    // branch would itself have failed silently, which would have been a particularly bad joke.
    //
    // Scoped by candidate, like the success path at 'Build project row'. sourceName defaults to
    // 'pasted-input' at every entry point, so this key collided across applicants: A's parked row
    // ceased to exist and reappeared inside B's record, after A had been told it was parked.
    Key: scopedKey(candidateId, slugOf(label), DEFAULT_CANDIDATE_ID),
    Name: label,
    Candidate: [candidateRow.id],
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
      `Every row written here carries its Candidate link (\`candidateId\` in the body; the default is the\n` +
      `seeded candidate). Resume intake is not on this canvas: in v3.0 the resume path runs through the\n` +
      `app server.\n\n` +
      `### Setup\n` +
      `- Environment: OPENROUTER_API_KEY, AIRTABLE_BASE_ID, POW_APP_TOKEN\n` +
      `- Credential: an Airtable personal access token with data.records read and write\n` +
      `- Generated by \`pnpm n8n:build\`. Do not hand-edit; \`--check\` fails on drift.`),

    webhook('Evidence received', 'proof-of-work/extract', [-40, 260]),
    code('Verify app token', [180, 260], verifyTokenNode()),
    ifNode('Token accepted?', [400, 260], '={{ $json.authorized }}'),
    unauthorizedRespond([620, 480]),
    sticky('Auth note', [120, 0], [480, 200], AUTH_STICKY),

    code('Build extraction request', [620, 260], buildExtractRequest()),
    http('Extract with Claude', [840, 260], '={{ JSON.stringify($json.request) }}'),
    code('Validate extraction', [1060, 260], validateNode()),
    ifNode('Usable record?', [1280, 260], '={{ $json.valid }}'),

    // Fanned off the gate, not chained one into the next. At Airtable typeVersion 2.1 a search runs
    // ONCE PER INPUT ITEM, so chaining meant 'Load capabilities' fired once per technology row — 44
    // sequential searches straight past Airtable's 5 req/s per-base cap. A 429 there aborts after the
    // OpenRouter spend and before any write, including the review stub, which is the opposite of the
    // canvas's own promise that failures are stored rather than dropped. match-role already fans.
    loadAll('Load candidates', 'Candidates', [1520, -60]),
    loadAll('Load technologies', 'Technologies', [1520, 60]),
    loadAll('Load capabilities', 'Capabilities', [1520, 180]),
    // Loaded so the dedup path can UNION rather than replace. An Airtable upsert overwrites a
    // linked-record cell — there is no append — so without the existing row a second ingest of the same
    // project erased every link the first one wrote.
    loadAll('Load projects', 'Projects', [1520, 300]),
    code('Resolve taxonomy', [2180, 60], resolveTaxonomyNode()),
    code('Build project row', [2400, 60], projectRowNode()),
    upsert('Write project', 'Projects', [2620, 60]),

    code('Fan out evidence', [2840, 60], fanOutEvidenceNode()),
    upsert('Write evidence rows', 'Evidence', [3060, 60]),

    // Its OWN branch off the write, positioned BELOW the evidence branch. Two things have to hold at
    // once and only this shape gives both:
    //
    //   The writes must finish first. Under executionOrder v1 branches run top-to-bottom by position,
    //   and this node used to sit ABOVE — so it answered ok:true before 'Write evidence rows' ran at
    //   all, and a 429 there left a project with no receipts and a caller already told it succeeded.
    //   A failing write now aborts the run before this node is reached, which is the honest outcome.
    //
    //   It must still answer when there is no evidence. A project with no receipts is legitimate, and
    //   an empty branch simply stops — so chaining Respond after the write would hang that request.
    //   Hanging on the empty case is how the first version of this fix broke it.
    respond('Respond', [2840, 220],
      `={{ {\n` +
      `  ok: true,\n` +
      `  project: $('Build project row').first().json.Name,\n` +
      `  key: $('Build project row').first().json.Key,\n` +
      `  technologiesLinked: $('Resolve taxonomy').first().json.techNames.length,\n` +
      `  capabilitiesLinked: $('Resolve taxonomy').first().json.capNames.length,\n` +
      `  unresolved: $('Resolve taxonomy').first().json.unresolved,\n` +
      // 'Fan out evidence' always executes (one item in from the project write) and emits one item per
      // evidence row, so this is the real count including zero — and it is only read after the write
      // branch has run. Reading the write node directly would throw on the empty case, where it never
      // executed at all. It used to count the VALIDATOR's list, which is what we meant to write.
      `  evidenceWritten: $('Fan out evidence').all().length,\n` +
      `  warnings: $('Validate extraction').first().json.warnings\n` +
      `} }}`),

    loadAll('Load candidates for review', 'Candidates', [1520, 420]),
    code('Build review row', [1740, 420], reviewStubNode()),
    upsert('Write Needs Review', 'Projects', [1960, 420]),
    respond('Rejected', [2180, 420],
      `={{ {\n` +
      `  ok: false,\n` +
      `  parked: $('Build review row').first().json.Name,\n` +
      `  reason: $('Build review row').first().json['Review Reason']\n` +
      `} }}`, 422),

    sticky('Error branch note', [1480, 560], [480, 210],
      `### Needs Review — the error branch\n\n` +
      `Nothing is dropped here. A failed extraction becomes a Project row with \`Review Status\`\n` +
      `set to \`needs-review\` and the validator's problem list in \`Review Reason\`, then answers 422.\n\n` +
      `\`retryable\` distinguishes a malformed reply (worth asking again) from a source that simply\n` +
      `contained no project (asking again spends money to fail identically).`),

    sticky('Linking note', [2560, 320], [520, 250],
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
    // The gate comes first. A request that cannot present the shared token answers 401 and touches
    // nothing — no model call, no Airtable read or write.
    ['Evidence received', 'Verify app token'],
    ['Verify app token', 'Token accepted?'],
    ['Token accepted?', 'Build extraction request', 0],
    ['Token accepted?', 'Unauthorized', 1],
    ['Build extraction request', 'Extract with Claude'],
    ['Extract with Claude', 'Validate extraction'],
    ['Validate extraction', 'Usable record?'],
    // Both branches resolve the candidate before they write: the true branch to link and scope, the
    // error branch so even a parked row knows its owner.
    ['Usable record?', 'Load candidates', 0],
    ['Usable record?', 'Load candidates for review', 1],
    ['Load candidates for review', 'Build review row'],
    ['Load candidates', 'Load technologies'],
    ['Load technologies', 'Load capabilities'],
    ['Load capabilities', 'Load projects'],
    ['Load projects', 'Resolve taxonomy'],
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

/* ── generated from src/pipeline/portable.ts — edit that file, then run \`pnpm n8n:build\` ──
 *
 * Everything between here and the end of this block is the app's own source, type-stripped. The rules
 * that decide a verdict are not restated in this workflow; they are compiled into it. Editing them here
 * is pointless — the next build overwrites it, and tests/workflow-parity.test.ts fails in the meantime.
 */
${sharedRules()}
/* ── end generated ── */

const parsed = $('Posting requirements').first().json;
const rows = $('Load the record').first().json;

// One normalisation, then everything below is the app's own functions. Airtable rows carry Key as the
// logical id and id as the opaque record id; resolution reads id, so the two are swapped here once
// rather than at every call site.
const snap = {
  technologies: rows.technologies.map((t) => ({ id: t.key, projects: t.projects || [] })),
  capabilities: rows.capabilities.map((c) => ({ id: c.key, tier: c.tier, projects: c.projects || [], evidence: c.evidence || [] })),
  projects: rows.projects.map((p) => ({ id: p.key, reviewStatus: p.reviewStatus, evidence: p.evidence || [] })),
  evidence: rows.evidence.map((e) => ({ id: e.key, label: e.label })),
};

const embedded = $('Collect vectors').first().json;

const requirements = (parsed.requirements || []).map((r, i) => ({
  id: 'req-' + (i + 1),
  text: String(r.text || ''),
  kind: r.kind === 'preferred' ? 'preferred' : 'required',
  category: r.category || 'process',
})).filter((r) => r.text);

const results = [];
requirements.forEach((req, reqIndex) => {
  const haystack = normalize(req.text);
  const candidates = [];
  // Absent when the embeddings call failed or returned short, which drops this requirement to lexical
  // only — reported, never hidden.
  const reqVector = embedded.ok ? embedded.requirementVectors[reqIndex] : undefined;

  // HYBRID: the better of a literal hit and a semantic one, exactly as src/pipeline/match.ts does. The
  // workflow scored lexical alone, so a posting describing a capability without naming it read as a gap
  // in this lane and as coverage in the app.
  for (const tech of rows.technologies) {
    const lexical = lexicalTechnologyScore(haystack, tech);
    const dense = denseScore(reqVector, embedded.vectors[vectorKeyFor('technology', tech.key)]);
    const score = Math.max(lexical, dense);
    if (score > 0) candidates.push({ kind: 'technology', id: tech.key, name: tech.name, score: score });
  }
  for (const cap of rows.capabilities) {
    // Scored against the RAW requirement text as well as the normalised haystack: the overlap fallback
    // inside tokenises for itself, and handing it a pre-normalised string changes its answer.
    const lexical = lexicalCapabilityScore(req.text, haystack, cap);
    const dense = denseScore(reqVector, embedded.vectors[vectorKeyFor('capability', cap.key)]);
    const score = Math.max(lexical, dense);
    if (score > 0) candidates.push({ kind: 'capability', id: cap.key, name: cap.name, score: score });
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const cited = topCited(candidates);
  const best = cited.length ? cited[0].score : 0;

  // THE DETERMINISTIC FLOOR. resolveRequirement runs the projects/evidence derivation and the evidence
  // gate — generated above from src/pipeline/portable.ts, so this cannot drift from src/pipeline/score.ts.
  // No strength is passed: this is the answer before any model was consulted, and 'Apply weighing'
  // compares against it.
  const resolution = resolveRequirement(cited, best, snap, { thresholdProven: THRESHOLD_PROVEN, thresholdPartial: THRESHOLD_PARTIAL });

  results.push({
    requirementId: req.id,
    requirement: req,
    status: resolution.status,
    score: Number(best.toFixed(3)),
    shortfall: resolution.shortfall,
    matchedTechnologies: resolution.matchedTechnologies,
    matchedCapabilities: resolution.matchedCapabilities,
    matchedProjects: resolution.matchedProjects,
    evidence: resolution.evidence,
    // Carried so the weighing pass can be asked about the same rows, and so 'Apply weighing' can
    // re-resolve from them rather than trusting anything the model returns.
    cited: cited,
    best: best,
  });
});

// Weighted coverage — coverageOf, generated above from src/pipeline/portable.ts. The weights are not
// restated here on purpose: a hand-typed pair in this node is exactly how the two lanes came to publish
// different percentages for the same posting.
const coverage = coverageOf(results.map((r) => ({ kind: r.requirement.kind, status: r.status })));

return [{
  json: {
    retrieval: embedded.ok ? 'hybrid' : 'lexical',
    retrievalDetail: embedded.detail,
    title: parsed.title || 'Untitled role',
    company: parsed.company || '',
    requirements,
    results,
    coverage,
  },
}];`;
}

function loadRecordNode(): string {
  return `// Flatten the five Airtable reads into one object, translating record ids back into our slugs.
//
// Airtable identifies rows with opaque recXXXX ids that do not exist until a row is written, while
// everything else here identifies them by slug. Every table carries a Key field for exactly this
// reason, and this node is where the translation happens.
const DEFAULT_CANDIDATE_ID = ${JSON.stringify(DEFAULT_CANDIDATE_ID)};
const table = (name) => $(name).all().map((i) => i.json);

// Whose record goes on the table. Optional in the webhook body; the default is the seeded candidate —
// the same default src/pipeline/index.ts applies — so every existing caller keeps working unchanged.
const requested = String((($('Role received').first().json.body) || {}).candidateId || '').trim();
const candidateId = requested || DEFAULT_CANDIDATE_ID;

const candidateRows = table('Load candidates');
const candidateRow = candidateRows.find((r) => r.fields && r.fields.Key === candidateId);
// Loud, not silent: scoring an unknown candidate against an empty record would report all-gaps and
// look exactly like an answer.
if (!candidateRow) throw new Error('candidateId "' + candidateId + '" is not in the Candidates table');

const byRecord = {};
const collect = (rows) => rows.forEach((r) => { if (r.fields && r.fields.Key) byRecord[r.id] = r.fields.Key; });
const projectAll = table('Load projects');
const techRows = table('Load technologies');
const capAll = table('Load capabilities');
const evidenceAll = table('Load evidence');
[candidateRows, projectAll, techRows, capAll, evidenceAll].forEach(collect);

// Scope before scoring, exactly as src/pipeline/index.ts does: projects, capabilities and evidence are
// owned per-candidate; technologies stay global — React is React for everyone. Rows the scorer never
// sees are rows it structurally cannot cite.
const mine = (r) => (((r.fields && r.fields.Candidate) || [])[0]) === candidateRow.id;
const projectRows = projectAll.filter(mine);
const capRows = capAll.filter(mine);
const evidenceRows = evidenceAll.filter(mine);

const links = (fields, field) => (fields[field] || []).map((id) => byRecord[id]).filter(Boolean);
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Only the metrics that are actually set, in the adapter's order — an absent metric must be absent,
// not zero, or the context reads "0 tests" about a project nobody counted.
const metricsOf = (f) => {
  const out = {};
  if (f.LOC !== undefined && f.LOC !== null) out.loc = f.LOC;
  if (f.Tests !== undefined && f.Tests !== null) out.tests = f.Tests;
  if (f.Commits !== undefined && f.Commits !== null) out.commits = f.Commits;
  if (f.Files !== undefined && f.Files !== null) out.files = f.Files;
  return out;
};

// Every row carries the record id it was read from, so the write side can cite the exact row that
// matched instead of asking Airtable to find one by display name. Name is not unique — two candidates
// can share one (the bundled fixture makes that pair), and so can two people's projects — so a link
// written by name can land on the wrong person's row, which no candidate-scoped read can undo.
return [{
  json: {
    candidate: { key: candidateId, name: candidateRow.fields.Name, id: candidateRow.id },
    projects: projectRows.map((r) => ({
      id: r.id,
      key: r.fields.Key, name: r.fields.Name, status: r.fields.Status,
      // Started, Summary and the four metrics are here because the rationale context is built from
      // them. Projecting a narrower project row than the app reads made the guard's corpus narrower
      // than the model's prompt, so a sentence citing a real metric was rejected as a fabrication.
      // The key order matches src/store/airtable.ts, because the context prints them in object order.
      started: r.fields.Started, summary: r.fields.Summary,
      metrics: metricsOf(r.fields),
      reviewStatus: r.fields['Review Status'] || 'ok',
      evidence: links(r.fields, 'Evidence'),
    })),
    technologies: techRows.map((r) => ({
      id: r.id,
      key: r.fields.Key, name: r.fields.Name, aliases: csv(r.fields.Aliases),
      projects: links(r.fields, 'Projects'),
    })),
    capabilities: capRows.map((r) => ({
      id: r.id,
      key: r.fields.Key, name: r.fields.Name, tier: r.fields.Tier,
      matchTerms: csv(r.fields['Match Terms']),
      projects: links(r.fields, 'Projects'), evidence: links(r.fields, 'Evidence'),
    })),
    evidence: evidenceRows.map((r) => ({
      id: r.id,
      key: r.fields.Key, label: r.fields.Label, value: r.fields.Value, url: r.fields.URL || null,
    })),
  },
}];`;
}

/**
 * Read the posting in code first, exactly as src/pipeline/jd.ts does.
 *
 * The workflow used to wire its webhook straight into the parse model, unconditionally. That is not a
 * missing optimisation — it is a different answer. On the bundled sample the model returns 18
 * paraphrased requirements and scores 66; the deterministic reader takes the 16 bullets verbatim and
 * scores 75. Both lanes upsert the SAME Roles key, so a same-day n8n run silently rewrote the app's row
 * and the pinned 75/10/4/2/16 anchor was an app-lane-only fact.
 *
 * The gate is the PASS that answered, not a requirement count — see jd.ts for why that replaced
 * "fewer than four" in 2026-07-30. Bulleted or unmarked is read verbatim and no model is called at all.
 */
function readPostingNode(): string {
  return `// READ THE POSTING WITHOUT A MODEL.
/* ── generated from src/pipeline/portable.ts — edit that file, then run \`pnpm n8n:build\` ── */
${sharedRules()}
/* ── end generated ── */

const READ_VERBATIM = ['bulleted', 'unmarked'];

const body = $input.first().json.body || $input.first().json;
const text = String(body.text || '');
if (!text.trim()) {
  throw new Error('no posting text supplied');
}

const role = parseRoleDeterministically(text);
// Prose, or nothing at all, is the one shape a model reads better. Everything else is already exact.
const needsModel = READ_VERBATIM.indexOf(role.pass) === -1;

return [{ json: { text: text, role: role, pass: role.pass, needsModel: needsModel, candidateId: body.candidateId || '' } }];`;
}

/**
 * The single name everything downstream reads, whichever branch ran.
 *
 * Both branches of `Needs a model?` land here, so the rest of the workflow references ONE node instead
 * of reaching into `Parse the posting`, which does not execute on the deterministic path. It also
 * carries the provenance: `Build role row` used to hardcode JD_MODELS[0] into the Roles row, so a
 * fallthrough to the second model in the chain left no trace — the exact event the repo's "never a
 * silent fallback" rule exists to expose.
 */
function postingRequirementsNode(): string {
  return `// WHICHEVER PASS ANSWERED, in one shape.
/* ── generated from src/pipeline/portable.ts — edit that file, then run \`pnpm n8n:build\` ── */
${sharedRules()}
/* ── end generated ── */

const read = $('Read the posting').first().json;
const item = $input.first().json;

// A model reply carries choices; the deterministic item does not.
if (item && item.choices) {
  const parsed = JSON.parse(item.choices[0].message.content);
  const requirements = (parsed.requirements || []).map((r, i) => ({
    id: 'req-' + (i + 1),
    text: String(r.text || ''),
    kind: r.kind === 'preferred' ? 'preferred' : 'required',
    category: r.category || 'process',
  })).filter((r) => r.text);

  return [{ json: {
    title: parsed.title || read.role.title || 'Untitled role',
    company: parsed.company || read.role.company || '',
    requirements: requirements,
    via: 'model',
    // The model OpenRouter actually served, not the first one we asked for.
    model: item.model || 'unknown',
    note: 'Parsed by a model because the posting reads as prose.',
  } }];
}

if (read.role.requirements.length === 0) {
  // Never a blank report: the app raises UnreadablePostingError here rather than rendering zero rows.
  throw new Error('the posting could not be read as requirements');
}

return [{ json: {
  title: read.role.title,
  company: read.role.company,
  requirements: read.role.requirements,
  via: 'deterministic',
  model: 'none',
  note: read.pass === 'bulleted' ? null : 'Read as an unmarked list.',
} }];`;
}

/**
 * Builds the posting-parse request, because an n8n parameter is only an EXPRESSION when it starts
 * with `=`.
 *
 * This node exists to fix a defect that made the whole match lane inert. `jsonBody` was a
 * `JSON.stringify({...})` — a string starting with `{` — with `={{ $json.body.text }}` nested inside
 * it. n8n's `isExpression` is `expr.charAt(0) === '='` and `resolveSimpleParameterValue` returns any
 * other string untouched, so the nested `{{ }}` was never resolved: OpenRouter received the eleven
 * characters `={{ $json.` and so on as the job posting, and scored a real applicant against it. The
 * workflow imported cleanly, round-tripped cleanly, and drift-checked cleanly the entire time, because
 * none of those execute it.
 *
 * Prefixing the existing string with `=` is NOT the fix. That makes the whole body one template, and a
 * posting containing a quote or a newline — every pasted posting — would be substituted in raw and
 * produce invalid JSON. Building the object here and sending `={{ JSON.stringify($json.request) }}`
 * escapes it exactly once, which is why `Build extraction request` has always done it this way.
 */
function buildParseRequest(): string {
  return `// Builds the OpenRouter request for the posting parse. Constants generated from src/openrouter
// and src/pipeline/jd.ts. Do not hand-edit: pnpm n8n:build --check will fail.
const MODELS = ${JSON.stringify(JD_MODELS)};
const SYSTEM = ${JSON.stringify(JD_SYSTEM)};
const SCHEMA = ${JSON.stringify(ROLE_PARSE_SCHEMA)};

// Arrives from 'Read the posting', which already validated it.
const text = String($input.first().json.text || '').slice(0, 24000);

return [{
  json: {
    text: text,
    request: {
      models: MODELS,
      max_tokens: 1200,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'role_parse', strict: true, schema: SCHEMA } },
      // Stops OpenRouter routing to an endpoint that ignores response_format and answers in prose
      // with a 200.
      provider: { require_parameters: true },
    },
  },
}];`;
}

/**
 * Everything that gets embedded, in one request.
 *
 * The workflow had no embeddings call at all: it scored from lexical hits alone and printed a
 * dense-only match as a gap, while src/ui/api.ts published embeddings as "ready — handled inside the
 * workflow". The app makes two calls (corpus, then requirements) because they are separate batches in
 * separate functions; embedding is per-text, so one call returning both in a known order is the same
 * vectors and one fewer round trip. The offset is recorded rather than recomputed, because guessing
 * where the corpus stops and the queries start is how every requirement ends up paired with the wrong
 * capability.
 */
function buildEmbedRequestNode(): string {
  return `// EMBED THE RECORD AND THE POSTING, in one request.
/* ── generated from src/pipeline/portable.ts — edit that file, then run \`pnpm n8n:build\` ── */
${sharedRules()}
/* ── end generated ── */

const MODEL = ${JSON.stringify(EMBEDDING_MODEL)};

const parsed = $('Posting requirements').first().json;
const rows = $('Load the record').first().json;

const keys = [];
const texts = [];
for (const tech of rows.technologies) {
  keys.push(vectorKeyFor('technology', tech.key));
  texts.push(embedTextForRow(tech));
}
for (const cap of rows.capabilities) {
  keys.push(vectorKeyFor('capability', cap.key));
  texts.push(embedTextForRow(cap));
}

const requirements = (parsed.requirements || []).map((r) => String(r.text || '')).filter(Boolean);
const corpusCount = texts.length;

return [{ json: {
  keys: keys,
  corpusCount: corpusCount,
  requirementCount: requirements.length,
  request: { model: MODEL, input: texts.concat(requirements), encoding_format: 'float' },
} }];`;
}

/**
 * Split the response back into a corpus lookup and one vector per requirement.
 *
 * OpenRouter documents an \`index\` on each row, and it is honoured rather than assumed: a reordered
 * batch would pair every requirement with the wrong capability, and nothing downstream could tell.
 * A short, empty or failed response degrades to lexical-only and SAYS SO — 'Retrieve and score' reads
 * \`ok\` and the Respond node reports the retrieval mode, because a hidden degradation is the one thing
 * this repo's "never a silent fallback" rule exists to prevent.
 */
function collectVectorsNode(): string {
  return `// SPLIT THE EMBEDDINGS BACK OUT, or degrade to lexical and say so.
const asked = $('Build embed request').first().json;
const payload = $input.first().json;

const rowsOut = (payload && payload.data) || [];
const expected = asked.corpusCount + asked.requirementCount;

let ok = rowsOut.length === expected;
const ordered = new Array(expected);
if (ok) {
  rowsOut.forEach((row, i) => {
    const at = typeof row.index === 'number' ? row.index : i;
    ordered[at] = row.embedding || [];
  });
  ok = ordered.every((v) => v && v.length > 0);
}

if (!ok) {
  // Not an error: retrieval falls back to lexical, which is a real degradation and a correct one.
  return [{ json: { ok: false, vectors: {}, requirementVectors: [], detail: rowsOut.length === 0 ? 'no embeddings returned' : 'expected ' + expected + ' vectors, got ' + rowsOut.length } }];
}

const vectors = {};
asked.keys.forEach((k, i) => { vectors[k] = ordered[i]; });

return [{ json: {
  ok: true,
  vectors: vectors,
  requirementVectors: ordered.slice(asked.corpusCount),
  detail: null,
} }];`;
}

/**
 * One weighing call per requirement, so a model can lower a verdict but never raise one.
 *
 * The workflow had no weighing pass at all: it called gateStatus without `strength`, so the
 * `weighedThin` branch was dead by construction and the app's four guards protected one lane. CLAUDE.md
 * lists "weighing can only lower a verdict" among the non-negotiables. Both lanes upsert the same Roles
 * key, so the lane without weighing could overwrite the lane with it — which is how a guarantee that
 * holds everywhere it is tested still fails in production.
 *
 * A requirement with nothing cited is flagged `skip`, and 'Apply weighing' discards whatever comes back
 * for it — there is nothing to weigh, and asking invites the model to invent something to weigh.
 *
 * KNOWN COST, stated rather than hidden: the item is still emitted, so the http node still calls the
 * model for it. src/pipeline/judge.ts returns early on an empty candidate list and makes no call at all,
 * so this lane spends one request per unweighable requirement more than the app does. It is safe —
 * `applyJudgments` drops every id it did not send, so the requirement falls through to unweighed — and
 * the obvious fix is worse: filtering the skipped items out means a posting where nothing matches emits
 * an empty branch, 'Apply weighing' never executes, and 'Fan out rationales' throws reading it.
 */
function fanOutJudgeNode(): string {
  return `// FAN OUT: one weighing call per requirement, exactly as src/pipeline/index.ts does.
const MODELS = ${JSON.stringify(WEIGHING_MODELS)};
const SYSTEM = ${JSON.stringify(WEIGHING_SYSTEM)};
const SCHEMA = ${JSON.stringify(JUDGMENT_SCHEMA)};

const scored = $('Retrieve and score').first().json;
const rows = $('Load the record').first().json;

const capOf = (key) => rows.capabilities.find((c) => c.key === key);
const techOf = (key) => rows.technologies.find((t) => t.key === key);
const projOf = (key) => rows.projects.find((p) => p.key === key);
const evOf = (key) => rows.evidence.find((e) => e.key === key);

return scored.results.map((r, i) => {
  // Everything the weighing model may see about this requirement: the rows retrieval returned, what
  // each is, and the receipts each carries. It never sees the base, so it cannot name a row that did
  // not match — and applyJudgments drops any id it returns that was not sent.
  const lines = ['Requirement (' + r.requirement.kind + '): ' + r.requirement.text, '', 'Retrieved rows:'];
  for (const c of r.cited) {
    if (c.kind === 'capability') {
      const cap = capOf(c.id) || {};
      const receipts = (cap.evidence || []).map((k) => (evOf(k) || {}).label).filter(Boolean);
      lines.push('- id=' + c.id + ' [capability, tier ' + (cap.tier || 'unknown') + '] ' + c.name +
        (receipts.length ? ' — receipts: ' + receipts.join('; ') : ' — no receipts linked'));
    } else {
      const tech = techOf(c.id) || {};
      const projects = (tech.projects || []).map((k) => (projOf(k) || {}).name).filter(Boolean);
      lines.push('- id=' + c.id + ' [technology] ' + c.name +
        (projects.length ? ' — used in: ' + projects.join(', ') : ' — no projects linked'));
    }
  }

  return { json: {
    __index: i,
    requirementId: r.requirementId,
    skip: r.cited.length === 0,
    request: {
      models: MODELS,
      max_tokens: 700,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: lines.join('\\n') },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'match_judgment', strict: true, schema: SCHEMA } },
      provider: { require_parameters: true },
    },
  } };
});`;
}

/**
 * Resolve every requirement a SECOND time with the model's numbers, and keep whichever came out worse.
 *
 * This is the whole guarantee. It holds for a reply that rates every row 1.0, for one naming ids from
 * another candidate's record, and for one written by someone who wants a better score, because none of
 * those can produce a status that beats an answer the model was never consulted about — the
 * deterministic resolution computed in 'Retrieve and score' before any model ran.
 *
 * A failed or malformed call costs that requirement its weighing, not the run: the deterministic answer
 * stands, which is exactly what the app does when callJson returns not-ok.
 */
function applyWeighingNode(): string {
  return `// WEIGH, THEN KEEP THE WORSE. src/pipeline/score.ts worseOf, DESIGN.md v3.8.
const THRESHOLD_PROVEN = ${THRESHOLD_PROVEN};
const THRESHOLD_PARTIAL = ${THRESHOLD_PARTIAL};

/* ── generated from src/pipeline/portable.ts — edit that file, then run \`pnpm n8n:build\` ── */
${sharedRules()}
/* ── end generated ── */

const scored = $('Retrieve and score').first().json;
const rows = $('Load the record').first().json;
const asked = $('Fan out judge').all().map((i) => i.json);

const snap = {
  technologies: rows.technologies.map((t) => ({ id: t.key, projects: t.projects || [] })),
  capabilities: rows.capabilities.map((c) => ({ id: c.key, tier: c.tier, projects: c.projects || [], evidence: c.evidence || [] })),
  projects: rows.projects.map((p) => ({ id: p.key, reviewStatus: p.reviewStatus, evidence: p.evidence || [] })),
  evidence: rows.evidence.map((e) => ({ id: e.key, label: e.label })),
};

// Position is the alignment: an http node emits one item per input item, in order. See 'Guard rationales'.
const replies = {};
$input.all().forEach((item, position) => {
  const stamped = item.json && item.json.__index;
  const index = typeof stamped === 'number' ? stamped : position;
  try {
    replies[index] = JSON.parse(item.json.choices[0].message.content);
  } catch (e) {
    replies[index] = null;   // one bad reply costs one weighing, never the run
  }
});

let demoted = 0;
let weighedCount = 0;

const results = scored.results.map((r, i) => {
  const deterministic = {
    status: r.status,
    matchedTechnologies: r.matchedTechnologies,
    matchedCapabilities: r.matchedCapabilities,
    matchedProjects: r.matchedProjects,
    evidence: r.evidence,
    shortfall: r.shortfall,
  };

  const raw = replies[i];
  if (!raw || (asked[i] && asked[i].skip)) {
    return Object.assign({}, r, { weighed: false, strength: null });
  }

  // Bound the reply BEFORE it is read: unknown ids dropped, unbacked strengths clamped, a receipt the
  // row does not carry rejected. applyJudgments in portable.ts holds all four guards.
  const judgments = applyJudgments(raw, r.cited, snap, THRESHOLD_PROVEN);
  if (judgments.length === 0) {
    return Object.assign({}, r, { weighed: false, strength: null });
  }

  const strength = strengthOfJudgments(judgments);
  const kept = pruneCandidates(r.cited, judgments);
  const weighed = resolveRequirement(kept, r.best, snap, { thresholdProven: THRESHOLD_PROVEN, thresholdPartial: THRESHOLD_PARTIAL }, strength);

  const final = worseOf(deterministic, weighed);
  weighedCount += 1;
  // Compare the STATUS, not the object: worseOf returns the weighed object on a tie for its narrower
  // citations, so identity is true on almost every requirement and counting it read "16 of 16 lowered"
  // on a run that lowered nothing.
  if (final.status !== deterministic.status) demoted += 1;

  return Object.assign({}, r, {
    status: final.status,
    shortfall: final.shortfall,
    matchedTechnologies: final.matchedTechnologies,
    matchedCapabilities: final.matchedCapabilities,
    matchedProjects: final.matchedProjects,
    evidence: final.evidence,
    weighed: true,
    strength: strength,
  });
});

// Recomputed from the FINAL statuses, not carried over from the deterministic pass.
const coverage = coverageOf(results.map((r) => ({ kind: r.requirement.kind, status: r.status })));

return [{ json: {
  title: scored.title,
  company: scored.company,
  requirements: scored.requirements,
  results: results,
  coverage: coverage,
  retrieval: scored.retrieval,
  retrievalDetail: scored.retrievalDetail,
  weighing: { weighed: weighedCount, demoted: demoted, source: weighedCount > 0 ? 'model' : 'unweighed' },
} }];`;
}

/**
 * One item per requirement, each carrying the exact prompt that requirement's rationale is written from.
 *
 * This node exists because `Write rationales` used to be a SINGLE call: every requirement was stringified
 * into one message, under a system prompt that says "you write one sentence" and a 160-token ceiling. The
 * guard then read `$input.all()`, got one item, and indexed it per requirement — so requirement 1 received
 * a sentence composed from all sixteen requirements' material, and requirements 2 through 16 read
 * `undefined` and silently fell back to the template. The n8n lane was shipping fifteen template sentences
 * and calling one of them a model rationale.
 *
 * An n8n HTTP node runs once per input item, so emitting N items here is what makes the fan-out real. The
 * app calls `writeRationale` once per requirement for the same reason.
 */
function fanOutRationalesNode(): string {
  return `// FAN OUT: one model call per requirement, exactly as src/pipeline/index.ts does.
//
// Reads 'Apply weighing', never 'Retrieve and score': the rationale must describe the verdict that was
// actually written, and weighing can lower one. Writing prose from the pre-weighed citations is how the
// app once produced a sentence about store certification under a requirement the model had scored 0.
//
// The request is assembled HERE rather than in the http node's jsonBody, because a jsonBody that does
// not start with '=' is a fixed string and its nested {{ }} is never resolved. See buildParseRequest.
const MODELS = ${JSON.stringify(RATIONALE_MODELS)};
const SYSTEM = ${JSON.stringify(RATIONALE_SYSTEM)};
const SCHEMA = ${JSON.stringify(RATIONALE_SCHEMA)};
/* ── generated from src/pipeline/portable.ts — edit that file, then run \\\`pnpm n8n:build\\\` ──
 *
 * buildRationaleContext and templateRationale below are the app's own source, type-stripped. The prompt
 * this node builds IS the corpus the guard checks the answer against, which is only true because one
 * function builds both.
 */
${sharedRules()}
/* ── end generated ── */

const scored = $('Apply weighing').first().json;
const rows = $('Load the record').first().json;

const nameOf = (list, key) => {
  const hit = list.find((x) => x.key === key);
  return hit ? hit.name : key;
};

return scored.results.map((r, i) => {
  const input = {
    requirementText: r.requirement.text,
    requirementKind: r.requirement.kind,
    status: r.status,
    technologies: r.matchedTechnologies.map((k) => nameOf(rows.technologies, k)),
    capabilities: r.matchedCapabilities.map((k) => nameOf(rows.capabilities, k)),
    projects: r.matchedProjects.map((k) => rows.projects.find((p) => p.key === k)).filter(Boolean),
    evidence: r.evidence.map((k) => rows.evidence.find((e) => e.key === k)).filter(Boolean),
    shortfall: r.shortfall || null,
  };
  const context = buildRationaleContext(input);
  // __index travels with the item so the guard can realign if anything reorders or drops.
  return { json: { __index: i, requirementId: r.requirementId, input: input, context: context, request: {
    models: MODELS,
    max_tokens: 160,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: context },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'rationale', strict: true, schema: SCHEMA } },
    provider: { require_parameters: true },
  } } };
});`;
}

function guardNode(): string {
  return `const DEFAULT_CANDIDATE_ID = ${JSON.stringify(DEFAULT_CANDIDATE_ID)};
// THE FABRICATION GUARD.
//
// Every number in a generated rationale must appear in the records that rationale was written from. A
// sentence containing an unsourced figure is discarded whole and replaced by the deterministic template
// — not repaired, because a half-trusted sentence is worse than a plain one.
//
// Numbers are the tripwire for two reasons: they are where a small model reaches for a total or a
// rounding, and they are the only claim in a fit report a reader will actually go and check.
/* ── generated from src/pipeline/portable.ts — edit that file, then run \`pnpm n8n:build\` ──
 *
 * The guard below is the app's own source, type-stripped. It carried a hand-typed copy of the number
 * check and no adjective ban whatsoever, so a live run's "extensive experience with Claude Code" would
 * have been rejected by the app and written to Airtable by this workflow.
 */
${sharedRules()}
/* ── end generated ── */

const scored = $('Apply weighing').first().json;
const rows = $('Load the record').first().json;
const contexts = $('Fan out rationales').all().map((i) => i.json);

// One model item per requirement. POSITION is the alignment: an HTTP node emits one item per input
// item in order, and replaces the json with the response body, so the __index the fan-out stamped does
// NOT survive the call. It is read when present anyway, because it costs one line and the failure it
// guards against is undetectable — a sentence about the wrong requirement, printed under the right
// heading, reads perfectly. alwaysOutputData keeps the count right when a call fails.
const written = {};
$input.all().forEach((item, position) => {
  const stamped = item.json && item.json.__index;
  const index = typeof stamped === 'number' ? stamped : position;
  try {
    written[index] = JSON.parse(item.json.choices[0].message.content).rationale;
  } catch (e) {
    // One malformed reply costs ONE template sentence, never the batch. The app degrades per
    // requirement because it calls per requirement; this does the same.
    written[index] = null;
  }
});

const results = scored.results.map((r, i) => {
  // The corpus is the prompt, byte for byte — the same string the model was given, built once in the
  // fan-out by the app's own buildRationaleContext. Two descriptions of "what the model saw" is how the
  // guard came to reject true sentences.
  const ctx = contexts[i] || {};
  const corpus = ctx.context || '';
  const template = templateRationale(ctx.input || {});

  const sentence = written[i];
  const verdict = checkRationale(sentence, corpus);
  const usable = verdict.usable;
  return { ...r, rationale: usable ? sentence : template, rationaleSource: usable ? 'model' : 'template' };
});

// Everything that is not proven, required first. The Gaps section is the load-bearing claim: a scoring
// system that only reports its hits is a flattery generator, and a reader can tell.
const rank = (r) => (r.requirement.kind === 'required' ? 0 : 2) + (r.status === 'gap' ? 0 : 1);
const gaps = results.filter((r) => r.status !== 'proven').sort((a, b) => rank(a) - rank(b)).map((r) => {
  const closest = rows.evidence.find((e) => e.key === r.evidence[0]) || null;
  return {
    requirement: r.requirement,
    status: r.status,
    note: gapNote(r.shortfall, r.matchedProjects.map((k) => {
      const p = rows.projects.find((x) => x.key === k);
      return p ? p.name : k;
    })),
    closestEvidence: closest ? { label: closest.label, value: closest.value, url: closest.url } : null,
  };
});

// Scoped to the candidate, via scopedKey generated above. A Roles row is a FIT REPORT — its Score and
// Requirement Count describe one applicant — and this key carried no candidate at all, so two people
// scored against the same posting on the same day landed on one row: Score last-writer-wins, both sets
// of Results linked to it, the VIEWS.md rollups reading 32 against a Requirement Count of 16, and the
// delivered recruiter link listing both under one name.
const roleKey = 'role-' + String(scored.company || scored.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + new Date().toISOString().slice(0, 10);
const key = scopedKey(rows.candidate.key, roleKey, DEFAULT_CANDIDATE_ID);

// Everything the rest of the workflow needs, in one item. The next node narrows it to the Airtable
// columns; nothing here is written directly, because autoMapInputData turns every top-level key into a
// column and would try to make one out of 'results'.
return [{ json: { key, results, gaps, coverage: scored.coverage } }];`;
}

/** Narrow the guard's output to exactly the Roles columns, and nothing else. */
function roleRowNode(): string {
  return `const scored = $('Apply weighing').first().json;
const guarded = $('Guard rationales').first().json;
const rows = $('Load the record').first().json;
const now = new Date().toISOString();

return [{
  json: {
    Key: guarded.key,
    // Whose fit report this is, by record id. The key is candidate-scoped already, but the shared
    // recruiter view filters on the Role link and reads the candidate off the ROW — so a row without
    // this reads as belonging to nobody. The app's saveRole gained this and the workflow did not,
    // which only showed up when a real run wrote a row with an empty Candidate cell.
    Candidate: [rows.candidate.id],
    Title: scored.title,
    Company: scored.company,
    'Posted Text': String(($('Role received').first().json.body || {}).text || '').slice(0, 90000),
    Score: scored.coverage.score,
    'Requirement Count': scored.requirements.length,
    'Matched At': now,
    // The model that actually served the parse, or 'none' when code read the posting. This was a
    // hardcoded JD_MODELS[0], so a fallthrough to the second model in the chain left no trace — the
    // exact event the repo's "never a silent fallback" rule exists to expose. 'Posting requirements'
    // reads it back off the response.
    Model: $('Posting requirements').first().json.model,
    Source: 'n8n',
    'Ingested At': now,
  },
}];`;
}

/**
 * One Results row per requirement, citations written as links.
 *
 * Links are given as record ids — the rows 'Load the record' read for this candidate, plus the Roles row
 * 'Write the role' just wrote. Giving them as primary-field values under typecast let Airtable resolve a
 * citation by display name, which is not unique across candidates.
 * This is the payoff of the sixth table: the citations become traversable rows instead of slugs inside
 * a string, and the Gaps view becomes a filter rather than an impossibility.
 */
function fanOutResultsNode(): string {
  return `const scored = $('Apply weighing').first().json;
const rows = $('Load the record').first().json;
const guarded = $('Guard rationales').first().json;
const candidate = rows.candidate;
const roleKey = guarded.key;
const results = guarded.results || [];

// Key → record id, from the rows 'Load the record' actually read for THIS candidate. A key that is not
// in the scoped record resolves to nothing and the citation is dropped, which is the correct outcome:
// this workflow cannot cite a row it was not allowed to see.
const idOf = (table, key) => (rows[table].find((r) => r.key === key) || {}).id;
// The Roles row 'Write the role' just wrote. Roles are shared across candidates and re-scoring a posting
// on a later date leaves two rows with the same Title, so resolving this link by Title could attach new
// results to a stale role.
const roleRecId = $('Write the role').first().json.id;

return results.map((r) => ({
  json: {
    // Results rows are candidate × role × requirement, so the candidate leads the Key — the exact
    // format src/store/airtable.ts writes, and what its reader strips back off.
    Key: candidate.key + '-' + roleKey + '-' + r.requirementId,
    Candidate: [candidate.id],
    Requirement: r.requirement.text,
    Kind: r.requirement.kind,
    Category: r.requirement.category,
    Status: r.status,
    Shortfall: r.shortfall || '',
    'Match Score': r.score,
    Rationale: r.rationale,
    'Rationale Source': r.rationaleSource,
    Role: [roleRecId],
    Technologies: r.matchedTechnologies.map((k) => idOf('technologies', k)).filter(Boolean),
    Capabilities: r.matchedCapabilities.map((k) => idOf('capabilities', k)).filter(Boolean),
    Projects: r.matchedProjects.map((k) => idOf('projects', k)).filter(Boolean),
    Evidence: r.evidence.map((k) => idOf('evidence', k)).filter(Boolean),
  },
}));`;
}

const matchWorkflow = (() => {
  /** Same shape and same reason as `loadAll` above: chained, and run exactly once. */
  const loadTable = (name: string, table: string, position: Position) => ({
    ...airtable(name, position, {
      operation: 'search',
      table: { __rl: true, mode: 'name', value: table },
      returnAll: true,
    }),
    executeOnce: true,
  });

  const nodes: N8nNode[] = [
    sticky('Overview', [-640, -220], [520, 700],
      `## Score a job description against the record\n\n` +
      `POST \`{ "text": "<the posting>" }\` — plus an optional \`candidateId\`, defaulting to the seeded\n` +
      `candidate — and get back a coverage score, a verdict per requirement with citations, and a Gaps\n` +
      `section, all scoped to that candidate's record. Results rows carry the Candidate link and a\n` +
      `candidate-prefixed Key, the same shape the application's Airtable adapter writes.\n\n` +
      `### The claim this canvas makes\n\n` +
      `**Matching is deterministic. The model only writes sentences.**\n\n` +
      `\`Retrieve and score\` is a Code node. It ranks rows that already exist in Airtable and computes\n` +
      `every verdict and the coverage number in arithmetic. Only then is a model asked to describe each\n` +
      `outcome in one line, from the rows retrieval returned — it never sees the base, so it cannot cite\n` +
      `a project that did not match, and it cannot move a status it was told.\n\n` +
      `\`Fan out rationales\` emits one item per requirement, so \`Write rationales\` runs once per\n` +
      `requirement rather than once per posting. The prompt it builds IS the corpus the guard checks the\n` +
      `answer against — one string, so the two can never describe different things.\n\n` +
      `\`Guard rationales\` discards a sentence that states a number absent from the records it was written\n` +
      `from, or that grades the candidate ("extensive", "strong", "deep"), and falls back to the\n` +
      `deterministic template for that row alone. A failed call costs one sentence, not the run.\n\n` +
      `### Model tiering\n` +
      `- parse the posting: ${JD_MODELS[0]} (medium difficulty, short clean input)\n` +
      `- write rationales: ${RATIONALE_MODELS[0]} (easy — the facts are already chosen)\n` +
      `- score and detect gaps: no model at all\n\n` +
      `Generated by \`pnpm n8n:build\`. Do not hand-edit; \`--check\` fails on drift.`),

    webhook('Role received', 'proof-of-work/match', [-40, 320]),
    code('Verify app token', [200, 320], verifyTokenNode()),
    ifNode('Token accepted?', [420, 320], '={{ $json.authorized }}'),
    unauthorizedRespond([640, 520]),
    sticky('Auth note', [140, 60], [480, 200], AUTH_STICKY),

    code('Read the posting', [640, 320], readPostingNode()),
    ifNode('Needs a model?', [860, 320], '={{ $json.needsModel }}'),
    // The model branch. It runs only for prose, and only when a key is set — otherwise the
    // deterministic read is the answer, not a fallback after a wasted request.
    code('Build parse request', [1080, 160], buildParseRequest()),
    http('Parse the posting', [1300, 160], '={{ JSON.stringify($json.request) }}'),
    code('Posting requirements', [1520, 320], postingRequirementsNode()),

    loadTable('Load candidates', 'Candidates', [1740, -20]),
    loadTable('Load projects', 'Projects', [1740, 120]),
    loadTable('Load technologies', 'Technologies', [1740, 260]),
    loadTable('Load capabilities', 'Capabilities', [1740, 400]),
    loadTable('Load evidence', 'Evidence', [1740, 540]),

    code('Load the record', [1960, 320], loadRecordNode()),

    // DENSE RETRIEVAL. Degrades: a failed or short embeddings response drops the run to lexical-only,
    // which is a real degradation and a correct one — 'Collect vectors' reports it and the Respond node
    // returns it, rather than the workflow quietly scoring a semantic match as a gap.
    code('Build embed request', [2180, 320], buildEmbedRequestNode()),
    http('Weigh similarity', [2400, 320], '={{ JSON.stringify($json.request) }}', true, EMBEDDINGS_ENDPOINT),
    code('Collect vectors', [2620, 320], collectVectorsNode()),

    code('Retrieve and score', [2840, 320], retrieveAndScoreNode()),

    // THE WEIGHING PASS (DESIGN.md v3.8). Every requirement is resolved twice — once with no model, once
    // with the model's numbers — and the worse verdict wins. The workflow had no equivalent, so this
    // guarantee held in the app lane only while both lanes wrote to the same Roles row.
    code('Fan out judge', [3060, 320], fanOutJudgeNode()),
    http('Weigh candidates', [3280, 320], '={{ JSON.stringify($json.request) }}', true),
    code('Apply weighing', [3500, 320], applyWeighingNode()),

    code('Fan out rationales', [3720, 320], fanOutRationalesNode()),

    // Runs once per item out of the fan-out — one requirement, one sentence, which is what
    // RATIONALE_SYSTEM ("you write one sentence") and the 160-token ceiling were always written for.
    http('Write rationales', [3940, 320], '={{ JSON.stringify($json.request) }}', true),

    code('Guard rationales', [4160, 320], guardNode()),
    code('Build role row', [4380, 320], roleRowNode()),
    upsert('Write the role', 'Roles', [4600, 320]),

    code('Fan out results', [4820, 420], fanOutResultsNode()),
    upsert('Write results', 'Results', [5040, 420]),

    // Below the results branch, for the same reason as the extract workflow's: under executionOrder v1
    // the topmost branch runs first, and this used to answer with a coverage score before 'Write
    // results' had written a single row. An Airtable failure then left a Roles row scored 75 with zero
    // Results linked and a caller who had been told it worked.
    respond('Respond', [4820, 620],
      `={{ {\n` +
      `  ok: true,\n` +
      `  role: $('Build role row').first().json.Title,\n` +
      `  company: $('Build role row').first().json.Company,\n` +
      `  candidate: $('Load the record').first().json.candidate.name,\n` +
      `  coverage: $('Guard rationales').first().json.coverage,\n` +
      `  gaps: $('Guard rationales').first().json.gaps,\n` +
      // Named in the response because a degradation nobody can see is the one this repo bans. `retrieval`
      // is hybrid or lexical depending on whether the embeddings call answered; `weighing` reports how
      // many requirements were weighed and how many the model lowered.
      `  retrieval: $('Apply weighing').first().json.retrieval,\n` +
      `  retrievalDetail: $('Apply weighing').first().json.retrievalDetail,\n` +
      `  weighing: $('Apply weighing').first().json.weighing\n` +
      `} }}`),

    sticky('Scoring note', [1300, 560], [500, 250],
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
    // The gate comes first, same as the extract workflow: 401 before any model call or Airtable read.
    ['Role received', 'Verify app token'],
    ['Verify app token', 'Token accepted?'],
    ['Token accepted?', 'Read the posting', 0],
    ['Read the posting', 'Needs a model?'],
    // Prose goes to the model; everything else is already exact and skips it entirely. Both branches
    // land on 'Posting requirements', so downstream reads ONE node name whichever ran.
    ['Needs a model?', 'Build parse request', 0],
    ['Build parse request', 'Parse the posting'],
    ['Parse the posting', 'Posting requirements'],
    ['Needs a model?', 'Posting requirements', 1],
    ['Token accepted?', 'Unauthorized', 1],
    // Chained, not fanned. See `loadAll` for why: a fan-in target runs before its other sources have.
    ['Posting requirements', 'Load candidates'],
    ['Load candidates', 'Load projects'],
    ['Load projects', 'Load technologies'],
    ['Load technologies', 'Load capabilities'],
    ['Load capabilities', 'Load evidence'],
    ['Load evidence', 'Load the record'],
    ['Load the record', 'Build embed request'],
    ['Build embed request', 'Weigh similarity'],
    ['Weigh similarity', 'Collect vectors'],
    ['Collect vectors', 'Retrieve and score'],
    ['Retrieve and score', 'Fan out judge'],
    ['Fan out judge', 'Weigh candidates'],
    ['Weigh candidates', 'Apply weighing'],
    ['Apply weighing', 'Fan out rationales'],
    ['Fan out rationales', 'Write rationales'],
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
      // CRLF-normalised: core.autocrlf rewrites the committed file on Windows checkouts, and a
      // byte-exact check would report phantom drift on every fresh clone. .gitattributes pins LF.
      const current = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
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

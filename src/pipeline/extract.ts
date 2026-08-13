/**
 * Stage 2: one messy blob in, one structured record out.
 *
 * This is the hard tier and the only place a capable model is worth paying for. The input is a README, a
 * package.json, a wall of test output, a store listing — unstructured, inconsistent, and full of numbers
 * that have to survive the trip intact. Everything downstream treats those numbers as facts, so an
 * extractor that rounds 536 to "over 500" has poisoned the well.
 *
 * There is a deterministic extractor underneath, and it is not a toy. It reads the taxonomy already in
 * the store and finds every technology and capability the blob names, pulls metrics with patterns that
 * match how these artifacts actually write them, and collects URLs and store ids as evidence. It gets
 * less out of a blob than the model does — it cannot summarise, and it cannot recognise a capability that
 * is described rather than named — but what it does get is correct, and it needs no key at all.
 */

import { callJson, shortReason, type LlmOptions, type LlmResult } from '../openrouter/client';
import { PROJECT_EXTRACTION_SCHEMA } from '../openrouter/schemas';
import type { Snapshot } from '../store/types';
import { containsTerm, normalize } from './text';
import type { ExtractedProject } from './validate';

export const EXTRACTION_SYSTEM = `You read one raw artifact from a software project and record what it
actually says. You are building an evidence file, not writing a pitch.

Rules, in order of importance:

1. Never invent a number. If the source says 536 tests, record 536. If it does not give a count, record
   null. A rounded or guessed metric is worse to us than a missing one, because a missing one is honest.
2. Only record technologies the source names. Do not infer that a React project "probably uses" anything.
3. Achievements are things that happened and could be checked by someone else — a store listing passing
   certification, a test suite of a given size, a service deployed. "Well architected" is not an
   achievement; it is an opinion, and it does not go in this record.
4. Evidence is anything a stranger could verify without your help: a URL, a store id, a count, a rating,
   a certification. Copy the value exactly as written.
5. Capabilities are what building this thing demonstrates the person can do, in plain words a hiring
   manager would use. Keep them short.

If the artifact does not describe a project at all, still return the schema with empty arrays and null
metrics. Do not fabricate a project to fill the shape.`;

export interface ExtractOptions extends LlmOptions {
  /** The store's current taxonomy, which the deterministic extractor scans for. */
  snapshot: Snapshot;
  sourceName: string;
}

export interface ExtractOutcome {
  raw: unknown;
  via: 'model' | 'deterministic';
  model: string;
  note: string | null;
}

/** Ask the model. On any typed failure, fall through to the deterministic reader and say which ran. */
export async function extract(blob: string, opts: ExtractOptions): Promise<ExtractOutcome> {
  const result: LlmResult<unknown> = await callJson(
    {
      tier: 'extraction',
      schemaName: 'project_extraction',
      schema: PROJECT_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
      system: EXTRACTION_SYSTEM,
      user: `Source file: ${opts.sourceName}\n\n---\n${blob}\n---`,
      maxTokens: 1600,
      temperature: 0,
    },
    opts,
  );

  if (result.ok) {
    return { raw: result.value, via: 'model', model: result.model, note: null };
  }

  return {
    raw: extractDeterministically(blob, opts.snapshot, opts.sourceName),
    via: 'deterministic',
    model: 'none',
    note: shortReason(result.error.kind),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The deterministic reader.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Metric patterns, written against how these artifacts actually phrase things.
 *
 * Order matters: the more specific pattern goes first, because "536 unit tests" also matches a looser
 * `(\d+) tests` and would otherwise be read twice.
 */
const METRIC_PATTERNS: Array<{ key: 'loc' | 'tests' | 'commits' | 'files'; re: RegExp; scale?: number }> = [
  { key: 'loc', re: /~?\s*([\d,]+)\s*k\s*(?:lines|loc|lines of code)\b/i, scale: 1000 },
  { key: 'loc', re: /~?\s*([\d,]+)\s*(?:lines of code|loc)\b/i },

  /**
   * Vitest's summary block, anchored to the start of a line:
   *
   *     Test Files  24 passed (24)
   *          Tests  536 passed (536)
   *
   * The anchor is the whole point. A looser pattern reads "Test Files 24 passed" first and records 24
   * tests — a number that is real, is in the output, and is the wrong one. Requiring `Tests` to be
   * followed directly by the count rules that line out.
   */
  { key: 'tests', re: /^\s*Tests?\s+([\d,]+)\s+passed/im },

  { key: 'tests', re: /([\d,]+)\s*(?:passing\s+)?(?:unit\s+)?tests?\s+pass/i },
  { key: 'tests', re: /([\d,]+)\s*(?:test\s+)?(?:cases|assertions)\b/i },
  { key: 'tests', re: /([\d,]+)\s*(?:passing\s+)?tests?\b/i },
  // Pasted terminal output, where the count is a bare number on the line after the command:
  //   $ git rev-list --count HEAD
  //   125
  { key: 'commits', re: /rev-list\s+--count[^\n]*\n\s*([\d,]+)/i },
  { key: 'commits', re: /([\d,]+)\s*commits?\b/i },
  { key: 'files', re: /([\d,]+)\s*files?\b/i },
];

function readMetrics(blob: string): ExtractedProject['metrics'] {
  const metrics: ExtractedProject['metrics'] = { loc: null, tests: null, commits: null, files: null };
  for (const { key, re, scale } of METRIC_PATTERNS) {
    if (metrics[key] !== null) continue;
    const hit = re.exec(blob);
    if (!hit?.[1]) continue;
    const value = Number.parseInt(hit[1].replace(/,/g, ''), 10);
    if (Number.isFinite(value)) metrics[key] = scale ? value * scale : value;
  }
  return metrics;
}

const URL_RE = /https?:\/\/[^\s)>"'\]]+/gi;
/** Microsoft Store product ids: 12 characters, starting with 9. */
const STORE_ID_RE = /\b(9[A-Z0-9]{11})\b/g;

function readEvidence(blob: string): ExtractedProject['evidence'] {
  const out: ExtractedProject['evidence'] = [];
  const seen = new Set<string>();

  for (const [, id] of blob.matchAll(STORE_ID_RE)) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ label: 'Microsoft Store product id', value: id, url: null, kind: 'store-listing' });
  }

  for (const [url] of blob.matchAll(URL_RE)) {
    const clean = url.replace(/[.,;]+$/, '');
    if (seen.has(clean)) continue;
    // URL_RE matches token shapes the WHATWG parser rejects (`http://:3000`, `http://%`, `http://[abc`),
    // so a bad URL in pasted text must skip the row, not throw. This runs on the keyless deterministic
    // path, so an unhandled throw here takes down the whole ingest instead of parking a Needs-Review stub.
    let host: string;
    try {
      host = new URL(clean).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    seen.add(clean);
    out.push({ label: host, value: clean, url: clean, kind: 'live-url' });
  }

  return out.slice(0, 12);
}

function readName(blob: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(blob);
  if (heading?.[1]) return heading[1].replace(/[*_`]/g, '').split('—')[0]?.trim() ?? fallback;

  const displayName = /"displayName"\s*:\s*"([^"]+)"/.exec(blob);
  if (displayName?.[1]) return displayName[1];

  const pkgName = /"name"\s*:\s*"([^"]+)"/.exec(blob);
  if (pkgName?.[1]) return pkgName[1];

  return fallback.replace(/\.[a-z]+$/i, '').replace(/^\d+[-_]/, '').replace(/[-_]/g, ' ');
}

const STATUS_HINTS: Array<[RegExp, string]> = [
  [/\b(shipped|published|certified|approved|released to the store)\b/i, 'shipped'],
  [/\b(delivered|accepted|closed at)\b/i, 'delivered'],
  [/\b(live|in production|deployed)\b/i, 'live'],
];

/**
 * Read a blob using only the taxonomy already in the store plus the patterns above.
 *
 * The summary is the honest limit of this path: it takes the first real sentence rather than writing one,
 * because a deterministic summariser would either be a template or a lie. The UI labels records extracted
 * this way, so nobody mistakes a first sentence for a considered summary.
 */
export function extractDeterministically(
  blob: string,
  snapshot: Snapshot,
  sourceName: string,
): ExtractedProject {
  const haystack = normalize(blob);

  const stack = snapshot.technologies
    .filter((tech) => [tech.name, ...tech.aliases].some((alias) => containsTerm(haystack, alias)))
    .map((tech) => tech.name);

  const capabilities = snapshot.capabilities
    .filter((cap) => [cap.name, ...cap.matchTerms].some((term) => containsTerm(haystack, term)))
    .map((cap) => cap.name);

  let status = 'in-development';
  for (const [re, value] of STATUS_HINTS) {
    if (re.test(blob)) {
      status = value;
      break;
    }
  }

  const started = /\b(20\d{2})-(0[1-9]|1[0-2])\b/.exec(blob);

  // Markdown emphasis has to come off both ends. Stripping only the leading `**` left summaries reading
  // "The agent-first IDE for multi-project orchestration.**", which looks like a parser that gave up.
  const prose = blob
    .split(/\n+/)
    .map((line) => line.replace(/^[#>*\-\s]+/, '').replace(/[*_`]+$/, '').trim())
    .find((line) => line.length > 40 && !line.startsWith('|') && !/^[{["]/.test(line));

  return {
    name: readName(blob, sourceName),
    role: 'Solo developer',
    started: started ? `${started[1]}-${started[2]}` : '',
    ended: null,
    status,
    summary: prose ? prose.slice(0, 300) : `Record read from ${sourceName}.`,
    metrics: readMetrics(blob),
    stack,
    achievements: [],
    evidence: readEvidence(blob),
    capabilities,
  };
}

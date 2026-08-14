/**
 * The deterministic validation node.
 *
 * A structured-output request is a strong hint, not a guarantee. The schema was asked for; whether it was
 * honoured depends on which provider OpenRouter routed to, and `require_parameters: true` reduces that
 * risk without eliminating it. So every field is re-checked here as untrusted input, and the range checks
 * that could not go in the schema (Anthropic rejects `minimum`/`maximum` on numbers) live here instead —
 * which is their right home anyway.
 *
 * Two outcomes, and the second one is the interesting one:
 *
 *   ok        → a Project the store will accept
 *   rejected  → problems, a `retryable` flag, and the raw reply preserved
 *
 * A rejection is never a dropped record. It becomes a Project with `reviewStatus: 'needs-review'` and the
 * reason attached, which is what the Needs Review view lists. Silently discarding a bad extraction is the
 * failure this file exists to prevent: the pipeline would look like it worked, and one project would just
 * quietly not be there.
 */

import { DEFAULT_CANDIDATE_ID, type Project, type ProjectStatus, type ReviewStatus } from '../store/types';
import { scopedKey } from './portable';

export interface ExtractedProject {
  name: string;
  role: string;
  started: string;
  ended: string | null;
  status: string;
  summary: string;
  metrics: { loc: number | null; tests: number | null; commits: number | null; files: number | null };
  stack: string[];
  achievements: string[];
  evidence: Array<{ label: string; value: string; url: string | null; kind: string }>;
  capabilities: string[];
}

export interface ValidationOk {
  ok: true;
  value: ExtractedProject;
  /** Non-fatal repairs, surfaced in the UI so a reader knows the record was touched. */
  warnings: string[];
}

export interface ValidationFailure {
  ok: false;
  problems: string[];
  /**
   * Whether asking the model again is worth a second call. Malformed JSON and missing fields are worth a
   * retry; a blob with no project in it is not, and retrying it just spends money to fail identically.
   */
  retryable: boolean;
}

export type ValidationResult = ValidationOk | ValidationFailure;

const VALID_STATUS = new Set<ProjectStatus>(['shipped', 'live', 'delivered', 'in-development']);
const VALID_EVIDENCE_KIND = new Set([
  'store-listing',
  'live-url',
  'test-count',
  'repo-metric',
  'infra-metric',
  'video',
  'certification',
  'client-review',
  'artifact',
]);

/** Nothing sane exceeds these. A model that emits 9,000,000 lines of code has hallucinated a digit. */
const METRIC_CEILING = { loc: 5_000_000, tests: 100_000, commits: 100_000, files: 200_000 } as const;

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((s) => s.length > 0);
}

function asMetric(
  value: unknown,
  key: keyof typeof METRIC_CEILING,
  problems: string[],
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`metrics.${key} is not a number`);
    return null;
  }
  if (value < 0) {
    problems.push(`metrics.${key} is negative (${value})`);
    return null;
  }
  if (value > METRIC_CEILING[key]) {
    // Loud, because an inflated metric is the single most damaging thing this pipeline could publish.
    problems.push(`metrics.${key} of ${value} exceeds the plausible ceiling of ${METRIC_CEILING[key]}`);
    return null;
  }
  return Math.round(value);
}

export function validateExtraction(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, problems: ['reply was not a JSON object'], retryable: true };
  }
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];
  const warnings: string[] = [];

  const name = asString(obj['name']);
  if (!name) problems.push('name is missing');

  const summary = asString(obj['summary']);
  if (!summary) problems.push('summary is missing');

  const started = asString(obj['started']);
  if (started && !YEAR_MONTH.test(started)) {
    warnings.push(`started "${started}" is not YYYY-MM; kept as written`);
  }

  const endedRaw = obj['ended'];
  const ended = endedRaw === null || endedRaw === undefined ? null : asString(endedRaw) || null;
  if (ended && !YEAR_MONTH.test(ended)) {
    warnings.push(`ended "${ended}" is not YYYY-MM; kept as written`);
  }

  let status = asString(obj['status']) as ProjectStatus;
  if (!VALID_STATUS.has(status)) {
    // "unknown" is in the schema's enum precisely so the model has somewhere honest to land.
    warnings.push(`status "${status || '(empty)'}" is not a known status; recorded as in-development`);
    status = 'in-development';
  }

  const metricsRaw = (obj['metrics'] ?? {}) as Record<string, unknown>;
  const metrics = {
    loc: asMetric(metricsRaw['loc'], 'loc', problems),
    tests: asMetric(metricsRaw['tests'], 'tests', problems),
    commits: asMetric(metricsRaw['commits'], 'commits', problems),
    files: asMetric(metricsRaw['files'], 'files', problems),
  };

  const stack = asStringArray(obj['stack']);
  const capabilities = asStringArray(obj['capabilities']);
  const achievements = asStringArray(obj['achievements']);

  const evidence: ExtractedProject['evidence'] = [];
  if (Array.isArray(obj['evidence'])) {
    for (const [i, item] of (obj['evidence'] as unknown[]).entries()) {
      if (typeof item !== 'object' || item === null) {
        warnings.push(`evidence[${i}] was not an object; skipped`);
        continue;
      }
      const e = item as Record<string, unknown>;
      const label = asString(e['label']);
      const value = asString(e['value']);
      const kind = asString(e['kind']);
      if (!label || !value) {
        warnings.push(`evidence[${i}] has no label or no value; skipped`);
        continue;
      }
      if (!VALID_EVIDENCE_KIND.has(kind)) {
        warnings.push(`evidence[${i}] kind "${kind}" is unknown; recorded as artifact`);
      }
      const urlRaw = asString(e['url']);
      evidence.push({
        label,
        value,
        url: urlRaw && /^https?:\/\//i.test(urlRaw) ? urlRaw : null,
        kind: VALID_EVIDENCE_KIND.has(kind) ? kind : 'artifact',
      });
    }
  }

  // A record with no stack and no evidence describes nothing checkable. Retrying will not conjure
  // details the source never contained, so it is parked rather than re-asked.
  if (stack.length === 0 && evidence.length === 0) {
    problems.push('no technologies and no evidence could be read from the source');
    return { ok: false, problems, retryable: false };
  }

  if (problems.length > 0) {
    const structural = problems.some((p) => p.endsWith('is missing') || p.includes('not a number'));
    return { ok: false, problems, retryable: structural };
  }

  return {
    ok: true,
    warnings,
    value: { name, role: asString(obj['role']) || 'Developer', started, ended, status, summary, metrics, stack, achievements, evidence, capabilities },
  };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Build the Project row a validated extraction becomes. Links are attached by the caller. */
export function toProject(
  extracted: ExtractedProject,
  provenance: { source: string; ingestedAt: string },
): Project {
  const metrics: Project['metrics'] = {};
  if (extracted.metrics.loc !== null) metrics.loc = extracted.metrics.loc;
  if (extracted.metrics.tests !== null) metrics.tests = extracted.metrics.tests;
  if (extracted.metrics.commits !== null) metrics.commits = extracted.metrics.commits;
  if (extracted.metrics.files !== null) metrics.files = extracted.metrics.files;

  return {
    id: slugify(extracted.name),
    candidate: DEFAULT_CANDIDATE_ID,
    name: extracted.name,
    slug: slugify(extracted.name),
    role: extracted.role,
    started: extracted.started,
    ended: extracted.ended,
    status: extracted.status as ProjectStatus,
    summary: extracted.summary,
    metrics,
    technologies: [],
    capabilities: [],
    evidence: [],
    reviewStatus: 'ok',
    reviewReason: null,
    source: provenance.source,
    ingestedAt: provenance.ingestedAt,
  };
}

/**
 * The record a failed extraction becomes.
 *
 * It is a real row in the real table with a real reason attached, which is what makes the Needs Review
 * view worth opening. The alternative — logging the error and moving on — produces a pipeline whose
 * output looks complete and is not.
 */
export function toReviewStub(
  sourceName: string,
  problems: string[],
  provenance: { source: string; ingestedAt: string },
  candidateId: string = DEFAULT_CANDIDATE_ID,
): Project {
  const label = `Unparsed: ${sourceName}`;
  const reviewStatus: ReviewStatus = 'needs-review';
  return {
    // Scoped, like every other project key. `sourceName` defaults to 'pasted-input' at every entry
    // point, so an unscoped stub meant two applicants' failed ingests collided on one row: A's parked
    // record ceased to exist and reappeared inside B's, after A was told it was parked. The success
    // path has always been scoped; only the error path was not.
    id: scopedKey(candidateId, slugify(label), DEFAULT_CANDIDATE_ID),
    candidate: candidateId,
    name: label,
    slug: slugify(label),
    role: '',
    started: '',
    ended: null,
    status: 'in-development',
    summary: `Extraction did not produce a usable record from ${sourceName}.`,
    metrics: {},
    technologies: [],
    capabilities: [],
    evidence: [],
    reviewStatus,
    reviewReason: problems.join('; '),
    source: provenance.source,
    ingestedAt: provenance.ingestedAt,
  };
}

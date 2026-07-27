/**
 * The deterministic validation node, and the rule that a rejection is never a dropped record.
 */

import { describe, expect, it } from 'vitest';
import { slugify, toProject, toReviewStub, validateExtraction } from '@/pipeline/validate';
import { PROJECT_EXTRACTION_SCHEMA, RATIONALE_SCHEMA, ROLE_PARSE_SCHEMA } from '@/openrouter/schemas';

const good = {
  name: 'Tendril',
  role: 'Solo developer',
  started: '2026-04',
  ended: '2026-06',
  status: 'shipped',
  summary: 'An agent-first IDE.',
  metrics: { loc: 132000, tests: 660, commits: 125, files: null },
  stack: ['Electron', 'React'],
  achievements: ['Passed 10 store certification rounds'],
  evidence: [{ label: 'Store id', value: '9NRC4P6JQ962', url: null, kind: 'store-listing' }],
  capabilities: ['Multi-agent orchestration'],
};

describe('validateExtraction', () => {
  it('accepts a well-formed extraction unchanged', () => {
    const out = validateExtraction(good);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.metrics.loc).toBe(132000);
    expect(out.warnings).toEqual([]);
  });

  it('rejects a reply that is not an object, and asks for a retry', () => {
    for (const bad of ['a string', 42, null, undefined]) {
      const out = validateExtraction(bad);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.retryable).toBe(true);
    }
  });

  it('rejects a missing name and asks for a retry', () => {
    const out = validateExtraction({ ...good, name: '' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.join()).toMatch(/name is missing/);
    expect(out.retryable).toBe(true);
  });

  it('rejects a metric that is not a number', () => {
    const out = validateExtraction({ ...good, metrics: { ...good.metrics, tests: 'lots' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.join()).toMatch(/tests is not a number/);
  });

  it('rejects an implausibly large metric rather than publishing it', () => {
    // An inflated number is the single most damaging thing this pipeline could write, because the whole
    // argument is that the numbers are real.
    const out = validateExtraction({ ...good, metrics: { ...good.metrics, loc: 9_000_000 } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.join()).toMatch(/exceeds the plausible ceiling/);
  });

  it('rejects a negative metric', () => {
    const out = validateExtraction({ ...good, metrics: { ...good.metrics, commits: -5 } });
    expect(out.ok).toBe(false);
  });

  it('does not ask for a retry when the source simply contained no project', () => {
    // Retrying will not conjure detail the source never had; it just spends money to fail identically.
    const out = validateExtraction({ ...good, stack: [], evidence: [] });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.retryable).toBe(false);
  });

  it('repairs an unknown status rather than failing the whole record', () => {
    const out = validateExtraction({ ...good, status: 'vibes' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.status).toBe('in-development');
    expect(out.warnings.join()).toMatch(/not a known status/);
  });

  it('keeps a malformed date as written and says so', () => {
    const out = validateExtraction({ ...good, started: 'summer 2026' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.started).toBe('summer 2026');
    expect(out.warnings.join()).toMatch(/not YYYY-MM/);
  });

  it('drops a non-http url instead of storing a link that goes nowhere', () => {
    const out = validateExtraction({
      ...good,
      evidence: [{ label: 'Site', value: 'x', url: 'javascript:alert(1)', kind: 'live-url' }],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.evidence[0]?.url).toBeNull();
  });

  it('files an unknown evidence kind as an artifact and warns', () => {
    const out = validateExtraction({
      ...good,
      evidence: [{ label: 'Thing', value: 'x', url: null, kind: 'vibes' }],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.evidence[0]?.kind).toBe('artifact');
    expect(out.warnings.join()).toMatch(/is unknown/);
  });
});

describe('a rejection becomes a visible row', () => {
  it('produces a project parked in Needs Review with the reason attached', () => {
    const stub = toReviewStub('11-broken-fragment.txt', ['no technologies and no evidence'], {
      source: '11-broken-fragment.txt',
      ingestedAt: '2026-07-27T00:00:00.000Z',
    });

    expect(stub.reviewStatus).toBe('needs-review');
    expect(stub.reviewReason).toMatch(/no technologies/);
    expect(stub.source).toBe('11-broken-fragment.txt');
    expect(stub.name).toMatch(/Unparsed/);
  });
});

describe('toProject', () => {
  it('omits a metric that was null rather than storing a zero', () => {
    // "no commits recorded" and "zero commits" are different claims, and only one of them is honest.
    const out = validateExtraction(good);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const project = toProject(out.value, { source: 's', ingestedAt: 'i' });
    expect(project.metrics.files).toBeUndefined();
    expect(project.metrics.loc).toBe(132000);
  });
});

describe('slugify', () => {
  it('produces a stable dedup key', () => {
    expect(slugify('North Star Support Bot')).toBe('north-star-support-bot');
    expect(slugify('  Tendril!  ')).toBe('tendril');
  });
});

/**
 * Schema hygiene. Each rule below cost a debugging session somewhere.
 */
describe('the JSON schemas', () => {
  const schemas = {
    extraction: PROJECT_EXTRACTION_SCHEMA,
    role: ROLE_PARSE_SCHEMA,
    rationale: RATIONALE_SCHEMA,
  } as Record<string, unknown>;

  function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, visit));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Record<string, unknown>;
    visit(obj);
    Object.values(obj).forEach((v) => walk(v, visit));
  }

  it('never uses minimum or maximum on a number', () => {
    // Anthropic's structured outputs reject range constraints with a 400 from every provider, which —
    // behind a fallback chain — is indistinguishable from the model being down. Ranges belong in
    // validate.ts, where the reply is treated as the untrusted input it always was.
    for (const [name, schema] of Object.entries(schemas)) {
      walk(schema, (obj) => {
        expect(obj['minimum'], `${name} has a minimum`).toBeUndefined();
        expect(obj['maximum'], `${name} has a maximum`).toBeUndefined();
      });
    }
  });

  it('sets additionalProperties false on every object', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      walk(schema, (obj) => {
        if (obj['type'] === 'object') {
          expect(obj['additionalProperties'], `${name}`).toBe(false);
        }
      });
    }
  });

  it('lists every property in required, as strict mode demands', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      walk(schema, (obj) => {
        if (obj['type'] !== 'object' || !obj['properties']) return;
        const properties = Object.keys(obj['properties'] as Record<string, unknown>).sort();
        const required = [...((obj['required'] as string[]) ?? [])].sort();
        expect(required, `${name}: ${properties.join()}`).toEqual(properties);
      });
    }
  });
});

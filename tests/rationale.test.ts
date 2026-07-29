/**
 * The fabrication guard on generated prose.
 *
 * Numbers are the tripwire, for two reasons. They are where a small model reaches for a total or a
 * rounding, and they are the only claim in a fit report a reader will actually go and check. A sentence
 * containing a figure that is not in the records it was written from is discarded whole — not repaired,
 * because a half-trusted sentence is worse than a plain one.
 */

import { describe, expect, it } from 'vitest';
import { buildContext, hasUnsourcedNumber, templateRationale, type RationaleContext } from '@/pipeline/rationale';
import type { Evidence, Project } from '@/store/types';

const project: Project = {
  id: 'north-star-support-bot',
  candidate: 'candidate-test',
  name: 'North Star Support Bot',
  slug: 'north-star-support-bot',
  role: 'Contract developer',
  started: '2026-07',
  ended: '2026-07',
  status: 'delivered',
  summary: 'Embeddable support widget.',
  metrics: { loc: 6200, tests: 359 },
  technologies: [],
  capabilities: [],
  evidence: ['ev'],
  reviewStatus: 'ok',
  reviewReason: null,
  source: 'test',
  ingestedAt: '2026-07-27T00:00:00.000Z',
};

const evidence: Evidence = {
  id: 'ev',
  candidate: 'candidate-test',
  label: 'Passing tests',
  kind: 'test-count',
  value: '359 across 19 files',
  url: null,
  verifiedOn: '2026-07-27',
  projects: ['north-star-support-bot'],
};

const context: RationaleContext = {
  requirement: { id: 'r', text: 'Automated testing', kind: 'required', category: 'process' },
  status: 'proven',
  technologies: ['Vitest'],
  capabilities: ['End-to-end test automation'],
  projects: [project],
  evidence: [evidence],
  shortfall: null,
};

const corpus = buildContext(context);

describe('hasUnsourcedNumber', () => {
  it('accepts a figure that appears in the records', () => {
    expect(hasUnsourcedNumber('359 tests pass in that project.', corpus)).toBe(false);
    expect(hasUnsourcedNumber('6200 lines of code.', corpus)).toBe(false);
  });

  it('rejects a figure that does not', () => {
    expect(hasUnsourcedNumber('Over 400 tests pass.', corpus)).toBe(true);
    expect(hasUnsourcedNumber('Around 1,000 tests across the suite.', corpus)).toBe(true);
  });

  it('rejects a rounded version of a real figure, which is the likeliest failure', () => {
    // "roughly 350" is the sentence a small model writes when 359 feels awkward, and it is exactly the
    // kind of small inaccuracy that costs the whole record its credibility.
    expect(hasUnsourcedNumber('Roughly 350 tests.', corpus)).toBe(true);
  });

  it('rejects a total the model computed rather than read', () => {
    expect(hasUnsourcedNumber('6559 lines and tests combined.', corpus)).toBe(true);
  });

  it('lets small incidental numbers through', () => {
    // "the second project", "one of three" — no claim is being made, and tripping on these would
    // discard good sentences for nothing.
    expect(hasUnsourcedNumber('Shipped across 2 projects.', corpus)).toBe(false);
  });
});

describe('buildContext', () => {
  it('states the verdict as already decided', () => {
    expect(corpus).toMatch(/Verdict already decided: proven/);
  });

  it('carries only the retrieved rows, never the whole store', () => {
    expect(corpus).toContain('North Star Support Bot');
    expect(corpus).not.toContain('Tendril');
  });

  it('says plainly when nothing matched', () => {
    const empty = buildContext({ ...context, status: 'gap', projects: [], evidence: [], technologies: [], capabilities: [] });
    expect(empty).toMatch(/Nothing in the record matched/);
  });
});

describe('templateRationale', () => {
  it('names one subject rather than listing everything that matched', () => {
    // An earlier version led with every matched row and produced "React, React product engineering
    // appears in…", which reads like a machine and buries the fact.
    const sentence = templateRationale(context);
    expect(sentence).toMatch(/^Vitest — shipped in North Star Support Bot/);
    expect(sentence).not.toMatch(/Vitest, End-to-end/);
  });

  it('says what is thin when the status is partial', () => {
    const sentence = templateRationale({ ...context, status: 'partial', shortfall: 'it is recorded as a stretch' });
    expect(sentence).toMatch(/but it is recorded as a stretch/);
  });

  it('claims nothing at all on a gap', () => {
    const sentence = templateRationale({ ...context, status: 'gap', projects: [], evidence: [] });
    expect(sentence).toBe('Nothing in the record matches this requirement.');
  });

  it('never writes a number that is not in the context it was built from', () => {
    for (const status of ['proven', 'partial', 'gap'] as const) {
      const sentence = templateRationale({ ...context, status });
      expect(hasUnsourcedNumber(sentence, buildContext({ ...context, status }))).toBe(false);
    }
  });
});

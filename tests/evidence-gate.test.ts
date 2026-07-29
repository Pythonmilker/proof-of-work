/**
 * The evidence gate — the single rule that keeps this from being a resume.
 *
 * A capability with nothing in its `evidence` array is a claim with no receipt, and it cannot score as
 * proven no matter how cleanly a requirement matched it. Adding a capability row is easy. Making it
 * count should not be.
 *
 * Every assertion here uses a perfect 1.0 match on purpose. The gate is only interesting when the match
 * is beyond argument — if a weak score were doing the work, the rule would be untested.
 */

import { describe, expect, it } from 'vitest';
import { resolve, THRESHOLD_PROVEN } from '@/pipeline/score';
import type { Capability, Evidence, Project, Requirement, Snapshot, Technology } from '@/store/types';

const requirement: Requirement = { id: 'r1', text: 'Widget wrangling', kind: 'required', category: 'process' };

function project(id: string, evidence: string[]): Project {
  return {
    id,
    candidate: 'candidate-test',
    name: id,
    slug: id,
    role: 'dev',
    started: '2026-01',
    ended: null,
    status: 'shipped',
    summary: '',
    metrics: {},
    technologies: [],
    capabilities: [],
    evidence,
    reviewStatus: 'ok',
    reviewReason: null,
    source: 'test',
    ingestedAt: '2026-01-01T00:00:00.000Z',
  };
}

function receipt(id: string, projects: string[]): Evidence {
  return { id, candidate: 'candidate-test', label: id, kind: 'artifact', value: 'v', url: null, verifiedOn: '2026-01-01', projects };
}

function capability(id: string, tier: Capability['tier'], evidence: string[], projects: string[]): Capability {
  return { id, candidate: 'candidate-test', name: id, statement: '', tier, matchTerms: [], projects, evidence };
}

function technology(id: string, projects: string[]): Technology {
  return { id, name: id, aliases: [], category: 'tooling', projects };
}

function snapshotWith(parts: Partial<Snapshot>): Snapshot {
  return { candidates: [], projects: [], technologies: [], capabilities: [], evidence: [], roles: [], ...parts };
}

const perfect = (kind: 'technology' | 'capability', id: string) => ({
  requirement,
  candidates: [{ kind, id, name: id, score: 1, via: 'lexical' as const }],
  best: 1,
});

describe('the evidence gate', () => {
  it('caps a perfectly matched capability at partial when nothing is linked to it', () => {
    const snapshot = snapshotWith({ capabilities: [capability('cap', 'proven', [], [])] });
    const result = resolve(perfect('capability', 'cap'), snapshot);

    expect(result.status).toBe('partial');
    expect(result.shortfall).toMatch(/no evidence linked|nothing verifiable/i);
  });

  it('promotes the same capability to proven the moment a receipt is attached', () => {
    const snapshot = snapshotWith({
      capabilities: [capability('cap', 'proven', ['ev1'], ['p1'])],
      projects: [project('p1', ['ev1'])],
      evidence: [receipt('ev1', ['p1'])],
    });

    expect(resolve(perfect('capability', 'cap'), snapshot).status).toBe('proven');
  });

  it('caps a stretch capability at partial even with receipts attached', () => {
    // This is what makes the Airtable and n8n rows honest: they have evidence, and the evidence
    // is this project. A stretch tier says "defensible, not shipped" and no match score overrides it.
    const snapshot = snapshotWith({
      capabilities: [capability('cap', 'stretch', ['ev1'], ['p1'])],
      projects: [project('p1', ['ev1'])],
      evidence: [receipt('ev1', ['p1'])],
    });

    const result = resolve(perfect('capability', 'cap'), snapshot);
    expect(result.status).toBe('partial');
    expect(result.shortfall).toMatch(/stretch/i);
  });

  const twoCapSnapshot = snapshotWith({
    capabilities: [
      capability('stretchy', 'stretch', ['ev1'], ['p1']),
      capability('solid', 'proven', ['ev1'], ['p1']),
    ],
    projects: [project('p1', ['ev1'])],
    evidence: [receipt('ev1', ['p1'])],
  });

  it('caps at partial when a stretch capability ties for the best match', () => {
    // The gate used to require EVERY matched capability to be stretch, so a posting bullet naming a
    // stretch capability alongside any incidentally-matched proven one was promoted to proven and then
    // dropped out of the Gaps section entirely. A tie means the best match is ambiguous, and the honest
    // answer to an ambiguous match is partial.
    const result = resolve(
      {
        requirement,
        candidates: [
          { kind: 'capability', id: 'solid', name: 'solid', score: 1, via: 'lexical' },
          { kind: 'capability', id: 'stretchy', name: 'stretchy', score: 1, via: 'lexical' },
        ],
        best: 1,
      },
      twoCapSnapshot,
    );
    expect(result.status).toBe('partial');
    expect(result.shortfall).toMatch(/stretch/i);
  });

  it('still reports proven when the proven capability clearly outscores the stretch one', () => {
    // The other direction matters too: one incidental stretch row must not drag down a requirement that
    // something evidenced genuinely covers.
    const result = resolve(
      {
        requirement,
        candidates: [
          { kind: 'capability', id: 'solid', name: 'solid', score: 1, via: 'lexical' },
          { kind: 'capability', id: 'stretchy', name: 'stretchy', score: 0.62, via: 'dense' },
        ],
        best: 1,
      },
      twoCapSnapshot,
    );
    expect(result.status).toBe('proven');
  });

  it('refuses to count a project that is parked in Needs Review', () => {
    // A record the validator rejected is not evidence of anything yet, however well it matches.
    const parked = { ...project('p1', ['ev1']), reviewStatus: 'needs-review' as const };
    const snapshot = snapshotWith({
      technologies: [technology('tech', ['p1'])],
      projects: [parked],
      evidence: [receipt('ev1', ['p1'])],
    });

    const result = resolve(perfect('technology', 'tech'), snapshot);
    expect(result.matchedProjects).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.status).toBe('partial');
  });

  it('lets a technology reach evidence through the projects that use it', () => {
    const snapshot = snapshotWith({
      technologies: [technology('tech', ['p1'])],
      projects: [project('p1', ['ev1'])],
      evidence: [receipt('ev1', ['p1'])],
    });

    const result = resolve(perfect('technology', 'tech'), snapshot);
    expect(result.status).toBe('proven');
    expect(result.evidence).toEqual(['ev1']);
  });

  it('never returns proven below the threshold, whatever is linked', () => {
    const snapshot = snapshotWith({
      technologies: [technology('tech', ['p1'])],
      projects: [project('p1', ['ev1'])],
      evidence: [receipt('ev1', ['p1'])],
    });

    const justUnder = THRESHOLD_PROVEN - 0.01;
    const result = resolve(
      { requirement, candidates: [{ kind: 'technology', id: 'tech', name: 'tech', score: justUnder, via: 'dense' }], best: justUnder },
      snapshot,
    );
    expect(result.status).toBe('partial');
  });
});

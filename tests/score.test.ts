/**
 * Scoring arithmetic. No model is involved in any of this, which is the point of testing it so plainly.
 */

import { describe, expect, it } from 'vitest';
import { coverage, gaps, type Resolution } from '@/pipeline/score';
import type { Requirement, RequirementResult, Snapshot } from '@/store/types';

function req(id: string, kind: Requirement['kind']): Requirement {
  return { id, text: `requirement ${id}`, kind, category: 'process' };
}

function result(id: string, status: RequirementResult['status']): RequirementResult {
  return {
    requirementId: id,
    status,
    score: status === 'gap' ? 0 : 1,
    matchedTechnologies: [],
    matchedCapabilities: [],
    matchedProjects: [],
    evidence: [],
    rationale: '',
    rationaleSource: 'template',
  };
}

const emptySnapshot: Snapshot = { projects: [], technologies: [], capabilities: [], evidence: [], roles: [] };

describe('coverage', () => {
  it('is 100 when everything required and preferred is proven', () => {
    const requirements = [req('a', 'required'), req('b', 'preferred')];
    const results = [result('a', 'proven'), result('b', 'proven')];
    expect(coverage(requirements, results).score).toBe(100);
  });

  it('is 0 when nothing matches', () => {
    const requirements = [req('a', 'required'), req('b', 'preferred')];
    expect(coverage(requirements, [result('a', 'gap'), result('b', 'gap')]).score).toBe(0);
  });

  it('weights a required item at twice a preferred one', () => {
    // Missing the single required item costs more than missing the single preferred one.
    const requirements = [req('a', 'required'), req('b', 'preferred')];
    const missedRequired = coverage(requirements, [result('a', 'gap'), result('b', 'proven')]).score;
    const missedPreferred = coverage(requirements, [result('a', 'proven'), result('b', 'gap')]).score;

    expect(missedRequired).toBeLessThan(missedPreferred);
    expect(missedRequired).toBe(33); // 0.5 of 1.5
    expect(missedPreferred).toBe(67); // 1.0 of 1.5
  });

  it('does not let a pile of preferred hits paper over missed must-haves', () => {
    // The reason coverage is weighted rather than counted: three missed must-haves against eleven
    // satisfied nice-to-haves should not read as a good result.
    const requirements = [
      ...['r1', 'r2', 'r3'].map((id) => req(id, 'required')),
      ...Array.from({ length: 11 }, (_, i) => req(`p${i}`, 'preferred')),
    ];
    const results = [
      ...['r1', 'r2', 'r3'].map((id) => result(id, 'gap')),
      ...Array.from({ length: 11 }, (_, i) => result(`p${i}`, 'proven')),
    ];
    expect(coverage(requirements, results).score).toBeLessThan(70);
  });

  it('counts a partial as exactly half', () => {
    expect(coverage([req('a', 'required')], [result('a', 'partial')]).score).toBe(50);
  });

  it('treats a requirement with no result at all as a gap', () => {
    expect(coverage([req('a', 'required')], []).score).toBe(0);
  });

  it('reports the required tally separately from the overall score', () => {
    const requirements = [req('a', 'required'), req('b', 'required'), req('c', 'preferred')];
    const out = coverage(requirements, [result('a', 'proven'), result('b', 'partial'), result('c', 'proven')]);
    expect(out.requiredCovered).toBe(1);
    expect(out.requiredTotal).toBe(2);
    expect(out.proven).toBe(2);
    expect(out.partial).toBe(1);
    expect(out.gap).toBe(0);
  });

  it('does not divide by zero on an empty posting', () => {
    expect(coverage([], []).score).toBe(0);
  });
});

describe('gaps', () => {
  const resolutions = (entries: Array<[string, string | null]>) =>
    new Map<string, Resolution>(
      entries.map(([id, shortfall]) => [
        id,
        {
          status: shortfall ? 'partial' : 'proven',
          matchedTechnologies: [],
          matchedCapabilities: [],
          matchedProjects: [],
          evidence: [],
          shortfall,
        },
      ]),
    );

  it('lists everything that is not proven, and nothing that is', () => {
    const requirements = [req('a', 'required'), req('b', 'required'), req('c', 'preferred')];
    const results = [result('a', 'proven'), result('b', 'partial'), result('c', 'gap')];
    const out = gaps(requirements, results, resolutions([['b', 'thin']]), emptySnapshot);

    // 'a' is proven and absent. A required partial outranks a preferred gap, because a reader scanning
    // this section should hit what could disqualify before what could not.
    expect(out.map((g) => g.requirement.id)).toEqual(['b', 'c']);
  });

  it('sorts required gaps above required partials above anything preferred', () => {
    const requirements = [
      req('preferred-gap', 'preferred'),
      req('required-partial', 'required'),
      req('required-gap', 'required'),
    ];
    const results = [
      result('preferred-gap', 'gap'),
      result('required-partial', 'partial'),
      result('required-gap', 'gap'),
    ];
    const out = gaps(requirements, results, resolutions([['required-partial', 'thin']]), emptySnapshot);

    expect(out.map((g) => g.requirement.id)).toEqual(['required-gap', 'required-partial', 'preferred-gap']);
  });

  it('always writes a note, even when nothing was resolved for the requirement', () => {
    const out = gaps([req('a', 'required')], [result('a', 'gap')], new Map(), emptySnapshot);
    expect(out[0]?.note.length).toBeGreaterThan(0);
    expect(out[0]?.closestEvidence).toBeNull();
  });
});

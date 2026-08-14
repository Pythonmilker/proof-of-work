/**
 * Retrieval and the text handling underneath it.
 *
 * Most of these are regressions. Every one of them was a wrong answer in a real fit report before it was
 * a test, and the awkward strings — `c#`, `node.js`, `ci/cd`, `react-three-fiber` — are where matching
 * quietly goes wrong without ever throwing.
 */

import { describe, expect, it } from 'vitest';
import { containsTerm, normalize, numbersIn, overlap, stem, tokens } from '@/pipeline/portable';
import { match, topCandidates } from '@/pipeline/match';
import { seedSnapshot } from '@/store/seed';
import type { Requirement } from '@/store/types';

const snapshot = seedSnapshot();

function requirement(text: string): Requirement {
  return { id: 'r', text, kind: 'required', category: 'process' };
}

function best(text: string) {
  const out = match({ requirement: requirement(text), snapshot });
  return { score: out.best, names: topCandidates(out).map((c) => c.name) };
}

describe('normalize', () => {
  it('keeps the four characters that carry meaning in a technology name', () => {
    expect(normalize('C# and Node.js with CI/CD and C++')).toBe('c# and node.js with ci/cd and c++');
  });

  it('treats a curly apostrophe exactly like a straight one', () => {
    // A posting pasted out of Word and one typed in a plain editor have to normalise identically,
    // or half the phrasings a real posting uses quietly stop matching.
    expect(normalize('we’re hiring')).toBe(normalize("we're hiring"));
    expect(normalize('“React”')).toBe(normalize('"React"'));
  });
});

describe('containsTerm', () => {
  it('matches the strings a word boundary gets wrong', () => {
    expect(containsTerm(normalize('strong C# experience'), 'c#')).toBe(true);
    expect(containsTerm(normalize('Node.js required'), 'node.js')).toBe(true);
    expect(containsTerm(normalize('owns CI/CD'), 'ci/cd')).toBe(true);
    expect(containsTerm(normalize('n8n and/or Zapier'), 'n8n')).toBe(true);
  });

  it('matches a pluralised term', () => {
    // "structured output" against "structured outputs" was silently failing and costing a real match.
    expect(containsTerm(normalize('designing structured outputs'), 'structured output')).toBe(true);
    expect(containsTerm(normalize('builds internal tools'), 'internal tool')).toBe(true);
    expect(containsTerm(normalize('REST APIs'), 'rest api')).toBe(true);
  });

  it('does not match a single-word term inside a hyphenated compound', () => {
    // React once matched react-three-fiber, and the fit report cited a Unity game as React experience.
    expect(containsTerm(normalize('Three.js / React-Three-Fiber'), 'react')).toBe(false);
    expect(containsTerm(normalize('uses React for the UI'), 'react')).toBe(true);
  });

  it('still matches a multi-word term written with hyphens', () => {
    expect(containsTerm(normalize('rest-api integration'), 'rest api')).toBe(true);
    expect(containsTerm(normalize('real-time updates'), 'real-time')).toBe(true);
  });

  it('does not match a term inside a longer word', () => {
    expect(containsTerm(normalize('reactive programming'), 'react')).toBe(false);
    expect(containsTerm(normalize('sqlite'), 'sql')).toBe(false);
  });
});

describe('stemming and overlap', () => {
  it('folds integrate, integrating and integration onto one root', () => {
    expect(stem('integration')).toBe(stem('integrating'));
    expect(stem('integrate')).toBe(stem('integration'));
  });

  it('folds ordinary plurals and gerunds', () => {
    expect(tokens('building internal systems')).toContain('system');
    expect(tokens('language models')).toContain('model');
  });

  it('reports overlap between a posting phrase and a capability statement', () => {
    expect(overlap('integrating large language models', 'LLM application integration')).toBeGreaterThan(0);
    expect(overlap('hedge fund compliance', 'Electron desktop packaging')).toBe(0);
  });
});

describe('match against the seeded record', () => {
  it('finds a technology named literally', () => {
    const react = best('React');
    expect(react.score).toBe(1);
    expect(react.names).toContain('React');
  });

  it('finds the two automation technologies the record is thin on', () => {
    for (const term of ['Airtable', 'n8n']) {
      expect(best(term).score, term).toBe(1);
    }
  });

  it('does not invent a match for something absent from the record', () => {
    expect(best('Familiarity with the hedge fund industry').score).toBe(0);
    expect(best('COBOL on a mainframe').score).toBe(0);
  });

  it('reaches a capability described rather than named', () => {
    expect(best('Building internal tools that connect systems our team already uses').score).toBeGreaterThan(0);
  });

  it('trims the citation list rather than returning everything that scored above zero', () => {
    const out = match({ requirement: requirement('React and TypeScript'), snapshot });
    expect(topCandidates(out).length).toBeLessThanOrEqual(4);
  });

  it('is deterministic — the same requirement scores identically every time', () => {
    const a = match({ requirement: requirement('Airtable as an application backend'), snapshot });
    const b = match({ requirement: requirement('Airtable as an application backend'), snapshot });
    expect(a.best).toBe(b.best);
    expect(topCandidates(a)).toEqual(topCandidates(b));
  });
});

describe('numbersIn', () => {
  it('picks out every figure a rationale could get wrong', () => {
    expect(numbersIn('536 unit cases and 124 end-to-end, over 132,000 lines')).toEqual([
      '536',
      '124',
      '132,000',
    ]);
  });

  it('ignores digits that are part of an identifier rather than a claim', () => {
    // e2e, n8n, s3, gpt-4o. Counting these produced phantom figures that the guard then hunted for in
    // the source records and rejected good sentences over.
    expect(numbersIn('e2e coverage on n8n and s3')).toEqual([]);
  });
});

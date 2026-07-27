/**
 * The product is generic. The seeded candidate is a fixture, the way a CRM demo ships with sample
 * contacts — and the fastest way to lose that framing is copy drift, one word at a time, until the
 * screen reads as a resume with extra steps.
 *
 * Copy drift is cheap to catch and expensive to notice late, which makes it exactly the right thing to
 * put behind a test rather than a style note nobody reads.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_DIR = join(process.cwd(), 'src', 'ui');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

/**
 * Only user-visible strings are checked. Comments explain the architecture and legitimately talk about
 * the person the fixture describes; a rule that also policed comments would just get switched off.
 */
function visibleText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/^\s*\*.*$/gm, ' ');
}

const BANNED: Array<{ pattern: RegExp; instead: string }> = [
  { pattern: /\bmy (skills|experience|projects|work|portfolio|resume|background)\b/i, instead: 'the record' },
  { pattern: /\babout me\b/i, instead: 'Candidate' },
  { pattern: /\bmy resume\b/i, instead: 'the record' },
  { pattern: /\bcurriculum vitae\b/i, instead: 'the record' },
  { pattern: />\s*(Resume|CV|Portfolio)\s*</, instead: 'Record / Evidence' },
  { pattern: /\bhire me\b/i, instead: 'coverage' },
  { pattern: /\bI (have|built|shipped|worked|am)\b/, instead: 'third person, or drop the sentence' },
];

describe('interface vocabulary', () => {
  const files = sourceFiles(UI_DIR);

  it('has UI source to check', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it('never speaks in the first person or calls the record a resume', () => {
    const offences: string[] = [];

    for (const path of files) {
      const text = visibleText(readFileSync(path, 'utf8'));
      for (const { pattern, instead } of BANNED) {
        const hit = pattern.exec(text);
        if (hit) offences.push(`${path.split(/[\\/]/).pop()}: "${hit[0]}" — use ${instead}`);
      }
    }

    expect(offences).toEqual([]);
  });

  it('uses the domain vocabulary the product is built around', () => {
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const word of ['Evidence', 'coverage', 'Requirements', 'record', 'Gaps']) {
      expect(all, `the interface never says "${word}"`).toContain(word);
    }
  });

  it('keeps the Gaps section in the fit report', () => {
    // The load-bearing claim. A scoring system that only reports its hits is a flattery generator, and
    // removing this section would make the whole thing one.
    const report = readFileSync(join(UI_DIR, 'FitReport.tsx'), 'utf8');
    expect(report).toContain('what this record does not cover');
    expect(report).toMatch(/className="gaps"/);
  });
});

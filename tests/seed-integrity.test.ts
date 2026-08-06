/**
 * Every number in the seed, checked against the source it came from.
 *
 * The table below is written out by hand rather than imported, and that is deliberate: importing the
 * seed to check the seed proves nothing. These figures come from the candidate's own portfolio ledger
 * and from commands run against the repositories — `git rev-list --count HEAD` returning 125 for
 * Tendril, and so on.
 *
 * A wrong test count is worse than no test count. The entire argument this project makes is that the
 * numbers are verifiable, so a metric that drifts to make a sentence read better fails the build.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedSnapshot } from '@/store/seed';
import { SAMPLE_POSTING } from '@/ui/sample-posting';

const snapshot = seedSnapshot();

/** Independently transcribed from the portfolio ledger. Do not derive these from the seed. */
const TRUTH = {
  tendril: { loc: 132_000, unitTests: 536, e2eTests: 124, commits: 125, storeId: '9NRC4P6JQ962', version: '1.0.159' },
  parastoria: { loc: 70_000, tests: 891, commits: 185, files: 430 },
  viralHostDigital: { loc: 39_000, files: 276, terraformResources: 212, dynamoTables: 21 },
  northStar: { loc: 6_200, tests: 359, testFiles: 19, bundleKb: 62, gzipKb: 23, rating: '5.0' },
  awsCert: 'CLF-C02',
  /**
   * This repository, counted on 2026-08-05. Unlike every row above, these describe the repo the test
   * is running inside, so they drift as work continues — which is the point of pinning them. The
   * first version of this receipt claimed "6 non-negotiables" and "34 commits"; by the end of the
   * same afternoon it was 7 and 38, and both wrong numbers had already been pushed to the live base.
   *
   *   loc, files   git ls-files '*.ts' '*.tsx' | xargs wc -l
   *   rules        the '- **' bullets under ## Non-negotiables in CLAUDE.md
   *
   * No test count and no commit count. Both describe this repository from inside it, so both go
   * stale the moment anyone adds a test or makes a commit — the receipt said "278 tests" until the
   * tests added to stop it drifting made it 282, which is the trap demonstrating itself.
   */
  proofOfWork: { loc: 16_171, files: 58, nonNegotiables: 7, rulesWithTests: 6, distinctTestFiles: 5 },
} as const;

function project(id: string) {
  const found = snapshot.projects.find((p) => p.id === id);
  expect(found, `project ${id} is missing from the seed`).toBeDefined();
  return found as NonNullable<typeof found>;
}

function evidence(id: string) {
  const found = snapshot.evidence.find((e) => e.id === id);
  expect(found, `evidence ${id} is missing from the seed`).toBeDefined();
  return found as NonNullable<typeof found>;
}

describe('project metrics match the source artifacts', () => {
  it('Tendril', () => {
    const p = project('tendril');
    expect(p.metrics.loc).toBe(TRUTH.tendril.loc);
    expect(p.metrics.commits).toBe(TRUTH.tendril.commits);
    // The stored `tests` figure is the total of both suites, and the split lives in the receipts.
    expect(p.metrics.tests).toBe(TRUTH.tendril.unitTests + TRUTH.tendril.e2eTests);
  });

  it('Parastoria', () => {
    const p = project('parastoria');
    expect(p.metrics.loc).toBe(TRUTH.parastoria.loc);
    expect(p.metrics.tests).toBe(TRUTH.parastoria.tests);
    expect(p.metrics.commits).toBe(TRUTH.parastoria.commits);
    expect(p.metrics.files).toBe(TRUTH.parastoria.files);
  });

  it('Viral Host Digital', () => {
    const p = project('viral-host-digital');
    expect(p.metrics.loc).toBe(TRUTH.viralHostDigital.loc);
    expect(p.metrics.files).toBe(TRUTH.viralHostDigital.files);
  });

  it('North Star Support Bot', () => {
    const p = project('north-star-support-bot');
    expect(p.metrics.loc).toBe(TRUTH.northStar.loc);
    expect(p.metrics.tests).toBe(TRUTH.northStar.tests);
  });
});

describe('evidence values match the source artifacts', () => {
  it('quotes the Microsoft Store product id exactly', () => {
    expect(evidence('ev-tendril-store').value).toBe(TRUTH.tendril.storeId);
    expect(evidence('ev-tendril-store').url).toContain(TRUTH.tendril.storeId);
  });

  it('quotes both Tendril test counts', () => {
    expect(evidence('ev-tendril-unit').value).toContain(String(TRUTH.tendril.unitTests));
    expect(evidence('ev-tendril-e2e').value).toContain(String(TRUTH.tendril.e2eTests));
  });

  it('quotes the commit counts', () => {
    expect(evidence('ev-tendril-commits').value).toBe(String(TRUTH.tendril.commits));
    expect(evidence('ev-parastoria-commits').value).toBe(String(TRUTH.parastoria.commits));
  });

  it('quotes the infrastructure figures', () => {
    expect(evidence('ev-vhd-terraform').value).toContain(String(TRUTH.viralHostDigital.terraformResources));
    expect(evidence('ev-vhd-dynamo').value).toContain(String(TRUTH.viralHostDigital.dynamoTables));
  });

  it('quotes the North Star figures and rating', () => {
    expect(evidence('ev-ns-tests').value).toContain(String(TRUTH.northStar.tests));
    expect(evidence('ev-ns-tests').value).toContain(String(TRUTH.northStar.testFiles));
    expect(evidence('ev-ns-bundle').value).toContain(String(TRUTH.northStar.bundleKb));
    expect(evidence('ev-ns-review').value).toContain(TRUTH.northStar.rating);
  });

  it('quotes the certification code', () => {
    expect(evidence('ev-aws-ccp').value).toContain(TRUTH.awsCert);
  });
});

describe('the raw fixtures agree with the seed', () => {
  const rawDir = join(process.cwd(), 'raw');
  const allRaw = readdirSync(rawDir)
    .map((f) => readFileSync(join(rawDir, f), 'utf8'))
    .join('\n');

  it('states the same figures the seed does', () => {
    // The fixtures are what a live ingest reads. If they disagree with the seed, a demo run produces a
    // record that contradicts the one already on screen.
    for (const figure of [
      String(TRUTH.tendril.unitTests),
      String(TRUTH.tendril.e2eTests),
      String(TRUTH.tendril.commits),
      TRUTH.tendril.storeId,
      TRUTH.tendril.version,
      String(TRUTH.parastoria.tests),
      String(TRUTH.parastoria.commits),
      String(TRUTH.viralHostDigital.terraformResources),
      String(TRUTH.viralHostDigital.dynamoTables),
      String(TRUTH.northStar.tests),
      TRUTH.awsCert,
    ]) {
      expect(allRaw, `raw fixtures never mention ${figure}`).toContain(figure);
    }
  });

  it('keeps company-identifying figures out of the sample AND out of our prose', () => {
    // This assertion used to run the other way for the sample: "700+ vetted advisors" and "600+
    // coaches" are absent from the company's own site but WERE in the posting, so quoting them was the
    // company quoting itself and the sample was allowed to carry them.
    //
    // That rationale died with the anonymisation. The demo now ships publicly and recruiters at other
    // companies open it, so the bundled sample names a company that does not exist and carries no
    // "About" blurb at all — no headcounts, no industry description, no learn-more URL. A figure that
    // identifies a real company has nowhere left to live, here or in raw/, and the ban on our own
    // prose is unchanged.
    for (const figure of [/700\+?\s*(vetted\s*)?advisors/i, /600\+?\s*coaches/i, /time-to-fill/i]) {
      expect(allRaw, `raw/ quotes ${figure}`).not.toMatch(figure);
      expect(SAMPLE_POSTING, `the sample quotes ${figure}`).not.toMatch(figure);
    }
    expect(SAMPLE_POSTING).not.toMatch(/arootah/i);
    expect(SAMPLE_POSTING).not.toMatch(/18 functional disciplines/i);
  });

  it('keeps every requirement bullet byte-identical through the anonymisation', () => {
    // Only the company name and its blurb changed. The bullets are what the deterministic reader
    // parses and what the pinned anchor stands on (tests/resume.test.ts: 16 requirements, 75 percent),
    // so a reworded bullet is a moved anchor even when the count survives.
    for (const bullet of [
      '- Build and maintain full-stack web and mobile-friendly applications, including React-based front ends and their supporting data layers',
      '- Design and maintain Airtable bases (schema, automations, interfaces, and data quality) that back internal and client-facing tools',
      '- Strong experience using Airtable as an application backend (linked records, automations, interfaces)',
      "- Familiarity with Claude Code (Anthropic's agentic coding tool), or a willingness to adopt it to ship quickly",
    ]) {
      expect(SAMPLE_POSTING).toContain(bullet);
    }
    expect(SAMPLE_POSTING.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(16);
  });
});

describe('referential integrity', () => {
  it('has no link pointing at a row that does not exist', () => {
    const ids = {
      projects: new Set(snapshot.projects.map((p) => p.id)),
      technologies: new Set(snapshot.technologies.map((t) => t.id)),
      capabilities: new Set(snapshot.capabilities.map((c) => c.id)),
      evidence: new Set(snapshot.evidence.map((e) => e.id)),
    };

    for (const p of snapshot.projects) {
      for (const id of p.technologies) expect(ids.technologies, `${p.id} -> ${id}`).toContain(id);
      for (const id of p.capabilities) expect(ids.capabilities, `${p.id} -> ${id}`).toContain(id);
      for (const id of p.evidence) expect(ids.evidence, `${p.id} -> ${id}`).toContain(id);
    }
    for (const c of snapshot.capabilities) {
      for (const id of c.projects) expect(ids.projects, `${c.id} -> ${id}`).toContain(id);
      for (const id of c.evidence) expect(ids.evidence, `${c.id} -> ${id}`).toContain(id);
    }
    for (const e of snapshot.evidence) {
      for (const id of e.projects) expect(ids.projects, `${e.id} -> ${id}`).toContain(id);
    }
  });

  it('fills the reverse link on every technology a project names', () => {
    for (const project of snapshot.projects) {
      for (const techId of project.technologies) {
        const tech = snapshot.technologies.find((t) => t.id === techId);
        expect(tech?.projects, `${techId} does not link back to ${project.id}`).toContain(project.id);
      }
    }
  });

  it('stamps every project, capability and evidence row with a candidate that exists', () => {
    const candidateIds = new Set(snapshot.candidates.map((c) => c.id));
    for (const p of snapshot.projects) expect(candidateIds, `${p.id}.candidate -> ${p.candidate}`).toContain(p.candidate);
    for (const c of snapshot.capabilities) expect(candidateIds, `${c.id}.candidate -> ${c.candidate}`).toContain(c.candidate);
    for (const e of snapshot.evidence) expect(candidateIds, `${e.id}.candidate -> ${e.candidate}`).toContain(e.candidate);
  });

  it("mirrors candidate-joel's link arrays over every row, with no orphans", () => {
    // Both directions at once: sorted equality fails on a link pointing at a row that does not exist
    // AND on a row the candidate's arrays quietly miss. The seed wraps the whole record in one person,
    // so an orphaned row here is a row the recruiter seat would never see.
    const joel = snapshot.candidates.find((c) => c.id === 'candidate-joel');
    expect(joel, 'candidate-joel is missing from the seed').toBeDefined();
    if (!joel) return;

    expect([...joel.projects].sort()).toEqual(snapshot.projects.map((p) => p.id).sort());
    expect([...joel.capabilities].sort()).toEqual(snapshot.capabilities.map((c) => c.id).sort());
    expect([...joel.evidence].sort()).toEqual(snapshot.evidence.map((e) => e.id).sort());
  });

  it('makes no claim it cannot back — every seeded capability carries evidence', () => {
    // This assertion used to be the inverse: one evidence-less row was kept so the gate had a visible
    // example. v3 changed what a capability IS — a claim the applicant made — so an unverified row on
    // the seeded applicant read as a claim caught failing verification, about something Joel never
    // claimed. The gate's visible example now comes from resume intake, where claims are born
    // unverified honestly (tests/resume.test.ts). The seeded record itself must be fully receipted.
    expect(snapshot.capabilities.some((c) => c.evidence.length === 0)).toBe(false);
  });

  it('marks Airtable and n8n as stretch, with this project as their only evidence', () => {
    for (const id of ['cap-airtable-backend', 'cap-n8n-automation']) {
      const cap = snapshot.capabilities.find((c) => c.id === id);
      expect(cap?.tier, id).toBe('stretch');
      expect(cap?.projects, id).toEqual(['proof-of-work']);
      expect(cap?.evidence.length, id).toBeGreaterThan(0);
    }
  });
});

/**
 * The self-referential receipt.
 *
 * ev-pow-claude-code describes THIS repository, so any number in it goes stale as this repository is
 * worked on. That is not hypothetical: it shipped saying "6 non-negotiables" and "34 commits", and by
 * the end of that afternoon the real figures were 7 and 38, with both wrong numbers already pushed to
 * the live Airtable base. The replacement then said "278 tests" until the tests written to stop it
 * drifting made it 282 — the trap demonstrating itself.
 *
 * So the receipt carries no counts, scale moved to the project row where every other project keeps
 * it, and the one number that survives is checked by counting CLAUDE.md rather than by trusting it.
 */
describe('the Claude Code receipt describes this repository accurately', () => {
  const claudeCode = () => evidence('ev-pow-claude-code');

  it('states what CLAUDE.md actually pins, including the rule with no test behind it', () => {
    /**
     * All three figures are counted, because the first version of this receipt said the rules name
     * "each one" a test file and that was false twice over: one rule names none, and two share a
     * file. A live rationale then reported "7 non-negotiables through 7 test files", inflating an
     * overstatement it had been handed. Downstream repeats the receipt more confidently than the
     * receipt states it, so the receipt is where this has to be exact.
     */
    const md = readFileSync('CLAUDE.md', 'utf8');
    const section = md.slice(md.indexOf('## Non-negotiables'), md.indexOf('## Stack'));

    const bullets = section.split(/\n(?=- \*\*)/).filter((b) => b.startsWith('- **'));
    const withTest = bullets.filter((b) => /tests\/[a-z-]+\.test\.ts/.test(b));
    const distinctFiles = new Set(section.match(/tests\/[a-z-]+\.test\.ts/g) ?? []);

    expect(bullets.length, 'non-negotiables').toBe(TRUTH.proofOfWork.nonNegotiables);
    expect(withTest.length, 'rules naming a test file').toBe(TRUTH.proofOfWork.rulesWithTests);
    expect(distinctFiles.size, 'distinct test files named').toBe(TRUTH.proofOfWork.distinctTestFiles);

    // The receipt states ONE of these three, deliberately. Every attempt to state the 6/5/1 breakdown
    // precisely was compressed wrong by the rationale model in turn: "7 non-negotiables through 7 test
    // files", then "6 test files ... across 5 test files", then "cites 6 test files". Each version was
    // more accurate and read worse, because a receipt carrying more nuance than a small model can
    // compress becomes a garbled sentence in front of a reader.
    //
    // The other two counts stay asserted above, where they make "each one stating how it is enforced"
    // a checked claim rather than a pleasant one: six rules name a test file, the seventh names the
    // mode banner, and six plus one accounts for all seven.
    expect(claudeCode().value).toContain(`${TRUTH.proofOfWork.nonNegotiables} non-negotiables`);
    expect(withTest.length + 1, 'every rule accounted for').toBe(TRUTH.proofOfWork.nonNegotiables);
  });

  it('carries no count that goes stale when this repository is worked on', () => {
    /**
     * The line this guard has to walk, learned by getting it wrong twice. "5 test files" is fine: it
     * counts the files CLAUDE.md names, changes only when a rule changes, and is pinned three lines
     * up. "282 tests" and "38 commits" are not: they change when anyone adds a test or commits.
     *
     * So the target is the volatile shape, not the words. Both earlier versions banned honest
     * phrasing instead — first "the test file that enforces it", then "5 test files" — and a guard
     * that fires on honest wording gets loosened until it guards nothing.
     */
    const value = claudeCode().value;
    expect(value, 'a commit count goes stale on the next commit').not.toMatch(/\d[\d,]*\s*commits?\b/i);
    expect(value, 'a suite-sized figure belongs on the project metrics row').not.toMatch(/\d[\d,]{2,}/);
    expect(value, 'lines and files belong on the project metrics row').not.toMatch(
      /\d[\d,]*\s*(lines|loc)\b/i,
    );
  });

  it('keeps the scale on the project metrics row, like every other project', () => {
    const p = project('proof-of-work');
    expect(p.metrics.loc).toBe(TRUTH.proofOfWork.loc);
    expect(p.metrics.files).toBe(TRUTH.proofOfWork.files);
    expect(p.metrics.tests, 'a test count here goes stale on the next test').toBeUndefined();
    expect(p.metrics.commits, 'a commit count here goes stale on the next commit').toBeUndefined();
  });

  it('counts the same TypeScript the metrics claim', () => {
    // Walks the tree the way `git ls-files '*.ts' '*.tsx' | xargs wc -l` does, so the number on the
    // project row has a command behind it rather than a memory. Banded rather than exact because this
    // file is itself TypeScript and grows whenever a test is added; drift past the band means the
    // figure needs re-counting, which is the reminder this assertion exists to deliver.
    const roots = ['src', 'tests', 'scripts', 'airtable', 'n8n'];
    let lines = 0;
    let files = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          files += 1;
          lines += readFileSync(path, 'utf8').split('\n').length;
        }
      }
    };
    for (const root of roots) walk(root);

    expect(files, 'TypeScript file count').toBeGreaterThanOrEqual(TRUTH.proofOfWork.files - 2);
    expect(files, 'TypeScript file count').toBeLessThan(TRUTH.proofOfWork.files + 6);
    expect(lines, 'TypeScript line count').toBeGreaterThan(TRUTH.proofOfWork.loc * 0.95);
    expect(lines, 'TypeScript line count').toBeLessThan(TRUTH.proofOfWork.loc * 1.15);
  });
});

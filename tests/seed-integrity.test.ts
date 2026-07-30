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

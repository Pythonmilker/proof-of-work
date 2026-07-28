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

  it('never quotes an Arootah statistic that could not be verified on their site', () => {
    // "18 functional disciplines" is on the site and is used. "700+ advisors" and "600+ coaches" were
    // not found there, so they appear nowhere in this project. Quoting a company's own numbers back at
    // them incorrectly would be a strange thing to do inside a demo about verifiable claims.
    // Only what a reader can actually see. The source file's own comment explains which figures were
    // excluded and why, and it would otherwise trip this check by naming them.
    const everything = [allRaw, SAMPLE_POSTING].join('\n');
    expect(everything).not.toMatch(/700\+?\s*(vetted\s*)?advisors/i);
    expect(everything).not.toMatch(/600\+?\s*coaches/i);
    expect(everything).not.toMatch(/time-to-fill/i);
  });

  it('does use the one Arootah figure that is on their site', () => {
    expect(SAMPLE_POSTING).toMatch(/18 functional disciplines/i);
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

  it('keeps at least one capability with no evidence, so the gate stays visible', () => {
    // Not a bug being tolerated. An unverified row is what the evidence gate looks like in the views,
    // and removing the last one would make the rule invisible to anyone reading the screenshots.
    expect(snapshot.capabilities.some((c) => c.evidence.length === 0)).toBe(true);
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

/**
 * The pipeline end to end, on the keyless path, against the real raw fixtures.
 *
 * These are the three branches a reviewer is shown on camera, so they are the three branches that must
 * never regress: a record that is genuinely new, a record already known, and a source that cannot be
 * parsed at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingest, matchRole } from '@/pipeline';
import { findDuplicate, linkCapabilities, linkTechnologies, mergeProject } from '@/pipeline/link';
import { LocalStore } from '@/store/local';
import { seedSnapshot } from '@/store/seed';
import { SAMPLE_POSTING } from '@/ui/sample-posting';

const raw = (name: string) => readFileSync(join(process.cwd(), 'raw', name), 'utf8');
const keyless = { apiKey: undefined, now: () => '2026-07-27T00:00:00.000Z' };

let store: LocalStore;
beforeEach(() => {
  store = new LocalStore();
});

describe('ingest', () => {
  it('creates a record from a source it has not seen', async () => {
    const result = await ingest(raw('10-genestrata-unity.md'), '10-genestrata-unity.md', store, keyless);

    expect(result.ok).toBe(true);
    expect(result.duplicateOf).toBeNull();
    expect(result.project?.name).toBe('Genestrata');
    expect(result.stages.every((s) => s.state !== 'failed')).toBe(true);

    const after = await store.read();
    expect(after.projects.some((p) => p.id === 'genestrata')).toBe(true);
  });

  it('updates rather than duplicating when the project is already on file', async () => {
    const before = (await store.read()).projects.length;
    const result = await ingest(raw('01-tendril-readme.md'), '01-tendril-readme.md', store, keyless);

    expect(result.ok).toBe(true);
    expect(result.duplicateOf).toBe('tendril');
    expect((await store.read()).projects.length).toBe(before);
  });

  it('parks an unparseable source in Needs Review instead of dropping it', async () => {
    // The whole argument for the error branch: a pipeline that discards what it cannot parse produces
    // output that looks complete and is not, and the omission is invisible.
    const result = await ingest(raw('11-broken-fragment.txt'), '11-broken-fragment.txt', store, keyless);

    expect(result.ok).toBe(false);
    expect(result.project?.reviewStatus).toBe('needs-review');
    expect(result.project?.reviewReason).toBeTruthy();

    const parked = (await store.read()).projects.filter((p) => p.reviewStatus === 'needs-review');
    expect(parked).toHaveLength(1);
    expect(parked[0]?.source).toBe('11-broken-fragment.txt');
  });

  it('reports every stage, including the ones it skipped', async () => {
    const result = await ingest(raw('11-broken-fragment.txt'), '11-broken-fragment.txt', store, keyless);
    expect(result.stages.map((s) => s.stage)).toEqual(['extract', 'validate', 'dedup', 'link', 'write']);
    expect(result.stages.find((s) => s.stage === 'validate')?.state).toBe('failed');
    expect(result.stages.find((s) => s.stage === 'dedup')?.state).toBe('skipped');
  });

  it('reads the real metrics out of raw test output without a model', async () => {
    const result = await ingest(raw('03-tendril-test-output.txt'), '03-tendril-test-output.txt', store, keyless);
    expect(result.ok).toBe(true);
    const extracted = result.extracted as { metrics: Record<string, number | null> };
    expect(extracted.metrics['tests']).toBe(536);
    expect(extracted.metrics['commits']).toBe(125);
  });

  it('records a capability it invented as unverified, never as proven', async () => {
    await ingest(raw('10-genestrata-unity.md'), '10-genestrata-unity.md', store, keyless);
    const after = await store.read();
    for (const created of after.capabilities.filter((c) => c.evidence.length === 0)) {
      expect(created.tier === 'stretch' || created.evidence.length === 0).toBe(true);
    }
  });
});

describe('dedup and linking', () => {
  const snapshot = seedSnapshot();

  it('matches on slug and on an overlapping name', () => {
    expect(findDuplicate(snapshot, 'Tendril').duplicate?.id).toBe('tendril');
    expect(findDuplicate(snapshot, 'Tendril — agent-first IDE').duplicate?.id).toBe('tendril');
    expect(findDuplicate(snapshot, 'Something Else Entirely').duplicate).toBeNull();
  });

  it('merges without losing anything the existing row already had', () => {
    const existing = snapshot.projects.find((p) => p.id === 'tendril');
    expect(existing).toBeDefined();
    if (!existing) return;

    const merged = mergeProject(existing, {
      ...existing,
      summary: 'A newer summary.',
      metrics: { commits: 126 },
      technologies: ['airtable'],
      capabilities: [],
      evidence: ['ev-new'],
    });

    expect(merged.summary).toBe('A newer summary.');
    expect(merged.metrics.commits).toBe(126);
    expect(merged.metrics.loc).toBe(existing.metrics.loc); // untouched, not clobbered
    expect(merged.technologies).toEqual(expect.arrayContaining([...existing.technologies, 'airtable']));
    expect(merged.evidence).toContain('ev-new');
  });

  it('resolves loose stack strings in both directions', () => {
    // "React 19" contains the row name; "Lambda" is contained by an alias. Real input does both.
    const out = linkTechnologies(snapshot, ['React 19', 'Lambda', 'Airtable']);
    expect(out.existing).toEqual(expect.arrayContaining(['react', 'aws-lambda', 'airtable']));
    expect(out.created).toEqual([]);
  });

  it('creates an unknown technology rather than silently dropping it', () => {
    const out = linkTechnologies(snapshot, ['Rust']);
    expect(out.created.map((t) => t.name)).toEqual(['Rust']);
    expect(out.existing).toContain('rust');
  });

  it('creates an unknown capability as stretch with no evidence', () => {
    // A model reading a README will happily assert "scalable architecture". It arrives unverified.
    const out = linkCapabilities(snapshot, ['Scalable architecture']);
    expect(out.created).toHaveLength(1);
    expect(out.created[0]?.tier).toBe('stretch');
    expect(out.created[0]?.evidence).toEqual([]);
  });
});

describe('matchRole', () => {
  it('scores the sample posting without a key, and says the retrieval was lexical', async () => {
    const report = await matchRole(SAMPLE_POSTING, store, keyless);

    expect(report.retrieval).toBe('lexical');
    expect(report.parseVia).toBe('deterministic');
    expect(report.rationaleVia).toBe('template');
    expect(report.role.requirements.length).toBeGreaterThan(8);
    expect(report.coverage.score).toBeGreaterThan(0);
    expect(report.coverage.score).toBeLessThanOrEqual(100);
  });

  it('never reports a perfect score against this posting', () => {
    // If this ever passes, something has stopped being honest. The record has no alternative-investment
    // domain experience and no talent-acquisition work, and both are in the posting.
    return matchRole(SAMPLE_POSTING, store, keyless).then((report) => {
      expect(report.coverage.score).toBeLessThan(100);
      expect(report.gaps.length).toBeGreaterThan(0);
    });
  });

  it('caps Airtable, n8n and Zapier at partial, because they are stretch capabilities', async () => {
    const report = await matchRole(SAMPLE_POSTING, store, keyless);
    const automation = report.role.requirements.filter((r) => /airtable|n8n|zapier/i.test(r.text));

    expect(automation.length).toBeGreaterThan(0);
    for (const requirement of automation) {
      const result = report.role.results.find((r) => r.requirementId === requirement.id);
      expect(result?.status, requirement.text).toBe('partial');
    }
  });

  it('lists this project as the closest evidence for the automation gaps', async () => {
    const report = await matchRole(SAMPLE_POSTING, store, keyless);
    const airtableGap = report.gaps.find((g) => /airtable/i.test(g.requirement.text));

    expect(airtableGap).toBeDefined();
    expect(airtableGap?.closestEvidence?.label).toMatch(/airtable/i);
    expect(airtableGap?.note).toMatch(/stretch/i);
  });

  it('gives the same answer twice for the same input', async () => {
    const a = await matchRole(SAMPLE_POSTING, store, keyless);
    const b = await matchRole(SAMPLE_POSTING, store, keyless);
    expect(a.coverage).toEqual(b.coverage);
    expect(a.role.results.map((r) => [r.requirementId, r.status, r.score])).toEqual(
      b.role.results.map((r) => [r.requirementId, r.status, r.score]),
    );
  });

  it('writes the posting back verbatim so a result can always be re-derived', async () => {
    const report = await matchRole(SAMPLE_POSTING, store, keyless);
    expect(report.role.postedText).toBe(SAMPLE_POSTING);
    expect((await store.read()).roles).toHaveLength(1);
  });
});

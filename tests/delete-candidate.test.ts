/**
 * Removing an applicant.  (DESIGN.md §v3.2 — the ownership map)
 *
 * A recruiter ingests test applicants and needs them gone, which makes delete a real feature and not a
 * convenience. Three things have to hold, and each one is a way this schema has already broken once:
 *
 *   1. **Exactly the owned rows go.** Projects, Capabilities, Evidence and the candidate's Results rows.
 *      Technologies and Roles are global vocabulary — React is React for everyone, a posting is
 *      scoreable by anyone — so a Role record stays and only that candidate's Results rows for it go.
 *   2. **Nothing is left pointing at a deleted row.** Airtable maintains the reverse side of a link for
 *      free; the local store does it in code, and a Technology holding the id of a deleted project is
 *      this file's recurring bug. The dangling sweep below walks every link array in the snapshot.
 *   3. **The seeded candidate cannot be deleted**, and the refusal lives in the store, where an API
 *      call cannot get around it.
 *
 * The last block re-runs the v3 regression anchor after a deletion. Removing someone else's record is
 * not allowed to move the number the demo stands on.
 */

import { describe, expect, it } from 'vitest';
import { ingestResume, matchRole } from '@/pipeline';
import { AirtableStore } from '@/store/airtable';
import { LocalStore } from '@/store/local';
import { DEFAULT_CANDIDATE_ID, deletionCounts, type Snapshot } from '@/store/types';
import { SAMPLE_POSTING } from '@/ui/sample-posting';

const keyless = { apiKey: undefined, now: () => '2026-07-28T00:00:00.000Z' };
/** A second scoring date, so the two runs land on two Roles rows rather than one overwriting the other. */
const later = { apiKey: undefined, now: () => '2026-07-29T00:00:00.000Z' };

/** Structured enough for the deterministic reader, and every skill resolves — the taxonomy stays clean. */
const JANE_RESUME = `# Jane Doe
jane.doe@example.net · (555) 123-4567 · https://janedoe.dev

## Skills
React, TypeScript, AWS Lambda, Terraform, DynamoDB, Playwright

## Experience
### Platform Engineer — Initech
- Built an internal React dashboard over DynamoDB for workflow tracking
- Automated infrastructure deployments with Terraform
`;

/**
 * A store holding two applicants, both scored, and one Roles row carrying BOTH their Results rows.
 *
 * The shared role is the case that matters: it is the only way to prove a delete filters Results by
 * the candidate stamp rather than dropping the posting they were scored against.
 */
async function twoApplicants(): Promise<{ store: LocalStore; janeId: string; sharedRole: string }> {
  const store = new LocalStore();
  const joel = await matchRole(SAMPLE_POSTING, store, keyless);

  const jane = await ingestResume(JANE_RESUME, 'jane-doe-resume.md', store, keyless);
  expect(jane.ok).toBe(true);
  const janeRun = await matchRole(SAMPLE_POSTING, store, { ...later, candidateId: jane.candidateId });

  // Both candidates' rows onto one Role, which is what the Airtable side produces naturally: results
  // are upserted there by their own `{candidate}-{role}-req-N` key and accumulate on the posting.
  const roles = (await store.read()).roles;
  const shared = roles.find((r) => r.id === joel.role.id);
  const janes = roles.find((r) => r.id === janeRun.role.id);
  if (!shared || !janes) throw new Error('both runs should have written a Roles row');
  await store.saveRole({ ...shared, results: [...shared.results, ...janes.results] });

  return { store, janeId: jane.candidateId, sharedRole: shared.id };
}

/**
 * Every link in the snapshot, in every direction, checked against the rows that still exist.
 *
 * Written as a sweep rather than as a handful of spot checks because the failure is always the link
 * nobody thought about — and a dangling link never throws, it just resolves to nothing.
 */
function danglingLinks(snapshot: Snapshot): string[] {
  const candidates = new Set(snapshot.candidates.map((c) => c.id));
  const projects = new Set(snapshot.projects.map((p) => p.id));
  const technologies = new Set(snapshot.technologies.map((t) => t.id));
  const capabilities = new Set(snapshot.capabilities.map((c) => c.id));
  const evidence = new Set(snapshot.evidence.map((e) => e.id));

  const bad: string[] = [];
  const check = (where: string, known: Set<string>, links: readonly string[]) => {
    for (const id of links) if (!known.has(id)) bad.push(`${where} → ${id}`);
  };

  for (const c of snapshot.candidates) {
    check(`Candidate ${c.id}.projects`, projects, c.projects);
    check(`Candidate ${c.id}.capabilities`, capabilities, c.capabilities);
    check(`Candidate ${c.id}.evidence`, evidence, c.evidence);
  }
  for (const p of snapshot.projects) {
    check(`Project ${p.id}.candidate`, candidates, [p.candidate]);
    check(`Project ${p.id}.technologies`, technologies, p.technologies);
    check(`Project ${p.id}.capabilities`, capabilities, p.capabilities);
    check(`Project ${p.id}.evidence`, evidence, p.evidence);
  }
  for (const t of snapshot.technologies) check(`Technology ${t.id}.projects`, projects, t.projects);
  for (const c of snapshot.capabilities) {
    check(`Capability ${c.id}.candidate`, candidates, [c.candidate]);
    check(`Capability ${c.id}.projects`, projects, c.projects);
    check(`Capability ${c.id}.evidence`, evidence, c.evidence);
  }
  for (const e of snapshot.evidence) {
    check(`Evidence ${e.id}.candidate`, candidates, [e.candidate]);
    check(`Evidence ${e.id}.projects`, projects, e.projects);
  }
  for (const role of snapshot.roles) {
    for (const r of role.results) {
      const at = `Result ${role.id}/${r.requirementId}`;
      check(`${at}.candidate`, candidates, [r.candidate]);
      check(`${at}.matchedTechnologies`, technologies, r.matchedTechnologies);
      check(`${at}.matchedCapabilities`, capabilities, r.matchedCapabilities);
      check(`${at}.matchedProjects`, projects, r.matchedProjects);
      check(`${at}.evidence`, evidence, r.evidence);
    }
  }
  return bad;
}

describe('LocalStore.deleteCandidate', () => {
  it('removes exactly the rows that candidate owns', async () => {
    const { store, janeId } = await twoApplicants();
    const before = await store.read();

    // The fixture is only worth anything if she actually owns rows in all four tables.
    const counts = deletionCounts(before, janeId);
    expect(counts.projects).toBeGreaterThan(0);
    expect(counts.claims).toBeGreaterThan(0);
    expect(counts.results).toBe(32); // 16 on her own Roles row, 16 on the shared one

    await store.deleteCandidate(janeId);
    const after = await store.read();

    const survivors = <T extends { candidate: string; id: string }>(rows: T[]) =>
      rows.filter((r) => r.candidate !== janeId).map((r) => r.id);

    expect(after.candidates.map((c) => c.id)).toEqual(
      before.candidates.filter((c) => c.id !== janeId).map((c) => c.id),
    );
    expect(after.projects.map((p) => p.id)).toEqual(survivors(before.projects));
    expect(after.capabilities.map((c) => c.id)).toEqual(survivors(before.capabilities));
    expect(after.evidence.map((e) => e.id)).toEqual(survivors(before.evidence));
    expect(deletionCounts(after, janeId)).toEqual({ projects: 0, claims: 0, evidence: 0, results: 0 });
  });

  it('leaves Technologies standing and takes only the deleted candidate’s fit reports', async () => {
    const { store, janeId, sharedRole } = await twoApplicants();
    const before = await store.read();
    const janeProjects = before.projects.filter((p) => p.candidate === janeId).map((p) => p.id);

    // Jane's position stub is linked into the GLOBAL React row. That link is the one that has to be
    // cleaned up without the row itself going anywhere.
    const reactBefore = before.technologies.find((t) => t.id === 'react');
    expect(reactBefore?.projects).toEqual(expect.arrayContaining(janeProjects));

    await store.deleteCandidate(janeId);
    const after = await store.read();

    expect(after.technologies.map((t) => t.id)).toEqual(before.technologies.map((t) => t.id));
    expect(after.technologies.find((t) => t.id === 'react')?.projects).toEqual(
      reactBefore?.projects.filter((id) => !janeProjects.includes(id)),
    );

    // A Roles row is one candidate's FIT REPORT, and since the key became candidate-scoped it belongs
    // to exactly one person. Jane's own row goes with her; the seed candidate's stays.
    const janeRoles = before.roles.filter((r) => r.candidate === janeId).map((r) => r.id);
    expect(janeRoles.length, 'the fixture should have given Jane a role of her own').toBeGreaterThan(0);
    expect(after.roles.map((r) => r.id)).toEqual(
      before.roles.filter((r) => !janeRoles.includes(r.id)).map((r) => r.id),
    );

    for (const role of after.roles) {
      const was = before.roles.find((r) => r.id === role.id);
      expect(role.requirements).toEqual(was?.requirements);
      expect(role.results.every((r) => r.candidate !== janeId)).toBe(true);
    }

    // The legacy shape still has to be scrubbed. `sharedRole` is deliberately built carrying BOTH
    // candidates' results — what the base produced before the key was scoped — and a delete has to
    // filter those rather than assume one row means one candidate.
    const shared = after.roles.find((r) => r.id === sharedRole);
    expect(shared, 'the seed candidate keeps their own report').toBeDefined();
    expect(shared?.results).toHaveLength(16); // the seed candidate's half, untouched
    expect(shared?.results.every((r) => r.candidate === DEFAULT_CANDIDATE_ID)).toBe(true);
  });

  it('leaves nothing in the snapshot pointing at a deleted row', async () => {
    const { store, janeId } = await twoApplicants();
    expect(danglingLinks(await store.read()), 'the fixture starts clean').toEqual([]);

    await store.deleteCandidate(janeId);

    expect(danglingLinks(await store.read())).toEqual([]);
  });

  it('refuses the seeded candidate in the store, not only in the UI', async () => {
    const store = new LocalStore();
    await expect(store.deleteCandidate(DEFAULT_CANDIDATE_ID)).rejects.toThrow(/cannot be deleted/);

    // And the record is exactly as it was — a refusal that half-deleted something would be worse than
    // no guard at all.
    const after = await store.read();
    expect(after.candidates.some((c) => c.id === DEFAULT_CANDIDATE_ID)).toBe(true);
    expect(after.projects.length).toBeGreaterThan(0);
    expect(after.capabilities.length).toBeGreaterThan(0);
  });

  it('refuses an applicant it does not have', async () => {
    const store = new LocalStore();
    await expect(store.deleteCandidate('candidate-nobody')).rejects.toThrow(/no applicant on file/);
  });
});

describe('the v3 regression anchor, after a deletion', () => {
  it('still scores the bundled posting 75 — 10 proven, 4 partial, 2 gaps across 16 requirements', async () => {
    // Pinned exactly (DESIGN.md §v3.5). Deleting somebody else's record is not allowed to move it.
    const { store, janeId } = await twoApplicants();
    await store.deleteCandidate(janeId);

    const report = await matchRole(SAMPLE_POSTING, store, keyless);

    expect(report.role.requirements).toHaveLength(16);
    expect(report.coverage.score).toBe(75);
    expect(report.coverage.proven).toBe(10);
    expect(report.coverage.partial).toBe(4);
    expect(report.coverage.gap).toBe(2);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The Airtable side. Real deletes, so what is asserted is the actual HTTP: which tables were called,
 * with which record ids, in chunks no larger than the write ceiling.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

interface FakeRecord {
  id: string;
  fields: Record<string, unknown>;
}

/** Twelve Results rows for Jane, so the batching is exercised rather than assumed: 10 then 2. */
function fakeBase(): Record<string, FakeRecord[]> {
  const janeResults = Array.from({ length: 12 }, (_, i) => ({
    id: `recJaneRes${i}`,
    fields: {
      Key: `candidate-jane-role-arootah-req-${i + 1}`,
      Candidate: ['recJane'],
      Role: ['recRole'],
      Requirement: `requirement ${i + 1}`,
      Status: 'gap',
    },
  }));

  return {
    Candidates: [
      { id: 'recJane', fields: { Key: 'candidate-jane', Name: 'Jane Doe', Projects: ['recJaneProj'] } },
      { id: 'recJoel', fields: { Key: DEFAULT_CANDIDATE_ID, Name: 'Joel', Projects: ['recJoelProj'] } },
    ],
    Projects: [
      { id: 'recJaneProj', fields: { Key: 'jane-p1', Name: 'Initech', Candidate: ['recJane'] } },
      { id: 'recJoelProj', fields: { Key: 'joel-p1', Name: 'Seed', Candidate: ['recJoel'] } },
    ],
    Technologies: [
      { id: 'recReact', fields: { Key: 'react', Name: 'React', Projects: ['recJaneProj', 'recJoelProj'] } },
    ],
    Capabilities: [{ id: 'recJaneCap', fields: { Key: 'cap-jane-1', Candidate: ['recJane'] } }],
    Evidence: [{ id: 'recJaneEv', fields: { Key: 'ev-jane-1', Candidate: ['recJane'] } }],
    Roles: [
      // Written before the Key was candidate-scoped: no Candidate link, and both applicants' Results
      // hang off it. Deleting one applicant must NOT take it, or the survivor loses their report.
      { id: 'recRole', fields: { Key: 'role-arootah', Title: 'AI Product Engineer' } },
      // Jane's own, written since. This one goes with her.
      { id: 'recJaneRole', fields: { Key: 'candidate-jane-role-northwind', Title: 'Engineer', Candidate: ['recJane'] } },
    ],
    Results: [
      ...janeResults,
      {
        id: 'recJoelRes',
        fields: {
          Key: `${DEFAULT_CANDIDATE_ID}-role-arootah-req-1`,
          Candidate: ['recJoel'],
          Role: ['recRole'],
          Requirement: 'requirement 1',
          Status: 'proven',
        },
      },
    ],
  };
}

function fakeAirtable(base: Record<string, FakeRecord[]>, deletes: Array<{ table: string; ids: string[] }>) {
  return (async (url: unknown, init?: RequestInit) => {
    const target = new URL(String(url));
    const table = decodeURIComponent(target.pathname.split('/').pop() ?? '');
    if ((init?.method ?? 'GET') === 'DELETE') {
      const ids = target.searchParams.getAll('records[]');
      deletes.push({ table, ids });
      for (const id of ids) base[table] = (base[table] ?? []).filter((r) => r.id !== id);
      return new Response(JSON.stringify({ records: ids.map((id) => ({ id, deleted: true })) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ records: base[table] ?? [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('AirtableStore.deleteCandidate', () => {
  it('deletes the owned rows in batches of ten and never touches Technologies or Roles', async () => {
    const base = fakeBase();
    const deletes: Array<{ table: string; ids: string[] }> = [];
    const store = new AirtableStore({ pat: 'pat-test', baseId: 'appTest', fetchImpl: fakeAirtable(base, deletes) });

    await store.deleteCandidate('candidate-jane');

    // Airtable 422s the whole request over the ceiling, not just the extra rows.
    for (const call of deletes) expect(call.ids.length).toBeLessThanOrEqual(10);

    const byTable = (table: string) => deletes.filter((d) => d.table === table).flatMap((d) => d.ids);
    expect(byTable('Results')).toEqual(Array.from({ length: 12 }, (_, i) => `recJaneRes${i}`));
    expect(deletes.filter((d) => d.table === 'Results')).toHaveLength(2); // 10 + 2
    expect(byTable('Evidence')).toEqual(['recJaneEv']);
    expect(byTable('Capabilities')).toEqual(['recJaneCap']);
    expect(byTable('Projects')).toEqual(['recJaneProj']);
    expect(byTable('Candidates')).toEqual(['recJane']);

    // Global vocabulary. Deleting an applicant must never reach for it.
    expect(byTable('Technologies')).toEqual([]);
    expect(base['Technologies']).toHaveLength(1);

    // Her own fit report goes; the pre-scoping row both applicants share stays, because taking it
    // would destroy the seed candidate's report to clean up hers.
    expect(byTable('Roles')).toEqual(['recJaneRole']);
    expect(base['Roles']?.map((r) => r.id)).toEqual(['recRole']);

    // The seed candidate's rows, including their Results row on the shared posting, are all still there.
    expect(base['Results']?.map((r) => r.id)).toEqual(['recJoelRes']);
    expect(base['Candidates']?.map((r) => r.id)).toEqual(['recJoel']);
  }, 20_000);

  it('refuses the seeded candidate before it issues a single request', async () => {
    const deletes: Array<{ table: string; ids: string[] }> = [];
    const calls: string[] = [];
    const inner = fakeAirtable(fakeBase(), deletes);
    const store = new AirtableStore({
      pat: 'pat-test',
      baseId: 'appTest',
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        calls.push(String(url));
        return inner(url as string, init);
      }) as typeof fetch,
    });

    await expect(store.deleteCandidate(DEFAULT_CANDIDATE_ID)).rejects.toThrow(/cannot be deleted/);
    expect(calls).toEqual([]);
    expect(deletes).toEqual([]);
  });
});

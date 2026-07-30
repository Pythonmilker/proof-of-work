/**
 * The resume intake path, end to end.  (DESIGN.md §v3.3)
 *
 * A resume is an artifact whose claims arrive with no receipts, and these tests pin the three things
 * that make that safe: the deterministic reader gets the real fixture right without a model, every claim
 * lands as an unverified stretch capability the evidence gate will cap, and one candidate's record is
 * structurally invisible to another's fit report. The last describe block is the v3 regression anchor —
 * if it moves, the migration broke the number the whole demo stands on.
 *
 * The model lane is exercised through `fetchImpl`, the injection point LlmOptions documents for tests.
 * No test here ever performs a live call.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestResume, matchRole } from '@/pipeline';
import { linkTechnologies } from '@/pipeline/link';
import { parseResume, parseResumeDeterministically } from '@/pipeline/resume';
import { LocalStore } from '@/store/local';
import { seedSnapshot } from '@/store/seed';
import { DEFAULT_CANDIDATE_ID } from '@/store/types';
import { SAMPLE_POSTING } from '@/ui/sample-posting';

const resumeText = readFileSync(join(process.cwd(), 'raw', '08-joel-resume.md'), 'utf8');
const keyless = { apiKey: undefined, now: () => '2026-07-28T00:00:00.000Z' };

/** Structured enough for the deterministic reader, owned by someone who is not the seed candidate. */
const SECOND_RESUME = `# Jane Doe
jane.doe@example.net · (555) 123-4567 · https://janedoe.dev

## Skills
React, TypeScript, AWS Lambda, Terraform, DynamoDB, Playwright

## Experience
### Platform Engineer — Initech
- Built an internal React dashboard over DynamoDB for workflow tracking
- Automated infrastructure deployments with Terraform
`;

/** Below the deterministic bar on purpose: a name but no skills section, so the model lane runs. */
const PROSE_RESUME = `Sam Prose

Sam is a developer who has spent a decade building data platforms and mentoring teams, most recently
leading the replatforming of a legacy CRM onto a modern serverless stack.`;

/** An OpenRouter-shaped 200 whose completion is the given object, recording every request it sees. */
function cannedModel(payload: unknown, requests: Array<Record<string, unknown>>): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

describe('the deterministic reader on the real fixture', () => {
  const parsed = parseResumeDeterministically(resumeText);

  it('reads the identity out of the header', () => {
    expect(parsed.name).toBe('Joel Brannan');
    expect(parsed.contact).toContain('joelb@viralhostdigital.com');
  });

  it('reads skills that resolve into the existing taxonomy through the alias machinery', () => {
    const link = linkTechnologies(seedSnapshot(), parsed.skills);
    const created = new Set(link.created.map((t) => t.id));
    const resolved = link.existing.filter((id) => !created.has(id));

    expect(resolved.length).toBeGreaterThanOrEqual(5);
    for (const id of ['react', 'aws-lambda', 'terraform', 'dynamodb', 'typescript', 'python']) {
      expect(resolved, `skill did not resolve to "${id}"`).toContain(id);
    }
  });

  it('turns the experience headers into position stubs', () => {
    expect(parsed.projects).toHaveLength(2);
    expect(parsed.projects[0]).toMatchObject({
      name: 'Viral Host Digital LLC',
      role: 'Founder & Full-Stack / Cloud Developer',
    });
    expect(parsed.projects[1]?.name).toBe('Independent Software Developer & Product Builder');
  });

  it('reads the experience bullets as claims and leaves the other sections alone', () => {
    expect(parsed.claims).toHaveLength(10);
    // Education and Selected Highlights are not experience, and their bullets are not claims.
    expect(parsed.claims.some((c) => /High School Diploma/i.test(c))).toBe(false);
    expect(parsed.claims.some((c) => /self-taught developer/i.test(c))).toBe(false);
  });
});

describe('parseResume — which lane runs, and never silently', () => {
  it('prefers the deterministic reader outright on a structured resume, calling no model at all', async () => {
    const outcome = await parseResume(resumeText, {
      apiKey: 'test-key',
      fetchImpl: (() => {
        throw new Error('the structured path must not spend a model call');
      }) as typeof fetch,
    });

    expect(outcome.via).toBe('deterministic');
    expect(outcome.model).toBe('none');
    expect(outcome.note).toBeNull(); // the designed primary, not a degradation
  });

  it('sends a prose resume to the extraction tier and re-validates the reply', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const outcome = await parseResume(PROSE_RESUME, {
      apiKey: 'test-key',
      fetchImpl: cannedModel(
        {
          name: 'Sam Prose',
          contact: 'sam@example.net',
          skills: ['React', 'Terraform'],
          projects: [{ name: 'Acme CRM', role: 'Lead developer', summary: 'Replatformed a legacy CRM.' }],
          claims: ['Replatformed a legacy CRM onto a serverless stack'],
        },
        requests,
      ),
    });

    expect(outcome.via).toBe('model');
    expect(outcome.model).toBe('anthropic/claude-haiku-4.5');
    expect(outcome.resume.name).toBe('Sam Prose');
    expect(outcome.resume.skills).toEqual(['React', 'Terraform']);
    expect(outcome.resume.projects[0]?.name).toBe('Acme CRM');

    // The real request body, because both OpenRouter traps live there.
    expect(requests).toHaveLength(1);
    const body = requests[0] as {
      models: string[];
      response_format: { json_schema: { name: string; strict: boolean } };
      provider: { require_parameters: boolean };
    };
    expect(body.models[0]).toBe('anthropic/claude-haiku-4.5'); // the extraction tier's primary
    expect(body.models.length).toBeLessThanOrEqual(3);
    expect(body.response_format.json_schema.name).toBe('resume_parse');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider.require_parameters).toBe(true);
  });

  it('falls back to the deterministic result on model failure, and says so', async () => {
    const outcome = await parseResume(PROSE_RESUME, {
      apiKey: 'test-key',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });

    expect(outcome.via).toBe('deterministic');
    expect(outcome.note).toBe('network unreachable');
    expect(outcome.resume.name).toBe('Sam Prose'); // what the reader could still get
  });

  it('never attempts a call without a key, and still carries the reason', async () => {
    const outcome = await parseResume(PROSE_RESUME, { apiKey: undefined });
    expect(outcome.via).toBe('deterministic');
    expect(outcome.note).toBe('no key set');
  });
});

describe('ingestResume', () => {
  it('creates the candidate row with identity, provenance and its side of every link', async () => {
    const store = new LocalStore();
    const result = await ingestResume(resumeText, '08-joel-resume.md', store, keyless);

    expect(result.ok).toBe(true);
    expect(result.candidateId).toBe('candidate-joel-brannan');
    expect(result.via).toBe('deterministic');

    const after = await store.read();
    const candidate = after.candidates.find((c) => c.id === 'candidate-joel-brannan');
    expect(candidate).toBeDefined();
    expect(candidate?.name).toBe('Joel Brannan');
    expect(candidate?.contact).toContain('joelb@viralhostdigital.com');
    expect(candidate?.source).toBe('08-joel-resume.md');
    expect(candidate?.ingestedAt).toBe('2026-07-28T00:00:00.000Z');
    expect(candidate?.capabilities).toEqual(result.createdCapabilities.map((c) => c.id));
    expect(candidate?.projects).toEqual(result.createdProjects.map((p) => p.id));
  });

  it('writes every claim as a stretch capability with an empty evidence array', async () => {
    const store = new LocalStore();
    const result = await ingestResume(resumeText, '08-joel-resume.md', store, keyless);

    expect(result.createdCapabilities.length).toBeGreaterThan(0);
    const written = (await store.read()).capabilities.filter((c) => c.candidate === 'candidate-joel-brannan');
    expect(written).toHaveLength(result.createdCapabilities.length);
    for (const cap of written) {
      // The whole design: unverified is the natural state of a resume claim, and the evidence gate
      // already caps a receiptless claim at partial. Nothing here may pre-verify anything.
      expect(cap.tier, cap.id).toBe('stretch');
      expect(cap.evidence, cap.id).toEqual([]);
    }
  });

  it('resolves skills into existing taxonomy rows and creates only what the taxonomy lacked', async () => {
    const store = new LocalStore();
    const result = await ingestResume(resumeText, '08-joel-resume.md', store, keyless);

    for (const id of ['react', 'aws-lambda', 'terraform']) {
      expect(result.resolvedTechnologies).toContain(id);
    }
    // Route 53 is on the resume and not in the seed taxonomy: a new row, not a dropped skill.
    expect(result.createdTechnologies.map((t) => t.id)).toContain('route-53');
    expect((await store.read()).technologies.some((t) => t.id === 'route-53')).toBe(true);
  });

  it('writes position stubs owned by the candidate, with technology links in both directions', async () => {
    const store = new LocalStore();
    const result = await ingestResume(resumeText, '08-joel-resume.md', store, keyless);

    const after = await store.read();
    const stubId = 'candidate-joel-brannan-viral-host-digital-llc';
    expect(result.createdProjects.map((p) => p.id)).toContain(stubId);

    const stub = after.projects.find((p) => p.id === stubId);
    expect(stub?.candidate).toBe('candidate-joel-brannan');
    expect(stub?.role).toBe('Founder & Full-Stack / Cloud Developer');
    expect(stub?.evidence).toEqual([]); // a stub is a claim, not a receipt
    expect(stub?.technologies).toContain('terraform'); // named in the stub's own words

    const terraform = after.technologies.find((t) => t.id === 'terraform');
    expect(terraform?.projects).toContain(stubId); // the reverse side of the same link
  });

  it('updates rather than duplicating when the same person is ingested twice', async () => {
    const store = new LocalStore();
    await ingestResume(resumeText, '08-joel-resume.md', store, keyless);
    const between = await store.read();
    await ingestResume(resumeText, '08-joel-resume.md', store, keyless);
    const after = await store.read();

    expect(after.candidates.length).toBe(between.candidates.length);
    expect(after.capabilities.length).toBe(between.capabilities.length);
    expect(after.projects.length).toBe(between.projects.length);
  });

  it('refuses a blob with no readable name instead of minting a nameless candidate', async () => {
    const store = new LocalStore();
    const before = await store.read();
    const result = await ingestResume('- just\n- some\n- bullets\n', 'not-a-resume.txt', store, keyless);

    expect(result.ok).toBe(false);
    expect(result.candidateId).toBe('');
    expect(result.stages.find((s) => s.stage === 'validate')?.state).toBe('failed');
    expect((await store.read()).candidates.length).toBe(before.candidates.length);
  });
});

describe('candidate isolation in matchRole', () => {
  it('scopes a second candidate to their own record and leaves the default candidate untouched', async () => {
    const store = new LocalStore();
    const ingested = await ingestResume(SECOND_RESUME, 'jane-doe-resume.md', store, keyless);
    expect(ingested.ok).toBe(true);
    expect(ingested.candidateId).toBe('candidate-jane-doe');
    expect(ingested.via).toBe('deterministic');
    expect(ingested.createdTechnologies).toEqual([]); // every skill resolves; the taxonomy stays clean

    const seed = seedSnapshot();
    const seedCapabilities = new Set(seed.capabilities.map((c) => c.id));
    const seedProjects = new Set(seed.projects.map((p) => p.id));
    const seedEvidence = new Set(seed.evidence.map((e) => e.id));

    const jane = await matchRole(SAMPLE_POSTING, store, { ...keyless, candidateId: 'candidate-jane-doe' });
    expect(jane.role.results.length).toBeGreaterThan(0);
    for (const result of jane.role.results) {
      expect(result.candidate).toBe('candidate-jane-doe');
      // NONE of the seed candidate's record may leak into another candidate's report.
      expect(result.matchedCapabilities.filter((id) => seedCapabilities.has(id))).toEqual([]);
      expect(result.matchedProjects.filter((id) => seedProjects.has(id))).toEqual([]);
      expect(result.evidence.filter((id) => seedEvidence.has(id))).toEqual([]);
    }

    // Her technologies match — React is React for everyone — but with zero receipts on file, nothing
    // can score proven. The evidence gate needs no changes to make that true; that is the point.
    expect(jane.role.results.some((r) => r.matchedTechnologies.includes('react'))).toBe(true);
    expect(jane.coverage.proven).toBe(0);

    const joel = await matchRole(SAMPLE_POSTING, store, keyless);
    expect(joel.coverage.score).toBe(75);
    expect(joel.coverage.proven).toBe(10);
    expect(joel.coverage.partial).toBe(4);
    expect(joel.coverage.gap).toBe(2);
    for (const result of joel.role.results) {
      expect(result.candidate).toBe(DEFAULT_CANDIDATE_ID);
      expect(result.matchedCapabilities.some((id) => id.startsWith('cap-jane-doe'))).toBe(false);
      expect(result.matchedProjects.some((id) => id.startsWith('candidate-jane-doe'))).toBe(false);
    }
  });
});

describe('the v3 regression anchor', () => {
  it('still scores the bundled posting 75 — 10 proven, 4 partial, 2 gaps across 16 requirements', async () => {
    // Pinned exactly (DESIGN.md §v3.5). Joel × the bundled posting is the number the demo stands on,
    // and the candidate-scoping migration is not allowed to move it. Anonymising the sample (2026-07-30)
    // was held to the same bar: the company name changed, not one requirement bullet, and these five
    // numbers did not move.
    const report = await matchRole(SAMPLE_POSTING, new LocalStore(), keyless);

    expect(report.role.requirements).toHaveLength(16);
    expect(report.coverage.score).toBe(75);
    expect(report.coverage.proven).toBe(10);
    expect(report.coverage.partial).toBe(4);
    expect(report.coverage.gap).toBe(2);
    expect(report.parseVia).toBe('deterministic');
  });
});

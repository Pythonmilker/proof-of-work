/**
 * The rationale fan-out, run rather than read.
 *
 * `Write rationales` used to be ONE http call carrying every requirement, under a system prompt that
 * says "you write one sentence" and a 160-token ceiling. `Guard rationales` then read `$input.all()`,
 * got a single item, and indexed it per requirement — so requirement 1 received a sentence composed
 * from all sixteen requirements' material and requirements 2..16 read `undefined` and silently fell
 * back to the template. The workflow was shipping fifteen template sentences and reporting one of them
 * as a model rationale. Every structural check in the repo passed throughout.
 *
 * Reading the JSON cannot catch that. So this file takes the two Code nodes out of the COMMITTED
 * workflow, stubs the handful of n8n globals they touch, and runs them against a real scored payload.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRationaleContext, parseRoleDeterministically, templateRationale } from '@/pipeline/portable';
import { SAMPLE_POSTING } from '@/ui/sample-posting';

interface Item {
  json: Record<string, unknown>;
}

function nodeCode(name: string): string {
  const workflow = JSON.parse(readFileSync(join(process.cwd(), 'n8n', 'match-role.json'), 'utf8')) as {
    nodes: Array<{ name: string; parameters?: { jsCode?: string } }>;
  };
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node?.parameters?.jsCode) throw new Error(`no Code node named ${name}`);
  return node.parameters.jsCode;
}

/** Run a Code node with `$('Name')` and `$input` stubbed from a table of upstream outputs. */
function runNode(name: string, upstream: Record<string, Item[]>, input: Item[] = []): Item[] {
  const $ = (nodeName: string) => {
    const items = upstream[nodeName];
    if (!items) throw new Error(`node ${name} referenced an unstubbed upstream node: ${nodeName}`);
    return { first: () => items[0], all: () => items };
  };
  const $input = { all: () => input, first: () => input[0] };
  return new Function('$', '$input', nodeCode(name))($, $input) as Item[];
}

/*
 * A two-requirement record, shaped exactly as `Load the record` and `Retrieve and score` emit it.
 * Small on purpose: the alignment bug is about count, and two is already more than one.
 */
const ROWS = {
  candidate: { key: 'candidate-joel', name: 'Joel Brannan', id: 'recCand' },
  projects: [
    {
      id: 'recP1',
      key: 'proj-tendril',
      name: 'Tendril',
      status: 'shipped',
      started: '2025-01',
      summary: 'A BYOK agent host.',
      metrics: { loc: 41000, tests: 552, commits: 125 },
      reviewStatus: 'ok',
      evidence: ['ev-tendril-commits'],
    },
  ],
  technologies: [{ id: 'recT1', key: 'tech-ts', name: 'TypeScript', aliases: [], projects: ['proj-tendril'] }],
  capabilities: [
    { id: 'recC1', key: 'cap-agents', name: 'Agent orchestration', tier: 'proven', matchTerms: [], projects: ['proj-tendril'], evidence: ['ev-tendril-commits'] },
  ],
  evidence: [
    { id: 'recE1', key: 'ev-tendril-commits', label: 'Commits on master', value: '125 commits', url: 'https://example.invalid/t' },
  ],
};

const SCORED = {
  title: 'AI Product Engineer',
  company: 'Northwind Systems',
  results: [
    {
      requirementId: 'req-1',
      requirement: { text: 'Experience building agent systems', kind: 'required' },
      status: 'proven',
      shortfall: null,
      matchedTechnologies: ['tech-ts'],
      matchedCapabilities: ['cap-agents'],
      matchedProjects: ['proj-tendril'],
      evidence: ['ev-tendril-commits'],
      cited: [
        { kind: 'capability', id: 'cap-agents', name: 'Agent orchestration', score: 1 },
        { kind: 'technology', id: 'tech-ts', name: 'TypeScript', score: 1 },
      ],
      best: 1,
    },
    {
      requirementId: 'req-2',
      requirement: { text: 'A degree in computer science', kind: 'required' },
      status: 'gap',
      shortfall: 'nothing in the record matches this closely enough to claim',
      matchedTechnologies: [],
      matchedCapabilities: [],
      matchedProjects: [],
      evidence: [],
      cited: [],
      best: 0,
    },
  ],
  coverage: { score: 50, proven: 1, partial: 0, gap: 1, requiredCovered: 1, requiredTotal: 2 },
};

const UPSTREAM = {
  'Apply weighing': [{ json: SCORED as unknown as Record<string, unknown> }],
  'Retrieve and score': [{ json: SCORED as unknown as Record<string, unknown> }],
  'Load the record': [{ json: ROWS as unknown as Record<string, unknown> }],
};

/** A well-formed OpenRouter reply carrying one sentence. */
const reply = (sentence: string): Item => ({
  json: { choices: [{ message: { content: JSON.stringify({ rationale: sentence }) } }] },
});

describe('the fan-out emits one model call per requirement', () => {
  const fanned = runNode('Fan out rationales', UPSTREAM);

  it('emits exactly one item per requirement, not one per posting', () => {
    // The regression in one line: this used to be a single call for the whole result set.
    expect(fanned).toHaveLength(SCORED.results.length);
  });

  it('builds each prompt with the app\'s own context builder', () => {
    const expected = buildRationaleContext({
      requirementText: 'Experience building agent systems',
      requirementKind: 'required',
      status: 'proven',
      technologies: ['TypeScript'],
      capabilities: ['Agent orchestration'],
      projects: ROWS.projects,
      evidence: ROWS.evidence,
      shortfall: null,
    });
    expect(fanned[0]!.json['context']).toBe(expected);
  });

  it('resolves keys to names, so the prompt never shows the model a raw record key', () => {
    const context = String(fanned[0]!.json['context']);
    expect(context).toContain('TypeScript');
    expect(context).toContain('Agent orchestration');
    expect(context).not.toContain('tech-ts');
    expect(context).not.toContain('cap-agents');
  });

  it('carries the project metrics the guard will be asked to vouch for', () => {
    // The old n8n corpus was name + status only, so a sentence citing "552 tests" — a real number, in
    // the record, that the model was shown — was rejected as a fabrication. A guard that fires on true
    // sentences is a guard someone turns off.
    const context = String(fanned[0]!.json['context']);
    expect(context).toContain('552 tests');
    expect(context).toContain('125 commits');
  });

  it('stamps an index so a reordered or retried item can be realigned', () => {
    expect(fanned.map((i) => i.json['__index'])).toEqual([0, 1]);
  });
});

describe('the guard scores each requirement against its own prompt', () => {
  const fanned = runNode('Fan out rationales', UPSTREAM);
  const withFanOut = { ...UPSTREAM, 'Fan out rationales': fanned };

  it('keeps a clean sentence for every requirement', () => {
    const out = runNode('Guard rationales', withFanOut, [
      reply('Agent orchestration — shipped in Tendril, with 125 commits.'),
      reply('Nothing in the record matches this requirement.'),
    ]);
    const results = out[0]!.json['results'] as Array<{ rationale: string; rationaleSource: string }>;
    expect(results.map((r) => r.rationaleSource)).toEqual(['model', 'model']);
    expect(results[0]!.rationale).toContain('125 commits');
  });

  it('a number the model was actually shown is NOT a fabrication', () => {
    // 552 is in project metrics. Under the old corpus this was rejected.
    const out = runNode('Guard rationales', withFanOut, [
      reply('Agent orchestration — shipped in Tendril, with 552 tests.'),
      reply('Nothing in the record matches this requirement.'),
    ]);
    const results = out[0]!.json['results'] as Array<{ rationaleSource: string }>;
    expect(results[0]!.rationaleSource).toBe('model');
  });

  it('still rejects a number nobody wrote', () => {
    const out = runNode('Guard rationales', withFanOut, [
      reply('Agent orchestration — shipped in Tendril, with 9000 commits.'),
      reply('Nothing in the record matches this requirement.'),
    ]);
    const results = out[0]!.json['results'] as Array<{ rationaleSource: string }>;
    expect(results[0]!.rationaleSource).toBe('template');
  });

  it('still rejects a sentence that grades the candidate', () => {
    const out = runNode('Guard rationales', withFanOut, [
      reply('The candidate has extensive experience with agent systems.'),
      reply('Nothing in the record matches this requirement.'),
    ]);
    const results = out[0]!.json['results'] as Array<{ rationaleSource: string }>;
    expect(results[0]!.rationaleSource).toBe('template');
  });

  it('one failed call costs one sentence, never the batch', () => {
    // What `onError: continueRegularOutput` puts on the wire: an error item in place of a reply. The
    // app degrades per requirement because it calls per requirement; with the fan-out, so does this.
    const out = runNode('Guard rationales', withFanOut, [
      { json: { error: 'openrouter 502' } },
      reply('Nothing in the record matches this requirement.'),
    ]);
    const results = out[0]!.json['results'] as Array<{ rationale: string; rationaleSource: string }>;
    expect(results[0]!.rationaleSource).toBe('template');
    expect(results[1]!.rationaleSource).toBe('model');
  });

  it('falls back to the app\'s own template sentence, word for word', () => {
    const out = runNode('Guard rationales', withFanOut, [
      { json: { error: 'openrouter 502' } },
      { json: { error: 'openrouter 502' } },
    ]);
    const results = out[0]!.json['results'] as Array<{ rationale: string }>;
    expect(results[0]!.rationale).toBe(
      templateRationale({
        requirementText: 'Experience building agent systems',
        requirementKind: 'required',
        status: 'proven',
        technologies: ['TypeScript'],
        capabilities: ['Agent orchestration'],
        projects: ROWS.projects,
        evidence: ROWS.evidence,
        shortfall: null,
      }),
    );
    expect(results[1]!.rationale).toBe('Nothing in the record matches this requirement.');
  });

  it('never lets one requirement\'s sentence land under another\'s heading', () => {
    // The alignment claim, stated directly: the sentence naming Tendril must attach to the requirement
    // Tendril matched, not to the degree line.
    const out = runNode('Guard rationales', withFanOut, [
      reply('Agent orchestration — shipped in Tendril, with 125 commits.'),
      reply('Nothing in the record matches this requirement.'),
    ]);
    const results = out[0]!.json['results'] as Array<{ requirementId: string; rationale: string }>;
    expect(results[0]!.requirementId).toBe('req-1');
    expect(results[0]!.rationale).toContain('Tendril');
    expect(results[1]!.requirementId).toBe('req-2');
    expect(results[1]!.rationale).not.toContain('Tendril');
  });
});

/**
 * The deterministic posting read, run in the workflow's own Code node.
 *
 * The workflow used to wire its webhook straight into the parse model. On the bundled sample the model
 * returns 18 paraphrased requirements and scores 66; code takes the 16 bullets verbatim and scores 75.
 * Both lanes upsert the same Roles key, so a same-day n8n run rewrote the app's row — the pinned
 * 75/10/4/2/16 anchor was an app-lane-only fact until this landed.
 */
describe('the workflow reads a posting the way the app does', () => {
  const webhook = (text: string): Item[] => [{ json: { body: { text } } }];

  it('reads the bundled sample verbatim and asks for no model', () => {
    const out = runNode('Read the posting', {}, webhook(SAMPLE_POSTING));
    const json = out[0]!.json;
    expect(json['needsModel']).toBe(false);
    expect(json['pass']).toBe('bulleted');

    const role = json['role'] as { requirements: unknown[]; title: string };
    const app = parseRoleDeterministically(SAMPLE_POSTING);
    expect(role.requirements).toEqual(app.requirements);
    expect(role.requirements).toHaveLength(16);
  });

  it('routes prose to the model, which is the one shape it reads better', () => {
    const prose =
      'Senior Engineer\n\nWe are looking for someone who can build internal tools quickly. ' +
      'You should be comfortable owning a feature end to end. Experience with cloud infrastructure ' +
      'is important to us. We value people who document what they build.';
    const out = runNode('Read the posting', {}, webhook(prose));
    expect(out[0]!.json['needsModel']).toBe(true);
    expect(out[0]!.json['pass']).toBe('prose');
  });

  it('refuses an empty posting instead of scoring against nothing', () => {
    expect(() => runNode('Read the posting', {}, webhook('   '))).toThrow(/no posting text/i);
  });

  it('agrees with the app on every fixture, pass for pass', () => {
    for (const text of [SAMPLE_POSTING, 'Requirements\n\nReact\nTypeScript\nAWS\nPostgres\n']) {
      const out = runNode('Read the posting', {}, webhook(text));
      const app = parseRoleDeterministically(text);
      expect(out[0]!.json['pass']).toBe(app.pass);
      expect((out[0]!.json['role'] as { requirements: unknown[] }).requirements).toEqual(app.requirements);
    }
  });
});

describe('the convergence node carries provenance either way', () => {
  it('reports the deterministic read with no model', () => {
    const read = runNode('Read the posting', {}, [{ json: { body: { text: SAMPLE_POSTING } } }]);
    const out = runNode('Posting requirements', { 'Read the posting': read }, read);
    expect(out[0]!.json['via']).toBe('deterministic');
    expect(out[0]!.json['model']).toBe('none');
    expect((out[0]!.json['requirements'] as unknown[])).toHaveLength(16);
  });

  it('reports the model OpenRouter actually served, not the one we asked for', () => {
    // The Roles row hardcoded JD_MODELS[0], so a fallthrough down the chain left no trace.
    const read = runNode('Read the posting', {}, [{ json: { body: { text: 'We build things. You will help.' } } }]);
    const reply = [{
      json: {
        model: 'google/gemini-2.5-flash',
        choices: [{ message: { content: JSON.stringify({ title: 'Engineer', company: 'Acme', requirements: [{ text: 'Ship features', kind: 'required', category: 'process' }] }) } }],
      },
    }];
    const out = runNode('Posting requirements', { 'Read the posting': read }, reply);
    expect(out[0]!.json['via']).toBe('model');
    expect(out[0]!.json['model']).toBe('google/gemini-2.5-flash');
  });

  it('refuses a posting nothing could read rather than writing a blank report', () => {
    const read = runNode('Read the posting', {}, [{ json: { body: { text: '...' } } }]);
    expect(() => runNode('Posting requirements', { 'Read the posting': read }, read)).toThrow(/could not be read/i);
  });
});

/**
 * The weighing pass, attacked with the replies a dishonest model would send.
 *
 * The workflow had no weighing pass at all — `gateStatus` was called without `strength`, so its
 * `weighedThin` branch was dead by construction. CLAUDE.md lists "weighing can only lower a verdict"
 * among the non-negotiables and `tests/judge.test.ts` proves it for the app. This proves it for the
 * workflow, by running the workflow's own Code node against the same hostile inputs.
 */
const judgeReply = (judgments: unknown[]): Item => ({
  json: { choices: [{ message: { content: JSON.stringify({ judgments }) } }] },
});

describe('the workflow weighs candidates and can only lower a verdict', () => {
  const asked = runNode('Fan out judge', UPSTREAM);
  const withJudge = { ...UPSTREAM, 'Fan out judge': asked };

  const weigh = (replies: Item[]): Array<Record<string, unknown>> => {
    const out = runNode('Apply weighing', withJudge, replies);
    return out[0]!.json['results'] as Array<Record<string, unknown>>;
  };

  it('asks once per requirement, and skips the one with nothing cited', () => {
    expect(asked).toHaveLength(2);
    expect(asked[0]!.json['skip']).toBe(false);
    // Nothing matched, so there is nothing to weigh — and asking anyway invites the model to invent it.
    expect(asked[1]!.json['skip']).toBe(true);
  });

  it('shows the model only the rows retrieval returned, with their receipts', () => {
    const prompt = String((asked[0]!.json['request'] as { messages: Array<{ content: string }> }).messages[1]!.content);
    expect(prompt).toContain('id=cap-agents');
    expect(prompt).toContain('Commits on master');
    // It never sees the base, so it cannot name a row that did not match.
    expect(prompt).not.toContain('cap-billing');
  });

  it('a reply rating everything 1.0 cannot raise a verdict', () => {
    const results = weigh([
      judgeReply([
        { id: 'cap-agents', relevance: 1, strength: 1, receipt: 'Commits on master', reason: 'perfect' },
        { id: 'tech-ts', relevance: 1, strength: 1, receipt: '', reason: 'perfect' },
      ]),
      judgeReply([]),
    ]);
    // Requirement 2 was a gap deterministically and stays a gap however the model scores it.
    expect(results[1]!['status']).toBe('gap');
    expect(results[0]!['status']).toBe('proven');
  });

  it('lowers a verdict when the model weighs the evidence thin', () => {
    const results = weigh([
      judgeReply([
        { id: 'cap-agents', relevance: 0.9, strength: 0.3, receipt: '', reason: 'mentioned, not demonstrated' },
      ]),
      judgeReply([]),
    ]);
    expect(results[0]!['status']).toBe('partial');
    expect(results[0]!['weighed']).toBe(true);
  });

  it('ignores ids it was never sent — including another candidate\'s rows', () => {
    const results = weigh([
      judgeReply([
        { id: 'cap-from-another-applicant', relevance: 1, strength: 1, receipt: 'invented', reason: 'x' },
      ]),
      judgeReply([]),
    ]);
    // Nothing the model said applied to a row we asked about, so the deterministic answer stands.
    expect(results[0]!['status']).toBe('proven');
    expect(results[0]!['weighed']).toBe(false);
  });

  it('clamps a high strength that cites a receipt the row does not carry', () => {
    const results = weigh([
      judgeReply([
        { id: 'cap-agents', relevance: 1, strength: 1, receipt: 'A receipt nobody linked', reason: 'x' },
      ]),
      judgeReply([]),
    ]);
    // Clamped to just under proven, which weighedThin then reads as partial.
    expect(results[0]!['status']).toBe('partial');
    expect(Number(results[0]!['strength'])).toBeLessThan(0.7);
  });

  it('prunes citations the model called coincidental, and says so in the count', () => {
    const results = weigh([
      judgeReply([
        { id: 'cap-agents', relevance: 0.9, strength: 0.9, receipt: 'Commits on master', reason: 'solid' },
        { id: 'tech-ts', relevance: 0, strength: 0, receipt: '', reason: 'incidental' },
      ]),
      judgeReply([]),
    ]);
    // The technology scored relevance 0 and drops out of the citations rather than being written to
    // Airtable and then described in prose.
    expect(results[0]!['matchedTechnologies']).toEqual([]);
    expect(results[0]!['matchedCapabilities']).toEqual(['cap-agents']);
    expect(results[0]!['status']).toBe('proven');
  });

  it('a failed call costs that requirement its weighing, not the run', () => {
    const results = weigh([{ json: { error: 'openrouter 502' } }, judgeReply([])]);
    expect(results[0]!['weighed']).toBe(false);
    expect(results[0]!['status']).toBe('proven');
    expect(results).toHaveLength(2);
  });

  it('recomputes coverage from the final statuses, not the deterministic ones', () => {
    const out = runNode('Apply weighing', withJudge, [
      judgeReply([{ id: 'cap-agents', relevance: 0.9, strength: 0.2, receipt: '', reason: 'thin' }]),
      judgeReply([]),
    ]);
    const coverage = out[0]!.json['coverage'] as { score: number; proven: number; partial: number };
    // One proven demoted to partial: 1 required proven + 1 required gap became 1 partial + 1 gap.
    expect(coverage.proven).toBe(0);
    expect(coverage.partial).toBe(1);
    expect(coverage.score).toBe(25);
  });

  it('counts what it lowered by status, not by object identity', () => {
    // worseOf returns the weighed object on a tie for its narrower citations, so identity is true on
    // almost every requirement — counting that way once read "16 of 16 lowered" on a run that lowered
    // nothing.
    const out = runNode('Apply weighing', withJudge, [
      judgeReply([{ id: 'cap-agents', relevance: 1, strength: 0.95, receipt: 'Commits on master', reason: 'solid' }]),
      judgeReply([]),
    ]);
    expect((out[0]!.json['weighing'] as { demoted: number }).demoted).toBe(0);
  });
});

/**
 * Dense retrieval, run in the workflow's own nodes.
 *
 * The workflow had no embeddings call at all. It scored from lexical hits alone and printed a
 * dense-only match as a gap, while `src/ui/api.ts` reported embeddings as "ready — handled inside the
 * workflow" and DESIGN.md described the step as "lexical + embeddings, cosine, threshold". A
 * degradation nobody can see is exactly what this repo's "never a silent fallback" rule bans.
 */
const POSTING_ITEM = {
  'Posting requirements': [{ json: { title: 'R', company: 'C', requirements: [{ text: 'Builds agent systems', kind: 'required', category: 'ai' }] } }],
  'Load the record': [{ json: ROWS as unknown as Record<string, unknown> }],
};

/** A response carrying one vector per input, in order. */
const embedReply = (count: number, dims = 4): Item[] => [{
  json: { data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: Array.from({ length: dims }, (_, d) => (i + d + 1) / 10) })) },
}];

describe('the workflow embeds the record and the posting', () => {
  const asked = runNode('Build embed request', POSTING_ITEM);

  it('embeds every technology and capability, then every requirement', () => {
    const json = asked[0]!.json;
    expect(json['corpusCount']).toBe(ROWS.technologies.length + ROWS.capabilities.length);
    expect(json['requirementCount']).toBe(1);
    const request = json['request'] as { input: string[] };
    expect(request.input).toHaveLength(Number(json['corpusCount']) + 1);
    // The requirement text is last, after the corpus — the offset the split relies on.
    expect(request.input[request.input.length - 1]).toBe('Builds agent systems');
  });

  it('keys each corpus row so the lookup cannot disagree with the corpus', () => {
    expect(asked[0]!.json['keys']).toEqual(['technology:tech-ts', 'capability:cap-agents']);
  });

  it('splits the response back into a lookup and one vector per requirement', () => {
    const total = Number(asked[0]!.json['corpusCount']) + 1;
    const out = runNode('Collect vectors', { 'Build embed request': asked }, embedReply(total));
    expect(out[0]!.json['ok']).toBe(true);
    expect(Object.keys(out[0]!.json['vectors'] as object)).toEqual(['technology:tech-ts', 'capability:cap-agents']);
    expect(out[0]!.json['requirementVectors']).toHaveLength(1);
  });

  it('honours the index rather than assuming arrival order', () => {
    const total = Number(asked[0]!.json['corpusCount']) + 1;
    const shuffled = embedReply(total);
    const data = (shuffled[0]!.json['data'] as Array<{ index: number; embedding: number[] }>).slice().reverse();
    const out = runNode('Collect vectors', { 'Build embed request': asked }, [{ json: { data } }]);
    const vectors = out[0]!.json['vectors'] as Record<string, number[]>;
    // Reversed arrival, same pairing: index wins. Getting this wrong pairs every requirement with the
    // wrong capability and nothing downstream could tell.
    expect(vectors['technology:tech-ts']).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('degrades to lexical and says why when the batch comes back short', () => {
    const out = runNode('Collect vectors', { 'Build embed request': asked }, embedReply(1));
    expect(out[0]!.json['ok']).toBe(false);
    expect(String(out[0]!.json['detail'])).toMatch(/expected 3 vectors, got 1/);
  });

  it('degrades to lexical when the call failed outright', () => {
    const out = runNode('Collect vectors', { 'Build embed request': asked }, [{ json: { error: 'openrouter 502' } }]);
    expect(out[0]!.json['ok']).toBe(false);
    expect(String(out[0]!.json['detail'])).toMatch(/no embeddings returned/);
  });
});

describe('the scorer is hybrid, and reports which mode it ran in', () => {
  const score = (embedded: Record<string, unknown>): Record<string, unknown> => {
    const out = runNode('Retrieve and score', { ...POSTING_ITEM, 'Collect vectors': [{ json: embedded }] });
    return out[0]!.json;
  };

  it('reports lexical when embeddings are unavailable', () => {
    const json = score({ ok: false, vectors: {}, requirementVectors: [], detail: 'no key' });
    expect(json['retrieval']).toBe('lexical');
    expect(json['retrievalDetail']).toBe('no key');
  });

  it('reports hybrid when they are, and scores a semantic-only match', () => {
    // 'Builds agent systems' shares no term with 'Agent orchestration' after stemming drops the plural,
    // so a lexical-only lane scores this a gap. Identical vectors give cosine 1.
    const v = [1, 0, 0, 0];
    const json = score({
      ok: true,
      vectors: { 'technology:tech-ts': [0, 1, 0, 0], 'capability:cap-agents': v },
      requirementVectors: [v],
      detail: null,
    });
    expect(json['retrieval']).toBe('hybrid');
    const results = json['results'] as Array<{ status: string; score: number; matchedCapabilities: string[] }>;
    expect(results[0]!.matchedCapabilities).toContain('cap-agents');
    // normalizeCosine(1) * 0.95 — a dense hit clears proven but never outranks a literal name match.
    expect(results[0]!.score).toBeCloseTo(0.95, 5);
  });
});

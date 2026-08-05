/**
 * Weighing, and the proof that it cannot be used to inflate a score.
 *
 * The weighing pass is the one place a model is asked for a judgement that changes a number, so it is
 * the one place worth attacking. Every test here hands the pipeline a reply a dishonest or broken model
 * would send — perfect scores on receiptless claims, ids from a record it was never shown, a receipt
 * label that does not exist, a flat 1.0 on everything — and asserts the report comes out no better than
 * the answer the arithmetic gave with no model involved at all.
 *
 * The rule under test, stated once: `worseOf(deterministic, weighed)`. If that holds, the model's
 * influence is bounded by construction and no prompt wording is load-bearing.
 */

import { describe, expect, it } from 'vitest';
import {
  applyJudgment,
  prune,
  strengthOf,
  RELEVANCE_FLOOR,
  UNPROVEN_CEILING,
  buildJudgeInput,
  type Judgment,
} from '@/pipeline/judge';
import { resolve, worseOf, THRESHOLD_PROVEN } from '@/pipeline/score';
import type { Candidate } from '@/pipeline/match';
import type { Capability, Evidence, Project, Requirement, Snapshot, Technology } from '@/store/types';

const requirement: Requirement = {
  id: 'r1',
  text: 'Infrastructure as code',
  kind: 'required',
  category: 'cloud',
};

function project(id: string, evidence: string[]): Project {
  return {
    id,
    candidate: 'candidate-test',
    name: id,
    slug: id,
    role: 'dev',
    started: '2026-01',
    ended: null,
    status: 'shipped',
    summary: 'a thing that was built',
    metrics: { tests: 12 },
    technologies: [],
    capabilities: [],
    evidence,
    reviewStatus: 'ok',
    reviewReason: null,
    source: 'test',
    ingestedAt: '2026-01-01T00:00:00.000Z',
  };
}

function receipt(id: string, label: string, projects: string[]): Evidence {
  return {
    id,
    candidate: 'candidate-test',
    label,
    kind: 'artifact',
    value: 'v',
    url: null,
    verifiedOn: '2026-01-01',
    projects,
  };
}

function capability(
  id: string,
  tier: Capability['tier'],
  evidence: string[],
  projects: string[],
): Capability {
  return {
    id,
    candidate: 'candidate-test',
    name: id,
    statement: 'claims to do a thing',
    tier,
    matchTerms: [],
    projects,
    evidence,
  };
}

function technology(id: string, projects: string[]): Technology {
  return { id, name: id, aliases: [], category: 'tooling', projects };
}

function snapshotWith(parts: Partial<Snapshot>): Snapshot {
  return {
    candidates: [],
    projects: [],
    technologies: [],
    capabilities: [],
    evidence: [],
    roles: [],
    ...parts,
  };
}

const cited = (kind: Candidate['kind'], id: string): Candidate[] => [
  { kind, id, name: id, score: 1, via: 'lexical' },
];

/** A capability with a real receipt: the only shape that is allowed to reach proven. */
const backedSnapshot = snapshotWith({
  capabilities: [capability('cap', 'proven', ['ev1'], ['p1'])],
  projects: [project('p1', ['ev1'])],
  evidence: [receipt('ev1', 'Terraform plan output', ['p1'])],
});

/** The same capability with the receipt removed. Everything else identical. */
const receiptlessSnapshot = snapshotWith({
  capabilities: [capability('cap', 'proven', [], [])],
});

const perfectReply = (id: string, receiptLabel = '') => ({
  judgments: [{ id, relevance: 1, strength: 1, receipt: receiptLabel, reason: 'looks great' }],
});

describe('applyJudgment — what a model is allowed to say', () => {
  it('drops an id it was never sent', () => {
    // The only defence that matters against a reply naming another candidate's rows.
    const judged = applyJudgment(perfectReply('cap-from-somewhere-else'), cited('capability', 'cap'), backedSnapshot);
    expect(judged.size).toBe(0);
  });

  it('clamps a perfect strength on a receiptless claim below the proven line', () => {
    const judged = applyJudgment(perfectReply('cap'), cited('capability', 'cap'), receiptlessSnapshot);

    expect(judged.get('cap')?.strength).toBe(UNPROVEN_CEILING);
    expect(judged.get('cap')?.strength).toBeLessThan(THRESHOLD_PROVEN);
    expect(judged.get('cap')?.clamped).toMatch(/nothing verifiable/i);
  });

  it('clamps a perfect strength on a stretch claim, receipts or not', () => {
    const stretchSnapshot = snapshotWith({
      capabilities: [capability('cap', 'stretch', ['ev1'], ['p1'])],
      projects: [project('p1', ['ev1'])],
      evidence: [receipt('ev1', 'Terraform plan output', ['p1'])],
    });

    const judged = applyJudgment(
      perfectReply('cap', 'Terraform plan output'),
      cited('capability', 'cap'),
      stretchSnapshot,
    );
    expect(judged.get('cap')?.strength).toBe(UNPROVEN_CEILING);
  });

  it('clamps when the model names a receipt that is not linked to the row', () => {
    // The fabrication guard. A confident number costs nothing; a citable receipt does.
    const judged = applyJudgment(
      perfectReply('cap', 'Certificate of Excellence'),
      cited('capability', 'cap'),
      backedSnapshot,
    );

    expect(judged.get('cap')?.strength).toBe(UNPROVEN_CEILING);
    expect(judged.get('cap')?.clamped).toMatch(/not linked/i);
  });

  it('clamps when a proven-level strength names no receipt at all', () => {
    const judged = applyJudgment(perfectReply('cap', ''), cited('capability', 'cap'), backedSnapshot);
    expect(judged.get('cap')?.strength).toBe(UNPROVEN_CEILING);
    expect(judged.get('cap')?.clamped).toMatch(/no receipt was named/i);
  });

  it('lets a proven-level strength stand when the named receipt is real', () => {
    const judged = applyJudgment(
      perfectReply('cap', 'Terraform plan output'),
      cited('capability', 'cap'),
      backedSnapshot,
    );

    expect(judged.get('cap')?.strength).toBe(1);
    expect(judged.get('cap')?.clamped).toBeNull();
  });

  it('matches a receipt label case-insensitively and around whitespace', () => {
    const judged = applyJudgment(
      perfectReply('cap', '  terraform PLAN output '),
      cited('capability', 'cap'),
      backedSnapshot,
    );
    expect(judged.get('cap')?.strength).toBe(1);
  });

  it('refuses the reply a live model actually sent through the deployed proxy', () => {
    /**
     * Not invented. Observed 2026-08-05, first call to the weighing schema through the public relay,
     * claude-haiku-4.5, on a record whose receipts line read "receipts: none linked":
     *
     *   {"id":"tf","relevance":1.0,"strength":1.0,"receipt":"none linked","reason":"Direct match ..."}
     *
     * It read the words "none linked" and handed them back as the receipt label. A prompt telling a
     * model to cite a real receipt is a request; the check is what makes it a requirement.
     */
    const snapshot = snapshotWith({ technologies: [technology('tf', [])] });
    const judged = applyJudgment(
      { judgments: [{ id: 'tf', relevance: 1, strength: 1, receipt: 'none linked', reason: 'Direct match' }] },
      cited('technology', 'tf'),
      snapshot,
    );

    expect(judged.get('tf')?.strength).toBe(UNPROVEN_CEILING);
    expect(judged.get('tf')?.strength).toBeLessThan(THRESHOLD_PROVEN);
  });

  it('survives replies that are not the shape the schema promised', () => {
    const hostile: unknown[] = [
      null,
      {},
      { judgments: null },
      { judgments: 'nope' },
      { judgments: [null] },
      { judgments: [{ id: 'cap' }] },
      { judgments: [{ id: 'cap', relevance: 'high', strength: 'lots', receipt: 5, reason: null }] },
      { judgments: [{ id: 'cap', relevance: Number.NaN, strength: Infinity, receipt: '', reason: '' }] },
      { judgments: [{ id: 'cap', relevance: -3, strength: 42, receipt: '', reason: '' }] },
    ];

    for (const reply of hostile) {
      const judged = applyJudgment(reply, cited('capability', 'cap'), receiptlessSnapshot);
      for (const j of judged.values()) {
        expect(j.strength).toBeGreaterThanOrEqual(0);
        expect(j.strength).toBeLessThanOrEqual(UNPROVEN_CEILING);
        expect(j.relevance).toBeGreaterThanOrEqual(0);
        expect(j.relevance).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the first answer when a reply judges the same row twice', () => {
    const judged = applyJudgment(
      {
        judgments: [
          { id: 'cap', relevance: 0.2, strength: 0.2, receipt: '', reason: 'first' },
          { id: 'cap', relevance: 1, strength: 1, receipt: 'Terraform plan output', reason: 'second' },
        ],
      },
      cited('capability', 'cap'),
      backedSnapshot,
    );

    expect(judged.size).toBe(1);
    expect(judged.get('cap')?.reason).toBe('first');
  });

  it('holds a technology to the standing of the projects it was used in', () => {
    const parked = { ...project('p1', ['ev1']), reviewStatus: 'needs-review' as const };
    const snapshot = snapshotWith({
      technologies: [technology('tech', ['p1'])],
      projects: [parked],
      evidence: [receipt('ev1', 'a receipt', ['p1'])],
    });

    const judged = applyJudgment(perfectReply('tech'), cited('technology', 'tech'), snapshot);
    expect(judged.get('tech')?.strength).toBe(UNPROVEN_CEILING);
  });
});

describe('worseOf — the guarantee itself', () => {
  /**
   * Pinned directly, over all nine pairs, because the integration tests below only catch a broken
   * `worseOf` in the one case where the clamps in applyJudgment did not already stop the promotion.
   * That was measured: replacing the body with `return weighed` failed exactly one test in this file.
   * A rule the whole design rests on deserves a test that fails for the rule's own reason.
   */
  const status = (s: 'proven' | 'partial' | 'gap') => ({
    status: s,
    matchedTechnologies: [],
    matchedCapabilities: [],
    matchedProjects: [],
    evidence: [],
    shortfall: s === 'proven' ? null : s,
  });
  const order = ['gap', 'partial', 'proven'] as const;

  it('never returns the better of the two, for any pair of statuses', () => {
    const rank = { proven: 2, partial: 1, gap: 0 };
    for (const d of order) {
      for (const w of order) {
        const out = worseOf(status(d), status(w));
        expect(rank[out.status], `deterministic=${d} weighed=${w}`).toBeLessThanOrEqual(rank[d]);
        expect(rank[out.status], `deterministic=${d} weighed=${w}`).toBe(Math.min(rank[d], rank[w]));
      }
    }
  });

  it('hands back the deterministic object on a tie, not the weighed one', () => {
    const d = status('partial');
    expect(worseOf(d, status('partial'))).toBe(d);
  });
});

describe('the model cannot raise a verdict', () => {
  /** Resolve a case both ways, exactly as matchRole does, and hand back both answers. */
  function bothWays(candidates: Candidate[], snapshot: Snapshot, reply: unknown, best = 1) {
    const deterministic = resolve({ requirement, candidates, best }, snapshot);
    const judgments = applyJudgment(reply, candidates, snapshot);
    const weighed = resolve(
      { requirement, candidates: prune(candidates, judgments), best, strength: strengthOf(judgments) },
      snapshot,
    );
    return { deterministic, weighed, final: worseOf(deterministic, weighed) };
  }

  it('leaves a receiptless claim at partial when the model rates it 1.0', () => {
    const { deterministic, final } = bothWays(
      cited('capability', 'cap'),
      receiptlessSnapshot,
      perfectReply('cap', 'Terraform plan output'),
    );

    expect(deterministic.status).toBe('partial');
    expect(final.status).toBe('partial');
  });

  it('cannot lift a gap, however relevant the model says the row is', () => {
    // Retrieval alone decides whether anything matched. Weighing only ever argues about how much a
    // match proves, so a record that does not contain the thing stays a gap.
    const belowFloor = 0.1;
    const { deterministic, final } = bothWays(
      [{ kind: 'capability', id: 'cap', name: 'cap', score: belowFloor, via: 'dense' }],
      backedSnapshot,
      perfectReply('cap', 'Terraform plan output'),
      belowFloor,
    );

    expect(deterministic.status).toBe('gap');
    expect(final.status).toBe('gap');
  });

  it('cannot promote by pruning the stretch row that was holding a tie down', () => {
    // Pruning exists to drop coincidental matches from citations. Used the other way it would be a
    // promotion channel: drop the stretch row, and a tie that resolved to partial resolves to proven.
    // `worseOf` closes that, which is why pruning does not need to be trusted.
    const snapshot = snapshotWith({
      capabilities: [
        capability('stretchy', 'stretch', ['ev1'], ['p1']),
        capability('solid', 'proven', ['ev1'], ['p1']),
      ],
      projects: [project('p1', ['ev1'])],
      evidence: [receipt('ev1', 'a receipt', ['p1'])],
    });
    const candidates: Candidate[] = [
      { kind: 'capability', id: 'solid', name: 'solid', score: 1, via: 'lexical' },
      { kind: 'capability', id: 'stretchy', name: 'stretchy', score: 1, via: 'lexical' },
    ];

    const { deterministic, weighed, final } = bothWays(candidates, snapshot, {
      judgments: [
        { id: 'solid', relevance: 1, strength: 1, receipt: 'a receipt', reason: 'strong' },
        { id: 'stretchy', relevance: 0, strength: 0, receipt: '', reason: 'coincidence' },
      ],
    });

    expect(deterministic.status).toBe('partial');
    expect(weighed.status).toBe('proven'); // the prune really would have promoted it
    expect(final.status).toBe('partial'); // and worseOf really does refuse
  });

  it('holds for a reply that rates every row perfect, across every shape of record', () => {
    const cases: { name: string; candidates: Candidate[]; snapshot: Snapshot }[] = [
      { name: 'backed capability', candidates: cited('capability', 'cap'), snapshot: backedSnapshot },
      { name: 'receiptless capability', candidates: cited('capability', 'cap'), snapshot: receiptlessSnapshot },
      {
        name: 'stretch capability',
        candidates: cited('capability', 'cap'),
        snapshot: snapshotWith({
          capabilities: [capability('cap', 'stretch', ['ev1'], ['p1'])],
          projects: [project('p1', ['ev1'])],
          evidence: [receipt('ev1', 'a receipt', ['p1'])],
        }),
      },
      {
        name: 'technology on a parked project',
        candidates: cited('technology', 'tech'),
        snapshot: snapshotWith({
          technologies: [technology('tech', ['p1'])],
          projects: [{ ...project('p1', ['ev1']), reviewStatus: 'needs-review' as const }],
          evidence: [receipt('ev1', 'a receipt', ['p1'])],
        }),
      },
    ];

    const rank = { proven: 2, partial: 1, gap: 0 } as const;

    for (const c of cases) {
      const flattery = {
        judgments: c.candidates.map((k) => ({
          id: k.id,
          relevance: 1,
          strength: 1,
          receipt: 'a receipt',
          reason: 'excellent',
        })),
      };
      const { deterministic, final } = bothWays(c.candidates, c.snapshot, flattery);
      expect(rank[final.status], c.name).toBeLessThanOrEqual(rank[deterministic.status]);
    }
  });

  it('keeps the arithmetic wording when both answers agree', () => {
    // A reader must never be shown a model's explanation for a decision the model did not make.
    const { deterministic, final } = bothWays(
      cited('capability', 'cap'),
      receiptlessSnapshot,
      perfectReply('cap'),
    );
    expect(final.shortfall).toBe(deterministic.shortfall);
  });
});

describe('weighing changes the answer when the work is thin', () => {
  it('demotes a perfectly matched, well-evidenced row the model judged shallow', () => {
    // The point of the whole pass. Retrieval says 1.0 because the name appears; the model says the work
    // behind it is thin; the report says partial and names why.
    const deterministic = resolve({ requirement, candidates: cited('capability', 'cap'), best: 1 }, backedSnapshot);
    expect(deterministic.status).toBe('proven');

    const judgments = applyJudgment(
      { judgments: [{ id: 'cap', relevance: 1, strength: 0.4, receipt: '', reason: 'named, not built' }] },
      cited('capability', 'cap'),
      backedSnapshot,
    );
    const weighed = resolve(
      { requirement, candidates: cited('capability', 'cap'), best: 1, strength: strengthOf(judgments) },
      backedSnapshot,
    );

    expect(worseOf(deterministic, weighed).status).toBe('partial');
    expect(worseOf(deterministic, weighed).shortfall).toMatch(/thinner than the requirement/i);
  });

  it('is a no-op when no judgment is supplied, and absent is not zero', () => {
    // The keyless path and the pinned regression anchor both depend on the first half being exactly
    // true. The second half is the trap it would be easy to fall into: defaulting `strength` to 0
    // instead of leaving it absent would demote every requirement in every keyless report to partial,
    // which is a silent 25-point haircut that no test would have noticed.
    const unweighed = resolve({ requirement, candidates: cited('capability', 'cap'), best: 1 }, backedSnapshot);
    expect(unweighed.status).toBe('proven');

    const zeroed = resolve(
      { requirement, candidates: cited('capability', 'cap'), best: 1, strength: 0 },
      backedSnapshot,
    );
    expect(zeroed.status).toBe('partial');
  });
});

describe('strengthOf and prune', () => {
  const judgment = (id: string, relevance: number, strength: number): Judgment => ({
    id,
    relevance,
    strength,
    receipt: '',
    reason: '',
    clamped: null,
  });

  it('ignores the strength of a row the model called coincidental', () => {
    const judged = new Map([['a', judgment('a', RELEVANCE_FLOOR - 0.01, 1)]]);
    expect(strengthOf(judged)).toBe(0);
  });

  it('takes the best relevant strength, not the average', () => {
    const judged = new Map([
      ['a', judgment('a', 1, 0.9)],
      ['b', judgment('b', 1, 0.2)],
    ]);
    expect(strengthOf(judged)).toBe(0.9);
  });

  it('never prunes a citation list down to nothing', () => {
    // An empty list would read as "no match in the record", which is a gap the record does not have.
    const candidates = cited('capability', 'cap');
    const judged = new Map([['cap', judgment('cap', 0, 0)]]);
    expect(prune(candidates, judged)).toEqual(candidates);
  });

  it('leaves the list alone when nothing was judged', () => {
    const candidates = cited('capability', 'cap');
    expect(prune(candidates, new Map())).toEqual(candidates);
  });
});

describe('what the model is shown', () => {
  it('names a stretch row as a stretch row', () => {
    const snapshot = snapshotWith({
      capabilities: [capability('cap', 'stretch', [], [])],
    });
    const text = buildJudgeInput({
      requirement,
      candidates: cited('capability', 'cap'),
      snapshot,
      now: '2026-08-05T00:00:00.000Z',
    });
    expect(text).toMatch(/stretch claim, not shipped work/);
  });

  it('says receipts: none linked rather than leaving the line out', () => {
    const text = buildJudgeInput({
      requirement,
      candidates: cited('capability', 'cap'),
      snapshot: receiptlessSnapshot,
      now: '2026-08-05T00:00:00.000Z',
    });
    expect(text).toMatch(/receipts: none linked/);
  });

  it('states recency in years rather than making the model do date arithmetic', () => {
    const snapshot = snapshotWith({
      capabilities: [capability('cap', 'proven', ['ev1'], ['p1'])],
      projects: [{ ...project('p1', ['ev1']), started: '2023-04' }],
      evidence: [receipt('ev1', 'a receipt', ['p1'])],
    });
    const text = buildJudgeInput({
      requirement,
      candidates: cited('capability', 'cap'),
      snapshot,
      now: '2026-08-05T00:00:00.000Z',
    });
    expect(text).toMatch(/started 3 years ago/);
  });

  it('never shows a row that retrieval did not return', () => {
    const snapshot = snapshotWith({
      capabilities: [capability('cap', 'proven', ['ev1'], ['p1']), capability('other', 'proven', [], [])],
      projects: [project('p1', ['ev1'])],
      evidence: [receipt('ev1', 'a receipt', ['p1'])],
    });
    const text = buildJudgeInput({
      requirement,
      candidates: cited('capability', 'cap'),
      snapshot,
      now: '2026-08-05T00:00:00.000Z',
    });
    expect(text).not.toMatch(/other/);
  });
});

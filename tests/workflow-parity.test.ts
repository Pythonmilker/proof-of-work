/**
 * The two lanes decide alike, proven by running both.
 *
 * `build.ts` cited this file for months before it existed, which is its own small lesson: a comment
 * naming a safety net is not a safety net. What it was supposed to catch, and did not, was the evidence
 * gate being fixed in `src/pipeline/score.ts` after an adversarial audit while the hand-typed copy inside
 * the n8n Code node kept the old rule. The two lanes then wrote different verdicts for the same candidate
 * into the same Airtable base, and every check in the repo stayed green — because the drift check
 * compares the committed JSON to what `build.ts` regenerates, which is `build.ts` against itself.
 *
 * So this suite does the one thing that check structurally cannot: it takes the JavaScript out of the
 * COMMITTED workflow, runs it, and compares its answers to the app's own functions over a table of
 * inputs chosen to sit on the seams. If someone hand-edits the JSON, rebuilds from an older portable.ts,
 * or "helpfully" tweaks a rule inside the Code node, a case below disagrees and this fails.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRationale,
  containsTerm,
  coverageOf,
  applyJudgments,
  duplicateProjectOf,
  gapNote,
  gateStatus,
  pruneCandidates,
  matchCapabilityRow,
  matchTechnologyRow,
  strengthOfJudgments,
  unionLinks,
  worseOf,
  lexicalCapabilityScore,
  topCited,
  type CoverageRow,
  type GateInput,
} from '@/pipeline/portable';
import { THRESHOLD_PARTIAL, THRESHOLD_PROVEN } from '@/pipeline/score';

const START = '── generated from src/pipeline/portable.ts';
const END = '── end generated ──';

/** A node's own code: everything outside the block generated from portable.ts. */
function handWritten(jsCode: string): string {
  const start = jsCode.indexOf(START);
  if (start === -1) return jsCode;
  return jsCode.slice(0, start) + jsCode.slice(jsCode.indexOf(END));
}

/**
 * A committed Code node, found by a rule it CALLS.
 *
 * Matched against the hand-written region only. The generated block DEFINES every rule and is emitted
 * into more than one node, so a whole-node search for `checkRationale(` matches the scoring node as
 * readily as the guard node and silently returns whichever comes first in the array — which is how the
 * first version of this helper handed the guard suite the wrong node.
 */
function committedNode(workflowFile: string, calls: string): string {
  const workflow = JSON.parse(
    readFileSync(join(process.cwd(), 'n8n', workflowFile), 'utf8'),
  ) as { nodes: Array<{ name: string; parameters?: { jsCode?: string } }> };

  const matches = workflow.nodes.filter(
    (n) => typeof n.parameters?.jsCode === 'string' && handWritten(n.parameters.jsCode).includes(`${calls}(`),
  );
  if (matches.length === 0) throw new Error(`no Code node in ${workflowFile} calls ${calls}`);
  if (matches.length > 1) {
    throw new Error(`${matches.length} Code nodes in ${workflowFile} call ${calls}: ${matches.map((n) => n.name).join(', ')}`);
  }
  return matches[0]!.parameters!.jsCode!;
}

// Matched on a rule unique to each node: 'Apply weighing' also calls resolveRequirement, which is the
// point of the change — resolution is stated once and both passes run it.
const scoreNode = (): string => committedNode('match-role.json', 'lexicalCapabilityScore');
const weighNode = (): string => committedNode('match-role.json', 'applyJudgments');
const guardNode = (): string => committedNode('match-role.json', 'checkRationale');

/**
 * Lift the generated block out of a committed node and evaluate it.
 *
 * Only the block between the markers is taken, so the surrounding node logic (Airtable shapes, n8n
 * globals) never has to run — the rules are pure by construction, which is what makes them liftable.
 * `names` is what to hand back, so each caller asks for the rules it is about to compare.
 */
function rulesFrom(jsCode: string, names: readonly string[]): Record<string, Function> {
  const start = jsCode.indexOf(START);
  const end = jsCode.indexOf(END);
  expect(start, 'the generated-rules block is missing from the committed workflow').toBeGreaterThan(-1);
  expect(end, 'the generated-rules block is unterminated in the committed workflow').toBeGreaterThan(start);

  const block = jsCode.slice(jsCode.indexOf('*/', start) + 2, jsCode.lastIndexOf('/*', end));
  return new Function(`${block}
return { ${names.join(', ')} };`)() as Record<string, Function>;
}

const T = { thresholdProven: THRESHOLD_PROVEN, thresholdPartial: THRESHOLD_PARTIAL };

/**
 * Inputs chosen for the seams, not for coverage.
 *
 * The first case is the one that was actually wrong in production for months: a stretch capability tied
 * at top score with an evidenced proven one. Under the old `every` rule the workflow called it proven and
 * dropped it from the Gaps section; the app called it partial.
 */
const GATE_CASES: Array<[name: string, input: GateInput]> = [
  ['the regression: a stretch tied with a proven row', { best: 1, evidenceCount: 3, decisive: [{ tier: 'proven', evidenceCount: 2 }, { tier: 'stretch', evidenceCount: 1 }], ...T }],
  ['a clean proven hit', { best: 1, evidenceCount: 2, decisive: [{ tier: 'proven', evidenceCount: 2 }], ...T }],
  ['nothing matched at all', { best: 0, evidenceCount: 0, decisive: [], ...T }],
  ['exactly on the partial threshold', { best: THRESHOLD_PARTIAL, evidenceCount: 1, decisive: [{ tier: 'proven', evidenceCount: 1 }], ...T }],
  ['exactly on the proven threshold', { best: THRESHOLD_PROVEN, evidenceCount: 1, decisive: [{ tier: 'proven', evidenceCount: 1 }], ...T }],
  ['a hair under proven', { best: THRESHOLD_PROVEN - 0.01, evidenceCount: 1, decisive: [{ tier: 'proven', evidenceCount: 1 }], ...T }],
  ['matched, but nothing verifiable linked', { best: 1, evidenceCount: 0, decisive: [{ tier: 'proven', evidenceCount: 0 }], ...T }],
  ['a decisive row carrying no receipt', { best: 1, evidenceCount: 4, decisive: [{ tier: 'proven', evidenceCount: 0 }], ...T }],
  ['every decisive row is a stretch', { best: 1, evidenceCount: 2, decisive: [{ tier: 'stretch', evidenceCount: 1 }], ...T }],
  ['no capability matched, only technologies', { best: 1, evidenceCount: 2, decisive: [], ...T }],
  ['weighed thin by the model', { best: 1, evidenceCount: 2, decisive: [{ tier: 'proven', evidenceCount: 2 }], strength: 0.4, ...T }],
  ['weighed at the boundary', { best: 1, evidenceCount: 2, decisive: [{ tier: 'proven', evidenceCount: 2 }], strength: THRESHOLD_PROVEN, ...T }],
];

const COVERAGE_CASES: Array<[name: string, rows: CoverageRow[]]> = [
  ['an empty posting', []],
  ['the anchor shape: 10 proven, 4 partial, 2 gap, all required', [
    ...Array.from({ length: 10 }, () => ({ kind: 'required', status: 'proven' as const })),
    ...Array.from({ length: 4 }, () => ({ kind: 'required', status: 'partial' as const })),
    ...Array.from({ length: 2 }, () => ({ kind: 'required', status: 'gap' as const })),
  ]],
  ['preferred items weigh half', [
    { kind: 'required', status: 'proven' },
    { kind: 'preferred', status: 'gap' },
  ]],
  ['three must-haves missed under eleven nice-to-haves', [
    ...Array.from({ length: 3 }, () => ({ kind: 'required', status: 'gap' as const })),
    ...Array.from({ length: 11 }, () => ({ kind: 'preferred', status: 'proven' as const })),
  ]],
  ['all gaps', [{ kind: 'required', status: 'gap' }, { kind: 'preferred', status: 'gap' }]],
];

describe('the committed workflow scores exactly as the app does', () => {
  const workflowRules = rulesFrom(scoreNode(), ['gateStatus', 'coverageOf']) as unknown as {
    gateStatus: typeof gateStatus;
    coverageOf: typeof coverageOf;
  };

  it.each(GATE_CASES)('gate agrees on %s', (_name, input) => {
    expect(workflowRules.gateStatus(input)).toEqual(gateStatus(input));
  });

  it.each(COVERAGE_CASES)('coverage agrees on %s', (_name, rows) => {
    expect(workflowRules.coverageOf(rows)).toEqual(coverageOf(rows));
  });

  it('holds the specific verdict the audit corrected', () => {
    // Stated as an absolute rather than a comparison: if both lanes regressed together, the equality
    // checks above would still pass and this would not.
    const [, tiedStretch] = GATE_CASES[0]!;
    expect(workflowRules.gateStatus(tiedStretch).status).toBe('partial');
    expect(workflowRules.gateStatus(tiedStretch).shortfall).toMatch(/recorded as a stretch/i);
  });

  it('states each rule once — the generated block, and nowhere else in the node', () => {
    // Scoped to the HAND-WRITTEN part of the node on purpose. The weights genuinely do appear inside the
    // generated block (portable.ts keeps them inside the function that needs them, precisely so they
    // travel with it), so a naive whole-file grep would fail on the fix working. What must not exist is a
    // second definition sitting outside the block, which is the shape the drift took last time.
    const own = handWritten(scoreNode());

    expect(own).not.toMatch(/caps\.every\(/);
    expect(own).not.toMatch(/WEIGHT\s*=\s*\{/);
    expect(own).not.toMatch(/VALUE\s*=\s*\{\s*proven/);
    // The matching rules had hand-typed twins here too, and the twin lacked the overlap fallback.
    expect(own).not.toMatch(/const (normalize|containsTerm|escapeRe)\s*=/);
    expect(own).not.toMatch(/MAX_CITED\s*=\s*4/);
    expect(own).not.toMatch(/MAX_CITED_PROJECTS\s*=/);
    // And the node really is calling the generated rules rather than reimplementing them inline.
    // The node calls the generated rules rather than reimplementing them. It used to inline the whole
    // projects/evidence derivation and the gate; now it hands cited rows to resolveRequirement.
    expect(own).toMatch(/resolveRequirement\(/);
    expect(own).toMatch(/coverageOf\(/);
    expect(own).toMatch(/lexicalCapabilityScore\(/);
    expect(own).toMatch(/topCited\(/);
  });
});

/**
 * Matching cases chosen for the specific wrong answers they produced, not for coverage.
 *
 * The hyphen and plural cases are bugs this repo actually shipped. The capability cases exist because the
 * workflow had NO overlap fallback at all — it scored a described capability zero where the app scored it
 * 0.6 or better. Silently, and on prose postings only, which is why nothing caught it.
 */
const TERM_CASES: Array<[haystack: string, needle: string]> = [
  ['built with react-three-fiber', 'react'],
  ['built with react and vite', 'react'],
  ['experience with rest-api design', 'rest api'],
  ['ships structured outputs', 'structured output'],
  ['worked in c# and .net', 'c#'],
  ['worked in c and assembly', 'c#'],
  ['ci/cd pipelines on aws', 'ci/cd'],
  ['deep-linking into the app', 'deep'],
  ['node.js services', 'node.js'],
  ['', 'react'],
];

const CAP = { name: 'Workflow automation', matchTerms: ['n8n'], statement: 'Connecting internal systems through automated workflows.' };

const CAPABILITY_CASES: Array<[name: string, requirement: string]> = [
  ['named outright', 'Experience with n8n'],
  ['described, never named — the case the workflow could not score', 'Builds automations that connect internal systems'],
  ['unrelated', 'Deep knowledge of colour theory'],
  ['partial overlap under the floor', 'Systems thinking for large teams'],
];

describe('the committed workflow matches exactly as the app does', () => {
  const rules = rulesFrom(scoreNode(), ['containsTerm', 'lexicalCapabilityScore', 'topCited']) as unknown as {
    containsTerm: typeof containsTerm;
    lexicalCapabilityScore: typeof lexicalCapabilityScore;
    topCited: typeof topCited;
  };

  it.each(TERM_CASES)('containsTerm agrees on %j / %j', (haystack, needle) => {
    expect(rules.containsTerm(haystack, needle)).toBe(containsTerm(haystack, needle));
  });

  it.each(CAPABILITY_CASES)('capability scoring agrees when %s', (_name, requirement) => {
    const haystack = requirement.toLowerCase();
    expect(rules.lexicalCapabilityScore(requirement, haystack, CAP)).toBeCloseTo(
      lexicalCapabilityScore(requirement, haystack, CAP),
      10,
    );
  });

  it('the described-capability case really does score, in both lanes', () => {
    // Absolute, not a comparison: if the fallback were dropped from portable.ts the equality check above
    // would still pass with both lanes returning 0, which is the exact failure being fixed.
    const [, requirement] = CAPABILITY_CASES[1]!;
    const haystack = requirement.toLowerCase();
    expect(lexicalCapabilityScore(requirement, haystack, CAP)).toBeGreaterThan(0.5);
    expect(rules.lexicalCapabilityScore(requirement, haystack, CAP)).toBeGreaterThan(0.5);
  });

  it('citation trimming agrees, including the DELTA floor the workflow was missing', () => {
    const ranked = [{ score: 1 }, { score: 0.9 }, { score: 0.75 }, { score: 0.6 }, { score: 0.2 }];
    expect(rules.topCited(ranked)).toEqual(topCited(ranked));
    // One real match must not drag two unrelated rows into the citation list.
    const thin = [{ score: 1 }, { score: 0.3 }, { score: 0.2 }];
    expect(topCited(thin)).toHaveLength(1);
    expect(rules.topCited(thin)).toHaveLength(1);
  });
});

/**
 * The fabrication guard, which the workflow enforced by half.
 *
 * It checked numbers and length and had no adjective ban at all, so the sentence a live run actually
 * produced — "extensive experience with Claude Code" — was rejected by the app and written to Airtable by
 * the workflow. That sentence is the first case.
 */
const CORPUS = 'Claude Code operating contract. 7 rules. Tendril shipped 125 commits on master.';

const RATIONALE_CASES: Array<[name: string, sentence: string]> = [
  ['the sentence a live run wrote', 'The candidate has extensive experience with Claude Code.'],
  ['a clean citation', 'Claude Code appears in Tendril, with 2 linked receipts.'],
  ['a figure nobody wrote', 'Tendril ships 4000 commits on master.'],
  ['a figure that is in the corpus', 'Tendril ships 125 commits on master.'],
  ['a small number, exempt', 'Cited in 3 projects.'],
  ['a banned word it only spells', 'Uses deep-linking into the app.'],
  ['another banned word it only spells', 'Runs on solid-state storage.'],
  ['graded a different way', 'Shows strong command of the toolchain.'],
  ['empty', ''],
  ['longer than a citation needs to be', 'Claude Code appears in Tendril. '.repeat(20)],
];

describe('the committed workflow guards rationales exactly as the app does', () => {
  const rules = rulesFrom(guardNode(), ['checkRationale']) as unknown as {
    checkRationale: typeof checkRationale;
  };

  it.each(RATIONALE_CASES)('guard agrees on %s', (_name, sentence) => {
    expect(rules.checkRationale(sentence, CORPUS)).toEqual(checkRationale(sentence, CORPUS));
  });

  it('holds the specific sentence the live run produced', () => {
    const [, banned] = RATIONALE_CASES[0]!;
    expect(rules.checkRationale(banned, CORPUS).usable).toBe(false);
    expect(rules.checkRationale(banned, CORPUS).faults.join(' ')).toMatch(/grades the candidate/i);
  });

  it('states each rule once — the generated block, and nowhere else in the node', () => {
    const own = handWritten(guardNode());
    expect(own).not.toMatch(/const numbersIn\s*=/);
    expect(own).not.toMatch(/length\s*<=\s*400/);
    expect(own).toMatch(/checkRationale\(/);
  });
});

/**
 * Every emission of the block, in both workflows, actually parses and runs.
 *
 * The suites above name the two nodes whose answers are compared. This one finds them by structure
 * instead, so a node that starts carrying the block later is covered without anyone remembering to add
 * it here — and a block that lands syntactically broken fails on the node it broke rather than on
 * whichever suite happened to touch it first. A Code node that throws at parse time in n8n reports a
 * runtime error against the workflow, not against this repo.
 */
describe('every generated block in every workflow is live code', () => {
  const emissions = ['extract-project.json', 'match-role.json'].flatMap((file) => {
    const workflow = JSON.parse(readFileSync(join(process.cwd(), 'n8n', file), 'utf8')) as {
      nodes: Array<{ name: string; parameters?: { jsCode?: string } }>;
    };
    return workflow.nodes
      .filter((n) => typeof n.parameters?.jsCode === 'string' && n.parameters.jsCode.includes(START))
      .map((n) => [`${file} → ${n.name}`, n.parameters!.jsCode!] as const);
  });

  it('there are emissions to check at all', () => {
    // Without this, deleting every block would make the it.each below vacuously pass.
    expect(emissions.length).toBeGreaterThanOrEqual(3);
  });

  it.each(emissions)('%s runs and agrees on the gate', (_label, jsCode) => {
    const rules = rulesFrom(jsCode, ['gateStatus', 'checkRationale']) as unknown as {
      gateStatus: typeof gateStatus;
      checkRationale: typeof checkRationale;
    };
    const [, probe] = GATE_CASES[0]!;
    expect(rules.gateStatus(probe)).toEqual(gateStatus(probe));
    expect(rules.checkRationale('The candidate has extensive experience.', '').usable).toBe(false);
  });
});

/**
 * The Gaps note, which the workflow wrote shorter than the app did.
 *
 * CLAUDE.md calls the Gaps section the load-bearing claim of the whole product. The n8n lane dropped the
 * "Closest on file" clause, so the same applicant against the same posting got a less useful Gaps
 * section in Airtable — the surface the recruiter actually reads — than in the app.
 */
const GAP_NOTE_CASES: Array<[name: string, shortfall: string | null, projects: string[]]> = [
  ['a shortfall with two projects', 'the matching capability is recorded as a stretch, not as shipped work', ['Tendril', 'Parastoria']],
  ['a shortfall with one project', 'matched, but nothing verifiable is linked to it', ['Tendril']],
  ['a shortfall with none', 'nothing in the record matches this closely enough to claim', []],
  ['more projects than fit', 'coverage is partial', ['A', 'B', 'C', 'D']],
  ['no shortfall at all', null, ['Tendril']],
  ['an empty shortfall', '', []],
];

describe('the committed workflow writes the same Gaps note as the app', () => {
  const rules = rulesFrom(scoreNode(), ['gapNote']) as unknown as { gapNote: typeof gapNote };

  it.each(GAP_NOTE_CASES)('agrees on %s', (_name, shortfall, projects) => {
    expect(rules.gapNote(shortfall, projects)).toBe(gapNote(shortfall, projects));
  });

  it('really does name the closest projects, in both lanes', () => {
    // Absolute rather than a comparison: dropping the clause from portable.ts would keep the equality
    // cases green while removing the thing this exists to protect.
    const note = gapNote('coverage is partial', ['Tendril', 'Parastoria']);
    expect(note).toBe('Coverage is partial. Closest on file: Tendril and Parastoria.');
    expect(rules.gapNote('coverage is partial', ['Tendril', 'Parastoria'])).toBe(note);
  });
});

/**
 * The weighing guards, compared rule for rule against the app's.
 *
 * `tests/judge.test.ts` attacks these in the app lane. The workflow had no weighing pass at all, so
 * these ran nowhere until the port — and the two lanes upsert the same Roles key, meaning the lane
 * without the guarantee could overwrite the lane with it.
 */
const JUDGE_SNAPSHOT = {
  technologies: [{ id: 'tech-ts', projects: ['proj-ok'] }],
  capabilities: [
    { id: 'cap-backed', tier: 'proven', projects: ['proj-ok'], evidence: ['ev-1'] },
    { id: 'cap-stretch', tier: 'stretch', projects: ['proj-ok'], evidence: ['ev-1'] },
    { id: 'cap-bare', tier: 'proven', projects: ['proj-ok'], evidence: [] },
  ],
  projects: [{ id: 'proj-ok', reviewStatus: 'ok', evidence: ['ev-1'] }],
  evidence: [{ id: 'ev-1', label: 'Commits on master' }],
};

const JUDGE_CANDIDATES = [
  { kind: 'capability', id: 'cap-backed', name: 'Backed', score: 1 },
  { kind: 'capability', id: 'cap-stretch', name: 'Stretch', score: 1 },
  { kind: 'capability', id: 'cap-bare', name: 'Bare', score: 1 },
  { kind: 'technology', id: 'tech-ts', name: 'TypeScript', score: 1 },
];

const JUDGE_CASES: Array<[name: string, raw: unknown]> = [
  ['an honest reply', { judgments: [{ id: 'cap-backed', relevance: 0.9, strength: 0.9, receipt: 'Commits on master', reason: 'ok' }] }],
  ['1.0 on a stretch row', { judgments: [{ id: 'cap-stretch', relevance: 1, strength: 1, receipt: 'Commits on master', reason: 'x' }] }],
  ['1.0 with no receipt named', { judgments: [{ id: 'cap-backed', relevance: 1, strength: 1, receipt: '', reason: 'x' }] }],
  ['1.0 citing a receipt the row does not carry', { judgments: [{ id: 'cap-backed', relevance: 1, strength: 1, receipt: 'Invented', reason: 'x' }] }],
  ['1.0 on a receiptless row', { judgments: [{ id: 'cap-bare', relevance: 1, strength: 1, receipt: 'Commits on master', reason: 'x' }] }],
  ['an id nobody sent', { judgments: [{ id: 'cap-elsewhere', relevance: 1, strength: 1, receipt: 'x', reason: 'x' }] }],
  ['the same id twice', { judgments: [
    { id: 'cap-backed', relevance: 0.2, strength: 0.2, receipt: '', reason: 'first' },
    { id: 'cap-backed', relevance: 1, strength: 1, receipt: 'Commits on master', reason: 'second' },
  ] }],
  ['out-of-range numbers', { judgments: [{ id: 'cap-backed', relevance: 5, strength: -3, receipt: '', reason: 'x' }] }],
  ['a technology at 1.0, which carries no labels of its own', { judgments: [{ id: 'tech-ts', relevance: 1, strength: 1, receipt: '', reason: 'x' }] }],
  ['nothing at all', { judgments: [] }],
  ['not even an object', 'sorry, I could not comply'],
];

describe('the committed workflow bounds a weighing reply exactly as the app does', () => {
  const rules = rulesFrom(weighNode(), ['applyJudgments', 'strengthOfJudgments', 'pruneCandidates', 'worseOf']) as unknown as {
    applyJudgments: typeof applyJudgments;
    strengthOfJudgments: typeof strengthOfJudgments;
    pruneCandidates: typeof pruneCandidates;
    worseOf: typeof worseOf;
  };

  it.each(JUDGE_CASES)('agrees on %s', (_name, raw) => {
    const mine = rules.applyJudgments(raw, JUDGE_CANDIDATES, JUDGE_SNAPSHOT, THRESHOLD_PROVEN);
    expect(mine).toEqual(applyJudgments(raw, JUDGE_CANDIDATES, JUDGE_SNAPSHOT, THRESHOLD_PROVEN));
    expect(rules.strengthOfJudgments(mine)).toBe(strengthOfJudgments(mine));
    expect(rules.pruneCandidates(JUDGE_CANDIDATES, mine)).toEqual(pruneCandidates(JUDGE_CANDIDATES, mine));
  });

  it('no reply, however confident, gets a strength above the ceiling without a named receipt', () => {
    // Absolute, not a comparison: both lanes regressing together would keep the equality cases green.
    for (const [, raw] of JUDGE_CASES.slice(1, 5)) {
      const judged = rules.applyJudgments(raw, JUDGE_CANDIDATES, JUDGE_SNAPSHOT, THRESHOLD_PROVEN);
      for (const j of judged) expect(j.strength).toBeLessThanOrEqual(THRESHOLD_PROVEN);
    }
  });

  it('worseOf never returns the better of the two', () => {
    const better = { status: 'proven' as const, matchedTechnologies: [], matchedCapabilities: [], matchedProjects: [], evidence: [], shortfall: null };
    const worse = { ...better, status: 'partial' as const, shortfall: 'thin' };
    expect(rules.worseOf(better, worse).status).toBe('partial');
    expect(rules.worseOf(worse, better).status).toBe('partial');
    expect(rules.worseOf(better, worse)).toEqual(worseOf(better, worse));
    expect(rules.worseOf(worse, better)).toEqual(worseOf(worse, better));
  });
});

/**
 * Resolving loose strings against the taxonomy, and merging rather than replacing.
 *
 * The extract workflow matched by normalised EQUALITY only, while link.ts ran two further passes — so
 * "Node.js 20+" and "AWS Lambda functions", both verbatim in raw/01-tendril-readme.md and both exactly
 * what the extraction prompt asks the model to produce, resolved in the app and landed in `unresolved`
 * in the workflow. Same blob, different links, therefore different citations at score time.
 */
const TECH_ROWS = [
  { name: 'Node.js', aliases: ['node', 'nodejs'] },
  { name: 'AWS Lambda', aliases: ['lambda', 'serverless'] },
  { name: 'React', aliases: ['react.js'] },
];

const CAP_ROWS = [
  { name: 'Workflow automation', matchTerms: ['n8n', 'zapier'] },
  { name: 'Retrieval augmented generation', matchTerms: ['rag', 'vector search'] },
];

const RESOLVE_CASES: Array<[raw: string, kind: 'tech' | 'cap']> = [
  ['Node.js 20+', 'tech'],
  ['AWS Lambda functions', 'tech'],
  ['nodejs', 'tech'],
  ['React', 'tech'],
  ['Rust', 'tech'],
  ['', 'tech'],
  ['n8n', 'cap'],
  ['Workflow automation', 'cap'],
  ['retrieval augmented generation pipelines', 'cap'],
  ['colour theory', 'cap'],
];

describe('the committed workflow resolves taxonomy exactly as the app does', () => {
  const rules = rulesFrom(committedNode('extract-project.json', 'matchTechnologyRow'), [
    'matchTechnologyRow',
    'matchCapabilityRow',
    'duplicateProjectOf',
    'unionLinks',
  ]) as unknown as {
    matchTechnologyRow: typeof matchTechnologyRow;
    matchCapabilityRow: typeof matchCapabilityRow;
    duplicateProjectOf: typeof duplicateProjectOf;
    unionLinks: typeof unionLinks;
  };

  it.each(RESOLVE_CASES)('agrees on %j (%s)', (raw, kind) => {
    if (kind === 'tech') {
      expect(rules.matchTechnologyRow(raw, TECH_ROWS)).toEqual(matchTechnologyRow(raw, TECH_ROWS));
    } else {
      expect(rules.matchCapabilityRow(raw, CAP_ROWS)).toEqual(matchCapabilityRow(raw, CAP_ROWS));
    }
  });

  it('really does resolve the two strings the workflow used to drop', () => {
    // Absolute rather than a comparison: both lanes returning undefined together would keep the
    // equality cases green while the defect stood.
    expect(matchTechnologyRow('Node.js 20+', TECH_ROWS)?.name).toBe('Node.js');
    expect(matchTechnologyRow('AWS Lambda functions', TECH_ROWS)?.name).toBe('AWS Lambda');
    expect(rules.matchTechnologyRow('Node.js 20+', TECH_ROWS)?.name).toBe('Node.js');
    expect(rules.matchTechnologyRow('AWS Lambda functions', TECH_ROWS)?.name).toBe('AWS Lambda');
  });

  it('catches the same-project-different-name duplicate', () => {
    const projects = [{ name: 'Tendril', slug: 'tendril', reviewStatus: 'ok' }];
    const verdict = rules.duplicateProjectOf(projects, 'Tendril — agent-first IDE');
    expect(verdict).toEqual(duplicateProjectOf(projects, 'Tendril — agent-first IDE'));
    expect(verdict.duplicate?.name).toBe('Tendril');
  });

  it('unions links instead of replacing them', () => {
    // An Airtable upsert overwrites a linked-record cell. Writing only this run's links erased the rest.
    const existing = ['recReact', 'recVite', 'recTailwind'];
    const incoming = ['recVite', 'recSqlite'];
    expect(rules.unionLinks(existing, incoming)).toEqual(unionLinks(existing, incoming));
    expect(unionLinks(existing, incoming)).toEqual(['recReact', 'recVite', 'recTailwind', 'recSqlite']);
    expect(unionLinks(undefined, incoming)).toEqual(incoming);
    expect(unionLinks(existing, undefined)).toEqual(existing);
  });
});

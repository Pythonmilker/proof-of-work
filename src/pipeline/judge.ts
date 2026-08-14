/**
 * Weighing: retrieval found these rows, but how much do they actually prove?  (DESIGN.md §v3.8)
 *
 * Retrieval answers a question about words. A posting that says "Terraform" and a record that says
 * "Terraform" score 1.0, and that number is then read downstream as though it meant the work was strong.
 * It does not. It means the string appeared. A tutorial that names Terraform and a fourteen-resource
 * estate that runs on it are indistinguishable to `containsTerm`, and the fit report was calling both of
 * them a direct hit.
 *
 * Difficulty, how much was built, how recent it is, and what a project actually demonstrates are not
 * things arithmetic can read off a name. They are judgement, so this file asks a model for judgement —
 * and then bounds the answer in code, because a model asked "how strong is this?" will happily say
 * "strong".
 *
 * ── What the model cannot do ────────────────────────────────────────────────────────────────────────
 *
 * It never sees the store. It sees the rows retrieval already returned, and its reply is a list of ids
 * copied back from the list it was sent. `applyJudgment` drops any id it did not send, so there is no
 * shape of reply — malformed, confused, or hostile — that adds a project, a technology or a receipt.
 *
 * It cannot raise a verdict. `weigh` in ../pipeline/index.ts resolves every requirement twice: once
 * deterministically, exactly as this pipeline did before weighing existed, and once with the model's
 * numbers. The worse of the two wins. That is the whole guarantee, it is three lines, and it holds
 * whatever the model returns — including a reply that rates every row 1.0.
 *
 * So the model can only ever move a requirement DOWN. That is the correct direction for an instrument
 * whose value is that it under-claims: a weighing pass that could promote would be a flattery generator
 * with an extra step, and the Gaps section exists precisely because that is the failure mode.
 */

import { callJson, type LlmOptions } from '../openrouter/client';
import { JUDGMENT_SCHEMA } from '../openrouter/schemas';
import type { Capability, Requirement, Snapshot, Technology } from '../store/types';
import type { Candidate } from './match';
import { THRESHOLD_PROVEN } from './score';
import {
  applyJudgments,
  pruneCandidates,
  strengthOfJudgments,
  RELEVANCE_FLOOR,
} from './portable';

/** Below this relevance a row is coincidental. Defined in ./portable.ts so both lanes share it. */
export { RELEVANCE_FLOOR };

/**
 * The ceiling a row is held to when its receipts do not support a direct hit.
 *
 * Deliberately just under `THRESHOLD_PROVEN` rather than something round: it is not a score, it is the
 * highest number that still means "not proven". Anything a clamp produces must fail the proven test by
 * construction, not by a comparison someone could later tune into being true.
 */
export const UNPROVEN_CEILING = THRESHOLD_PROVEN - 0.01;


export interface Judgment {
  id: string;
  relevance: number;
  strength: number;
  /** The evidence label the model says justifies a proven-level strength. Empty when it claimed none. */
  receipt: string;
  reason: string;
  /** Set when code overrode the model's number, and why. Surfaced in the report. */
  clamped: string | null;
}

export interface WeighOutcome {
  /** Keyed by candidate id. Only ids that were sent, only after clamping. */
  judgments: Map<string, Judgment>;
  /** The strength the requirement is judged at: the best clamped strength among its cited rows. */
  strength: number;
  source: 'model' | 'unweighed';
}

export const WEIGHING_SYSTEM = `You judge how strongly a candidate's recorded work demonstrates one job
requirement. You are given the requirement and a numbered list of records that a search already matched
against it. Judge only those records.

For each record return two numbers.

relevance — does this record speak to THIS requirement at all?
  1.0  directly about it
  0.6  related, adjacent work
  0.0  the words overlap and nothing else does

strength — how strongly does the work behind this record demonstrate the requirement?
  0.9  built and shipped something substantial with it, recently, and the receipts show scale
  0.7  real shipped work, modest in scope, or strong work that is now a couple of years old
  0.4  used it inside a larger project, or the record asserts it without much behind it
  0.1  named only, nothing built

Judge strength on what the receipts and project details actually show: how hard the thing was to build,
how much of it there is, how recent it is, and what shipping it proves. A record that names a technology
is not the same as a record that shows a system running on it. Say so with the number.

Rules:
- Copy each id exactly as given. Never write an id that is not in the list.
- To give a strength above 0.7 you must name, in "receipt", the exact label of the one receipt shown for
  that record that justifies it. If no receipt shown supports that, score it 0.7 or below and leave
  "receipt" empty. A receipt you cannot name is a receipt that does not count.
- Be strict. Most real records are 0.4 to 0.7. Reserve 0.9 for work you can point at a receipt for.
- "reason" is one short clause about the evidence, not about the person.`;

/** The recency band a project falls in, as words rather than a date the model has to do maths on. */
function recencyOf(started: string | undefined, now: string): string {
  if (!started) return 'date not recorded';
  const startYear = Number(started.slice(0, 4));
  const nowYear = Number(now.slice(0, 4));
  if (!Number.isFinite(startYear) || !Number.isFinite(nowYear)) return 'date not recorded';
  const age = nowYear - startYear;
  if (age <= 0) return 'this year';
  if (age === 1) return 'last year';
  return `${age} years ago`;
}

export interface JudgeInput {
  requirement: Requirement;
  candidates: readonly Candidate[];
  snapshot: Snapshot;
  /** ISO date the report is being run on, so recency is stated rather than assumed. */
  now: string;
}

/**
 * Everything the model may see about one requirement.
 *
 * Receipts are listed by label because the label is what the model must quote back to clear the proven
 * line. Metrics and status come along because "14 Terraform resources, live" is the difference this
 * whole file exists to notice, and it is invisible in a technology's name.
 */
export function buildJudgeInput(input: JudgeInput): string {
  const { requirement, candidates, snapshot, now } = input;
  const techIndex = new Map(snapshot.technologies.map((t) => [t.id, t]));
  const capIndex = new Map(snapshot.capabilities.map((c) => [c.id, c]));
  const projectIndex = new Map(snapshot.projects.map((p) => [p.id, p]));
  const evidenceIndex = new Map(snapshot.evidence.map((e) => [e.id, e]));

  const lines: string[] = [`Requirement (${requirement.kind}): ${requirement.text}`, '', 'Records:'];

  for (const c of candidates) {
    const row = c.kind === 'technology' ? techIndex.get(c.id) : capIndex.get(c.id);
    if (!row) continue;

    lines.push(`- id: ${c.id}`);
    if (c.kind === 'technology') {
      const tech = row as Technology;
      lines.push(`  technology: ${tech.name}`);
    } else {
      const cap = row as Capability;
      lines.push(`  capability: ${cap.name}`);
      lines.push(`  states: ${cap.statement}`);
      // Named plainly. A stretch row is a claim the record itself does not stand behind, and hiding
      // that from the model produces a confident 0.9 on the one kind of row that must never earn one.
      if (cap.tier === 'stretch') lines.push('  recorded as: a stretch claim, not shipped work');
    }

    const projectIds = c.kind === 'technology' ? (row as Technology).projects : (row as Capability).projects;
    for (const pid of projectIds.slice(0, 3)) {
      const project = projectIndex.get(pid);
      if (!project) continue;
      const metrics = Object.entries(project.metrics)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');
      lines.push(
        `  built in: ${project.name} (${project.status}, started ${recencyOf(project.started, now)})` +
          `${metrics ? ` — ${metrics}` : ''}`,
      );
    }

    const receiptIds = c.kind === 'technology' ? [] : (row as Capability).evidence;
    const receipts = receiptIds.map((id) => evidenceIndex.get(id)).filter(Boolean);
    if (receipts.length === 0) {
      lines.push('  receipts: none linked');
    } else {
      for (const e of receipts) lines.push(`  receipt "${e?.label}": ${e?.value}`);
    }
  }

  return lines.join('\n');
}

/**
 * Is this row's own record good enough to support a proven-level strength?
 *
 * This is the arithmetic half of the gate, and it runs on the row rather than on the model's opinion of
 * the row. A capability with nothing linked, or one the record itself files as a stretch, cannot clear
 * the line no matter how the model scored it — which is the same rule `resolve` enforces, applied one
 * step earlier so the number the resolver reads is already honest.
 */
/*
 * The guards are `applyJudgments`, `judgeBacked`, `judgeReceiptLabels`, `strengthOfJudgments` and
 * `pruneCandidates` in ./portable.ts — the definitions the n8n Code nodes are generated from. They
 * lived here, and the workflow had no weighing pass at all, so nothing enforced them on that lane.
 * The wrappers below keep this file's Map-based signatures, which the app and its tests already use.
 */
export function applyJudgment(
  raw: unknown,
  candidates: readonly Candidate[],
  snapshot: Snapshot,
): Map<string, Judgment> {
  const judged = applyJudgments(raw, candidates, snapshot, THRESHOLD_PROVEN);
  return new Map(judged.map((j) => [j.id, j]));
}

/** Ask the model, then bound the answer. A failed call is not an error — it is an unweighed report. */
export async function weighCandidates(
  input: JudgeInput,
  opts: LlmOptions,
): Promise<WeighOutcome> {
  if (input.candidates.length === 0) {
    return { judgments: new Map(), strength: 0, source: 'unweighed' };
  }

  const result = await callJson<unknown>(
    {
      tier: 'weighing',
      schemaName: 'match_judgment',
      schema: JUDGMENT_SCHEMA as unknown as Record<string, unknown>,
      system: WEIGHING_SYSTEM,
      user: buildJudgeInput(input),
      maxTokens: 700,
      temperature: 0,
    },
    opts,
  );

  if (!result.ok) return { judgments: new Map(), strength: 0, source: 'unweighed' };

  const judgments = applyJudgment(result.value, input.candidates, input.snapshot);
  if (judgments.size === 0) return { judgments: new Map(), strength: 0, source: 'unweighed' };

  return { judgments, strength: strengthOf(judgments), source: 'model' };
}

/** The best clamped strength among rows the model kept. `strengthOfJudgments` in ./portable.ts. */
export function strengthOf(judgments: ReadonlyMap<string, Judgment>): number {
  return strengthOfJudgments([...judgments.values()]);
}

/** Rows the model called coincidental. `pruneCandidates` in ./portable.ts. */
export function prune(
  candidates: readonly Candidate[],
  judgments: ReadonlyMap<string, Judgment>,
): Candidate[] {
  return pruneCandidates(candidates, [...judgments.values()]);
}

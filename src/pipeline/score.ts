/**
 * Scoring. No model is called from this file, and none ever should be.
 *
 * Everything a reader would be tempted to argue with — is this proven or partial, what is the coverage
 * number, which requirements are gaps — is decided here, in arithmetic, before any prose is written. The
 * model's turn comes after, and by then the outcome is already fixed.
 *
 * That ordering is the whole architecture. A system that asks a model "how well does this candidate fit?"
 * gets an answer shaped by how the question was phrased. A system that computes the answer and asks a
 * model to write it down in a sentence gets an answer shaped by the data.
 */

import type {
  CoverageStatus,
  Evidence,
  Project,
  Requirement,
  RequirementResult,
  Snapshot,
} from '../store/types';
import type { Candidate } from './match';
import {
  coverageOf,
  gapNote,
  resolveRequirement,
  worseOf as worseOfPortable,
  type Resolution as PortableResolution,
} from './portable';

/** At or above this, a well-evidenced match counts as fully covered. */
export const THRESHOLD_PROVEN = 0.7;
/** Below this, nothing matched well enough to claim anything. */
export const THRESHOLD_PARTIAL = 0.45;


export interface ResolvedMatch {
  requirement: Requirement;
  candidates: Candidate[];
  best: number;
  /**
   * The weighed strength from ../pipeline/judge.ts, when a model ran. (DESIGN.md §v3.8)
   *
   * Absent on the deterministic path, and absent is not zero — a requirement nobody weighed is decided
   * exactly as it was before weighing existed. Present, it is an ADDITIONAL condition on `proven` and
   * nothing else: it cannot create a gap, and it cannot lift one. Retrieval still decides whether
   * anything matched at all, which is why no reply from a model can conjure coverage out of a record
   * that does not contain it.
   */
  strength?: number;
}

export interface Resolution {
  status: CoverageStatus;
  matchedTechnologies: string[];
  matchedCapabilities: string[];
  matchedProjects: string[];
  evidence: string[];
  /** Why the status is not `proven`, in plain words. Null when it is. */
  shortfall: string | null;
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Turn a ranked candidate list into a status, plus every id a reader can click through to.
 *
 * The evidence gate lives here. A capability with nothing in its `evidence` array is a claim with no
 * receipt, and this function refuses to let one score as proven no matter how cleanly it matched. That
 * single rule is what stops the record drifting into a resume: adding a capability row is easy, and it
 * buys you nothing until you also link something a stranger can check.
 */
export function resolve(input: ResolvedMatch, snapshot: Snapshot): Resolution {
  // The arithmetic is `resolveRequirement` in ./portable.ts — the definition the n8n Code node is
  // generated from. The workflow used to reimplement all of this by hand.
  return resolveRequirement(
    input.candidates,
    input.best,
    snapshot,
    { thresholdProven: THRESHOLD_PROVEN, thresholdPartial: THRESHOLD_PARTIAL },
    input.strength,
  ) as Resolution;
}

/**
 * Keep whichever resolution came out worse. The rule is `worseOf` in ./portable.ts; DESIGN.md §v3.8 has
 * the reasoning, and CLAUDE.md lists it as a non-negotiable. It held in the app lane only until the
 * workflow gained a weighing pass of its own.
 */
export function worseOf(deterministic: Resolution, weighed: Resolution): Resolution {
  return worseOfPortable(deterministic as PortableResolution, weighed as PortableResolution) as Resolution;
}

export interface Coverage {
  /** 0..100. */
  score: number;
  proven: number;
  partial: number;
  gap: number;
  requiredCovered: number;
  requiredTotal: number;
}

/**
 * Weighted coverage across the whole posting.
 *
 * Weighted rather than a plain count, because a posting that lists three must-haves and eleven
 * nice-to-haves should not score 79% for missing every must-have. Partial credit is real credit at half
 * value — pretending a partial is a zero would understate as badly as counting it as a pass overstates.
 */
export function coverage(requirements: readonly Requirement[], results: readonly RequirementResult[]): Coverage {
  const status = new Map(results.map((r) => [r.requirementId, r.status]));
  // The arithmetic — the weights, the half-credit for partial — is `coverageOf` in ./portable.ts, the
  // same definition the n8n Code node is generated from. A requirement nobody scored counts as a gap.
  const totals = coverageOf(
    requirements.map((req) => ({ kind: req.kind, status: status.get(req.id) ?? 'gap' })),
  );

  return {
    score: totals.score,
    proven: totals.proven,
    partial: totals.partial,
    gap: totals.gap,
    requiredCovered: totals.requiredCovered,
    requiredTotal: totals.requiredTotal,
  };
}

export interface Gap {
  requirement: Requirement;
  status: Exclude<CoverageStatus, 'proven'>;
  /** The best thing in the record, even when it did not clear the bar. Null when nothing came close. */
  closestEvidence: { label: string; value: string; url: string | null } | null;
  /** The honest sentence, assembled from the shortfall reason and the closest thing on file. */
  note: string;
}

/**
 * The Gaps section.
 *
 * This exists because a scoring system that only reports its hits is a flattery generator, and a reader
 * can tell. Every requirement that did not come out proven is listed with the closest real thing on file
 * and a sentence saying what is missing. When the closest evidence is this project itself, it says so.
 */
export function gaps(
  requirements: readonly Requirement[],
  results: readonly RequirementResult[],
  resolutions: ReadonlyMap<string, Resolution>,
  snapshot: Snapshot,
): Gap[] {
  const evidenceIndex = byId(snapshot.evidence);
  const projectIndex = byId(snapshot.projects);
  const reqIndex = byId(requirements as Requirement[]);
  const out: Gap[] = [];

  for (const result of results) {
    if (result.status === 'proven') continue;
    const requirement = reqIndex.get(result.requirementId);
    if (!requirement) continue;

    const resolution = resolutions.get(result.requirementId);
    const closestId = result.evidence[0];
    const closest = closestId ? evidenceIndex.get(closestId) : undefined;

    const closestEvidence = closest
      ? { label: closest.label, value: closest.value, url: closest.url }
      : null;

    out.push({
      requirement,
      status: result.status,
      closestEvidence,
      // The sentence is `gapNote` in ./portable.ts — the same definition the n8n Code node is
      // generated from, which until now wrote a shorter note than this lane did.
      note: gapNote(
        resolution?.shortfall ?? null,
        result.matchedProjects.map((id) => projectIndex.get(id)?.name ?? id),
      ),
    });
  }

  // Required gaps first, then required partials, then the preferred ones. A reader scanning this section
  // should hit the things that would actually disqualify before the things that would not.
  const rank = (g: Gap): number =>
    (g.requirement.kind === 'required' ? 0 : 2) + (g.status === 'gap' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Evidence rows reachable from a project, for the report's citation list. */
export function evidenceFor(project: Project, snapshot: Snapshot): Evidence[] {
  const index = byId(snapshot.evidence);
  return project.evidence.map((id) => index.get(id)).filter(Boolean) as Evidence[];
}

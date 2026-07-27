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
  Capability,
  CoverageStatus,
  Evidence,
  Project,
  Requirement,
  RequirementResult,
  Snapshot,
} from '../store/types';
import type { Candidate } from './match';

/** At or above this, a well-evidenced match counts as fully covered. */
export const THRESHOLD_PROVEN = 0.7;
/** Below this, nothing matched well enough to claim anything. */
export const THRESHOLD_PARTIAL = 0.45;

/** How many projects a single requirement may cite. See `resolve` for why this is capped. */
const MAX_CITED_PROJECTS = 3;

/** A required item is worth twice a preferred one. Preferred items still move the number. */
const WEIGHT = { required: 1, preferred: 0.5 } as const;
const VALUE: Record<CoverageStatus, number> = { proven: 1, partial: 0.5, gap: 0 };

export interface ResolvedMatch {
  requirement: Requirement;
  candidates: Candidate[];
  best: number;
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
  const techIndex = byId(snapshot.technologies);
  const capIndex = byId(snapshot.capabilities);
  const projectIndex = byId(snapshot.projects);

  const matchedTechnologies = input.candidates.filter((c) => c.kind === 'technology').map((c) => c.id);
  const matchedCapabilities = input.candidates.filter((c) => c.kind === 'capability').map((c) => c.id);

  const caps = matchedCapabilities.map((id) => capIndex.get(id)).filter(Boolean) as Capability[];

  /**
   * Projects are derived, never matched directly — a project is relevant because something in it is.
   *
   * Ranked by how many of the matched rows each project actually contains, then cut to three. A common
   * technology like React legitimately touches every project, and citing all of them produces a list of
   * twenty-six receipts that nobody reads and nobody trusts. Three strongest is a citation; everything
   * is a data dump.
   */
  const hits = new Map<string, number>();
  const credit = (projectIds: readonly string[]): void => {
    for (const id of projectIds) {
      if (projectIndex.get(id)?.reviewStatus !== 'ok') continue; // parked records prove nothing yet
      hits.set(id, (hits.get(id) ?? 0) + 1);
    }
  };
  for (const id of matchedTechnologies) credit(techIndex.get(id)?.projects ?? []);
  for (const cap of caps) credit(cap.projects);

  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const matchedProjects = ranked.slice(0, MAX_CITED_PROJECTS).map(([id]) => id);

  // Capability evidence is never trimmed: it is the most specific receipt available, and it is the one
  // the evidence gate below is actually asking about.
  const evidenceIds = new Set<string>();
  for (const cap of caps) {
    for (const e of cap.evidence) evidenceIds.add(e);
  }
  for (const id of matchedProjects) {
    for (const e of projectIndex.get(id)?.evidence ?? []) evidenceIds.add(e);
  }
  const evidence = [...evidenceIds];

  if (input.best < THRESHOLD_PARTIAL) {
    return {
      status: 'gap',
      matchedTechnologies,
      matchedCapabilities,
      matchedProjects,
      evidence,
      shortfall: 'nothing in the record matches this closely enough to claim',
    };
  }

  /**
   * The gate reads the capability that actually matched, not all of them.
   *
   * This was `every` and it was wrong. A posting bullet that named a stretch capability alongside any
   * incidentally-matched proven one was promoted to `proven` and then dropped out of the Gaps section
   * entirely, which is the precise over-claim this file exists to prevent. `some` is wrong in the other
   * direction: one incidental stretch row would drag down a requirement that is genuinely covered.
   *
   * So it reads the top-scoring capabilities, and any tie at that score counts. If the best match for a
   * requirement is ambiguous between a proven row and a stretch row, the honest answer is partial.
   */
  const bestCapScore = Math.max(
    0,
    ...input.candidates.filter((c) => c.kind === 'capability').map((c) => c.score),
  );
  const decisive = input.candidates
    .filter((c) => c.kind === 'capability' && c.score >= bestCapScore)
    .map((c) => capIndex.get(c.id))
    .filter(Boolean) as Capability[];

  const belowProven = input.best < THRESHOLD_PROVEN;
  const noEvidence = evidence.length === 0;
  const allStretch = decisive.length > 0 && decisive.some((c) => c.tier === 'stretch');
  const capsUnevidenced = decisive.length > 0 && decisive.some((c) => c.evidence.length === 0);

  if (belowProven || noEvidence || allStretch || capsUnevidenced) {
    const reason = belowProven
      ? 'matched, but not closely enough to call it a direct hit'
      : noEvidence
        ? 'matched, but nothing verifiable is linked to it'
        : allStretch
          ? 'the matching capability is recorded as a stretch, not as shipped work'
          : 'the matching capability has no evidence linked, so it reads as unverified';
    return {
      status: 'partial',
      matchedTechnologies,
      matchedCapabilities,
      matchedProjects,
      evidence,
      shortfall: reason,
    };
  }

  return {
    status: 'proven',
    matchedTechnologies,
    matchedCapabilities,
    matchedProjects,
    evidence,
    shortfall: null,
  };
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
  let earned = 0;
  let possible = 0;
  const tally: Record<CoverageStatus, number> = { proven: 0, partial: 0, gap: 0 };
  let requiredCovered = 0;
  let requiredTotal = 0;

  for (const req of requirements) {
    const s = status.get(req.id) ?? 'gap';
    const w = WEIGHT[req.kind];
    earned += w * VALUE[s];
    possible += w;
    tally[s] += 1;
    if (req.kind === 'required') {
      requiredTotal += 1;
      if (s === 'proven') requiredCovered += 1;
    }
  }

  return {
    score: possible === 0 ? 0 : Math.round((earned / possible) * 100),
    proven: tally.proven,
    partial: tally.partial,
    gap: tally.gap,
    requiredCovered,
    requiredTotal,
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

    const shortfall = resolution?.shortfall ?? 'no match in the record';
    const where =
      result.matchedProjects.length > 0
        ? ` Closest on file: ${result.matchedProjects
            .map((id) => projectIndex.get(id)?.name ?? id)
            .slice(0, 2)
            .join(' and ')}.`
        : '';

    out.push({
      requirement,
      status: result.status,
      closestEvidence,
      note: `${shortfall[0]?.toUpperCase() ?? ''}${shortfall.slice(1)}.${where}`,
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

/**
 * The seven tables.
 *
 * The count is a design constraint, but the rule is legibility, not arithmetic — every table must earn
 * its tab, and structure must never hide inside a long-text field to hold the count down. Results was
 * the test case: it began as escaped JSON on Roles and became the sixth table, because a JSON blob
 * disabled filtering, grouping and Interfaces on the one table holding the output. Candidates is the
 * seventh, for the same reason: a person is real structure, not a property dodging a tab.
 *
 * These types are the contract that the local JSON store and the Airtable adapter both satisfy, and the
 * shape the n8n workflows read and write. Change a field here and you owe an edit in three places:
 * `airtable/schema.ts`, the seed data, and whichever n8n Code node touches it. `pnpm test` says which.
 */

/** Anything the pipeline writes carries the id of the raw blob it came from. No orphan claims. */
export interface Provenance {
  /** Filename under `raw/` that produced this record. */
  source: string;
  /** ISO date the record was written. */
  ingestedAt: string;
}

/**
 * The person a record belongs to. Projects, Capabilities and Evidence are owned per-candidate;
 * Technologies and Roles stay global — React is React for everyone, and a posting is scoreable by
 * anyone. Results rows are candidate × role × requirement.
 */
export interface Candidate {
  /** Slug, e.g. `candidate-joel`. */
  id: string;
  name: string;
  /** As extracted from the source. May be empty. */
  contact: string;
  /** Resume filename, or `seed` for the bundled record. */
  source: string;
  /** ISO date the candidate was written. */
  ingestedAt: string;
  /** Project ids this candidate owns. */
  projects: string[];
  /** Capability ids. */
  capabilities: string[];
  /** Evidence ids. */
  evidence: string[];
}

/**
 * The one candidate the v3.0 seat is wired to. The seed wraps the whole existing record in this
 * candidate, and the pipeline stamps it on everything it writes until the resume intake path lands
 * and candidate ids start arriving from outside.
 */
export const DEFAULT_CANDIDATE_ID = 'candidate-joel';

export type ProjectStatus = 'shipped' | 'live' | 'delivered' | 'in-development';

/**
 * Why a record is parked. `ok` records show in the normal views; anything else lands in Needs Review.
 * The point of the enum is that a failed extraction is *stored*, not dropped — see src/pipeline/validate.ts.
 */
export type ReviewStatus = 'ok' | 'needs-review';

export interface Project extends Provenance {
  id: string;
  /** Candidate id — who owns this row. */
  candidate: string;
  name: string;
  slug: string;
  role: string;
  /** `YYYY-MM`. Kept as a string because a half-known date is honest and `new Date()` is not. */
  started: string;
  ended: string | null;
  status: ProjectStatus;
  summary: string;
  /** Only counts that came out of a real artifact. A metric with no receipt does not belong here. */
  metrics: Partial<Record<'loc' | 'tests' | 'commits' | 'files', number>>;
  /** Technology ids. */
  technologies: string[];
  /** Capability ids. */
  capabilities: string[];
  /** Evidence ids. */
  evidence: string[];
  reviewStatus: ReviewStatus;
  reviewReason: string | null;
}

export type TechnologyCategory =
  | 'language'
  | 'framework'
  | 'cloud'
  | 'data'
  | 'automation'
  | 'ai'
  | 'payments'
  | 'tooling';

export interface Technology {
  id: string;
  name: string;
  /**
   * Every spelling a job description might use. This is the whole reason lexical matching works at all:
   * a posting says "Zapier and/or n8n", "React.js", "AWS Lambda" — and the alias list is data, so
   * widening it is a row edit rather than a code change.
   */
  aliases: string[];
  category: TechnologyCategory;
  /** Project ids. Airtable maintains this side of the link automatically; the local store does it in code. */
  projects: string[];
}

/**
 * `proven` means it has shipped in something real. `stretch` means it is defensible but thin.
 *
 * A stretch capability can never be reported as full coverage no matter how well it matches — see
 * src/pipeline/score.ts. That rule is the difference between a capability record and a resume bullet.
 */
export type CapabilityTier = 'proven' | 'stretch';

export interface Capability {
  id: string;
  /** Candidate id — who owns this claim. */
  candidate: string;
  name: string;
  /** One line, written to be read aloud in a fit report. */
  statement: string;
  tier: CapabilityTier;
  /** Phrasings a JD is likely to use for this capability. Same role as Technology.aliases. */
  matchTerms: string[];
  projects: string[];
  /**
   * Evidence ids. An empty array is meaningful and is the best idea in this schema: a capability with
   * nothing linked is rendered as unverified and is capped at partial credit, so the record cannot
   * quietly inflate itself. See src/pipeline/score.ts and tests/evidence-gate.test.ts.
   */
  evidence: string[];
}

export type EvidenceKind =
  | 'store-listing'
  | 'live-url'
  | 'test-count'
  | 'repo-metric'
  | 'infra-metric'
  | 'video'
  | 'certification'
  | 'client-review'
  | 'artifact';

export interface Evidence {
  id: string;
  /** Candidate id — whose receipt this is. */
  candidate: string;
  label: string;
  kind: EvidenceKind;
  /** The receipt itself: an id, a count, a URL, a rating. */
  value: string;
  url: string | null;
  /** ISO date someone last confirmed this by looking at the thing. */
  verifiedOn: string;
  projects: string[];
}

export type RequirementKind = 'required' | 'preferred';

export type RequirementCategory =
  | 'frontend'
  | 'backend'
  | 'automation'
  | 'ai'
  | 'data'
  | 'cloud'
  | 'process'
  | 'domain';

export interface Requirement {
  id: string;
  text: string;
  kind: RequirementKind;
  category: RequirementCategory;
}

export type CoverageStatus = 'proven' | 'partial' | 'gap';

/** One row of the fit report. Everything here except `rationale` is computed in code. */
export interface RequirementResult {
  requirementId: string;
  /** Candidate id — a Results row is candidate × role × requirement, keyed `{candidate}-{role}-req-N`. */
  candidate: string;
  /** Denormalised so a Results row is readable on its own in Airtable, without following the link. */
  requirementText: string;
  kind: RequirementKind;
  category: RequirementCategory;
  status: CoverageStatus;
  /** Why this is not `proven`, in plain words. Null when it is. Drives the Gaps view. */
  shortfall: string | null;
  /** 0..1, from src/pipeline/match.ts. Deterministic given the same store and the same requirement. */
  score: number;
  matchedTechnologies: string[];
  matchedCapabilities: string[];
  matchedProjects: string[];
  /** Evidence ids reachable from whatever matched. Empty is why a strong match still lands on partial. */
  evidence: string[];
  /** The only field a language model is allowed to write, and only from the records above. */
  rationale: string;
  /** How the rationale got written, so a reader can tell prose from arithmetic. */
  rationaleSource: 'model' | 'template';
}

export interface Role extends Provenance {
  id: string;
  title: string;
  company: string;
  /** The pasted job description, kept verbatim so a result can always be re-derived. */
  postedText: string;
  requirements: Requirement[];
  results: RequirementResult[];
  /** 0..100, computed in src/pipeline/score.ts. Never produced by a model. */
  score: number;
  matchedAt: string;
  /** Which model wrote the rationales, or `none` on the deterministic path. */
  model: string;
}

/** Everything a store holds. The Airtable adapter maps this 1:1 onto seven tables. */
export interface Snapshot {
  candidates: Candidate[];
  projects: Project[];
  technologies: Technology[];
  capabilities: Capability[];
  evidence: Evidence[];
  roles: Role[];
}

/**
 * Deleting the seeded candidate, refused.
 *
 * Typed rather than a bare Error because two callers need to tell this apart from a genuine failure:
 * the server answers 403 on it, and the UI never renders a control that can raise it. The guard lives
 * in the STORE, not only in those two places — an API someone can curl around the UI is not guarded.
 */
export class ProtectedCandidateError extends Error {
  constructor(readonly candidateId: string) {
    super(
      `${candidateId} is the seeded applicant — the worked example the product ships with — and cannot be deleted`,
    );
    this.name = 'ProtectedCandidateError';
  }
}

/** Deleting someone the store does not have. Distinct from the refusal above: a 404, not a 403. */
export class UnknownCandidateError extends Error {
  constructor(readonly candidateId: string) {
    super(`no applicant on file with id ${candidateId}`);
    this.name = 'UnknownCandidateError';
  }
}

/**
 * Everything one candidate OWNS, by the v3.2 ownership map — the rows that leave with them.
 *
 * Technologies and Roles are absent on purpose: they are global vocabulary. React is React for
 * everyone and a posting is scoreable by anyone, so deleting an applicant removes their Results rows
 * for a Role and leaves the Role itself standing.
 *
 * One function, four callers (both adapters, the server's counts, the browser lane), because the
 * ownership map is exactly the thing that must not be re-derived slightly differently in each of them.
 */
export interface OwnedRows {
  projects: string[];
  capabilities: string[];
  evidence: string[];
  /** Results row keys, `{candidateKey}-{roleKey}-req-N`, across every role. */
  results: string[];
}

export function ownedRows(snapshot: Snapshot, candidateId: string): OwnedRows {
  return {
    projects: snapshot.projects.filter((p) => p.candidate === candidateId).map((p) => p.id),
    capabilities: snapshot.capabilities.filter((c) => c.candidate === candidateId).map((c) => c.id),
    evidence: snapshot.evidence.filter((e) => e.candidate === candidateId).map((e) => e.id),
    results: snapshot.roles.flatMap((role) =>
      role.results
        .filter((r) => r.candidate === candidateId)
        .map((r) => `${r.candidate}-${role.id}-${r.requirementId}`),
    ),
  };
}

/** What a delete removed, in the words the roster reports it in. */
export interface DeletionCounts {
  projects: number;
  claims: number;
  evidence: number;
  /** Results rows — one per scored requirement, across every posting this candidate was scored on. */
  results: number;
}

export function deletionCounts(snapshot: Snapshot, candidateId: string): DeletionCounts {
  const owned = ownedRows(snapshot, candidateId);
  return {
    projects: owned.projects.length,
    claims: owned.capabilities.length,
    evidence: owned.evidence.length,
    results: owned.results.length,
  };
}

export interface Store {
  read(): Promise<Snapshot>;
  upsertCandidate(candidate: Candidate): Promise<void>;
  upsertProject(project: Project): Promise<void>;
  upsertEvidence(evidence: Evidence): Promise<void>;
  /**
   * Rows the pipeline invented because the taxonomy did not have them yet. These must be written before
   * the links that reference them, or the link resolves to nothing and the new row is orphaned — which
   * on the Airtable side means the record id does not exist and the field silently comes back empty.
   */
  upsertTechnology(technology: Technology): Promise<void>;
  upsertCapability(capability: Capability): Promise<void>;
  linkTechnologies(projectId: string, technologyIds: string[]): Promise<void>;
  linkCapabilities(projectId: string, capabilityIds: string[]): Promise<void>;
  saveRole(role: Role): Promise<void>;
  /**
   * Remove one candidate and everything they own — Projects, Capabilities, Evidence, and their Results
   * rows on every posting. Technologies and Roles survive: see `ownedRows` above.
   *
   * Throws `ProtectedCandidateError` for `DEFAULT_CANDIDATE_ID` and `UnknownCandidateError` for an id
   * the store does not have. Returns nothing — a caller who wants counts reads them off the snapshot
   * with `deletionCounts` BEFORE calling, which keeps one shape of truth for both adapters.
   */
  deleteCandidate(candidateId: string): Promise<void>;
  /** Human-readable name of the backing store, shown in the UI header. */
  readonly label: string;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  candidates: [],
  projects: [],
  technologies: [],
  capabilities: [],
  evidence: [],
  roles: [],
};

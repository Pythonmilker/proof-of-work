/**
 * The six tables.
 *
 * The count is a design constraint, but the rule is legibility, not arithmetic — every table must earn
 * its tab, and structure must never hide inside a long-text field to hold the count down. Results was
 * the test case: it began as escaped JSON on Roles and became the sixth table, because a JSON blob
 * disabled filtering, grouping and Interfaces on the one table holding the output.
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

export type ProjectStatus = 'shipped' | 'live' | 'delivered' | 'in-development';

/**
 * Why a record is parked. `ok` records show in the normal views; anything else lands in Needs Review.
 * The point of the enum is that a failed extraction is *stored*, not dropped — see src/pipeline/validate.ts.
 */
export type ReviewStatus = 'ok' | 'needs-review';

export interface Project extends Provenance {
  id: string;
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

/** Everything a store holds. The Airtable adapter maps this 1:1 onto six tables. */
export interface Snapshot {
  projects: Project[];
  technologies: Technology[];
  capabilities: Capability[];
  evidence: Evidence[];
  roles: Role[];
}

export interface Store {
  read(): Promise<Snapshot>;
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
  /** Human-readable name of the backing store, shown in the UI header. */
  readonly label: string;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  projects: [],
  technologies: [],
  capabilities: [],
  evidence: [],
  roles: [],
};

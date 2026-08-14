/**
 * Connecting an extraction to the taxonomy, and noticing when we have seen it before.
 *
 * Extraction returns loose strings — "React 19", "AWS Lambda", "structured output". The tables hold rows
 * with ids. This is where one becomes the other, and where a second ingest of the same project updates
 * the existing row instead of creating a near-duplicate that quietly splits its evidence in two.
 */

import { DEFAULT_CANDIDATE_ID, type Capability, type Project, type Snapshot, type Technology } from '../store/types';
import { duplicateProjectOf, matchCapabilityRow, matchTechnologyRow, normalize } from './portable';
import { slugify } from './validate';

export interface LinkOutcome<T> {
  /** Ids of existing rows this extraction matched. */
  existing: string[];
  /** Rows that did not exist and were created. */
  created: T[];
}

/**
 * Match a loose stack string to a Technology row.
 *
 * Two directions, and both are needed. The extraction may say "React 19" where the row is "React"
 * (the row name appears inside the extracted string), or it may say "Lambda" where the row is
 * "AWS Lambda" (the extracted string appears inside an alias). Checking only one direction misses
 * roughly half of real inputs.
 */
function findTechnology(technologies: readonly Technology[], raw: string): Technology | undefined {
  const needle = normalize(raw);
  if (!needle) return undefined;
  // The rule is `matchTechnologyRow` in ./portable.ts — the definition the n8n Code node is generated
  // from. That node matched by exact equality only, so half of what the extraction prompt asks for
  // resolved here and went unresolved there.
  return matchTechnologyRow(raw, technologies);
}

/**
 * Unmatched technologies become new rows rather than being dropped.
 *
 * A pipeline that silently discards anything not already in its taxonomy stops learning the moment it
 * ships, and the omission is invisible — the report simply never mentions the thing. New rows are
 * created with a single alias and a generic category, and the ingest result reports them so a human can
 * file them properly later.
 */
export function linkTechnologies(
  snapshot: Snapshot,
  stack: readonly string[],
): LinkOutcome<Technology> {
  const existing: string[] = [];
  const created: Technology[] = [];
  const pool = [...snapshot.technologies];

  for (const raw of stack) {
    const hit = findTechnology(pool, raw);
    if (hit) {
      if (!existing.includes(hit.id)) existing.push(hit.id);
      continue;
    }
    const id = slugify(raw);
    if (!id || existing.includes(id) || created.some((c) => c.id === id)) continue;
    const row: Technology = {
      id,
      name: raw,
      aliases: [raw.toLowerCase()],
      category: 'tooling',
      projects: [],
    };
    created.push(row);
    pool.push(row);
    existing.push(id);
  }

  return { existing, created };
}

/** Capability phrasing varies far more than technology names, so this leans on overlap, not equality. */
function findCapability(capabilities: readonly Capability[], raw: string): Capability | undefined {
  const needle = normalize(raw);
  if (!needle) return undefined;

  // The rule is `matchCapabilityRow` in ./portable.ts, generated into the extract workflow's
  // 'Resolve taxonomy' node, which previously ran neither the overlap pass nor anything but equality.
  return matchCapabilityRow(raw, capabilities);
}

/**
 * Capabilities created by ingest start as `stretch` with no evidence, and that is the point.
 *
 * A model reading a README will happily assert that the project demonstrates "scalable architecture".
 * Letting that arrive as a proven, evidenced capability would make the record worthless. It arrives
 * unverified instead, shows up that way in the Capabilities view, and stays there until a person links
 * something checkable to it.
 */
export function linkCapabilities(
  snapshot: Snapshot,
  claims: readonly string[],
  candidateId: string = DEFAULT_CANDIDATE_ID,
): LinkOutcome<Capability> {
  const existing: string[] = [];
  const created: Capability[] = [];
  const pool = [...snapshot.capabilities];

  // Ids for the seed candidate stay plain slugs (every existing row and test knows them). Any other
  // candidate gets candidate-scoped ids — the same convention ingestResume uses, and for the same
  // reason: two people making the same claim must never share a row.
  const idFor = (raw: string) =>
    candidateId === DEFAULT_CANDIDATE_ID
      ? slugify(raw)
      : `cap-${candidateId.replace(/^candidate-/, '')}-${slugify(raw).slice(0, 64)}`.replace(/-+$/, '');

  for (const raw of claims) {
    const hit = findCapability(pool, raw);
    if (hit) {
      if (!existing.includes(hit.id)) existing.push(hit.id);
      continue;
    }
    if (!slugify(raw)) continue;
    const id = idFor(raw);
    if (!id || existing.includes(id) || created.some((c) => c.id === id)) continue;
    const row: Capability = {
      id,
      candidate: candidateId,
      name: raw,
      statement: raw,
      tier: 'stretch',
      matchTerms: [raw.toLowerCase()],
      projects: [],
      evidence: [],
    };
    created.push(row);
    pool.push(row);
    existing.push(id);
  }

  return { existing, created };
}

export interface DuplicateVerdict {
  duplicate: Project | null;
  /** How the match was made, for the ingest result line. */
  reason: string | null;
}

/**
 * Have we ingested this project before?
 *
 * Slug equality catches the same source pasted twice. Name overlap catches "Tendril" against
 * "Tendril — agent-first IDE", which is what actually happens when the same project is described by two
 * different artifacts. Getting this wrong in the permissive direction merges two real projects; getting
 * it wrong in the strict direction splits one project's evidence across two rows, and the second is the
 * failure that makes a capability look unverified when it is not.
 */
export function findDuplicate(snapshot: Snapshot, candidateName: string): DuplicateVerdict {
  // The rule is `duplicateProjectOf` in ./portable.ts. The n8n lane carried only the slug arm, so
  // "Tendril — agent-first IDE" merged here and created a second row there.
  return duplicateProjectOf(snapshot.projects, candidateName) as DuplicateVerdict;
}

/** Merge a fresh extraction into a row we already had, preferring newly-supplied concrete values. */
export function mergeProject(existing: Project, incoming: Project): Project {
  return {
    ...existing,
    summary: incoming.summary || existing.summary,
    role: incoming.role || existing.role,
    started: incoming.started || existing.started,
    ended: incoming.ended ?? existing.ended,
    status: incoming.status,
    metrics: { ...existing.metrics, ...incoming.metrics },
    technologies: [...new Set([...existing.technologies, ...incoming.technologies])],
    capabilities: [...new Set([...existing.capabilities, ...incoming.capabilities])],
    evidence: [...new Set([...existing.evidence, ...incoming.evidence])],
    source: incoming.source,
    ingestedAt: incoming.ingestedAt,
  };
}

/**
 * Connecting an extraction to the taxonomy, and noticing when we have seen it before.
 *
 * Extraction returns loose strings — "React 19", "AWS Lambda", "structured output". The tables hold rows
 * with ids. This is where one becomes the other, and where a second ingest of the same project updates
 * the existing row instead of creating a near-duplicate that quietly splits its evidence in two.
 */

import { DEFAULT_CANDIDATE_ID, type Capability, type Project, type Snapshot, type Technology } from '../store/types';
import { containsTerm, normalize, overlap } from './text';
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

  for (const tech of technologies) {
    for (const alias of [tech.name, ...tech.aliases]) {
      const a = normalize(alias);
      if (a === needle) return tech;
    }
  }
  for (const tech of technologies) {
    for (const alias of [tech.name, ...tech.aliases]) {
      if (containsTerm(needle, alias)) return tech;
    }
  }
  return undefined;
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

  for (const cap of capabilities) {
    for (const term of [cap.name, ...cap.matchTerms]) {
      if (normalize(term) === needle) return cap;
    }
  }

  let best: { cap: Capability; score: number } | undefined;
  for (const cap of capabilities) {
    const score = Math.max(
      overlap(raw, cap.name),
      ...cap.matchTerms.map((t) => overlap(raw, t)),
    );
    if (score >= 0.6 && (!best || score > best.score)) best = { cap, score };
  }
  return best?.cap;
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
): LinkOutcome<Capability> {
  const existing: string[] = [];
  const created: Capability[] = [];
  const pool = [...snapshot.capabilities];

  for (const raw of claims) {
    const hit = findCapability(pool, raw);
    if (hit) {
      if (!existing.includes(hit.id)) existing.push(hit.id);
      continue;
    }
    const id = slugify(raw);
    if (!id || existing.includes(id) || created.some((c) => c.id === id)) continue;
    const row: Capability = {
      id,
      candidate: DEFAULT_CANDIDATE_ID,
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
  const slug = slugify(candidateName);

  for (const project of snapshot.projects) {
    if (project.slug === slug) return { duplicate: project, reason: 'same slug' };
  }
  for (const project of snapshot.projects) {
    if (project.reviewStatus !== 'ok') continue;
    if (overlap(candidateName, project.name) >= 0.8) {
      return { duplicate: project, reason: `name overlaps "${project.name}"` };
    }
  }
  return { duplicate: null, reason: null };
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

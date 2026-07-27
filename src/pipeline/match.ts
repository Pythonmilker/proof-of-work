/**
 * Retrieval: given one requirement, which rows in the store are relevant?
 *
 * This module is the reason the demo can claim it structurally cannot invent experience. It never
 * generates anything. It ranks rows that already exist and returns their ids. If a technology is not in
 * the Technologies table, no amount of confident phrasing downstream can put it in the report — the
 * rationale writer is handed ids, and it can only describe what it was given.
 *
 * Hybrid on purpose. Job descriptions name technologies literally ("React", "Airtable", "n8n"), which is
 * exactly what lexical matching is good at and what embeddings are wasteful for. They also describe
 * capabilities in prose ("build internal tools that connect our systems"), which lexical matching cannot
 * reach. Running both and taking the better score gets each one's strength without either one's blind spot.
 */

import { cosine, normalizeCosine, type Vector } from '../openrouter/embeddings';
import type { Capability, Requirement, Snapshot, Technology } from '../store/types';
import { containsTerm, normalize, overlap } from './text';

export type MatchVia = 'lexical' | 'dense' | 'both';

export interface Candidate {
  kind: 'technology' | 'capability';
  id: string;
  name: string;
  score: number;
  via: MatchVia;
}

export interface MatchInput {
  requirement: Requirement;
  snapshot: Snapshot;
  /** Present only when an OpenRouter key produced them. Keyed by `technology:<id>` / `capability:<id>`. */
  vectors?: Map<string, Vector>;
  /** The requirement's own vector, when embeddings ran. */
  requirementVector?: Vector;
}

export interface MatchOutput {
  candidates: Candidate[];
  best: number;
  /** Which retrieval modes actually contributed, for the report's method line. */
  modes: MatchVia[];
}

/**
 * A dense-only hit is never allowed to outrank an exact name hit.
 *
 * Without this, a requirement saying "React" can score a semantically-adjacent capability above the
 * React technology row, and the citation then points somewhere confusing. The penalty is small because
 * dense retrieval is doing real work — it just does not get to win ties against a literal name.
 */
const DENSE_CEILING = 0.95;

/** Text an entity is embedded as. Name plus its own words — never a project's words, which would leak. */
export function embedTextFor(entity: Technology | Capability): string {
  if ('aliases' in entity) {
    return [entity.name, ...entity.aliases].join(', ');
  }
  return [entity.name, entity.statement, ...entity.matchTerms].join('. ');
}

export function vectorKey(kind: 'technology' | 'capability', id: string): string {
  return `${kind}:${id}`;
}

function lexicalScoreForTechnology(haystack: string, tech: Technology): number {
  for (const alias of [tech.name, ...tech.aliases]) {
    if (containsTerm(haystack, alias)) return 1;
  }
  return 0;
}

function lexicalScoreForCapability(requirementText: string, haystack: string, cap: Capability): number {
  for (const term of [cap.name, ...cap.matchTerms]) {
    if (containsTerm(haystack, term)) return 1;
  }
  // No literal hit. Fall back to token overlap against the capability's own statement, which is what
  // catches a JD that describes the capability instead of naming it.
  const phrase = Math.max(overlap(requirementText, cap.name), overlap(requirementText, cap.statement));
  return phrase >= 0.5 ? 0.6 + (phrase - 0.5) * 0.6 : 0;
}

export function match(input: MatchInput): MatchOutput {
  const { requirement, snapshot, vectors, requirementVector } = input;
  const haystack = normalize(requirement.text);
  const dense = Boolean(vectors && requirementVector && requirementVector.length > 0);

  const candidates: Candidate[] = [];
  const modes = new Set<MatchVia>();

  const consider = (
    kind: 'technology' | 'capability',
    id: string,
    name: string,
    lexical: number,
  ): void => {
    let denseScore = 0;
    if (dense) {
      const vec = vectors?.get(vectorKey(kind, id));
      if (vec && vec.length > 0) {
        denseScore = normalizeCosine(cosine(requirementVector as Vector, vec)) * DENSE_CEILING;
      }
    }

    const score = Math.max(lexical, denseScore);
    if (score <= 0) return;

    const via: MatchVia =
      lexical > 0 && denseScore > 0 ? 'both' : lexical > 0 ? 'lexical' : 'dense';
    modes.add(via === 'both' ? 'both' : via);
    candidates.push({ kind, id, name, score, via });
  };

  for (const tech of snapshot.technologies) {
    consider('technology', tech.id, tech.name, lexicalScoreForTechnology(haystack, tech));
  }
  for (const cap of snapshot.capabilities) {
    consider('capability', cap.id, cap.name, lexicalScoreForCapability(requirement.text, haystack, cap));
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    candidates,
    best: candidates[0]?.score ?? 0,
    modes: [...modes],
  };
}

/**
 * Keep the winners and drop the long tail.
 *
 * A requirement that matches eleven things has not really matched eleven things — it has matched two,
 * and nine rows scored above zero because they share a word. Anything more than `DELTA` below the best
 * score is noise in the citation list, and a citation list nobody trusts is worse than a short one.
 */
const DELTA = 0.2;
const MAX_CITED = 4;

export function topCandidates(out: MatchOutput): Candidate[] {
  if (out.candidates.length === 0) return [];
  const floor = out.best - DELTA;
  return out.candidates.filter((c) => c.score >= floor).slice(0, MAX_CITED);
}

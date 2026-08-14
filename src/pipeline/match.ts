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

import { type Vector } from '../openrouter/embeddings';
import type { Capability, Requirement, Snapshot, Technology } from '../store/types';
import {
  lexicalCapabilityScore,
  lexicalTechnologyScore,
  normalize,
  topCited,
  denseScore,
  embedTextForRow,
} from './portable';

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


/** Text an entity is embedded as. Name plus its own words — never a project's words, which would leak. */
/** The string a row is embedded as. The rule is `embedTextForRow` in ./portable.ts. */
export function embedTextFor(entity: Technology | Capability): string {
  return embedTextForRow(entity);
}

export function vectorKey(kind: 'technology' | 'capability', id: string): string {
  return `${kind}:${id}`;
}

/*
 * The two lexical scorers are `lexicalTechnologyScore` and `lexicalCapabilityScore` in ./portable.ts,
 * alongside the citation trim — the definitions the n8n Code nodes are generated from. They lived here
 * until the workflow was found scoring prose postings lower than the app on identical data, having never
 * carried the capability fallback at all.
 */

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
    let dense_ = 0;
    if (dense) {
      const vec = vectors?.get(vectorKey(kind, id));
      if (vec && vec.length > 0) {
        dense_ = denseScore(requirementVector as Vector, vec);
      }
    }

    const score = Math.max(lexical, dense_);
    if (score <= 0) return;

    const via: MatchVia =
      lexical > 0 && dense_ > 0 ? 'both' : lexical > 0 ? 'lexical' : 'dense';
    modes.add(via === 'both' ? 'both' : via);
    candidates.push({ kind, id, name, score, via });
  };

  for (const tech of snapshot.technologies) {
    consider('technology', tech.id, tech.name, lexicalTechnologyScore(haystack, tech));
  }
  for (const cap of snapshot.capabilities) {
    consider('capability', cap.id, cap.name, lexicalCapabilityScore(requirement.text, haystack, cap));
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    candidates,
    best: candidates[0]?.score ?? 0,
    modes: [...modes],
  };
}

/** Keep the winners, drop the long tail. The rule is `topCited` in ./portable.ts. */
export function topCandidates(out: MatchOutput): Candidate[] {
  return topCited(out.candidates);
}

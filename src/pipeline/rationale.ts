/**
 * The model's only writing job, and the guard that keeps it honest.  (DESIGN.md §6.4)
 *
 * By the time this runs the status is decided, the score is computed, and the evidence is selected. The
 * model is handed a decision and a list of rows and asked to describe them in one sentence. It never
 * sees the store — only what retrieval returned — so it cannot cite a project that did not match, and it
 * cannot move a status it was told.
 *
 * An 8B is the right model here and that is not a cost compromise. Choosing words for a single sentence
 * from facts already chosen is genuinely easy, and the guard below catches the one thing a small model
 * reliably gets wrong: making up a number.
 */

import { callJson, type LlmOptions } from '../openrouter/client';
import { RATIONALE_SCHEMA } from '../openrouter/schemas';
import type { CoverageStatus, Evidence, Project, Requirement, Snapshot } from '../store/types';
import {
  buildRationaleContext,
  checkRationale,
  gradesTheCandidate,
  hasUnsourcedNumber,
  templateRationale as templateFor,
  type RationaleInput,
} from './portable';

export const RATIONALE_SYSTEM = `You write one sentence explaining why a candidate record does or does
not cover a job requirement.

You are given the requirement, a verdict that has already been decided, and the exact records that
matched. Write from those records and nothing else.

Rules:
- One sentence. Two at the absolute most. A hiring manager is scanning, not reading.
- Every number you write must appear in the records you were given. Do not round, do not total, do not
  estimate. If you want to say "hundreds of tests" and the record says 359, write 359.
- Do not name a project, technology, or capability that is not in the records you were given.
- Do not argue with the verdict. If it says partial, explain what is thin, do not talk it up.
- No adjectives about the candidate. "Extensive", "strong", "deep" are all banned — the reader decides
  that from the receipts, and your job is to say what the receipts are.
- Plain sentences. No preamble, no "This requirement is covered because".`;

export interface RationaleContext {
  requirement: Requirement;
  status: CoverageStatus;
  technologies: string[];
  capabilities: string[];
  projects: Project[];
  evidence: Evidence[];
  shortfall: string | null;
}

/**
 * The app's typed context, flattened to the plain shape both lanes share.
 *
 * The store's Requirement/Project/Evidence types stop here. Past this point the rules run on values that
 * survive a JSON round-trip, because in the n8n lane they arrive from one.
 */
function portableForm(ctx: RationaleContext): RationaleInput {
  return {
    requirementText: ctx.requirement.text,
    requirementKind: ctx.requirement.kind,
    status: ctx.status,
    technologies: ctx.technologies,
    capabilities: ctx.capabilities,
    projects: ctx.projects,
    evidence: ctx.evidence,
    shortfall: ctx.shortfall,
  };
}

/** Everything the model may see about one requirement, and the corpus the guard checks numbers against. */
export function buildContext(ctx: RationaleContext): string {
  return buildRationaleContext(portableForm(ctx));
}

/** The deterministic sentence. The rule is `templateRationale` in ./portable.ts. */
export function templateRationale(ctx: RationaleContext): string {
  return templateFor(portableForm(ctx));
}

/*
 * The guard is `checkRationale` in ./portable.ts, with `hasUnsourcedNumber` and `gradesTheCandidate`
 * beneath it — the same definitions the n8n Code nodes are generated from, so a sentence this lane
 * rejects is rejected by the workflow too. They are re-exported here because this is where a reader
 * looks for them and where the tests have always imported them from.
 *
 * Why numbers are the tripwire: a substring check on the facts is not enough on its own, because a model
 * can contradict the data it is summarising while quoting none of it incorrectly. Numbers are where a
 * small model reaches for a total or a rounding, and they are the only claim in a fit report a reader
 * will actually check. A trip discards the whole sentence rather than trying to repair it.
 */
export { gradesTheCandidate, hasUnsourcedNumber };

export interface RationaleOutcome {
  text: string;
  source: 'model' | 'template';
}

/** Generate, guard, and fall back. The caller records which path produced the sentence. */
export async function writeRationale(
  ctx: RationaleContext,
  opts: LlmOptions,
): Promise<RationaleOutcome> {
  const corpus = buildContext(ctx);

  const result = await callJson<{ rationale?: unknown }>(
    {
      tier: 'rationale',
      schemaName: 'rationale',
      schema: RATIONALE_SCHEMA as unknown as Record<string, unknown>,
      system: RATIONALE_SYSTEM,
      user: corpus,
      maxTokens: 160,
      temperature: 0.2,
    },
    opts,
  );

  if (!result.ok) return { text: templateRationale(ctx), source: 'template' };

  const raw = result.value.rationale;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!checkRationale(text, corpus).usable) {
    return { text: templateRationale(ctx), source: 'template' };
  }

  return { text, source: 'model' };
}

/** Assemble the corpus for a whole snapshot, for tests that need a realistic guard corpus. */
export function corpusFor(snapshot: Snapshot): string {
  return [
    ...snapshot.projects.map((p) => `${p.name} ${p.summary} ${Object.values(p.metrics).join(' ')}`),
    ...snapshot.evidence.map((e) => `${e.label} ${e.value}`),
  ].join('\n');
}

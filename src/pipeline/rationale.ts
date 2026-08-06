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
import { numbersIn } from './text';

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

/** Everything the model may see about one requirement, and the corpus the guard checks numbers against. */
export function buildContext(ctx: RationaleContext): string {
  const lines: string[] = [
    `Requirement (${ctx.requirement.kind}): ${ctx.requirement.text}`,
    `Verdict already decided: ${ctx.status}`,
  ];
  if (ctx.shortfall) lines.push(`Why it is not full coverage: ${ctx.shortfall}`);

  if (ctx.technologies.length > 0) lines.push(`Matched technologies: ${ctx.technologies.join(', ')}`);
  if (ctx.capabilities.length > 0) lines.push(`Matched capabilities: ${ctx.capabilities.join(', ')}`);

  for (const project of ctx.projects) {
    const metrics = Object.entries(project.metrics)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    lines.push(
      `Project "${project.name}" (${project.status}${project.started ? `, ${project.started}` : ''})` +
        `${metrics ? ` — ${metrics}` : ''}. ${project.summary}`,
    );
  }

  for (const e of ctx.evidence) {
    lines.push(`Evidence — ${e.label}: ${e.value}${e.url ? ` (${e.url})` : ''}`);
  }

  if (ctx.projects.length === 0 && ctx.evidence.length === 0) {
    lines.push('Nothing in the record matched this requirement.');
  }

  return lines.join('\n');
}

/**
 * Reject a sentence containing a number that is not in the records it was written from.
 *
 * A substring check on the facts is not enough on its own — an earlier project shipped a bug where a
 * model wrote prose that contradicted the data it was summarising while quoting none of it incorrectly.
 * Numbers are where a small model reaches for a total or a rounding, and they are also the only claim in
 * a fit report that a reader will actually check. So numbers are the tripwire, and a trip discards the
 * whole sentence rather than trying to repair it.
 */
export function hasUnsourcedNumber(sentence: string, corpus: string): boolean {
  const allowed = new Set(numbersIn(corpus));
  // Years and small ordinals appear in ordinary phrasing ("the second", "2026") and carry no claim.
  return numbersIn(sentence).some((n) => !allowed.has(n) && Number(n.replace(/,/g, '')) > 12);
}

/**
 * Reject a sentence that grades the candidate instead of citing the record.
 *
 * RATIONALE_SYSTEM has banned these words since it was written, and until 2026-08-05 nothing enforced
 * it — the guard checked numbers only. A live run produced "The candidate has extensive experience
 * with Claude Code", which is the flattery this whole product argues against, written by the one
 * component whose output a reader takes at face value. A rule stated only in a prompt is a preference.
 *
 * Matched on word boundaries, with hyphens treated as part of the word — the same rule `containsTerm`
 * in text.ts had to learn, for the same reason. A bare `\bdeep\b` fires inside "deep-link", and a
 * guard that mangles honest sentences gets switched off, after which it protects nothing. The ban is
 * on grading a person, not on the words existing.
 */
const BANNED_ADJECTIVES = [
  'extensive',
  'strong',
  'deep',
  'expert',
  'expertise',
  'seasoned',
  'proficient',
  'excellent',
  'impressive',
  'exceptional',
  'outstanding',
  'robust',
  'solid',
  'vast',
  'significant',
];

export function gradesTheCandidate(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return BANNED_ADJECTIVES.some((word) => new RegExp(`(?<![\\w-])${word}(?![\\w-])`).test(lower));
}

/** Join a list the way a person would: "a", "a and b", "a, b and c". */
function readable(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The deterministic sentence. Used with no key, and whenever the guard rejects a generated one.
 *
 * It names one thing, not everything. An earlier version led with every matched row and produced
 * "React, React product engineering appears in…", which reads like a machine and buries the fact. The
 * citation panel already lists the full set; this sentence only has to say what and where.
 */
export function templateRationale(ctx: RationaleContext): string {
  if (ctx.status === 'gap') return 'Nothing in the record matches this requirement.';

  const where = readable(ctx.projects.map((p) => p.name)) || 'the record';
  const subject = ctx.technologies[0] ?? ctx.capabilities[0] ?? 'This';
  const receipts = ctx.evidence.length;
  const receiptText =
    receipts === 0 ? 'nothing verifiable linked' : `${receipts} linked receipt${receipts === 1 ? '' : 's'}`;

  if (ctx.status === 'proven') {
    return `${subject} — shipped in ${where}, with ${receiptText}.`;
  }
  return `${subject} appears in ${where} with ${receiptText}, but ${ctx.shortfall ?? 'coverage is partial'}.`;
}

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
  if (!text || text.length > 400 || hasUnsourcedNumber(text, corpus) || gradesTheCandidate(text)) {
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

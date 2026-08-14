/**
 * Stage 4 step 1: a pasted job description becomes a list of requirements.  (DESIGN.md §6.1)
 *
 * Which reader answers is decided by the SHAPE of the posting, and the shape is whichever of the
 * deterministic reader's three passes put the requirements on the table:
 *
 *   pass 1  bulleted       an explicit list                → read in code, no model call
 *   pass 2  unmarked list  lines under a requirement head  → read in code, no model call
 *   pass 3  prose          sentences, no list at all       → read by the model when a key is set
 *
 * A list is read in code because a list parses and the posting's own words survive — the recruiter
 * recognises them, and they anchor matching better than a paraphrase. Prose goes to the model because
 * there is no list for code to read, and sentence heuristics return sentences, not requirements.
 *
 * Every line of that was measured, not assumed.
 *
 * BULLETED. On the real posting this project was built against, the model scored 66 percent over 18
 * paraphrased rows — dropping the React anchor from two bullets, double-counting one prose paragraph,
 * and minting "strong problem-solving skills" as a gap. A fabricated failure, in the report whose whole
 * argument is that its failures are real. Code reads the same posting as 16 verbatim rows, scoring 75.
 *
 * UNMARKED. This is what a LinkedIn paste actually is: the bullet glyphs are not selectable, so they
 * never reach the clipboard while the line breaks do. Measured on the sample posting with every marker
 * stripped, code returned all 16 requirement lines verbatim; the model returned 13 paraphrases, dropped
 * the collaborate, document and sole-engineer bullets outright, invented "experience with low-code
 * platforms", and marked five must-haves preferred on a posting that has no nice-to-have section. Two
 * further unmarked postings repeated it — 12 verbatim rows against 8, and 10 against 12 where the
 * model's extra rows were splits of a single line. So "the posting is not bulleted" was the wrong thing
 * to hand the model. What matters is whether there is a list, not whether someone marked it.
 *
 * PROSE. Here the model earns its keep. On two prose postings, code returned the company introducing
 * itself ("We have been at this for six years and we still ship every week"), read a title line as a
 * requirement, returned whole sentences instead of asks, and silently dropped a 232-character sentence
 * carrying three requirements for being over its length cap. The model returned 11 and 10 clean noun
 * phrases with nothing invented. Prose is the one shape where a paraphrase beats a verbatim read,
 * because there is nothing verbatim to read.
 *
 * The reader has THREE passes, and passes 2 and 3 were added after a measurement rather than a hunch.
 * Only an explicit bullet marker counted as an item, so a typical LinkedIn paste — a heading, then plain
 * unmarked lines — parsed to zero requirements, and so did a prose-only posting. On the hosted static
 * demo there is no key to fall through to, so zero requirements meant a visitor saw "parsed without a
 * model" over an empty report: a dead end in the deployed product.
 *
 * Neither new pass is silent. The outcome's note names the pass whenever it was not the bulleted
 * primary, and a posting that all three passes plus the model fail on raises instead of rendering a
 * blank report.
 */

import { callJson, shortReason, type LlmOptions } from '../openrouter/client';
import { ROLE_PARSE_SCHEMA } from '../openrouter/schemas';
import type { Requirement, RequirementCategory, RequirementKind } from '../store/types';
import {
  parseRoleDeterministically,
  splitList,
  normalize,
  type DeterministicRole,
  type ParsePass,
} from './portable';

export const JD_SYSTEM = `You read a job posting and list what it is actually asking for.

Rules:
- One requirement per entry. If a bullet says "React, TypeScript and REST APIs", that is three entries.
- Rewrite each as a short noun phrase, not a sentence. "React" — not "Experience with React".
- kind: "required" for must-haves. "preferred" for anything marked nice-to-have, bonus, plus, or
  a differentiator. When the posting does not signal either way, use "required".
- Skip anything that is not a capability the candidate could demonstrate: salary, hours, location,
  company blurb, benefits, equal-opportunity boilerplate, "team player", "self-starter".
- Keep the posting's own vocabulary. If it says "no-code tools", do not translate that to "low-code".
- category: pick the closest of frontend, backend, automation, ai, data, cloud, process, domain.
  "domain" is for industry knowledge the work sits inside, not for technical skills.`;

export interface ParsedRole {
  title: string;
  company: string;
  requirements: Requirement[];
}

/** Which of the deterministic reader's three passes put the requirements on the table. */


export interface ParseOutcome {
  role: ParsedRole;
  via: 'model' | 'deterministic';
  model: string;
  note: string | null;
}

/**
 * Every pass failed and so did the model: there is no report to render.
 *
 * Thrown rather than returned as an empty role, because an empty role renders as a fit report with no
 * requirements, a 0 percent score and a Gaps section reading "every requirement came out proven" —
 * output that looks like an answer and is not one. `status` is duck-typed by the dev server's error
 * handler (see vite.config.ts): an unreadable paste is a bad request, not a server fault.
 */
export class UnreadablePostingError extends Error {
  readonly status = 400;

  constructor(detail: string | null) {
    super(
      `No requirements could be read from this posting${detail ? ` (${detail})` : ''}. All three ` +
        `deterministic passes — bulleted list, unmarked list, prose — came back empty, so nothing was ` +
        `scored. Paste the posting's requirements or responsibilities section and run it again.`,
    );
    this.name = 'UnreadablePostingError';
  }
}

const VALID_KIND = new Set<RequirementKind>(['required', 'preferred']);
const VALID_CATEGORY = new Set<RequirementCategory>([
  'frontend',
  'backend',
  'automation',
  'ai',
  'data',
  'cloud',
  'process',
  'domain',
]);


/**
 * The passes whose result is taken as-is, with no model call at all.
 *
 * Both read the posting's own lines: pass 1 off explicit markers, pass 2 off the lines under a
 * requirement heading. Pass 3 is absent on purpose — prose is the shape the model reads better (see the
 * header), so a prose posting falls through rather than being answered from sentence heuristics.
 */
const READ_VERBATIM: ReadonlySet<ParsePass> = new Set<ParsePass>(['bulleted', 'unmarked']);

/**
 * What the reader tells the reviewer when the requirements did not come off a bullet list.
 *
 * Whole sentences, in the reviewer's terms, because these render verbatim in the report. They say
 * what the reader DID, never what it lacked: reading a posting in code is the designed primary path
 * (see the header above), so framing it as a missing model would report the design as a fault.
 * Null is "nothing worth saying".
 */
const PASS_NOTES: Record<ParsePass, string | null> = {
  bulleted: null,
  unmarked: 'This posting has no bulleted list, so its requirements were read from the lines under its headings.',
  prose: 'This posting has no list at all, so its requirements were read from its sentences.',
};

/**
 * What the reader tells the reviewer when the model read the posting.
 *
 * Same rule as PASS_NOTES: a whole sentence, saying what happened. The model running on a prose posting
 * is the designed path rather than a degradation, so this states it plainly instead of apologising for
 * it — and naming the engine matters, because a paraphrased row and a verbatim one are worth different
 * amounts to someone checking the report against the posting they wrote.
 */
const MODEL_PARSED_NOTE =
  'This posting has no list, so its requirements were read by the posting-parsing model rather than in code.';

/**
 * Only a model that was *expected* and failed is a degradation worth naming — which, since the reorder,
 * is every failure that reaches here: the model is now called only on the shape it is the primary for.
 */
function modelUnavailable(reason: string, passNote: string | null): string {
  const base = `The posting-parsing model was unavailable (${reason}), so the posting was read in code instead.`;
  return passNote ? `${base} ${passNote}` : base;
}

export async function parseRole(text: string, opts: LlmOptions): Promise<ParseOutcome> {
  const deterministic = parseRoleDeterministically(text);
  const passNote = deterministic.pass ? PASS_NOTES[deterministic.pass] : null;

  if (deterministic.pass !== null && READ_VERBATIM.has(deterministic.pass)) {
    // The posting is a list, marked or not, so code already has its own words and the model is not
    // consulted. Not a fallback — the designed primary for a posting with a list in it. A bulleted read
    // carries no note; an unmarked one carries one, because the reader had to lean on the headings to
    // know those lines were a list at all.
    return { role: deterministic, via: 'deterministic', model: 'none', note: passNote };
  }

  // Prose, or nothing readable at all. No key means there is no model to reach for, so there is no
  // degradation to report — only what the reader did. The header already states the missing key once;
  // repeating it per run reads as a failure on the hosted demo, where a key is never coming.
  if (!opts.apiKey) {
    if (deterministic.requirements.length === 0) {
      throw new UnreadablePostingError(passNote);
    }
    return { role: deterministic, via: 'deterministic', model: 'none', note: passNote };
  }

  const result = await callJson<unknown>(
    {
      tier: 'jd-parsing',
      schemaName: 'role_parse',
      schema: ROLE_PARSE_SCHEMA as unknown as Record<string, unknown>,
      system: JD_SYSTEM,
      user: text,
      maxTokens: 1200,
      temperature: 0,
    },
    opts,
  );

  if (!result.ok) {
    const note = modelUnavailable(shortReason(result.error.kind), passNote);
    if (deterministic.requirements.length === 0) throw new UnreadablePostingError(note);
    return { role: deterministic, via: 'deterministic', model: 'none', note };
  }

  const parsed = coerceParsedRole(result.value);
  // A model reply with nothing usable in it is worse than no model at all — the deterministic reader
  // would at least have returned what it found.
  if (parsed.requirements.length === 0) {
    const note = modelUnavailable('it returned no requirements', passNote);
    if (deterministic.requirements.length === 0) throw new UnreadablePostingError(note);
    return { role: deterministic, via: 'deterministic', model: 'none', note };
  }

  return { role: parsed, via: 'model', model: result.model, note: MODEL_PARSED_NOTE };
}

/** Re-validate the reply as untrusted input, same as everywhere else. */
export function coerceParsedRole(raw: unknown): ParsedRole {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const title = typeof obj['title'] === 'string' ? obj['title'].trim() : '';
  const company = typeof obj['company'] === 'string' ? obj['company'].trim() : '';

  const requirements: Requirement[] = [];
  const seen = new Set<string>();

  if (Array.isArray(obj['requirements'])) {
    for (const item of obj['requirements'] as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const r = item as Record<string, unknown>;
      const reqText = typeof r['text'] === 'string' ? r['text'].trim() : '';
      if (!reqText) continue;

      const key = normalize(reqText);
      if (seen.has(key)) continue;
      seen.add(key);

      const kind = VALID_KIND.has(r['kind'] as RequirementKind) ? (r['kind'] as RequirementKind) : 'required';
      const category = VALID_CATEGORY.has(r['category'] as RequirementCategory)
        ? (r['category'] as RequirementCategory)
        : 'process';

      requirements.push({ id: `req-${requirements.length + 1}`, text: reqText, kind, category });
    }
  }

  return { title: title || 'Untitled role', company, requirements };
}

export { parseRoleDeterministically, splitList, type DeterministicRole, type ParsePass };

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
import { normalize } from './text';

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
export type ParsePass = 'bulleted' | 'unmarked' | 'prose';

export interface DeterministicRole extends ParsedRole {
  /**
   * The last pass that contributed a requirement, or null when the text yielded nothing at all.
   * Carried out of the reader so the outcome's note can name it — a result read from prose is a
   * weaker read than a result read from a bullet list, and the report has to say which it got.
   */
  pass: ParsePass | null;
}

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
 * How many requirements a pass must find before the reader stops trying the next one.
 *
 * It gates the passes INSIDE the reader, and nothing else. It used to gate the outer decision as well —
 * "found four, so do not call the model" — and that is the ordering this file corrected. Once passes 2
 * and 3 existed, unstructured text cleared the bar on sentence heuristics, so the model stopped running
 * on exactly the input it reads best. What decides now is which pass answered, not how many rows it
 * happened to return.
 */
const STRUCTURED_MINIMUM = 4;

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

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The deterministic reader.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const PREFERRED_MARKERS =
  /\b(preferred|nice[- ]to[- ]have|bonus|a plus|plus if|desirable|ideally|would be great|advantage)\b/i;
const REQUIRED_HEADING = /\b(requirements?|must have|qualifications?|you (?:will )?need|what we need)\b/i;
const PREFERRED_HEADING = /\b(nice to have|bonus|preferred|pluses|extra credit)\b/i;

/**
 * The same heading idea, widened for the passes that have no bullet marker to lean on.
 *
 * Pass 1 keeps the narrow regex untouched: it decides which lines get swallowed as headings instead of
 * read as bullets, and it produces the pinned regression anchor. The widened form is only consulted
 * once the bulleted pass has already come up short, where the cost of missing a heading is the whole
 * section and the cost of over-matching one is a line that was never a bullet anyway.
 */
const REQUIRED_HEADING_WIDE = new RegExp(
  `${REQUIRED_HEADING.source}|\\b(responsibilities|what you(?:'|’)?ll do|what you will do|what we(?:'|’)?re looking for|skills|competencies)\\b`,
  'i',
);

/**
 * Headings that END a requirement section rather than opening one. Without these an "About us" or
 * "Benefits" heading leaves the reader still inside the last list, and the company blurb underneath it
 * becomes requirements.
 */
const CLOSING_HEADING =
  /\b(about|benefits?|perks?|compensation|salary|pay|how to apply|why join|our (?:mission|team|values|story)|equal opportunity|location|hours|schedule|who we are)\b/i;

/** Lines that describe the job rather than the person. Dropping these keeps the report readable. */
const NOISE =
  /\b(salary|compensation|\$\d|per hour|hrs?\/wk|hours per week|equal opportunity|benefits|401k|pto|remote|full[- ]time|part[- ]time|about us|we are a|our mission|apply (?:now|here)|team player|self[- ]starter|fast[- ]paced)\b/i;

const CATEGORY_HINTS: Array<[RegExp, RequirementCategory]> = [
  [/\b(react|vue|angular|next\.?js|frontend|front[- ]end|ui|css|tailwind|typescript|javascript)\b/i, 'frontend'],
  [/\b(node|api|backend|back[- ]end|server|rest|graphql|webhook|python)\b/i, 'backend'],
  [/\b(n8n|zapier|make\.com|automation|workflow|integrat|no[- ]code|low[- ]code|airtable)\b/i, 'automation'],
  [/\b(llm|ai|claude|anthropic|openai|gpt|prompt|rag|embedding|model)\b/i, 'ai'],
  [/\b(database|sql|postgres|dynamo|data model|schema|etl|analytics)\b/i, 'data'],
  [/\b(aws|azure|gcp|cloud|lambda|serverless|terraform|docker|kubernetes|ci\/cd)\b/i, 'cloud'],
  [/\b(hedge fund|private equity|family office|alternative investment|advisor|coaching|financial)\b/i, 'domain'],
];

function categorize(text: string): RequirementCategory {
  for (const [re, category] of CATEGORY_HINTS) {
    if (re.test(text)) return category;
  }
  return 'process';
}

/**
 * Split a bullet into separate requirements, but only when it really is a list.
 *
 * "React, TypeScript, and REST APIs" is three requirements. "Documented, maintainable systems that
 * someone else can pick up" is one, and splitting it produces a requirement called "Documented" that
 * matches nothing and scores as a gap — a fabricated failure, which is worse than a missed split.
 *
 * The test is whether every part reads like a name: at most four words, and no part opening with a verb
 * that signals a clause rather than an item. A single part failing the test means the whole bullet is
 * prose and stays whole.
 */
const CLAUSE_OPENER = /^(?:including|such as|especially|e\.g|ideally|plus|with|from|for|to|in|and|or)\b/i;

export function splitList(body: string): string[] {
  if (!body.includes(',') || body.length > 160) return [body];

  const parts = body
    .split(/,\s*(?:and\s+|or\s+)?/)
    .map((p) => p.replace(/^(?:and|or)\s+/i, '').trim())
    .filter(Boolean);

  if (parts.length < 2) return [body];

  const listLike = parts.every((p) => {
    const words = p.split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 4 && !CLAUSE_OPENER.test(p);
  });
  if (!listLike) return [body];

  /**
   * Second guard, learned from the real posting: "Test, debug, and optimize applications for
   * performance, reliability, and usability" passes the length test and is one requirement, while
   * "React, TypeScript, and REST APIs" is three. The reliable difference in real postings is case —
   * technology lists name proper nouns, verb lists are lowercase (the first word's capital is just the
   * bullet's). So split only when a majority of parts beyond the first start with a capital or digit.
   */
  const rest = parts.slice(1);
  const capitalised = rest.filter((p) => /^[A-Z0-9]/.test(p)).length;
  if (capitalised * 2 < rest.length) return [body];

  return parts;
}

/** "Northwind Systems — part-time, remote" and "Engineer at Northwind" both name the company; catch either. */
function readCompany(lines: readonly string[]): string {
  for (const raw of lines.slice(0, 6)) {
    const line = raw.trim();
    if (!line) continue;
    // `·` included: "Northwind Systems · Remote · $60/hr" is how job boards write the byline.
    const dashed = /^([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s*[—–·-]\s+\S/.exec(line);
    if (dashed?.[1]) return dashed[1].trim();
    const at = /\bat\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/.exec(line);
    if (at?.[1]) return at[1].trim();
  }
  return '';
}

/** The body of an explicitly marked list item, or null when the line carries no marker. */
function bulletBody(line: string): string | null {
  const bullet = /^[-*•·—–]\s*(.+)$/.exec(line) ?? /^\d+[.)]\s*(.+)$/.exec(line);
  return bullet?.[1]?.trim() ?? null;
}

/**
 * One candidate line becomes zero or more requirements. Every pass goes through here, so the noise
 * filter, the list splitting, the dedup key and the required-vs-preferred marker rule are written once
 * and cannot drift between a bulleted posting and an unmarked one.
 */
function collect(
  body: string,
  section: RequirementKind,
  requirements: Requirement[],
  seen: Set<string>,
): void {
  if (body.length < 3) return;
  if (NOISE.test(body)) return;

  for (const part of splitList(body)) {
    const cleaned = part.replace(/[.;]+$/, '').trim();
    if (cleaned.length < 3) continue;
    const key = normalize(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);

    // Markers are tested with parentheticals removed: "(React preferred)" states which framework
    // they prefer, not that the requirement is optional, and it demoted a must-have on the real
    // posting.
    const forMarkers = cleaned.replace(/\([^)]*\)/g, ' ');
    requirements.push({
      id: `req-${requirements.length + 1}`,
      text: cleaned,
      kind: PREFERRED_MARKERS.test(forMarkers) ? 'preferred' : section,
      category: categorize(cleaned),
    });
  }
}

/**
 * Pass 1 — an explicit list.
 *
 * Section headings are tracked as state because postings signal required-vs-preferred structurally as
 * often as they do inline: a "Nice to have" heading governs every bullet under it until the next
 * heading, and reading each bullet in isolation loses that entirely.
 *
 * Unchanged from the original single-pass reader, deliberately: this is the path that produces the
 * pinned regression anchor, and the later passes are additive rather than a rewrite of it.
 */
function readBulletedList(lines: readonly string[], requirements: Requirement[], seen: Set<string>): void {
  let section: RequirementKind = 'required';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (PREFERRED_HEADING.test(line) && line.length < 60) {
      section = 'preferred';
      continue;
    }
    if (REQUIRED_HEADING.test(line) && line.length < 60) {
      section = 'required';
      continue;
    }

    const body = bulletBody(line);
    if (body === null) continue;
    collect(body, section, requirements, seen);
  }
}

/** What a short line does to section state in passes 2 and 3. `other` closes the current list. */
type HeadingKind = 'required' | 'preferred' | 'other';

function headingKind(line: string): HeadingKind | null {
  if (line.length >= 60) return null;
  if (PREFERRED_HEADING.test(line)) return 'preferred';
  if (REQUIRED_HEADING_WIDE.test(line)) return 'required';
  // An unrecognised heading — "About Northwind Systems", "Benefits", "Tech stack:" — ends the section
  // rather than extending it. Conservative on purpose: a missed item costs one row, and a company
  // blurb read as requirements costs the report its credibility.
  if (CLOSING_HEADING.test(line) || /:$/.test(line)) return 'other';
  return null;
}

/**
 * A line that reads like an item rather than a paragraph: one sentence, short enough to be a bullet
 * that lost its bullet. A LinkedIn paste keeps the line breaks and drops the markers, which is exactly
 * this shape; a pasted prose paragraph arrives as one long multi-sentence line and fails here.
 */
function listItemLike(line: string): boolean {
  if (line.length < 4 || line.length > 180) return false;
  if (/[.!?]["')\]]?\s+["'(]?[A-Z]/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 30;
}

/**
 * Pass 2 — a list nobody marked.
 *
 * The measured failure this exists for: paste a posting off LinkedIn and the headings survive while the
 * bullet glyphs do not, so "Responsibilities" is followed by six plain lines that pass 1 cannot see. The
 * heading is the only signal left that those lines are a list, so a line counts only when a requirement
 * heading is open above it — and required-vs-preferred keeps tracking across the same headings.
 */
function readUnmarkedList(lines: readonly string[], requirements: Requirement[], seen: Set<string>): void {
  let section: RequirementKind = 'required';
  let underHeading = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // A blank line does not close the section: job boards double-space list items.
    if (!line) continue;

    const heading = headingKind(line);
    if (heading === 'preferred') {
      section = 'preferred';
      underHeading = true;
      continue;
    }
    if (heading === 'required') {
      section = 'required';
      underHeading = true;
      continue;
    }
    if (heading === 'other') {
      underHeading = false;
      continue;
    }

    if (!underHeading) continue;
    if (bulletBody(line) !== null) continue; // pass 1 already read this one
    if (!listItemLike(line)) continue;

    collect(line, section, requirements, seen);
  }
}

/**
 * Sentences that could be asking for something: a capability verb, or a technology the matcher knows.
 * Anything else in a prose posting is the company talking about itself.
 */
const CAPABILITY_VERB =
  /\b(build\w*|design\w*|develop\w*|maintain\w*|integrat\w+|ship\w*|automat\w+|implement\w*|deploy\w*|document\w*|optimi[sz]\w*|debug\w*|test\w*|writ\w+|own|owns|owning|lead\w*|manag\w+|collaborat\w+|support\w*|scope\w*|experience[ds]?|familiar\w*|proficien\w+|knowledge|comfortable|abilit\w+|skilled|expertise|understanding|responsible|require[ds]?|must have|looking for)\b/i;

/**
 * A company introducing itself, which is not a requirement even when it contains a verb the filter
 * likes. "Northwind Systems is a small team building tools for operators" would otherwise land as a
 * requirement, match nothing and score as a gap — a fabricated failure, the one failure mode this whole
 * file is written to avoid. The proper-noun form stays case-SENSITIVE on purpose: lowercased it also
 * swallows "Experience with AWS is a plus", which is a real requirement.
 */
const COMPANY_VOICE = /^(?:we|our team|our company|the company)\s+(?:is|are|was|were)\s+(?:a|an|the)\b/i;
const SELF_INTRO = /^[A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,3}\s+(?:is|was)\s+(?:a|an|the)\b/;

/** A long company blurb must not explode into a report. Twenty rows is already more than any posting. */
const PROSE_MAXIMUM = 20;

function splitSentences(body: string): string[] {
  return body.split(/(?<=[.!?])\s+/);
}

/**
 * Pass 3 — no list at all.
 *
 * Some postings are three paragraphs of prose, and on the keyless static build there is no model behind
 * this to fall through to. Consecutive lines are rejoined into a paragraph first, because a posting
 * pasted out of a text editor is hard-wrapped and splitting on newlines alone cuts sentences in half;
 * then sentences are kept only when they carry a capability verb or a technology term. The section
 * headings still steer required-vs-preferred, and the count is capped so a founder's origin story
 * cannot become twenty requirements.
 */
function readProse(lines: readonly string[], requirements: Requirement[], seen: Set<string>): void {
  let section: RequirementKind = 'required';
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    const body = paragraph.join(' ');
    paragraph = [];

    for (const sentence of splitSentences(body)) {
      if (requirements.length >= PROSE_MAXIMUM) return;
      const cleaned = sentence.trim();
      if (cleaned.length < 20 || cleaned.length > 220) continue;
      if (COMPANY_VOICE.test(cleaned) || SELF_INTRO.test(cleaned)) continue;
      if (!CAPABILITY_VERB.test(cleaned) && !CATEGORY_HINTS.some(([re]) => re.test(cleaned))) continue;
      collect(cleaned, section, requirements, seen);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }

    const heading = headingKind(line);
    if (heading !== null) {
      flush();
      // "other" only steers the section back to the default here; a prose posting has no list for it
      // to close, and refusing to read anything after an "About" heading would refuse most of them.
      if (heading === 'preferred') section = 'preferred';
      else if (heading === 'required') section = 'required';
      continue;
    }

    if (bulletBody(line) !== null) {
      flush(); // pass 1 already read this one
      continue;
    }

    if (requirements.length >= PROSE_MAXIMUM) break;
    paragraph.push(line);
  }

  flush();
}

/**
 * Read a posting without a model: an explicit list first, then an unmarked one, then prose.
 *
 * Each pass runs only when everything before it left the reader under STRUCTURED_MINIMUM, and every
 * pass writes into the same collection, so the dedup key and the requirement numbering are continuous
 * and a posting that mixes shapes is read once rather than twice.
 */
export function parseRoleDeterministically(text: string): DeterministicRole {
  const lines = text.split(/\r?\n/);
  const requirements: Requirement[] = [];
  const seen = new Set<string>();

  const titleLine = lines.find((l) => l.trim().length > 0)?.trim() ?? 'Untitled role';
  const company = readCompany(lines);

  readBulletedList(lines, requirements, seen);
  let pass: ParsePass | null = requirements.length > 0 ? 'bulleted' : null;

  if (requirements.length < STRUCTURED_MINIMUM) {
    const before = requirements.length;
    readUnmarkedList(lines, requirements, seen);
    if (requirements.length > before) pass = 'unmarked';
  }

  if (requirements.length < STRUCTURED_MINIMUM) {
    const before = requirements.length;
    readProse(lines, requirements, seen);
    if (requirements.length > before) pass = 'prose';
  }

  return { title: titleLine.slice(0, 120), company, requirements, pass };
}

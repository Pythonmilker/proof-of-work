/**
 * Stage 4 step 1: a pasted job description becomes a list of requirements.  (DESIGN.md §6.1)
 *
 * The medium tier. Input is short and already structured by whoever wrote the posting; the work is
 * splitting bundled bullets ("React, TypeScript, and REST APIs" is three requirements, not one) and
 * deciding required vs preferred, which postings signal with words rather than sections.
 *
 * The deterministic fallback here is unusually good, because job postings are bullet lists and bullet
 * lists parse. It loses the bundling split and some of the required/preferred nuance; it does not lose
 * requirements.
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

export interface ParseOutcome {
  role: ParsedRole;
  via: 'model' | 'deterministic';
  model: string;
  note: string | null;
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

export async function parseRole(text: string, opts: LlmOptions): Promise<ParseOutcome> {
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
    return {
      role: parseRoleDeterministically(text),
      via: 'deterministic',
      model: 'none',
      note: shortReason(result.error.kind),
    };
  }

  const parsed = coerceParsedRole(result.value);
  // A model reply with nothing usable in it is worse than no model at all — the deterministic reader
  // would at least have returned the bullets.
  if (parsed.requirements.length === 0) {
    return {
      role: parseRoleDeterministically(text),
      via: 'deterministic',
      model: 'none',
      note: 'model returned no requirements',
    };
  }

  return { role: parsed, via: 'model', model: result.model, note: null };
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

  return listLike ? parts : [body];
}

/** "Arootah — part-time, remote" and "Engineer at Arootah" both name the company; catch either. */
function readCompany(lines: readonly string[]): string {
  for (const raw of lines.slice(0, 6)) {
    const line = raw.trim();
    if (!line) continue;
    const dashed = /^([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s*[—–-]\s+\S/.exec(line);
    if (dashed?.[1]) return dashed[1].trim();
    const at = /\bat\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/.exec(line);
    if (at?.[1]) return at[1].trim();
  }
  return '';
}

/**
 * Split a bullet list into requirements without a model.
 *
 * Section headings are tracked as state because postings signal required-vs-preferred structurally as
 * often as they do inline: a "Nice to have" heading governs every bullet under it until the next
 * heading, and reading each bullet in isolation loses that entirely.
 */
export function parseRoleDeterministically(text: string): ParsedRole {
  const lines = text.split(/\r?\n/);
  const requirements: Requirement[] = [];
  const seen = new Set<string>();
  let section: RequirementKind = 'required';

  const titleLine = lines.find((l) => l.trim().length > 0)?.trim() ?? 'Untitled role';
  const company = readCompany(lines);

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

    const bullet = /^[-*•·—–]\s*(.+)$/.exec(line) ?? /^\d+[.)]\s*(.+)$/.exec(line);
    const body = bullet?.[1]?.trim();
    if (!body || body.length < 3) continue;
    if (NOISE.test(body)) continue;

    const parts = splitList(body);

    for (const part of parts) {
      const cleaned = part.replace(/[.;]+$/, '').trim();
      if (cleaned.length < 3) continue;
      const key = normalize(cleaned);
      if (seen.has(key)) continue;
      seen.add(key);

      requirements.push({
        id: `req-${requirements.length + 1}`,
        text: cleaned,
        kind: PREFERRED_MARKERS.test(cleaned) ? 'preferred' : section,
        category: categorize(cleaned),
      });
    }
  }

  return { title: titleLine.slice(0, 120), company, requirements };
}

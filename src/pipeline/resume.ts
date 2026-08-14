/**
 * Resume intake, step 1: a pasted resume becomes an identity plus a sheet of claims.  (DESIGN.md §v3.3)
 *
 * The deterministic reader runs first and wins whenever the resume is structured, for the same reason
 * jd.ts reads postings that way: resumes are bullet lists under section headers, and bullet lists parse —
 * keeping the resume's own words, which is what makes the claim report recognisable to the person who
 * wrote it. The model is the path for prose-heavy resumes, where there are no sections to read.
 *
 * Nothing here verifies anything. Every skill and experience statement leaves this file as an assertion,
 * and the evidence gate downstream is what keeps an assertion from scoring as shipped work. Unverified is
 * the natural state of a resume in this system — that is the whole design.
 */

import { callJson, shortReason, type LlmOptions } from '../openrouter/client';
import { RESUME_PARSE_SCHEMA } from '../openrouter/schemas';
import { normalize } from './portable';

export const RESUME_SYSTEM = `You read one resume and record what it actually says. You are filling in a
claim sheet, not assessing a person.

Rules, in order of importance:

1. Copy, do not improve. The name exactly as the header writes it; skills only where the resume names
   them; experience statements close to the original wording. Nothing the resume does not say.
2. skills: one named skill or technology per entry. "React, TypeScript and AWS" is three entries.
3. projects: one entry per position or named project in the experience sections — employer or product as
   the name, the title held as the role, one line of the resume's own words as the summary.
4. claims: the experience bullets, one statement per entry. These are recorded as unverified claims, so
   do not soften or inflate them — the wording on the page is the claim.
5. contact: email, phone and links from the header, joined with " · ". Empty string if there are none.

If the text is not a resume at all, return empty strings and empty arrays. Do not invent a person.`;

export interface ResumeProjectStub {
  name: string;
  role: string;
  summary: string;
}

export interface ParsedResume {
  name: string;
  contact: string;
  skills: string[];
  projects: ResumeProjectStub[];
  /** Experience statements — one receiptless claim each. Capabilities-to-be, tier stretch, no evidence. */
  claims: string[];
}

export interface ResumeParseOutcome {
  resume: ParsedResume;
  via: 'model' | 'deterministic';
  model: string;
  note: string | null;
}

/**
 * The bar the deterministic reader must clear for its result to be preferred outright: a name, and at
 * least this many skill terms. At or above it the resume is structured and code reads it verbatim; below
 * it the resume is prose-heavy and the model earns its keep.
 */
const STRUCTURED_SKILL_MINIMUM = 5;

export async function parseResume(text: string, opts: LlmOptions): Promise<ResumeParseOutcome> {
  const deterministic = parseResumeDeterministically(text);
  if (deterministic.name && deterministic.skills.length >= STRUCTURED_SKILL_MINIMUM) {
    // Not a fallback — the designed primary for structured resumes, so no degradation note.
    return { resume: deterministic, via: 'deterministic', model: 'none', note: null };
  }

  const result = await callJson<unknown>(
    {
      // The hard tier. A resume is long messy input with a nested schema, same shape of job as project
      // extraction, and a model that drops a claim drops it silently.
      tier: 'extraction',
      schemaName: 'resume_parse',
      schema: RESUME_PARSE_SCHEMA as unknown as Record<string, unknown>,
      system: RESUME_SYSTEM,
      user: text,
      maxTokens: 1600,
      temperature: 0,
    },
    opts,
  );

  if (!result.ok) {
    return {
      resume: deterministic,
      via: 'deterministic',
      model: 'none',
      note: shortReason(result.error.kind),
    };
  }

  const parsed = coerceParsedResume(result.value);
  // A model reply with no identity and no claims in it is worse than no model at all — the deterministic
  // reader would at least have returned what it found.
  if (!parsed.name && parsed.skills.length === 0 && parsed.claims.length === 0) {
    return {
      resume: deterministic,
      via: 'deterministic',
      model: 'none',
      note: 'model returned no identity or claims',
    };
  }

  return { resume: parsed, via: 'model', model: result.model, note: null };
}

/** Re-validate the reply as untrusted input, same as everywhere else. */
export function coerceParsedResume(raw: unknown): ParsedResume {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
  const contact = typeof obj['contact'] === 'string' ? obj['contact'].trim() : '';

  const skills: string[] = [];
  const seenSkills = new Set<string>();
  if (Array.isArray(obj['skills'])) {
    for (const item of obj['skills'] as unknown[]) {
      if (typeof item !== 'string') continue;
      const skill = item.trim();
      const key = normalize(skill);
      if (!key || seenSkills.has(key)) continue;
      seenSkills.add(key);
      skills.push(skill);
    }
  }

  const projects: ResumeProjectStub[] = [];
  const seenProjects = new Set<string>();
  if (Array.isArray(obj['projects'])) {
    for (const item of obj['projects'] as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const p = item as Record<string, unknown>;
      const stubName = typeof p['name'] === 'string' ? p['name'].trim() : '';
      if (!stubName) continue;
      const key = normalize(stubName);
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      projects.push({
        name: stubName,
        role: typeof p['role'] === 'string' ? p['role'].trim() : '',
        summary: typeof p['summary'] === 'string' ? p['summary'].trim() : '',
      });
    }
  }

  const claims: string[] = [];
  const seenClaims = new Set<string>();
  if (Array.isArray(obj['claims'])) {
    for (const item of obj['claims'] as unknown[]) {
      if (typeof item !== 'string') continue;
      const claim = item.trim();
      const key = normalize(claim);
      if (!key || seenClaims.has(key)) continue;
      seenClaims.add(key);
      claims.push(claim);
    }
  }

  return { name, contact, skills, projects, claims };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The deterministic reader.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const SKILLS_HEADING = /\b(skills?|technolog(?:y|ies)|competenc(?:y|ies)|tech stack|toolbox)\b/i;
const EXPERIENCE_HEADING = /\b(experience|employment|work history|projects?|positions?)\b/i;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]?\d{4}\b/;
const LINK_RE = /(?:https?:\/\/|www\.)[^\s)>"'\]]+/i;

/** A horizontal rule, a blank underline — layout, not content. */
const RULE_LINE = /^[-=_*·\s]{3,}$/;

/** How far down "the top" of a resume reaches when hunting for contact details. */
const HEADER_LINES = 8;

function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/[*_`]/g, '')
    .trim();
}

/**
 * The first plausible non-empty line is the name. "Plausible" is doing real work: short, no digits, no
 * email, and never a bullet — which walks straight past headers that lead with contact details or a
 * title line, and stops at nothing rather than guessing. A blob whose name cannot be found is handed to
 * the model, and if the model cannot find one either, ingest refuses to mint a person out of it.
 */
function readName(lines: readonly string[]): string {
  let inspected = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    const line = stripMarkdown(trimmed);
    if (!line || RULE_LINE.test(trimmed)) continue;
    inspected += 1;
    if (inspected > 5) break;
    if (BULLET_RE.test(trimmed) || NUMBERED_RE.test(trimmed)) continue; // a bullet is content, not a name
    const words = line.split(/\s+/).filter(Boolean);
    if (line.length <= 60 && words.length <= 5 && !/\d/.test(line) && !line.includes('@')) {
      return line;
    }
  }
  return '';
}

/** First email, plus any phone and link near the top, joined the way the Candidates field expects. */
function readContact(lines: readonly string[]): string {
  const top: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || RULE_LINE.test(line)) continue;
    top.push(line);
    if (top.length >= HEADER_LINES) break;
  }
  const header = top.join('\n');

  const parts: string[] = [];
  const email = EMAIL_RE.exec(header)?.[0];
  if (email) parts.push(email);
  const phone = PHONE_RE.exec(header)?.[0]?.trim();
  if (phone) parts.push(phone);
  const link = LINK_RE.exec(header)?.[0]?.replace(/[.,;]+$/, '');
  if (link && link !== email) parts.push(link);

  return [...new Set(parts)].join(' · ');
}

/**
 * One line of a skills section becomes skill terms.
 *
 * Order matters and each step exists for a real line in a real resume. Parentheticals go first, because
 * "S3 (cross-region replication, versioning)" splits into garbage if the commas inside them survive.
 * Then the category label — "AWS / Cloud: Lambda, …" names a heading, not a skill. Only then is the
 * remainder split, on commas, middots and spaced slashes — never bare slashes, which would cut CI/CD
 * in half.
 */
function readSkillLine(raw: string): string[] {
  const line = stripMarkdown(raw)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^[^:]{1,48}:\s*/, '');

  return line
    .split(/[,;·•|]|\s\/\s/)
    .map((part) => part.trim().replace(/[.]+$/, ''))
    .filter((part) => part.length >= 2 && part.length <= 60);
}

const BULLET_RE = /^[-*•·]\s+(.+)$/;
const NUMBERED_RE = /^\d+[.)]\s+(.+)$/;

/**
 * Is this line a section header, and how deep? Markdown headings count; so does a short standalone line,
 * because plain-text resumes write "TECHNICAL SKILLS" with no # in sight — but a bare line with a digit
 * in it is a date range ("2025 – Present · Remote"), not a header, and treating it as one ends the
 * experience section right after it opens. Bullets never count, whatever they say.
 */
function readHeader(rawLine: string): { text: string; depth: number } | null {
  const line = rawLine.trim();
  if (!line || BULLET_RE.test(line) || NUMBERED_RE.test(line)) return null;
  const markdown = /^(#{1,6})\s+/.exec(line);
  if (markdown?.[1]) return { text: stripMarkdown(line), depth: markdown[1].length };
  const bare = stripMarkdown(line);
  // No colon, comma or digit: those mark a labelled list, a short skill list and a date range — all
  // content lines that would otherwise read as headers and silently end the section they sit in.
  if (
    bare.length > 0 &&
    bare.length <= 40 &&
    !bare.includes(':') &&
    !bare.includes(',') &&
    !/[.]$/.test(bare) &&
    !/\d/.test(bare)
  ) {
    return { text: bare, depth: 0 };
  }
  return null;
}

/** "Founder & Cloud Developer — Viral Host Digital LLC": the dash separates the role from the name. */
function readStub(header: string): ResumeProjectStub {
  const split = header.split(/\s+[—–]\s+/);
  if (split.length === 2 && split[0] && split[1]) {
    return { name: split[1].trim(), role: split[0].trim(), summary: '' };
  }
  return { name: header.trim(), role: '', summary: '' };
}

/**
 * Read a resume using sections, headers and bullets — no model, no key, no judgement calls.
 *
 * Section headings are tracked as state for the same reason jd.ts tracks them: a "Technical Skills"
 * heading governs every line under it until the next heading, and reading lines in isolation loses that.
 * Experience bullets become claims; experience sub-headers become project stubs; and the stub whose
 * section a bullet sits in lends the bullet nothing — a claim is the person's, not the employer's.
 */
export function parseResumeDeterministically(text: string): ParsedResume {
  const lines = text.split(/\r?\n/);

  const name = readName(lines);
  const contact = readContact(lines);

  const skills: string[] = [];
  const seenSkills = new Set<string>();
  const projects: ResumeProjectStub[] = [];
  const seenProjects = new Set<string>();
  const claims: string[] = [];
  const seenClaims = new Set<string>();

  type Section = 'skills' | 'experience' | 'other';
  let section: Section = 'other';
  /** Heading depth of the experience section itself, so `## Education` ends it and `### Founder` does not. */
  let experienceDepth = 0;
  let currentStub: ResumeProjectStub | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || RULE_LINE.test(line)) continue;

    const header = readHeader(line);
    if (header) {
      if (SKILLS_HEADING.test(header.text)) {
        section = 'skills';
        currentStub = null;
        continue;
      }
      if (EXPERIENCE_HEADING.test(header.text)) {
        section = 'experience';
        experienceDepth = header.depth;
        currentStub = null;
        continue;
      }
      // A header inside the experience section is a position or a named project when it sits deeper
      // than the section heading, or when it reads like one — "Role — Company". A sibling heading
      // ("## Education" next to "## Experience") is a new section, and Education is not experience.
      const isStubHeader =
        section === 'experience' &&
        ((header.depth > 0 && header.depth > experienceDepth) || /\s[—–]\s/.test(header.text));
      if (isStubHeader) {
        const stub = readStub(header.text);
        const key = normalize(stub.name);
        if (key && !seenProjects.has(key)) {
          seenProjects.add(key);
          projects.push(stub);
          currentStub = stub;
        }
        continue;
      }
      // Any other header ends the section it interrupts.
      section = 'other';
      currentStub = null;
      continue;
    }

    if (section === 'skills') {
      for (const skill of readSkillLine(line)) {
        const key = normalize(skill);
        if (!key || seenSkills.has(key)) continue;
        seenSkills.add(key);
        skills.push(skill);
      }
      continue;
    }

    if (section === 'experience') {
      const bullet = BULLET_RE.exec(line) ?? NUMBERED_RE.exec(line);
      const body = bullet?.[1] ? stripMarkdown(bullet[1]) : '';
      if (body && body.length >= 12) {
        const key = normalize(body);
        if (!seenClaims.has(key)) {
          seenClaims.add(key);
          claims.push(body);
        }
        if (currentStub && !currentStub.summary) currentStub.summary = body.slice(0, 300);
      }
    }
  }

  return { name, contact, skills, projects, claims };
}

/**
 * THE RULES BOTH LANES RUN. One definition, two runtimes.
 *
 * The app imports these directly. `n8n/build.ts` reads THIS FILE, strips the types with
 * `ts.transpileModule` (comments survive), and pastes the result into the Code nodes, so a workflow does
 * not contain a copy of these rules — it contains these rules. A change here lands in both lanes on the
 * next `pnpm n8n:build`, and `tests/workflow-parity.test.ts` fails if a committed workflow is carrying an
 * older emission.
 *
 * WHY THIS FILE EXISTS. The gate below was fixed once, in score.ts, after an adversarial audit found it
 * promoting stretch claims to proven. The n8n Code node carried a hand-typed copy of the old rule and
 * kept promoting them for months — the drift check never saw it, because it compares the committed JSON
 * to what build.ts regenerates, which is build.ts against itself. Two lanes wrote different verdicts for
 * the same candidate into the same Airtable base. Hand-mirroring logic into a template string is what
 * made that possible, so the logic stopped being hand-mirrored.
 *
 * THE CONSTRAINTS, and they are load-bearing rather than stylistic:
 *
 *   1. NO IMPORTS. The whole file is emitted, so functions here may call each other freely — but nothing
 *      outside it comes along, and a call to an imported symbol is a ReferenceError inside a Code node.
 *      This is the constraint that decides what belongs here: a rule moves into this file WITH its
 *      helpers, or it does not move.
 *   2. CONSTANTS LIVE IN THE FUNCTION THAT NEEDS THEM. Module scope is emitted, so a hoisted const would
 *      technically work — the reason to keep them local is collision. This block is pasted into a node
 *      alongside hand-written code, and a module-level `WEIGHT` is a name the node may already be using.
 *      Local constants also travel with the rule when it is read, which is how the pair stays honest.
 *   3. PLAIN VALUES ONLY. These cross a JSON boundary, so no classes, no Map, no Set at the seam. Inside
 *      a function body they are ordinary JavaScript and perfectly fine.
 *   4. TYPES ARE ERASED, so runtime behaviour may never depend on them. Every input is validated as if it
 *      arrived from a webhook, because in one of the two lanes it did.
 *   5. NO I/O AND NO CLOCK. Same input, same answer, in both lanes and in the parity test that runs them
 *      against each other. A rule that reads the time or the network cannot be compared.
 */

/** proven beats partial beats gap. */
export type GateStatus = 'proven' | 'partial' | 'gap';

/**
 * What the gate needs to know, already measured by whichever lane is asking.
 *
 * `decisive` is the TOP-SCORING capabilities only, not everything cited. That distinction is the fix the
 * audit forced: reading every cited capability let one incidental proven row rescue a stretch match.
 */
export interface GateInput {
  /** Best retrieval score across all cited rows. */
  best: number;
  /** How many receipts the citation set carries in total. */
  evidenceCount: number;
  /** The top-scoring capabilities: their tier, and how many receipts each carries. */
  decisive: Array<{ tier: string; evidenceCount: number }>;
  /** The weighing model's strength, when one ran. Absent is NOT zero. */
  strength?: number;
  /** At or above this, a well-evidenced match is a direct hit. */
  thresholdProven: number;
  /** Below this, nothing matched well enough to claim anything. */
  thresholdPartial: number;
}

export interface GateResult {
  status: GateStatus;
  /** Why it is not proven, in plain words. Null when it is. */
  shortfall: string | null;
}

/**
 * The evidence gate: the one rule that stops the record drifting into a resume.
 *
 * A capability with nothing linked to it cannot score proven however cleanly it matched. Adding a
 * capability row is easy; making it count should not be.
 *
 * The decisive set is read with `some`, not `every`. `every` was the original and it was wrong: a bullet
 * naming a stretch capability alongside any incidentally-matched proven one was promoted and then
 * dropped out of the Gaps section, which is the precise over-claim this exists to prevent. Applying
 * `some` to ALL cited rows would be wrong the other way — one incidental stretch row would drag down a
 * requirement something evidenced genuinely covers. So it reads the best matches, and a tie at that
 * score counts: if the strongest match is ambiguous between proven and stretch, the honest answer is
 * partial.
 */
export function gateStatus(input: GateInput): GateResult {
  const best = Number(input.best) || 0;
  const decisive = Array.isArray(input.decisive) ? input.decisive : [];

  if (best < input.thresholdPartial) {
    return { status: 'gap', shortfall: 'nothing in the record matches this closely enough to claim' };
  }

  const belowProven = best < input.thresholdProven;
  const noEvidence = (Number(input.evidenceCount) || 0) === 0;
  const anyStretch = decisive.length > 0 && decisive.some((c) => c.tier === 'stretch');
  const anyUnevidenced = decisive.length > 0 && decisive.some((c) => (Number(c.evidenceCount) || 0) === 0);
  // An ADDITIONAL condition on proven, never a route to it: absent leaves the verdict exactly as the
  // deterministic pass decided it.
  const weighedThin = input.strength !== undefined && input.strength !== null && Number(input.strength) < input.thresholdProven;

  if (belowProven || noEvidence || anyStretch || anyUnevidenced || weighedThin) {
    return {
      status: 'partial',
      shortfall: belowProven
        ? 'matched, but not closely enough to call it a direct hit'
        : noEvidence
          ? 'matched, but nothing verifiable is linked to it'
          : anyStretch
            ? 'the matching capability is recorded as a stretch, not as shipped work'
            : anyUnevidenced
              ? 'the matching capability has no evidence linked, so it reads as unverified'
              : 'the name matches, but the work behind it is thinner than the requirement asks for',
    };
  }

  return { status: 'proven', shortfall: null };
}

export interface CoverageRow {
  /** Deliberately wide: coverageOf weighs an unrecognised kind as required rather than rejecting it. */
  kind: string;
  status: GateStatus;
}

export interface CoverageTotals {
  /** 0..100. */
  score: number;
  proven: number;
  partial: number;
  gap: number;
  requiredCovered: number;
  requiredTotal: number;
}

/**
 * Weighted coverage across a whole posting.
 *
 * Weighted rather than counted, because a posting listing three must-haves and eleven nice-to-haves must
 * not score 79% while missing every must-have. Partial credit is real credit at half value: treating a
 * partial as a zero understates as badly as treating it as a pass overstates.
 *
 * The weights live inside this function on purpose — see constraint 2 in the header. Hoisting them to a
 * module constant is exactly how the n8n copy came to carry its own hand-typed pair.
 */
export function coverageOf(rows: readonly CoverageRow[]): CoverageTotals {
  const WEIGHT = { required: 1, preferred: 0.5 };
  const VALUE = { proven: 1, partial: 0.5, gap: 0 };

  let earned = 0;
  let possible = 0;
  let proven = 0;
  let partial = 0;
  let gap = 0;
  let requiredCovered = 0;
  let requiredTotal = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    // Unknown kinds weigh as required, unknown statuses earn nothing: an input this function does not
    // recognise must never be worth MORE than one it does.
    const weight = row.kind === 'preferred' ? WEIGHT.preferred : WEIGHT.required;
    const status = row.status;
    const value = status === 'proven' ? VALUE.proven : status === 'partial' ? VALUE.partial : VALUE.gap;
    earned += weight * value;
    possible += weight;

    if (status === 'proven') proven += 1;
    else if (status === 'partial') partial += 1;
    else gap += 1;

    if (row.kind === 'required') {
      requiredTotal += 1;
      if (status === 'proven') requiredCovered += 1;
    }
  }

  return {
    score: possible === 0 ? 0 : Math.round((earned / possible) * 100),
    proven,
    partial,
    gap,
    requiredCovered,
    requiredTotal,
  };
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * MATCHING. Which strings count as the same thing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Lowercase, strip punctuation, collapse whitespace — with four survivors.
 *
 *   `+` survives   C++, Notion+
 *   `#` survives   C#, F#
 *   `.` survives   Node.js, .NET, ASP.NET
 *   `/` survives   CI/CD, TCP/IP
 *
 * Dropping any of those turns distinct technologies into the same token, which is how "C" and "C#" end
 * up matching each other.
 */
export function normalize(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `haystack` contain `needle` as a whole term?
 *
 * `\b` is wrong for these strings and the failure is silent. In `c#` the boundary sits between `c` and
 * `#`, so `/\bc#\b/` never matches "c#" — the trailing `\b` wants a word character after `#` and there is
 * none. Same for `node.js` and `ci/cd`. The lookarounds below handle every case the `+#./` survivors can
 * produce. Two further rules, each from a specific wrong answer:
 *
 * **Plurals.** `(?:e?s)?` on the end. Postings pluralise constantly — "structured outputs", "internal
 * tools", "REST APIs" — and without it "structured output" fails against "structured outputs" because the
 * trailing boundary sees the `s`. One character, several requirements silently scoring zero.
 *
 * **Hyphens.** A single-word term treats `-` as part of a word, so `react` does not match
 * `react-three-fiber`. It used to, and the fit report cheerfully cited a Unity game as React experience. A
 * multi-word term folds hyphens to spaces on both sides instead, so `rest api` still matches `rest-api`.
 * The asymmetry is the point: inside a compound word a hyphen joins, between words it separates.
 */
export function containsTerm(haystack: string, needle: string): boolean {
  const term = normalize(needle);
  if (!term) return false;
  const hay = String(haystack ?? '');

  if (term.includes(' ')) {
    return new RegExp(`(?<![a-z0-9])${escapeRegex(term)}(?:e?s)?(?![a-z0-9])`, 'i').test(
      hay.replace(/-/g, ' '),
    );
  }
  return new RegExp(`(?<![a-z0-9-])${escapeRegex(term)}(?:e?s)?(?![a-z0-9-])`, 'i').test(hay);
}

/**
 * Crude suffix stripping, applied only inside `overlap`.
 *
 * Not a real stemmer and not trying to be. It exists because a posting writes "integrating large language
 * models" where a capability statement writes "LLM application integration", and without folding those to
 * a shared root the two share no tokens at all and the requirement scores zero.
 *
 * The `at` rule runs first so integrate / integrating / integration all land on `integrat`; the general
 * rule then handles ordinary plurals and gerunds. Over-stemming is tolerable because `overlap` requires
 * half the smaller token set to match before it reports anything.
 */
export function stem(token: string): string {
  return token.replace(/(ations?|ating|ated|ate)$/, 'at').replace(/(ing|ed|es|s)$/, '');
}

/** Content words, stemmed. Stopwords are listed here rather than hoisted — constraint 2. */
export function tokens(input: string): string[] {
  const STOPWORDS = [
    'a', 'an', 'and', 'or', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from',
    'is', 'are', 'be', 'been', 'we', 'you', 'your', 'our', 'their', 'it', 'this', 'that', 'these',
    'experience', 'strong', 'solid', 'proven', 'excellent', 'good', 'ability', 'able', 'work',
    'working', 'using', 'use', 'skills', 'knowledge', 'familiarity', 'familiar', 'plus', 'bonus',
    'years', 'year', 'must', 'should', 'have', 'has', 'including', 'etc',
  ];
  return normalize(input)
    .split(' ')
    .filter((t) => t.length > 1 && STOPWORDS.indexOf(t) === -1)
    .map(stem)
    .filter((t) => t.length > 1);
}

/**
 * Overlap of two token sets against the SMALLER set, 0..1.
 *
 * The floor beneath dense retrieval, not a replacement for it: it catches "builds automations that connect
 * systems" against "workflow automation" and misses anything requiring actual synonymy. When a key is
 * present, embeddings cover what this cannot; when there is no key, the UI says the matcher is running
 * lexical-only rather than pretending the result is equivalent.
 *
 * Dividing by the smaller set rather than the union is deliberate and is NOT Jaccard: a three-word
 * capability fully contained in a thirty-word posting bullet should score 1, not 0.1.
 */
export function overlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

/** Read structurally, so each lane can pass its own row shape. Only these fields are ever touched. */
export interface TechnologyLike {
  name: string;
  aliases?: readonly string[];
}

export interface CapabilityLike {
  name: string;
  matchTerms?: readonly string[];
  statement?: string;
}

/** A technology is named or it is not. There is no partial credit for spelling something similar. */
export function lexicalTechnologyScore(haystack: string, tech: TechnologyLike): number {
  const aliases = [tech.name].concat((tech.aliases ?? []) as string[]);
  return aliases.some((a) => containsTerm(haystack, a)) ? 1 : 0;
}

/**
 * A capability, unlike a technology, can be described without being named.
 *
 * A literal hit scores 1. Failing that it falls back to token overlap against the capability's own
 * words, which is what catches a posting writing "builds automations that connect internal systems"
 * where the record says "workflow automation" — no shared term, plainly the same thing.
 *
 * The fallback is deliberately capped below a literal match: 0.5 overlap enters at 0.6 and full overlap
 * reaches 0.9, so a described match can be cited and can clear `THRESHOLD_PROVEN`, but a named match
 * always outranks it. The n8n lane omitted this fallback entirely for months, which did not throw or
 * warn — it silently scored prose postings lower than the app did on identical data.
 */
export function lexicalCapabilityScore(
  requirementText: string,
  haystack: string,
  cap: CapabilityLike,
): number {
  const terms = [cap.name].concat((cap.matchTerms ?? []) as string[]);
  if (terms.some((t) => containsTerm(haystack, t))) return 1;

  const phrase = Math.max(overlap(requirementText, cap.name), overlap(requirementText, cap.statement ?? ''));
  return phrase >= 0.5 ? 0.6 + (phrase - 0.5) * 0.6 : 0;
}

/**
 * Keep the winners, drop the long tail. Expects `candidates` already sorted best-first.
 *
 * A requirement that matches eleven things has not matched eleven things — it has matched two, and nine
 * rows scored above zero because they share a word. Anything more than DELTA below the best is noise,
 * and a citation list nobody trusts is worse than a short one.
 *
 * The floor is the half of this the n8n lane was missing: it took a flat top-4 with no DELTA, so a
 * requirement with one real match cited three unrelated rows beneath it.
 */
export function topCited<T extends { score: number }>(candidates: readonly T[]): T[] {
  const DELTA = 0.2;
  const MAX_CITED = 4;

  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const floor = (Number(candidates[0]?.score) || 0) - DELTA;
  return (candidates as T[]).filter((c) => (Number(c.score) || 0) >= floor).slice(0, MAX_CITED);
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RATIONALE GUARD. What a written sentence is not allowed to say.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Every number in a string, as written.
 *
 * The lookarounds exclude digits welded to letters, because `numbersIn` once counted the 2 inside "e2e"
 * and the fabrication guard then hunted for a figure nobody had written and rejected good sentences over
 * it. A trailing comma is trimmed so "shipped 3, twice" yields `3` rather than `3,`.
 */
export function numbersIn(input: string): string[] {
  const found = String(input ?? '').match(/(?<![a-z0-9])\d[\d,]*(?![a-z])/gi);
  return (found ?? []).map((n) => n.replace(/,$/, ''));
}

/**
 * A figure the sentence states that its source material does not contain.
 *
 * Small numbers are exempt above a threshold of 12 because ordinals, counts of listed items and years-ago
 * arithmetic legitimately appear in a sentence without appearing in the corpus, and flagging those made
 * the guard useless. This catches invented magnitudes, which is the failure that matters — it does NOT
 * catch a real number attached to the wrong thing. A live run wrote "34 commits to `.claude/`" from a
 * receipt ending in a dangling "34 commits", and this passed it, correctly: 34 was in the corpus. The fix
 * for misattribution is wording the model cannot misread, not a stricter number check.
 */
export function hasUnsourcedNumber(sentence: string, corpus: string): boolean {
  const allowed = numbersIn(corpus);
  return numbersIn(sentence).some(
    (n) => allowed.indexOf(n) === -1 && Number(n.replace(/,/g, '')) > 12,
  );
}

/**
 * Does the sentence grade the candidate instead of reporting what they did?
 *
 * The prompt has always banned these words and for months that was the entire enforcement — a prompt with
 * nothing behind it. A live run then wrote "The candidate has extensive experience with Claude Code",
 * where "extensive" is the prompt's own first banned example. The ban is a function now.
 *
 * The boundaries are `[\w-]` rather than `\b` because a bare `\bdeep\b` fires inside "deep-link" and a
 * bare `\bsolid\b` inside "solid-state" — real words in real receipts, rejected for containing a banned
 * adjective they only spell.
 */
export function gradesTheCandidate(sentence: string): boolean {
  const BANNED = [
    'extensive', 'strong', 'deep', 'expert', 'expertise', 'seasoned', 'proficient', 'excellent',
    'impressive', 'exceptional', 'outstanding', 'robust', 'solid', 'vast', 'significant',
  ];
  const lower = String(sentence ?? '').toLowerCase();
  return BANNED.some((word) => new RegExp(`(?<![\\w-])${word}(?![\\w-])`).test(lower));
}

/** Read structurally: the app passes its store rows, the workflow passes Airtable rows. */
export interface RationaleProject {
  name: string;
  status?: string;
  started?: string;
  summary?: string;
  metrics?: Record<string, string | number>;
}

export interface RationaleEvidence {
  label: string;
  value: string;
  url?: string | null;
}

export interface RationaleInput {
  requirementText: string;
  requirementKind: string;
  status: GateStatus;
  technologies: string[];
  capabilities: string[];
  projects: RationaleProject[];
  evidence: RationaleEvidence[];
  shortfall: string | null;
}

/**
 * Everything the model may see about ONE requirement — and, unchanged, the corpus the guard checks its
 * answer against.
 *
 * That the two are the same string is the whole design. The guard rejects a sentence containing a number
 * the model was not given, so "what the model was given" has to be one artifact, not two descriptions of
 * one. The n8n lane used to build the prompt from all sixteen requirements and the corpus from four
 * hand-picked fields, which meant a sentence citing a project metric was legal in the app and a
 * fabrication in the workflow — the guard firing on a true sentence, which is how a guard gets removed.
 */
export function buildRationaleContext(ctx: RationaleInput): string {
  const lines: string[] = [
    `Requirement (${ctx.requirementKind}): ${ctx.requirementText}`,
    `Verdict already decided: ${ctx.status}`,
  ];
  if (ctx.shortfall) lines.push(`Why it is not full coverage: ${ctx.shortfall}`);

  const techs = ctx.technologies ?? [];
  const caps = ctx.capabilities ?? [];
  if (techs.length > 0) lines.push(`Matched technologies: ${techs.join(', ')}`);
  if (caps.length > 0) lines.push(`Matched capabilities: ${caps.join(', ')}`);

  const projects = ctx.projects ?? [];
  const evidence = ctx.evidence ?? [];

  for (const project of projects) {
    const metrics = Object.entries(project.metrics ?? {})
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    lines.push(
      `Project "${project.name}" (${project.status}${project.started ? `, ${project.started}` : ''})` +
        `${metrics ? ` — ${metrics}` : ''}. ${project.summary}`,
    );
  }

  for (const e of evidence) {
    lines.push(`Evidence — ${e.label}: ${e.value}${e.url ? ` (${e.url})` : ''}`);
  }

  if (projects.length === 0 && evidence.length === 0) {
    lines.push('Nothing in the record matched this requirement.');
  }

  return lines.join('\n');
}

/** Join a list the way a person would: "a", "a and b", "a, b and c". */
function readable(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The deterministic sentence: used when no model is reachable, and whenever the guard rejects one.
 *
 * It names ONE thing, not everything. An earlier version led with every matched row and produced
 * "React, React product engineering appears in…", which reads like a machine and buries the fact. The
 * citation panel already lists the full set; this sentence only has to say what and where.
 */
export function templateRationale(ctx: RationaleInput): string {
  if (ctx.status === 'gap') return 'Nothing in the record matches this requirement.';

  const projects = ctx.projects ?? [];
  const where = readable(projects.map((p) => p.name)) || 'the record';
  const subject = (ctx.technologies ?? [])[0] ?? (ctx.capabilities ?? [])[0] ?? 'This';
  const receipts = (ctx.evidence ?? []).length;
  const receiptText =
    receipts === 0 ? 'nothing verifiable linked' : `${receipts} linked receipt${receipts === 1 ? '' : 's'}`;

  if (ctx.status === 'proven') {
    return `${subject} — shipped in ${where}, with ${receiptText}.`;
  }
  return `${subject} appears in ${where} with ${receiptText}, but ${ctx.shortfall ?? 'coverage is partial'}.`;
}

/**
 * The sentence under a Gaps entry: what is missing, then the nearest real thing on file.
 *
 * Capped at two project names because this runs under a heading that already names the requirement, and
 * a gap note listing six projects is a list nobody reads. The n8n lane omitted the "Closest on file"
 * clause entirely, so the same candidate against the same posting produced a shorter, less useful Gaps
 * section in Airtable than in the app — the section CLAUDE.md calls the load-bearing claim.
 */
export function gapNote(shortfall: string | null, projectNames: readonly string[]): string {
  const reason = shortfall && shortfall.length > 0 ? shortfall : 'no match in the record';
  const names = (projectNames ?? []).filter(Boolean).slice(0, 2);
  const where = names.length > 0 ? ` Closest on file: ${names.join(' and ')}.` : '';
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.${where}`;
}

export interface RationaleVerdict {
  usable: boolean;
  /** Why it was rejected, in the order checked. Empty when usable. */
  faults: string[];
}

/**
 * The whole guard, in one call, because both lanes must reject the same sentences.
 *
 * A rejected sentence is not an error — the caller falls back to the deterministic sentence, which cites
 * the same rows and grades nobody. Model prose is an upgrade this system is willing to decline.
 */
export function checkRationale(sentence: string, corpus: string): RationaleVerdict {
  // A rationale is one or two sentences under a requirement heading. Past this the model has stopped
  // citing and started arguing, and the template says the same thing in a form nobody has to audit.
  const MAX_CHARS = 400;

  const text = String(sentence ?? '').trim();
  const faults: string[] = [];

  if (text.length === 0) faults.push('empty');
  if (text.length > MAX_CHARS) faults.push('longer than a citation needs to be');
  if (gradesTheCandidate(text)) faults.push('grades the candidate rather than reporting the work');
  if (hasUnsourcedNumber(text, corpus)) faults.push('states a figure that is not in the cited material');

  return { usable: faults.length === 0, faults };
}

/*
 * ───────────────────────────────────────────────────────────────────────────────
 * READING A POSTING WITHOUT A MODEL.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * This lived in jd.ts and the n8n lane had no equivalent at all: the workflow wired its webhook
 * straight into the parse model, unconditionally. That is not a missing optimisation, it is a
 * different answer. Measured on the bundled sample, the model reads it as 18 paraphrased requirements
 * and scores 66; the deterministic reader takes the 16 bullets verbatim and scores 75. Both lanes
 * upsert the SAME Roles key, so whichever ran last won — an n8n run silently rewrote the app's row.
 *
 * The gate is the PASS that answered, not a count: bulleted or unmarked is read verbatim and no model
 * is called; prose or nothing falls through to the model. See jd.ts for why that gate replaced
 * "fewer than four requirements" in 2026-07-30.
 */

/** Fewer than this from a pass and the next pass runs too. */
export const STRUCTURED_MINIMUM = 4;

/** Which pass answered. Null when nothing did. */
export type ParsePass = 'bulleted' | 'unmarked' | 'prose';

/**
 * Structural twin of the store's Requirement — declared, not imported, per constraint 1.
 *
 * The two unions below mirror `RequirementKind` and `RequirementCategory` in ../store/types.ts. That is
 * a duplication this file cannot avoid and a test pins it: tests/workflow-parity.test.ts fails if either
 * list drifts, so the twin stays assignable to the original rather than quietly widening it to string.
 */
export type PortableRequirementKind = 'required' | 'preferred';

export type PortableRequirementCategory =
  | 'frontend'
  | 'backend'
  | 'automation'
  | 'ai'
  | 'data'
  | 'cloud'
  | 'process'
  | 'domain';

export interface PortableRequirement {
  id: string;
  text: string;
  kind: PortableRequirementKind;
  category: PortableRequirementCategory;
}

export interface DeterministicRole {
  title: string;
  company: string;
  requirements: PortableRequirement[];
  pass: ParsePass | null;
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

const CATEGORY_HINTS: Array<[RegExp, PortableRequirementCategory]> = [
  [/\b(react|vue|angular|next\.?js|frontend|front[- ]end|ui|css|tailwind|typescript|javascript)\b/i, 'frontend'],
  [/\b(node|api|backend|back[- ]end|server|rest|graphql|webhook|python)\b/i, 'backend'],
  [/\b(n8n|zapier|make\.com|automation|workflow|integrat|no[- ]code|low[- ]code|airtable)\b/i, 'automation'],
  [/\b(llm|ai|claude|anthropic|openai|gpt|prompt|rag|embedding|model)\b/i, 'ai'],
  [/\b(database|sql|postgres|dynamo|data model|schema|etl|analytics)\b/i, 'data'],
  [/\b(aws|azure|gcp|cloud|lambda|serverless|terraform|docker|kubernetes|ci\/cd)\b/i, 'cloud'],
  [/\b(hedge fund|private equity|family office|alternative investment|advisor|coaching|financial)\b/i, 'domain'],
];

function categorize(text: string): PortableRequirementCategory {
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
  section: PortableRequirementKind,
  requirements: PortableRequirement[],
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
function readBulletedList(lines: readonly string[], requirements: PortableRequirement[], seen: Set<string>): void {
  let section: PortableRequirementKind = 'required';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // A marked bullet is an ITEM, tested before the heading regexes — never swallowed as a heading.
    // "- Must have experience with React" is 33 chars and matches REQUIRED_HEADING, so the old
    // heading-first order dropped it entirely (and a bullet like "- Bonus: ..." also flipped the
    // section). Only an UNMARKED line can be a section heading, which is what these regexes are for.
    const body = bulletBody(line);
    if (body !== null) {
      collect(body, section, requirements, seen);
      continue;
    }

    if (PREFERRED_HEADING.test(line) && line.length < 60) {
      section = 'preferred';
      continue;
    }
    if (REQUIRED_HEADING.test(line) && line.length < 60) {
      section = 'required';
      continue;
    }
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
function readUnmarkedList(lines: readonly string[], requirements: PortableRequirement[], seen: Set<string>): void {
  let section: PortableRequirementKind = 'required';
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
function readProse(lines: readonly string[], requirements: PortableRequirement[], seen: Set<string>): void {
  let section: PortableRequirementKind = 'required';
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
  const requirements: PortableRequirement[] = [];
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

/*
 * ───────────────────────────────────────────────────────────────────────────────
 * RESOLUTION AND WEIGHING.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * Everything below was app-only. The workflow reimplemented resolution by hand and had no weighing pass
 * at all, so `gateStatus` was always called without `strength` and the `weighedThin` branch was dead by
 * construction. CLAUDE.md lists "weighing can only lower a verdict" as a non-negotiable; it held in one
 * lane. Both lanes upsert the same Roles key, so the lane without it could overwrite the lane with it.
 */

/** Structural twin of the store rows resolution reads. `id` is the logical key, not an Airtable id. */
export interface ResolveSnapshot {
  technologies: Array<{ id: string; projects?: readonly string[] }>;
  capabilities: Array<{ id: string; tier: string; projects?: readonly string[]; evidence?: readonly string[] }>;
  projects: Array<{ id: string; reviewStatus?: string; evidence?: readonly string[] }>;
  evidence?: Array<{ id: string; label: string }>;
}

export interface ScoredCandidate {
  kind: string;
  id: string;
  name: string;
  score: number;
}

export interface Resolution {
  status: GateStatus;
  matchedTechnologies: string[];
  matchedCapabilities: string[];
  matchedProjects: string[];
  evidence: string[];
  shortfall: string | null;
}

/** How many projects one requirement may cite. Three strongest is a citation; everything is a dump. */
export const MAX_CITED_PROJECTS = 3;

/**
 * Turn a cited candidate list into a status plus every id a reader can click through to.
 *
 * Projects are DERIVED, never matched directly — a project is relevant because something in it is —
 * then ranked by how many matched rows each contains and cut to three. A common technology like React
 * touches every project, and citing all of them produces twenty-six receipts nobody reads.
 *
 * Capability evidence is never trimmed: it is the most specific receipt available and the one the gate
 * is actually asking about.
 */
export function resolveRequirement(
  cited: readonly ScoredCandidate[],
  best: number,
  snapshot: ResolveSnapshot,
  thresholds: { thresholdProven: number; thresholdPartial: number },
  strength?: number,
): Resolution {
  const rows = cited ?? [];
  const techs = snapshot.technologies ?? [];
  const capsAll = snapshot.capabilities ?? [];
  const projects = snapshot.projects ?? [];

  const matchedTechnologies = rows.filter((c) => c.kind === 'technology').map((c) => c.id);
  const matchedCapabilities = rows.filter((c) => c.kind === 'capability').map((c) => c.id);
  const caps = matchedCapabilities
    .map((id) => capsAll.find((x) => x.id === id))
    .filter(Boolean) as Array<{ id: string; tier: string; projects?: readonly string[]; evidence?: readonly string[] }>;

  const hits: Record<string, number> = {};
  const credit = (ids: readonly string[] | undefined): void => {
    for (const id of ids ?? []) {
      const project = projects.find((p) => p.id === id);
      if (!project || project.reviewStatus === 'needs-review') continue; // a parked record proves nothing yet
      hits[id] = (hits[id] ?? 0) + 1;
    }
  };
  for (const id of matchedTechnologies) credit(techs.find((t) => t.id === id)?.projects);
  for (const cap of caps) credit(cap.projects);

  const matchedProjects = Object.keys(hits)
    .sort((a, b) => (hits[b] ?? 0) - (hits[a] ?? 0) || a.localeCompare(b))
    .slice(0, MAX_CITED_PROJECTS);

  const evidenceIds: string[] = [];
  const addEvidence = (ids: readonly string[] | undefined): void => {
    for (const e of ids ?? []) if (evidenceIds.indexOf(e) === -1) evidenceIds.push(e);
  };
  for (const cap of caps) addEvidence(cap.evidence);
  for (const id of matchedProjects) addEvidence(projects.find((p) => p.id === id)?.evidence);

  // The decisive set: the top-scoring capabilities, ties included. Which of them the gate reads, and
  // how, is `gateStatus` above — this only measures what the gate needs.
  const capScores = rows.filter((c) => c.kind === 'capability').map((c) => Number(c.score) || 0);
  const bestCapScore = capScores.length > 0 ? Math.max(...capScores) : 0;
  const decisive = rows
    .filter((c) => c.kind === 'capability' && (Number(c.score) || 0) >= bestCapScore)
    .map((c) => capsAll.find((x) => x.id === c.id))
    .filter(Boolean)
    .map((c) => ({
      tier: (c as { tier: string }).tier,
      evidenceCount: ((c as { evidence?: readonly string[] }).evidence ?? []).length,
    }));

  const gate = gateStatus({
    best: Number(best) || 0,
    evidenceCount: evidenceIds.length,
    decisive,
    ...(strength !== undefined && strength !== null ? { strength } : {}),
    thresholdProven: thresholds.thresholdProven,
    thresholdPartial: thresholds.thresholdPartial,
  });

  return {
    status: gate.status,
    matchedTechnologies,
    matchedCapabilities,
    matchedProjects,
    evidence: evidenceIds,
    shortfall: gate.shortfall,
  };
}

/**
 * The guarantee, in one function: keep whichever resolution came out WORSE.
 *
 * Everything the weighing pass claims it cannot do reduces to this comparison. It holds for a reply that
 * rates every row 1.0, for one naming ids from another candidate's record, and for one written by
 * someone who wants a better score, because none of those can produce a status that beats an answer the
 * model was never consulted about.
 *
 * A TIE goes to the WEIGHED side, and that is not a softening. Equal statuses mean the weighing changed
 * no verdict, so there is nothing to guard against — and the weighed resolution carries pruned
 * citations. Returning the deterministic object on a tie threw that away, which was measured to matter:
 * the Claude Code requirement kept citing Tendril through a capability the model had scored relevance 0,
 * and the rationale writer duly wrote a sentence about store certification.
 */
export function worseOf(deterministic: Resolution, weighed: Resolution): Resolution {
  const RANK: Record<string, number> = { proven: 2, partial: 1, gap: 0 };
  return (RANK[weighed.status] ?? 0) <= (RANK[deterministic.status] ?? 0) ? weighed : deterministic;
}

/** Below this relevance a row is coincidental: dropped from citations, never used to raise a verdict. */
export const RELEVANCE_FLOOR = 0.35;

export interface PortableJudgment {
  id: string;
  relevance: number;
  strength: number;
  receipt: string;
  reason: string;
  /** Why the strength was held down, if it was. Null when the model's number stood. */
  clamped: string | null;
}

/** Is this row backed? A capability by its own receipts, a technology by the projects it was used in. */
export function judgeBacked(kind: string, id: string, snapshot: ResolveSnapshot): boolean {
  if (kind === 'capability') {
    const cap = (snapshot.capabilities ?? []).find((c) => c.id === id);
    if (!cap) return false;
    return cap.tier !== 'stretch' && (cap.evidence ?? []).length > 0;
  }
  const tech = (snapshot.technologies ?? []).find((t) => t.id === id);
  if (!tech) return false;
  // A technology carries no receipts of its own; it borrows the standing of its projects.
  return (tech.projects ?? []).some((pid) => {
    const project = (snapshot.projects ?? []).find((p) => p.id === pid);
    return project !== undefined && project.reviewStatus !== 'needs-review' && (project.evidence ?? []).length > 0;
  });
}

/** Evidence labels a row may legitimately cite, lowercased. Technologies carry none of their own. */
export function judgeReceiptLabels(kind: string, id: string, snapshot: ResolveSnapshot): string[] {
  if (kind !== 'capability') return [];
  const cap = (snapshot.capabilities ?? []).find((c) => c.id === id);
  const out: string[] = [];
  for (const eid of cap?.evidence ?? []) {
    const row = (snapshot.evidence ?? []).find((e) => e.id === eid);
    if (row) out.push(String(row.label).trim().toLowerCase());
  }
  return out;
}

/**
 * Take the model's reply and make it safe to read. Every guarantee is enforced HERE, not in the prompt.
 *
 * The gate on the clamp is `thresholdProven`, not the ceiling it clamps TO. The prompt tells the model
 * to "score it 0.7 or below and leave receipt empty" when nothing backs a row, so a receipt is only
 * required ABOVE 0.7. Firing at > ceiling (0.69) clamped an as-instructed 0.7/empty-receipt row down to
 * 0.69, which `weighedThin` then demoted — eroding the score for following the instructions.
 */
export function applyJudgments(
  raw: unknown,
  candidates: readonly ScoredCandidate[],
  snapshot: ResolveSnapshot,
  thresholdProven: number,
): PortableJudgment[] {
  const UNPROVEN_CEILING = thresholdProven - 0.01;
  const clamp01 = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
  };

  const sent = candidates ?? [];
  const out: PortableJudgment[] = [];
  const rowsRaw = (raw as { judgments?: unknown })?.judgments;
  const rows = Array.isArray(rowsRaw) ? (rowsRaw as Array<Record<string, unknown>>) : [];

  for (const row of rows) {
    const id = typeof row?.['id'] === 'string' ? (row['id'] as string) : '';
    const candidate = sent.find((c) => c.id === id);
    if (!candidate) continue; // not a row we sent, so not a row that exists as far as this pass goes
    if (out.some((j) => j.id === id)) continue; // first answer wins; a second is the model arguing with itself

    const relevance = clamp01(row['relevance']);
    let strength = clamp01(row['strength']);
    const receipt = typeof row['receipt'] === 'string' ? (row['receipt'] as string).trim() : '';
    const reason = typeof row['reason'] === 'string' ? (row['reason'] as string).trim().slice(0, 200) : '';
    let clamped: string | null = null;

    if (strength > thresholdProven) {
      if (!judgeBacked(candidate.kind, id, snapshot)) {
        strength = UNPROVEN_CEILING;
        clamped = 'held below a direct hit: nothing verifiable is linked to this row';
      } else if (candidate.kind === 'capability') {
        // The named-receipt guard. Technologies carry no labels of their own, so it applies to
        // capabilities, which are the rows that can actually over-claim.
        const labels = judgeReceiptLabels(candidate.kind, id, snapshot);
        if (!receipt || labels.indexOf(receipt.toLowerCase()) === -1) {
          strength = UNPROVEN_CEILING;
          clamped = receipt
            ? 'held below a direct hit: cited a receipt that is not linked to this row ("' + receipt + '")'
            : 'held below a direct hit: no receipt was named to support it';
        }
      }
    }

    out.push({ id, relevance, strength, receipt, reason, clamped });
  }

  return out;
}

/**
 * The requirement's weighed strength: the best clamped strength among rows the model kept.
 *
 * Best rather than average, because a requirement is covered by the strongest thing that covers it. One
 * excellent receipt plus three incidental mentions has covered it; averaging punishes a thorough record.
 */
export function strengthOfJudgments(judgments: readonly PortableJudgment[]): number {
  let best = 0;
  for (const j of judgments ?? []) {
    if (j.relevance < RELEVANCE_FLOOR) continue;
    if (j.strength > best) best = j.strength;
  }
  return best;
}

/** Rows the model called coincidental. Dropped from citations; never used to raise a verdict. */
export function pruneCandidates<T extends { id: string }>(
  candidates: readonly T[],
  judgments: readonly PortableJudgment[],
): T[] {
  const all = (candidates ?? []) as T[];
  if (!judgments || judgments.length === 0) return [...all];
  const kept = all.filter((c) => {
    const j = judgments.find((x) => x.id === c.id);
    return !j || j.relevance >= RELEVANCE_FLOOR;
  });
  // Never prune to nothing: an empty citation list turns a real match into "no match in the record",
  // which reads as a gap the record does not actually have.
  return kept.length > 0 ? kept : [...all];
}

/*
 * ───────────────────────────────────────────────────────────────────────────────
 * DENSE RETRIEVAL.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * The workflow had no embeddings call at all — no cosine, no ceiling, nothing. It scored `best` from
 * lexical hits alone and printed a dense-only match as a gap. Meanwhile src/ui/api.ts published
 * embeddings as "ready — handled inside the workflow" and DESIGN.md described the step as "lexical +
 * embeddings, cosine, threshold". A degradation nobody could see is the one thing this repo's
 * "never a silent fallback" rule exists to prevent.
 */

/** A vector is a plain number array, which is also what survives the JSON hop between n8n nodes. */
export type PortableVector = readonly number[];

/**
 * Raw cosine of two vectors, 0 when they cannot be compared.
 *
 * Mismatched lengths return 0 rather than throwing: the two sides come from separate API responses, and
 * a truncated batch must degrade to lexical rather than take down a scoring run.
 */
export function cosine(a: PortableVector, b: PortableVector): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rescale a raw cosine into 0..1 against the band real matches actually occupy.
 *
 * Sentence embeddings do not use the full -1..1 range: unrelated strings sit around 0.3 and near-
 * identical ones around 0.85, so passing a raw cosine to a 0.7 threshold would mark almost nothing
 * proven. The floor and ceiling below map that real band onto the thresholds the gate is written for.
 */
export function normalizeCosine(raw: number): number {
  const COSINE_FLOOR = 0.3;
  const COSINE_CEILING = 0.85;
  const clamped = Math.min(COSINE_CEILING, Math.max(COSINE_FLOOR, raw));
  return (clamped - COSINE_FLOOR) / (COSINE_CEILING - COSINE_FLOOR);
}

/**
 * The dense score for one row, or 0 when there is nothing to compare.
 *
 * Capped below 1 on purpose: a literal name match is worth more than a semantic neighbour however close,
 * so a dense-only hit can clear the proven threshold but never outrank a row the posting actually named.
 */
export function denseScore(requirementVector: PortableVector | undefined, rowVector: PortableVector | undefined): number {
  const DENSE_CEILING = 0.95;
  if (!requirementVector || !rowVector || requirementVector.length === 0 || rowVector.length === 0) return 0;
  return normalizeCosine(cosine(requirementVector, rowVector)) * DENSE_CEILING;
}

/** The string a row is embedded as. Aliases and match terms are part of what the row means. */
export function embedTextForRow(row: { name: string; aliases?: readonly string[]; statement?: string; matchTerms?: readonly string[] }): string {
  if (row.aliases !== undefined) return [row.name].concat(row.aliases as string[]).join(', ');
  return [row.name, row.statement ?? ''].concat((row.matchTerms ?? []) as string[]).join('. ');
}

/** Stable key for a row's vector, so the corpus and the lookup cannot disagree about naming. */
export function vectorKeyFor(kind: string, id: string): string {
  return kind + ':' + id;
}

/*
 * ───────────────────────────────────────────────────────────────────────────────
 * RESOLVING LOOSE STRINGS AGAINST THE TAXONOMY.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * The extract workflow matched by normalised equality ONLY, while link.ts ran two further passes. So
 * "Node.js 20+" and "AWS Lambda functions" — both verbatim in raw/01-tendril-readme.md, both exactly
 * what the extraction prompt asks the model to produce — resolved in the app and landed in `unresolved`
 * in the workflow. Same blob, different links, therefore different matchedProjects and different
 * evidence at score time. `containsTerm` and `overlap` were already pasted into that Code node by
 * sharedRules(); nothing called them.
 */

/**
 * Find the technology row a loose string names, or nothing.
 *
 * Exact first across every alias, THEN containment. Order matters: "React" must land on the React row
 * rather than on whichever row happens to contain the substring first, and an exact hit anywhere in the
 * table outranks a containment hit anywhere else.
 */
export function matchTechnologyRow<T extends { name: string; aliases?: readonly string[] }>(
  raw: string,
  technologies: readonly T[],
): T | undefined {
  const needle = normalize(raw);
  if (!needle) return undefined;
  const rows = technologies ?? [];

  for (const tech of rows) {
    for (const alias of [tech.name].concat((tech.aliases ?? []) as string[])) {
      if (normalize(alias) === needle) return tech;
    }
  }
  for (const tech of rows) {
    for (const alias of [tech.name].concat((tech.aliases ?? []) as string[])) {
      if (containsTerm(needle, alias)) return tech;
    }
  }
  return undefined;
}

/**
 * Find the capability row a loose phrase names, or nothing.
 *
 * Exact first, then the best token overlap at or above 0.6 — capabilities are sentences, so a model
 * writing "builds automations that connect internal systems" is naming the row called "Workflow
 * automation" without sharing a term with it. BEST rather than first: two capabilities can both clear
 * the floor and the closer one should win, which is not the one that happens to be earlier in the table.
 */
export function matchCapabilityRow<T extends { name: string; matchTerms?: readonly string[] }>(
  raw: string,
  capabilities: readonly T[],
): T | undefined {
  const needle = normalize(raw);
  if (!needle) return undefined;
  const rows = capabilities ?? [];

  for (const cap of rows) {
    for (const term of [cap.name].concat((cap.matchTerms ?? []) as string[])) {
      if (normalize(term) === needle) return cap;
    }
  }

  const FLOOR = 0.6;
  let best: { cap: T; score: number } | undefined;
  for (const cap of rows) {
    let score = overlap(raw, cap.name);
    for (const term of (cap.matchTerms ?? []) as string[]) {
      const s = overlap(raw, term);
      if (s > score) score = s;
    }
    if (score >= FLOOR && (best === undefined || score > best.score)) best = { cap, score };
  }
  return best?.cap;
}

/**
 * Union two link lists, preserving order and dropping duplicates.
 *
 * An Airtable upsert REPLACES a linked-record cell — there is no append — so the extract workflow's
 * dedup path wrote only the links resolved from the run it was processing. On the documented dedup
 * demo that erased React, Vite, Tailwind, Electron, SQLite, Stripe and Cognito from the seeded Tendril
 * row, and with them the reverse `technology.projects` entries that resolution credits when it derives
 * which projects a requirement cites. The app has always merged before writing (`mergeProject`).
 */
export function unionLinks(existing: readonly string[] | undefined, incoming: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const list of [existing ?? [], incoming ?? []]) {
    for (const id of list) {
      if (id && out.indexOf(id) === -1) out.push(id);
    }
  }
  return out;
}

/** Lowercase, hyphenated slug. The identity key a project row is deduped on. */
export function slugOf(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface DuplicateVerdict<T> {
  duplicate: T | null;
  reason: string | null;
}

/**
 * Is this extraction a project we already have?
 *
 * Slug first, then name overlap at 0.8. The second arm is what catches "Tendril — agent-first IDE"
 * against "Tendril": different slugs, plainly the same project. The n8n lane had only the slug arm, so
 * that pair merged in the app and created a second row in the workflow — the same project split across
 * two rows, its evidence divided between them, both looking thinner than the work actually is.
 *
 * Parked rows are skipped on the overlap arm only: a needs-review row is not yet a fact about the
 * record, and merging into one would bury a real extraction inside a failed one.
 */
export function duplicateProjectOf<T extends { slug?: string; name: string; reviewStatus?: string }>(
  projects: readonly T[],
  candidateName: string,
): DuplicateVerdict<T> {
  const THRESHOLD = 0.8;
  const slug = slugOf(candidateName);
  const rows = projects ?? [];

  for (const project of rows) {
    if ((project.slug ?? slugOf(project.name)) === slug) return { duplicate: project, reason: 'same slug' };
  }
  for (const project of rows) {
    if (project.reviewStatus !== undefined && project.reviewStatus !== 'ok') continue;
    if (overlap(candidateName, project.name) >= THRESHOLD) {
      return { duplicate: project, reason: 'name overlaps "' + project.name + '"' };
    }
  }
  return { duplicate: null, reason: null };
}

/**
 * Scope a row key to its candidate, leaving the seed candidate's keys plain.
 *
 * The convention `ingestResume` set, stated once so every writer follows it. The seed candidate keeps
 * bare slugs because the seed, the fixtures and every test know them by name; anyone else's rows are
 * prefixed, so two applicants' "Tendril" rows cannot collide on Key.
 *
 * Three keys were missing it and each produced a different flavour of the same bug:
 *
 *   Roles — `role-<slug>-<date>` with no candidate at all. Two applicants scored against one posting on
 *   one day shared a row: Score became last-writer-wins, both sets of Results linked to it, the
 *   rollups in airtable/VIEWS.md counted 32 against a Requirement Count of 16 ("Meets 20 of 16
 *   requirements"), and the delivered recruiter link — which filters on Role and nothing else — listed
 *   both people's verdicts under one person's name. Every row was stamped correctly; isolation failed
 *   only at the surface the recruiter actually reads.
 *
 *   The Needs Review stub — `unparsed-<sourceName>`, where sourceName defaults to `pasted-input`
 *   everywhere. Two applicants' failed ingests collided on one row, so A's parked record ceased to
 *   exist and reappeared inside B's, after A had been told it was parked.
 */
export function scopedKey(candidateId: string, key: string, seedCandidateId: string): string {
  const owner = String(candidateId ?? '').trim();
  if (!owner || owner === seedCandidateId) return key;
  return owner + '-' + key;
}

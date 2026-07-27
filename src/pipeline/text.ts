/**
 * Text normalisation shared by the matcher and the validator.
 *
 * Kept in one place because the alias table only works if the string that goes into it was normalised
 * the same way the alias was. Two slightly different lowercase-and-strip helpers is a bug that presents
 * as "the matcher just doesn't find Node.js sometimes".
 */

/**
 * Lowercase, fold curly quotes, and reduce runs of anything-not-alphanumeric to single spaces — except
 * the four characters that carry meaning inside a technology name.
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
  return input
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(input: string): string {
  return input.replace(REGEX_SPECIALS, '\\$&');
}

/*
 * `\b` is wrong for these strings and the failure is silent. In `c#`, the boundary sits between `c` and
 * `#`, so `/\bc#\b/` never matches "c#" — the trailing `\b` wants a word character after `#` and there
 * is none. Same story for `node.js` and `ci/cd`. The lookarounds below handle every case the `+#./`
 * survivors above can produce.
 */
/**
 * Does `haystack` contain `needle` as a whole term?
 *
 * Two rules, and each one exists because of a specific wrong answer:
 *
 * **Plurals.** `(?:e?s)?` on the end. Postings pluralise constantly — "structured outputs", "internal
 * tools", "REST APIs" — and without it the term "structured output" fails against "structured outputs",
 * because the trailing boundary sees the `s`. One character, several requirements silently scoring zero.
 *
 * **Hyphens.** A single-word term treats `-` as part of a word, so `react` does not match
 * `react-three-fiber`. It used to, and the fit report cheerfully cited a Unity game as React experience.
 * A multi-word term folds hyphens to spaces on both sides instead, so `rest api` still matches
 * `rest-api`. The asymmetry is the point: inside a compound word a hyphen joins, between words it
 * separates.
 */
export function containsTerm(haystack: string, needle: string): boolean {
  const term = normalize(needle);
  if (!term) return false;

  if (term.includes(' ')) {
    const folded = haystack.replace(/-/g, ' ');
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(term)}(?:e?s)?(?![a-z0-9])`, 'i');
    return pattern.test(folded);
  }

  const pattern = new RegExp(`(?<![a-z0-9-])${escapeRegex(term)}(?:e?s)?(?![a-z0-9-])`, 'i');
  return pattern.test(haystack);
}

/** Words worth ignoring when comparing two phrases. Short, and only words that carry no signal here. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from',
  'is', 'are', 'be', 'been', 'we', 'you', 'your', 'our', 'their', 'it', 'this', 'that', 'these',
  'experience', 'strong', 'solid', 'proven', 'excellent', 'good', 'ability', 'able', 'work',
  'working', 'using', 'use', 'skills', 'knowledge', 'familiarity', 'familiar', 'plus', 'bonus',
  'years', 'year', 'must', 'should', 'have', 'has', 'including', 'etc',
]);

/**
 * Crude suffix stripping, applied only inside `overlap`.
 *
 * Not a real stemmer and not trying to be. It exists because a posting writes "integrating large
 * language models" where a capability statement writes "LLM application integration", and without
 * folding those to a shared root the two share no tokens at all and the requirement scores zero.
 *
 * The `at` rule runs first so integrate / integrating / integration all land on `integrat`; the general
 * rule then handles ordinary plurals and gerunds. Over-stemming is tolerable here because `overlap`
 * requires half the smaller token set to match before it reports anything.
 */
export function stem(token: string): string {
  return token.replace(/(ations?|ating|ated|ate)$/, 'at').replace(/(ing|ed|es|s)$/, '');
}

export function tokens(input: string): string[] {
  return normalize(input)
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => t.length > 1);
}

/**
 * Jaccard overlap of two token sets, 0..1.
 *
 * This is the floor beneath dense retrieval, not a replacement for it: it catches "builds automations
 * that connect systems" against "workflow automation" and misses anything requiring actual synonymy.
 * When a key is present, embeddings cover what this cannot; when there is no key, the UI says the
 * matcher is running lexical-only rather than pretending the result is equivalent.
 */
export function overlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

/**
 * Every standalone figure in a string, as written. Feeds the fabrication guard in rationale.ts.
 *
 * Digits touching letters are skipped, because they are part of an identifier rather than a claim —
 * `e2e`, `n8n`, `s3`, `gpt-4o`. Counting those produced phantom numbers that the guard then went looking
 * for in the source records, and rejected perfectly good sentences over.
 */
export function numbersIn(input: string): string[] {
  return (input.match(/(?<![a-z0-9])\d[\d,]*(?![a-z])/gi) ?? []).map((n) => n.replace(/,$/, ''));
}

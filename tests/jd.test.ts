/**
 * The posting reader's three passes, and the dead end that made passes 2 and 3 necessary.
 *
 * Measured before the fix: a typical LinkedIn paste (headings, then plain unmarked lines) parsed to
 * ZERO requirements, and so did a prose-only posting, because only an explicit bullet marker counted as
 * an item. On the hosted static build there is no key to fall through to, so zero requirements is not a
 * degraded report — it is an empty one, in the deployed product.
 *
 * These tests pin the fix in both directions: the new passes find the requirements, and they never fire
 * on a posting the bulleted pass already read (which is what protects the regression anchor).
 */

import { describe, expect, it } from 'vitest';
import { parseRole, parseRoleDeterministically, UnreadablePostingError } from '@/pipeline/jd';
import { SAMPLE_POSTING } from '@/ui/sample-posting';

const keyless = { apiKey: undefined };

/** Headings survive a LinkedIn copy-paste; the bullet glyphs do not. This is the shape that failed. */
const UNMARKED = `AI Product Engineer
Contoso Labs · Remote

About the job

We are hiring an AI Product Engineer to own our internal tooling end to end.

Responsibilities

Build and maintain full-stack web applications in React and TypeScript
Design and maintain Airtable bases that back internal tools
Build workflow automations in n8n and Zapier across the CRM and forms
Integrate LLM APIs into applications and workflows where they add value

Requirements

Demonstrated experience shipping full-stack web projects
Hands-on experience integrating AI or LLM services into applications

Nice to have

Familiarity with Claude Code or a willingness to adopt it

Benefits

Health, dental and vision from day one
`;

/** No list of any kind. The company talks about itself first, which must not become requirements. */
const PROSE = `Product Engineer at Northwind Systems

Northwind Systems is a small team building tools for operations leaders. We started in a garage and we
have not lost that energy since.

You will build and maintain the web applications our operators use every day, working in React and
TypeScript alongside a Python service layer. You will design the data model in Airtable and keep it
clean as the product grows. You will integrate LLM services into the product where they genuinely help
and leave them out where they do not. Experience with AWS and infrastructure as code is important
because you will own the deploys.
`;

describe('pass 1 — an explicit list', () => {
  it('reads the bundled sample off its bullets and never reaches another pass', () => {
    const parsed = parseRoleDeterministically(SAMPLE_POSTING);
    expect(parsed.requirements).toHaveLength(16);
    expect(parsed.pass).toBe('bulleted');
    expect(parsed.company).toBe('Northwind Systems');
  });

  it('reads a posting written with • characters', () => {
    const parsed = parseRoleDeterministically(`Senior Automation Engineer
Fabrikam · Hybrid

Requirements

• Strong experience using Airtable as an application backend
• Experience with workflow automation platforms such as n8n and Zapier
• Hands-on experience integrating AI or LLM services into applications
• Comfort operating as a sole engineer, self-directed and disciplined about scope
`);
    expect(parsed.requirements).toHaveLength(4);
    expect(parsed.pass).toBe('bulleted');
  });
});

describe('pass 2 — a list nobody marked', () => {
  const parsed = parseRoleDeterministically(UNMARKED);

  it('reads the plain lines under a requirement heading', () => {
    expect(parsed.pass).toBe('unmarked');
    expect(parsed.requirements.length).toBeGreaterThanOrEqual(7);
    expect(parsed.requirements.map((r) => r.text)).toContain(
      'Build and maintain full-stack web applications in React and TypeScript',
    );
  });

  it('keeps section state across the pass', () => {
    const claudeCode = parsed.requirements.find((r) => /Claude Code/.test(r.text));
    expect(claudeCode?.kind, 'the "Nice to have" heading governs the lines under it').toBe('preferred');
    const react = parsed.requirements.find((r) => /React and TypeScript/.test(r.text));
    expect(react?.kind).toBe('required');
  });

  it('stops at a heading that is not asking for anything', () => {
    // "About the job" and "Benefits" close the section; what sits under them is not a requirement.
    const texts = parsed.requirements.map((r) => r.text).join(' | ');
    expect(texts).not.toMatch(/we are hiring/i);
    expect(texts).not.toMatch(/dental/i);
  });
});

describe('pass 3 — no list at all', () => {
  const parsed = parseRoleDeterministically(PROSE);

  it('reads requirements out of the paragraphs', () => {
    expect(parsed.pass).toBe('prose');
    expect(parsed.requirements.length).toBeGreaterThanOrEqual(4);
    expect(parsed.requirements.map((r) => r.text).join(' | ')).toMatch(/Airtable/);
  });

  it('rejoins hard-wrapped lines instead of cutting sentences in half', () => {
    // Split on newlines alone this arrives as "...working in React and" plus a fragment starting
    // "TypeScript alongside...", and both score as their own requirement.
    expect(parsed.requirements.map((r) => r.text)).toContain(
      'You will build and maintain the web applications our operators use every day, working in React and TypeScript alongside a Python service layer',
    );
  });

  it('leaves the company introducing itself out of the report', () => {
    // A blurb sentence read as a requirement matches nothing and scores as a gap — a fabricated
    // failure, which is the one thing this whole file is written to avoid.
    const texts = parsed.requirements.map((r) => r.text).join(' | ');
    expect(texts).not.toMatch(/is a small team/i);
    expect(texts).not.toMatch(/garage/i);
  });

  it('caps the count so a long blurb cannot explode into noise', () => {
    const blurb = Array.from(
      { length: 60 },
      (_, i) => `You will build and maintain internal tooling number ${i} across the estate.`,
    ).join('\n\n');
    expect(parseRoleDeterministically(`Engineer\n\n${blurb}`).requirements.length).toBeLessThanOrEqual(20);
  });
});

describe('never a silent fallback', () => {
  it('carries no note when the bulleted primary produced the result', async () => {
    const outcome = await parseRole(SAMPLE_POSTING, keyless);
    expect(outcome.via).toBe('deterministic');
    expect(outcome.note).toBeNull();
  });

  it('names the unmarked pass in the note', async () => {
    const outcome = await parseRole(UNMARKED, keyless);
    expect(outcome.note).toBe(
      'This posting has no bulleted list, so its requirements were read from the lines under its headings.',
    );
  });

  it('says what the reader did, not that a model was missing', async () => {
    // Keyless is the hosted demo's permanent state, and reading a posting in code is the DESIGNED
    // primary — so a note here must describe the pass, never report the absent model as a fault. The
    // note used to read "no key set, read from prose" and then got wrapped in "Posting parsed without
    // a model (…)", which fired on every run of the public demo and read as breakage. Joel hit it.
    const outcome = await parseRole(
      'Engineer\n\nYou will build and maintain the React front end for our operators.\n',
      keyless,
    );
    expect(outcome.note).toBe(
      'This posting has no list at all, so its requirements were read from its sentences.',
    );
    expect(outcome.note).not.toMatch(/model|key/i);
    expect(outcome.role.requirements.length).toBeGreaterThan(0);
  });

  it('raises rather than returning an empty report when every pass comes back empty', async () => {
    // An empty role renders as a fit report with no rows, a 0 percent score and a Gaps section reading
    // "every requirement came out proven". That looks like an answer and is not one.
    await expect(parseRole('Hello there.\n\nThanks for reading.\n', keyless)).rejects.toThrow(
      UnreadablePostingError,
    );
    await expect(parseRole('Hello there.\n\nThanks for reading.\n', keyless)).rejects.toThrow(
      /No requirements could be read/,
    );
  });
});

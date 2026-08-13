/**
 * The posting reader's three passes, the dead end that made passes 2 and 3 necessary, and which reader
 * answers for which shape of posting.
 *
 * Measured before the passes existed: a typical LinkedIn paste (headings, then plain unmarked lines)
 * parsed to ZERO requirements, and so did a prose-only posting, because only an explicit bullet marker
 * counted as an item. On the hosted static build there is no key to fall through to, so zero
 * requirements is not a degraded report — it is an empty one, in the deployed product.
 *
 * Measured after: the passes cleared the old ">= 4 requirements" gate on sentence heuristics, so the
 * model stopped running on prose, the one shape it reads better. The gate is now keyed on WHICH pass
 * answered — see the header of src/pipeline/jd.ts for the side-by-side numbers.
 *
 * These tests pin all of it: the new passes find the requirements, they never fire on a posting the
 * bulleted pass already read (which is what protects the regression anchor), a posting with a list never
 * spends a model call, and a prose posting with a key does.
 *
 * The model lane is exercised through `LlmOptions.fetchImpl`. No test here ever performs a live call.
 */

import { describe, expect, it } from 'vitest';
import { matchRole } from '@/pipeline';
import { parseRole, parseRoleDeterministically, UnreadablePostingError } from '@/pipeline/jd';
import { LocalStore } from '@/store/local';
import { SAMPLE_POSTING } from '@/ui/sample-posting';

const keyless = { apiKey: undefined };

const UNMARKED_NOTE =
  'This posting has no bulleted list, so its requirements were read from the lines under its headings.';
const PROSE_NOTE = 'This posting has no list at all, so its requirements were read from its sentences.';
const MODEL_NOTE =
  'This posting has no list, so its requirements were read by the posting-parsing model rather than in code.';

/** An OpenRouter-shaped 200 whose completion is the given object, recording every request it sees. */
function cannedModel(payload: unknown, requests: Array<Record<string, unknown>>): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        model: 'openai/gpt-4o-mini',
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

/**
 * A fetch that records every call and then fails.
 *
 * The recorded count is what the assertion reads, not the throw: `callJson` catches a thrown fetch and
 * turns it into a typed offline failure, so a bare throw here would be swallowed and the test would pass
 * on a run that did spend the call.
 */
function forbiddenModel(calls: string[]): typeof fetch {
  return (async (url: unknown) => {
    calls.push(String(url));
    throw new Error('a posting with a list must not spend a model call');
  }) as typeof fetch;
}

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
    expect(outcome.note).toBe(UNMARKED_NOTE);
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
    expect(outcome.note).toBe(PROSE_NOTE);
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

describe('which reader answers, keyed on the posting’s shape', () => {
  const withKey = { apiKey: 'test-key' };

  it('reads a bulleted posting in code and spends no model call, key or no key', async () => {
    const calls: string[] = [];
    const outcome = await parseRole(SAMPLE_POSTING, { ...withKey, fetchImpl: forbiddenModel(calls) });

    expect(calls).toEqual([]);
    expect(outcome.via).toBe('deterministic');
    expect(outcome.model).toBe('none');
    expect(outcome.role.requirements).toHaveLength(16);
    expect(outcome.note).toBeNull(); // the designed primary, not a degradation
  });

  it('reads an unmarked list in code too, which is why the gate is not "was it bulleted"', async () => {
    // The reported failure: LinkedIn's bullet glyphs are not selectable, so a real paste arrives with the
    // line breaks intact and no markers at all. Measured on the sample posting with every marker stripped,
    // code returned all 16 requirement lines verbatim while the model returned 13 paraphrases, dropped
    // three bullets outright and marked five must-haves preferred. Handing this shape to the model was the
    // obvious reorder and the measurement refused it.
    const calls: string[] = [];
    const outcome = await parseRole(UNMARKED, { ...withKey, fetchImpl: forbiddenModel(calls) });

    expect(calls).toEqual([]);
    expect(outcome.via).toBe('deterministic');
    expect(outcome.model).toBe('none');
    expect(outcome.note).toBe(UNMARKED_NOTE);
    expect(outcome.role.requirements.length).toBeGreaterThanOrEqual(7);
  });

  it('sends a prose posting to the jd-parsing tier and re-validates the reply', async () => {
    // Under the old gate this never happened: the prose pass found more than four requirements, cleared
    // the "structured enough" bar on sentence heuristics, and returned before the model was consulted.
    const requests: Array<Record<string, unknown>> = [];
    const outcome = await parseRole(PROSE, {
      ...withKey,
      fetchImpl: cannedModel(
        {
          title: 'Product Engineer',
          company: 'Northwind Systems',
          requirements: [
            { text: 'React', kind: 'required', category: 'frontend' },
            { text: 'TypeScript', kind: 'required', category: 'frontend' },
            { text: 'Airtable data modelling', kind: 'required', category: 'data' },
            { text: 'LLM API integration', kind: 'required', category: 'ai' },
            { text: 'Infrastructure as code on AWS', kind: 'preferred', category: 'cloud' },
          ],
        },
        requests,
      ),
    });

    expect(outcome.via).toBe('model');
    expect(outcome.model).toBe('openai/gpt-4o-mini');
    expect(outcome.role.requirements).toHaveLength(5);
    expect(outcome.role.requirements.map((r) => r.text)).toContain('Airtable data modelling');
    expect(outcome.role.requirements[4]?.kind).toBe('preferred');
    // Whichever engine answered, the reviewer is told which one. A paraphrased row and a verbatim one
    // are worth different amounts to someone checking the report against the posting they wrote.
    expect(outcome.note).toBe(MODEL_NOTE);

    // The real request body, because both OpenRouter traps live there.
    expect(requests).toHaveLength(1);
    const body = requests[0] as {
      models: string[];
      response_format: { json_schema: { name: string; strict: boolean } };
      provider: { require_parameters: boolean };
    };
    expect(body.models[0]).toBe('openai/gpt-4o-mini'); // the jd-parsing tier's primary
    expect(body.models.length).toBeLessThanOrEqual(3);
    expect(body.response_format.json_schema.name).toBe('role_parse');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider.require_parameters).toBe(true);
  });

  it('keeps the deterministic prose read when there is no key, and says which pass it was', async () => {
    const outcome = await parseRole(PROSE, keyless);

    expect(outcome.via).toBe('deterministic');
    expect(outcome.model).toBe('none');
    expect(outcome.role.requirements.length).toBeGreaterThanOrEqual(4);
    expect(outcome.note).toBe(PROSE_NOTE);
    expect(outcome.note).not.toMatch(/model|key/i); // no key is not a degradation on the hosted demo
  });

  it('falls back to the prose read when the model was expected and failed, and names both halves', async () => {
    const outcome = await parseRole(PROSE, {
      ...withKey,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });

    expect(outcome.via).toBe('deterministic');
    expect(outcome.role.requirements.length).toBeGreaterThanOrEqual(4);
    expect(outcome.note).toBe(
      `The posting-parsing model was unavailable (network unreachable), so the posting was read in code instead. ${PROSE_NOTE}`,
    );
  });

  it('keeps the deterministic read when the model answers with nothing usable', async () => {
    const outcome = await parseRole(PROSE, {
      ...withKey,
      fetchImpl: cannedModel({ title: 'Product Engineer', company: '', requirements: [] }, []),
    });

    expect(outcome.via).toBe('deterministic');
    expect(outcome.role.requirements.length).toBeGreaterThanOrEqual(4);
    expect(outcome.note).toMatch(/^The posting-parsing model was unavailable \(it returned no requirements\)/);
  });
});

describe('the regression anchor', () => {
  it('still scores the bundled posting 75 — 10 proven, 4 partial, 2 gaps across 16 requirements', async () => {
    // The number on Joel's resume, in his cover letter and in the live Airtable base. The sample is
    // bulleted, so the reorder must not touch it: pass 1 answers, no model is consulted, sixteen rows.
    const report = await matchRole(SAMPLE_POSTING, new LocalStore(), keyless);

    expect(report.role.requirements).toHaveLength(16);
    expect(report.coverage.score).toBe(75);
    expect(report.coverage.proven).toBe(10);
    expect(report.coverage.partial).toBe(4);
    expect(report.coverage.gap).toBe(2);
    expect(report.parseVia).toBe('deterministic');
  });
});

describe('a marked bullet is an item, never a section heading', () => {
  /**
   * REGRESSION. `readBulletedList` tested the heading regexes before stripping the bullet marker, so a
   * short bulleted requirement whose text happened to contain a heading word was swallowed as a heading
   * and never collected. Measured on the two most ordinary phrasings a posting uses.
   */
  it('collects a bulleted "Must have ..." instead of eating it as a heading', () => {
    const role = parseRoleDeterministically(
      ['Engineer', '', 'Requirements', '- Must have experience with React', '- Comfortable with SQL'].join('\n'),
    );
    const texts = role.requirements.map((r) => r.text);
    expect(texts).toContain('Must have experience with React');
    expect(texts).toContain('Comfortable with SQL');
  });

  it('a bulleted "Bonus: ..." is an item and does not flip the section for the bullets after it', () => {
    // The compounding half of the bug: the swallowed bullet also switched section state, so every
    // following required bullet was recorded as preferred and silently half-weighted in coverage.
    const role = parseRoleDeterministically(
      ['Engineer', '', 'Requirements', '- Bonus: familiarity with Zapier', '- Ship a React front end'].join('\n'),
    );
    const shipIt = role.requirements.find((r) => r.text.includes('React front end'));
    expect(shipIt?.kind).toBe('required');
    expect(role.requirements.map((r) => r.text)).toContain('Bonus: familiarity with Zapier');
  });

  it('an UNMARKED heading line still opens its section', () => {
    // The regexes keep their real job: only a line with no bullet marker can be a heading.
    const role = parseRoleDeterministically(
      ['Engineer', '', 'Requirements', '- Ship a React front end', 'Nice to have', '- Zapier'].join('\n'),
    );
    expect(role.requirements.find((r) => r.text === 'Zapier')?.kind).toBe('preferred');
    expect(role.requirements.find((r) => r.text.includes('React'))?.kind).toBe('required');
  });

  it('leaves the pinned sample posting exactly where it was', () => {
    expect(parseRoleDeterministically(SAMPLE_POSTING).requirements).toHaveLength(16);
  });
});

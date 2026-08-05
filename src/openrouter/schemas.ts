/**
 * The JSON schemas the models are held to.
 *
 * Three rules learned the hard way, and every one of them cost a debugging session:
 *
 *  1. No `minimum` / `maximum` on numbers. Anthropic's structured outputs reject range constraints and
 *     return a 400 from every provider, which — behind a fallback chain — looks exactly like the model
 *     being unavailable. Range checks belong in validate.ts, where the reply is treated as the untrusted
 *     input it always was.
 *  2. Every property listed in `required`, and `additionalProperties: false` everywhere. Strict mode
 *     demands it, and a schema that is quietly non-strict is a schema that is quietly not applied.
 *  3. Optional means `["string", "null"]`, never an absent key. A model asked for an optional field will
 *     otherwise omit it inconsistently, and the difference between "no commits recorded" and "zero
 *     commits" matters when the whole product is about not overstating.
 */

/** What extraction pulls out of one messy blob. Deliberately nested — this is the hard tier's job. */
export const PROJECT_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'role',
    'started',
    'ended',
    'status',
    'summary',
    'metrics',
    'stack',
    'achievements',
    'evidence',
    'capabilities',
  ],
  properties: {
    name: { type: 'string', description: 'The project name exactly as the source writes it.' },
    role: { type: 'string', description: 'What the person did on it, e.g. "Solo developer".' },
    started: { type: 'string', description: 'YYYY-MM. Empty string if the source does not say.' },
    ended: { type: ['string', 'null'], description: 'YYYY-MM, or null if ongoing or unstated.' },
    status: {
      type: 'string',
      enum: ['shipped', 'live', 'delivered', 'in-development', 'unknown'],
    },
    summary: { type: 'string', description: 'One or two sentences. No adjectives the source did not use.' },
    metrics: {
      type: 'object',
      additionalProperties: false,
      required: ['loc', 'tests', 'commits', 'files'],
      properties: {
        loc: { type: ['integer', 'null'] },
        tests: { type: ['integer', 'null'] },
        commits: { type: ['integer', 'null'] },
        files: { type: ['integer', 'null'] },
      },
    },
    stack: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named technologies. Only ones the source actually names.',
    },
    achievements: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific, checkable things that happened. Not qualities.',
    },
    evidence: {
      type: 'array',
      description: 'Anything a stranger could verify: a URL, a store id, a count, a rating.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value', 'url', 'kind'],
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
          url: { type: ['string', 'null'] },
          kind: {
            type: 'string',
            enum: [
              'store-listing',
              'live-url',
              'test-count',
              'repo-metric',
              'infra-metric',
              'video',
              'certification',
              'client-review',
              'artifact',
            ],
          },
        },
      },
    },
    capabilities: {
      type: 'array',
      items: { type: 'string' },
      description: 'What building this demonstrates the person can do, in plain words.',
    },
  },
} as const;

/** What JD parsing pulls out of a pasted posting. Flat and short — the medium tier handles it fine. */
export const ROLE_PARSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'company', 'requirements'],
  properties: {
    title: { type: 'string' },
    company: { type: 'string', description: 'Empty string if the posting does not name one.' },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind', 'category'],
        properties: {
          text: {
            type: 'string',
            description: 'One requirement, rewritten as a short noun phrase. Split bundled bullets apart.',
          },
          kind: {
            type: 'string',
            enum: ['required', 'preferred'],
            description: '"required" for must-haves, "preferred" for nice-to-haves and bonuses.',
          },
          category: {
            type: 'string',
            enum: ['frontend', 'backend', 'automation', 'ai', 'data', 'cloud', 'process', 'domain'],
          },
        },
      },
    },
  },
} as const;

/**
 * What resume parsing pulls out of a pasted resume. (DESIGN.md §v3.3)
 *
 * Identity plus claims, and nothing that implies verification: skills and experience statements arrive
 * as assertions, and the evidence gate downstream is what decides how far an assertion travels. The
 * model is never asked whether a claim is credible — only what the resume actually says.
 */
export const RESUME_PARSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'contact', 'skills', 'projects', 'claims'],
  properties: {
    name: { type: 'string', description: 'The name as the resume header writes it. Empty string if none is stated.' },
    contact: {
      type: 'string',
      description: 'Email, phone and links from the header, joined with " · ". Empty string if none.',
    },
    skills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named skills and technologies, one per entry. Only ones the resume actually names.',
    },
    projects: {
      type: 'array',
      description: 'One entry per position or named project in the experience sections.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role', 'summary'],
        properties: {
          name: { type: 'string', description: 'Employer, product or project name.' },
          role: { type: 'string', description: 'The title held there. Empty string if unstated.' },
          summary: { type: 'string', description: 'One line, in the words the resume uses. No added adjectives.' },
        },
      },
    },
    claims: {
      type: 'array',
      items: { type: 'string' },
      description: 'Experience statements, one per entry, kept close to the wording on the page. These are unverified claims, not facts.',
    },
  },
} as const;

/**
 * What the weighing model returns, one entry per row retrieval already found. (DESIGN.md §v3.8)
 *
 * `id` is the tell that this call cannot invent anything: the model is echoing back identifiers it was
 * handed, and judge.ts drops any id that was not in the list it sent. There is no field here for a new
 * project, a new technology, or a new claim, so the worst a compromised reply can do is misjudge rows
 * that already exist.
 *
 * `receipt` is the fabrication guard, and it is the reason strength is not just a number. A model may
 * say a row is strong; to be believed past the proven line it has to name which receipt makes it strong,
 * and that name is checked against the row's own evidence labels in code.
 */
export const JUDGMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['judgments'],
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'relevance', 'strength', 'receipt', 'reason'],
        properties: {
          id: { type: 'string', description: 'Copy an id from the list exactly. Never invent one.' },
          relevance: {
            type: 'number',
            description: '0 to 1. Does this row speak to THIS requirement at all? 0 means a coincidence of wording.',
          },
          strength: {
            type: 'number',
            description:
              '0 to 1. How strongly does the work behind this row demonstrate the requirement, judged on ' +
              'technical difficulty, how much was actually built, how recent it is, and what it proves.',
          },
          receipt: {
            type: 'string',
            description:
              'The exact label of the one receipt that justifies a strength above 0.7, copied from the ' +
              'evidence shown for this row. Empty string when the strength does not need one.',
          },
          reason: { type: 'string', description: 'One short clause. What the score is based on.' },
        },
      },
    },
  },
} as const;

/**
 * What the rationale model returns. One field, because one field is all it is trusted with.
 *
 * The score is already computed before this call is made. The model is being handed a decision and asked
 * to describe it — it cannot change the outcome, only the wording, which is why an 8B is the honest
 * choice here rather than a cost-cutting compromise.
 */
export const RATIONALE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rationale'],
  properties: {
    rationale: { type: 'string' },
  },
} as const;

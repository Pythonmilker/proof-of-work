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

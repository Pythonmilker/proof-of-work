/**
 * The Airtable base, defined once.
 *
 * Six tables, small enough to read in one screenshot. It was five, and the sixth is a correction worth
 * recording: `Roles` used to hold its requirements and results as escaped JSON inside two long-text
 * fields, to protect a self-imposed five-table rule whose stated cost was "every extra table costs a
 * column in the screenshot".
 *
 * That reasoning was wrong twice. Airtable renders tables as horizontal tabs, so six versus five is
 * visually identical. And JSON in a long-text field disables everything Airtable is for: you cannot
 * filter to the roles where n8n came out a gap, cannot group by status, cannot colour a status cell,
 * cannot fire an automation on a gap, and cannot build the requirement grid in an Interface. It also
 * broke the link graph at the one table holding the output, since the cited projects and receipts were
 * slugs buried in a string rather than links.
 *
 * `tests/schema-parity.test.ts` checks these definitions against `src/store/types.ts` so the two cannot
 * drift.
 *
 * ## The two-pass problem
 *
 * A `multipleRecordLinks` field needs `linkedTableId`, and the target table does not have an id until
 * the base has been created. So the base is created with its plain fields first, and the link fields are
 * added in a second pass once every table id is known. That is not a workaround for a bug; it falls out
 * of how the Meta API is shaped, and any script that creates a relational base has to do it.
 *
 * ## Keys
 *
 * Every table carries a `Key` text field holding our slug. Airtable identifies records with opaque
 * `recXXXX` ids that do not exist until a row is written, and everything else in this codebase
 * identifies them by slug, so something has to hold the translation. Field types verified against
 * airtable.com/developers/web/api/field-model.
 */

export interface FieldSpec {
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
}

export interface LinkSpec {
  table: string;
  field: string;
  linkedTable: string;
  description?: string;
}

export interface TableSpec {
  name: string;
  description: string;
  /** The first entry is the primary field, and must be a type Airtable allows as one. */
  fields: FieldSpec[];
}

const KEY_FIELD: FieldSpec = {
  name: 'Key',
  type: 'singleLineText',
  description: 'Stable slug used by the pipeline. Airtable record ids are opaque; this is the join key.',
};

const select = (name: string, choices: string[], description?: string): FieldSpec => ({
  name,
  type: 'singleSelect',
  ...(description ? { description } : {}),
  options: { choices: choices.map((c) => ({ name: c })) },
});

const number = (name: string, description?: string): FieldSpec => ({
  name,
  type: 'number',
  ...(description ? { description } : {}),
  options: { precision: 0 },
});

export const TABLES: TableSpec[] = [
  {
    name: 'Projects',
    description: 'One row per piece of work. Metrics only ever come from a real artifact.',
    fields: [
      { name: 'Name', type: 'singleLineText' },
      KEY_FIELD,
      { name: 'Role', type: 'singleLineText' },
      {
        name: 'Started',
        type: 'singleLineText',
        description: 'YYYY-MM as text, not a date. A half-known date is honest; a coerced one is not.',
      },
      { name: 'Ended', type: 'singleLineText' },
      select('Status', ['shipped', 'live', 'delivered', 'in-development']),
      { name: 'Summary', type: 'multilineText' },
      number('LOC'),
      number('Tests'),
      number('Commits'),
      number('Files'),
      select('Review Status', ['ok', 'needs-review'], 'Drives the Needs Review view.'),
      {
        name: 'Review Reason',
        type: 'multilineText',
        description: 'The validator problem list, verbatim. A failed extraction is stored, never dropped.',
      },
      { name: 'Source', type: 'singleLineText', description: 'Which raw artifact produced this row.' },
      { name: 'Ingested At', type: 'singleLineText' },
    ],
  },
  {
    name: 'Technologies',
    description: 'The vocabulary a job description might use. Widening a match is a row edit here.',
    fields: [
      { name: 'Name', type: 'singleLineText' },
      KEY_FIELD,
      {
        name: 'Aliases',
        type: 'multilineText',
        description: 'Comma separated. Every spelling a posting has actually used: React.js, AWS Lambda, n8n.io.',
      },
      select('Category', ['language', 'framework', 'cloud', 'data', 'automation', 'ai', 'payments', 'tooling']),
    ],
  },
  {
    name: 'Capabilities',
    description: 'What the work demonstrates. Tier and Evidence together decide what may be claimed.',
    fields: [
      { name: 'Name', type: 'singleLineText' },
      KEY_FIELD,
      { name: 'Statement', type: 'multilineText' },
      select('Tier', ['proven', 'stretch'], 'A stretch capability is capped at partial credit, whatever it matches.'),
      { name: 'Match Terms', type: 'multilineText', description: 'Comma separated JD phrasings.' },
    ],
  },
  {
    name: 'Evidence',
    description: 'The receipts. Anything a stranger could check without help.',
    fields: [
      { name: 'Label', type: 'singleLineText' },
      KEY_FIELD,
      select('Kind', [
        'store-listing',
        'live-url',
        'test-count',
        'repo-metric',
        'infra-metric',
        'video',
        'certification',
        'client-review',
        'artifact',
      ]),
      { name: 'Value', type: 'singleLineText', description: 'The receipt itself, exactly as written.' },
      { name: 'URL', type: 'url' },
      { name: 'Verified On', type: 'singleLineText' },
    ],
  },
  {
    name: 'Roles',
    description: 'Pasted job descriptions. One row per posting scored against the record.',
    fields: [
      { name: 'Title', type: 'singleLineText' },
      KEY_FIELD,
      { name: 'Company', type: 'singleLineText' },
      {
        name: 'Posted Text',
        type: 'multilineText',
        description: 'The posting verbatim, so any result can be re-derived later.',
      },
      number('Score', '0-100, computed in code. Never produced by a model.'),
      number('Requirement Count'),
      { name: 'Matched At', type: 'singleLineText' },
      { name: 'Model', type: 'singleLineText', description: 'Which model wrote the rationales, or "none".' },
      { name: 'Source', type: 'singleLineText' },
      { name: 'Ingested At', type: 'singleLineText' },
    ],
  },
  {
    name: 'Results',
    description:
      'One row per requirement per role. The fit report, as records rather than as a JSON blob.',
    fields: [
      {
        name: 'Requirement',
        type: 'singleLineText',
        description: 'The requirement text, denormalised so the row reads on its own.',
      },
      KEY_FIELD,
      select('Kind', ['required', 'preferred'], 'Required items are weighted double when scoring.'),
      select('Category', [
        'frontend',
        'backend',
        'automation',
        'ai',
        'data',
        'cloud',
        'process',
        'domain',
      ]),
      select('Status', ['proven', 'partial', 'gap'], 'Colour this green/amber/red. It is the whole report.'),
      {
        name: 'Shortfall',
        type: 'multilineText',
        description: 'Why this is not proven. Empty when it is. The Gaps view reads this.',
      },
      { name: 'Match Score', type: 'number', options: { precision: 2 } },
      { name: 'Rationale', type: 'multilineText' },
      select('Rationale Source', ['model', 'template'], 'Which wrote the sentence: a model, or code.'),
    ],
  },
];

/**
 * Added after the base exists, because a link field needs the target table's id.
 *
 * Airtable creates the reverse side of every link automatically, so only one direction is declared here.
 * Declaring both would produce two separate one-way fields, which looks right in the schema and is
 * wrong in the base.
 */
export const LINKS: LinkSpec[] = [
  { table: 'Projects', field: 'Technologies', linkedTable: 'Technologies' },
  { table: 'Projects', field: 'Capabilities', linkedTable: 'Capabilities' },
  { table: 'Projects', field: 'Evidence', linkedTable: 'Evidence' },
  {
    table: 'Capabilities',
    field: 'Evidence',
    linkedTable: 'Evidence',
    description: 'Empty here means unverified. Such a capability can never score as proven.',
  },

  // The citations, as links rather than as slugs inside a string. This is what the sixth table bought.
  { table: 'Results', field: 'Role', linkedTable: 'Roles' },
  { table: 'Results', field: 'Technologies', linkedTable: 'Technologies' },
  { table: 'Results', field: 'Capabilities', linkedTable: 'Capabilities' },
  { table: 'Results', field: 'Projects', linkedTable: 'Projects' },
  {
    table: 'Results',
    field: 'Evidence',
    linkedTable: 'Evidence',
    description: 'The receipts behind this verdict. Empty on a gap, and on a partial that failed the gate.',
  },
];

/** Views a recruiter or an operator would actually open. */
export const VIEWS = [
  {
    table: 'Capabilities',
    name: 'Proven Capabilities',
    description: 'Tier is proven AND Evidence is not empty. The recruiter view.',
    filter: 'AND({Tier} = "proven", COUNTA({Evidence}) > 0)',
  },
  {
    table: 'Projects',
    name: 'Needs Review',
    description: 'Extraction failed on these. The operator view, and proof the error branch is real.',
    filter: '{Review Status} = "needs-review"',
  },
  {
    table: 'Results',
    name: 'Gaps',
    description:
      'Everything a role asked for that the record does not cover, required first. Impossible while ' +
      'results lived in a JSON string, which is the clearest argument for the sixth table.',
    filter: '{Status} != "proven"',
  },
] as const;

/**
 * `Score` on Roles stays a plain number written by the pipeline, rather than an Airtable rollup over
 * Results.
 *
 * A rollup would look tidier in the base and would move the arithmetic into Airtable, where a formula
 * edit could silently change a published score. Scoring in code, verified by `tests/score.test.ts`, is
 * the architectural claim; the base stores the answer and does not compute it. Convert it by hand later
 * if you want Airtable to own the number.
 */
export const SCORE_IS_NOT_A_ROLLUP = true;

export const BASE_NAME = 'Proof of Work';

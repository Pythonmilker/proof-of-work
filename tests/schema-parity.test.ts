/**
 * The Airtable schema against the TypeScript types.
 *
 * Two definitions of the same five tables, in two languages, and nothing in either one stops them
 * drifting. The failure mode is quiet and annoying: a field renamed in `types.ts` still reads fine in
 * the local store and comes back `undefined` from Airtable, so the app works in demo mode and loses a
 * column the moment someone connects a real base.
 *
 * The mapping is written out by hand below. That is the point — it is the one place the two naming
 * conventions meet, and a field added on either side without a line here fails the build.
 */

import { describe, expect, it } from 'vitest';
import { LINKS, TABLES, VIEWS } from '../airtable/schema';
import { seedSnapshot } from '@/store/seed';

/** TypeScript property → Airtable field name. `null` means the property is not stored in Airtable. */
const MAPPING: Record<string, Record<string, string | null>> = {
  Projects: {
    id: 'Key',
    slug: 'Key',
    name: 'Name',
    role: 'Role',
    started: 'Started',
    ended: 'Ended',
    status: 'Status',
    summary: 'Summary',
    'metrics.loc': 'LOC',
    'metrics.tests': 'Tests',
    'metrics.commits': 'Commits',
    'metrics.files': 'Files',
    technologies: 'Technologies',
    capabilities: 'Capabilities',
    evidence: 'Evidence',
    reviewStatus: 'Review Status',
    reviewReason: 'Review Reason',
    source: 'Source',
    ingestedAt: 'Ingested At',
  },
  Technologies: {
    id: 'Key',
    name: 'Name',
    aliases: 'Aliases',
    category: 'Category',
    projects: 'Projects',
  },
  Capabilities: {
    id: 'Key',
    name: 'Name',
    statement: 'Statement',
    tier: 'Tier',
    matchTerms: 'Match Terms',
    projects: 'Projects',
    evidence: 'Evidence',
  },
  Evidence: {
    id: 'Key',
    label: 'Label',
    kind: 'Kind',
    value: 'Value',
    url: 'URL',
    verifiedOn: 'Verified On',
    projects: 'Projects',
  },
  Roles: {
    id: 'Key',
    title: 'Title',
    company: 'Company',
    postedText: 'Posted Text',
    // Both rebuild from the Results rows. `requirements` has no field of its own because a Results row
    // carries its own text, kind and category, so there is one source of truth rather than two.
    requirements: null,
    results: 'Results',
    score: 'Score',
    matchedAt: 'Matched At',
    model: 'Model',
    source: 'Source',
    ingestedAt: 'Ingested At',
  },
  Results: {
    requirementId: 'Key',
    requirementText: 'Requirement',
    kind: 'Kind',
    category: 'Category',
    status: 'Status',
    shortfall: 'Shortfall',
    score: 'Match Score',
    matchedTechnologies: 'Technologies',
    matchedCapabilities: 'Capabilities',
    matchedProjects: 'Projects',
    evidence: 'Evidence',
    rationale: 'Rationale',
    rationaleSource: 'Rationale Source',
  },
};

/**
 * Fields the base holds that no TypeScript property maps to, and why each one is legitimate.
 *
 * Kept explicit rather than hand-waved: an unexplained extra column in the base is usually a mapping
 * that has quietly gone missing, and this is the list that says which ones are on purpose.
 */
const DERIVED: Record<string, string> = {
  'Roles.Requirement Count': 'Denormalised count, for reading the grid without opening the linked rows.',
  'Results.Role': 'The parent link. Implicit in the TypeScript, where results live inside their Role.',
};

/**
 * Reverse links Airtable creates that the type layer deliberately does not carry.
 *
 * `Capabilities.Evidence` produces an `Evidence.Capabilities` field automatically. Nothing in the
 * pipeline ever asks which capabilities cite a given receipt — traversal only runs the other way — so
 * adding the property would mean maintaining a field in the types, the local store's reverse-linking,
 * and the Airtable adapter, in exchange for nothing.
 *
 * Listed here rather than quietly excluded, because an asymmetry someone will notice in the base is
 * better documented than discovered.
 */
const REVERSE_ONLY = new Set([
  'Evidence.Capabilities',
  // Results links out to four tables, so each of them gains a Results field. Nothing traverses back
  // that way: the report is always read from the Role down.
  'Technologies.Results',
  'Capabilities.Results',
  'Projects.Results',
  'Evidence.Results',
]);

/**
 * Field names Airtable ends up with, including the reverse sides it creates for free.
 *
 * A link declared as `Projects.Technologies` also produces `Technologies.Projects`, which is why only
 * one direction is declared in schema.ts but both directions exist in the base.
 */
function airtableFieldsFor(table: string): Set<string> {
  const declared = TABLES.find((t) => t.name === table)?.fields.map((f) => f.name) ?? [];
  const forward = LINKS.filter((l) => l.table === table).map((l) => l.field);
  const reverse = LINKS.filter((l) => l.linkedTable === table).map((l) => l.table);
  return new Set([...declared, ...forward, ...reverse]);
}

describe('every table in the type layer exists in the base', () => {
  it('has six tables, small enough to read in one screenshot', () => {
    // It was five, and the fifth-table rule was costing more than it saved: results lived as escaped
    // JSON in a long-text field to avoid a sixth table, which disabled filtering, grouping, colouring
    // and Interfaces on the one table holding the output. Airtable renders tables as horizontal tabs,
    // so six versus five is visually identical. The real constraint is legibility, not arithmetic.
    expect(TABLES).toHaveLength(6);
    expect(TABLES.map((t) => t.name).sort()).toEqual([
      'Capabilities',
      'Evidence',
      'Projects',
      'Results',
      'Roles',
      'Technologies',
    ]);
  });

  it('stores no JSON blob in any long-text field', () => {
    // The anti-pattern this schema was rebuilt to remove. A field whose description or name suggests it
    // holds serialised structure is a linked table that has not been written yet.
    for (const table of TABLES) {
      for (const field of table.fields) {
        expect(field.name, `${table.name}.${field.name}`).not.toMatch(/json/i);
        expect(field.description ?? '', `${table.name}.${field.name}`).not.toMatch(/JSON/);
      }
    }
  });

  it.each(Object.keys(MAPPING))('%s: every mapped property has a field', (table) => {
    const fields = airtableFieldsFor(table);
    for (const [property, field] of Object.entries(MAPPING[table] ?? {})) {
      if (field === null) continue;
      expect(fields, `${table}.${property} → ${field}`).toContain(field);
    }
  });

  it.each(Object.keys(MAPPING))('%s: every field is accounted for by a property', (table) => {
    const mapped = new Set(Object.values(MAPPING[table] ?? {}).filter(Boolean));
    for (const field of airtableFieldsFor(table)) {
      if (REVERSE_ONLY.has(`${table}.${field}`)) continue;
      if (DERIVED[`${table}.${field}`]) continue;
      expect(mapped, `${table}.${field} has no property mapped to it`).toContain(field);
    }
  });

  it('only tolerates a derived field that the base really has', () => {
    for (const entry of Object.keys(DERIVED)) {
      const [table, field] = entry.split('.');
      expect(airtableFieldsFor(table as string), entry).toContain(field);
    }
  });

  it('only tolerates a reverse-only field where one is actually created', () => {
    // Keeps the exception list honest: an entry that no longer corresponds to a real Airtable field
    // would otherwise sit there hiding a mapping that had genuinely gone missing.
    for (const entry of REVERSE_ONLY) {
      const [table, field] = entry.split('.');
      expect(airtableFieldsFor(table as string), entry).toContain(field);
    }
  });
});

describe('single-select choices match the unions in types.ts', () => {
  function choicesFor(table: string, field: string): string[] {
    const spec = TABLES.find((t) => t.name === table)?.fields.find((f) => f.name === field);
    const choices = (spec?.options?.['choices'] ?? []) as Array<{ name: string }>;
    return choices.map((c) => c.name).sort();
  }

  it('Projects.Status', () => {
    expect(choicesFor('Projects', 'Status')).toEqual(['delivered', 'in-development', 'live', 'shipped']);
  });

  it('Projects.Review Status', () => {
    expect(choicesFor('Projects', 'Review Status')).toEqual(['needs-review', 'ok']);
  });

  it('Capabilities.Tier', () => {
    expect(choicesFor('Capabilities', 'Tier')).toEqual(['proven', 'stretch']);
  });

  it('covers every value the seed actually uses', () => {
    // The check that would have caught a category added to the seed and forgotten in the schema — which
    // Airtable rejects at write time with a 422 on the whole batch.
    const snapshot = seedSnapshot();
    const statuses = choicesFor('Projects', 'Status');
    for (const p of snapshot.projects) expect(statuses, p.name).toContain(p.status);

    const categories = choicesFor('Technologies', 'Category');
    for (const t of snapshot.technologies) expect(categories, t.name).toContain(t.category);

    const kinds = choicesFor('Evidence', 'Kind');
    for (const e of snapshot.evidence) expect(kinds, e.label).toContain(e.kind);
  });
});

describe('link fields', () => {
  it('declares each relationship once, letting Airtable create the reverse side', () => {
    // Declaring both directions produces two separate one-way fields, which looks right in the schema
    // and is wrong in the base.
    const pairs = LINKS.map((l) => [l.table, l.linkedTable].join('→'));
    const reversed = LINKS.map((l) => [l.linkedTable, l.table].join('→'));
    for (const pair of pairs) expect(reversed).not.toContain(pair);
  });

  it('only links tables that exist', () => {
    const names = new Set(TABLES.map((t) => t.name));
    for (const link of LINKS) {
      expect(names, link.table).toContain(link.table);
      expect(names, link.linkedTable).toContain(link.linkedTable);
    }
  });

  it('gives Capabilities its own Evidence link, which is what the evidence gate reads', () => {
    const link = LINKS.find((l) => l.table === 'Capabilities' && l.linkedTable === 'Evidence');
    expect(link).toBeDefined();
    expect(link?.description).toMatch(/unverified/i);
  });
});

describe('views', () => {
  it('defines the recruiter view, the operator view and the gaps view', () => {
    expect(VIEWS.map((v) => v.name)).toEqual(['Proven Capabilities', 'Needs Review', 'Gaps']);
  });

  it('puts Gaps on Results, which is only possible now results are rows', () => {
    // The clearest single argument for the sixth table: while results were a JSON string, no filter
    // could reach a status, so this view could not exist at all.
    const gaps = VIEWS.find((v) => v.name === 'Gaps');
    expect(gaps?.table).toBe('Results');
    expect(gaps?.filter).toContain('Status');
  });

  it('filters Proven Capabilities on evidence as well as tier', () => {
    // One condition would list capabilities that claim to be proven and have nothing behind them, which
    // is exactly the row the view exists to exclude.
    const view = VIEWS.find((v) => v.name === 'Proven Capabilities');
    expect(view?.filter).toContain('Tier');
    expect(view?.filter).toContain('Evidence');
  });
});

describe('the primary field of each table', () => {
  it('is a text field, as Airtable requires', () => {
    for (const table of TABLES) {
      const primary = table.fields[0];
      expect(primary?.type, `${table.name} primary field`).toBe('singleLineText');
    }
  });

  it('is never the Key, so the grid reads as names rather than slugs', () => {
    for (const table of TABLES) {
      expect(table.fields[0]?.name, table.name).not.toBe('Key');
    }
  });
});

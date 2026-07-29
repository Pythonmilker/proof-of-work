/**
 * Creates the base from nothing.  `pnpm airtable:provision`
 *
 * The point of this script is that a stranger needs one credential and no clicking. Not a template to
 * duplicate, not a CSV to import, not a list of field names to retype — a personal access token with
 * `schema.bases:write`, and one command.
 *
 * Idempotent. Re-running against an existing base adds what is missing and leaves the rest alone, so
 * a half-finished run is safe to repeat.
 *
 * Two passes, and the second one is not optional: a `multipleRecordLinks` field needs `linkedTableId`,
 * and the target table has no id until the base has been created.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { BASE_NAME, LINKS, TABLES } from './schema';

const API = 'https://api.airtable.com/v0/meta';

interface AirtableTable {
  id: string;
  name: string;
  fields: Array<{ id: string; name: string; type: string }>;
}

function env(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess.trim();

  // .env.local is gitignored and is where the README tells people to put these.
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    const line = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  }
  return undefined;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const pat = env('AIRTABLE_PAT');
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Airtable ${response.status} on ${path}\n${body}`);
  }
  return (await response.json()) as T;
}

async function findExistingBase(): Promise<string | null> {
  const { bases } = await call<{ bases: Array<{ id: string; name: string }> }>('/bases');
  return bases.find((b) => b.name === BASE_NAME)?.id ?? null;
}

async function createBase(workspaceId: string): Promise<string> {
  const created = await call<{ id: string }>('/bases', {
    method: 'POST',
    body: JSON.stringify({
      name: BASE_NAME,
      workspaceId,
      // Link fields are deliberately absent here. See the header.
      tables: TABLES.map((t) => ({
        name: t.name,
        description: t.description,
        fields: t.fields.map((f) => ({
          name: f.name,
          type: f.type,
          ...(f.description ? { description: f.description } : {}),
          ...(f.options ? { options: f.options } : {}),
        })),
      })),
    }),
  });
  return created.id;
}

async function tablesIn(baseId: string): Promise<AirtableTable[]> {
  const { tables } = await call<{ tables: AirtableTable[] }>(`/bases/${baseId}/tables`);
  return tables;
}

/**
 * A table added to the schema after the base exists — Candidates was the first — is created here.
 * Same shape as creation-time tables: no link fields, those come in the link pass once the table id
 * exists on both sides.
 */
async function createMissingTable(baseId: string, spec: (typeof TABLES)[number]): Promise<void> {
  await call(`/bases/${baseId}/tables`, {
    method: 'POST',
    body: JSON.stringify({
      name: spec.name,
      description: spec.description,
      fields: spec.fields.map((f) => ({
        name: f.name,
        type: f.type,
        ...(f.description ? { description: f.description } : {}),
        ...(f.options ? { options: f.options } : {}),
      })),
    }),
  });
  console.log(`  + table ${spec.name} (${spec.fields.length} fields)`);
}

async function addMissingFields(baseId: string, tables: AirtableTable[]): Promise<number> {
  let added = 0;
  for (const spec of TABLES) {
    const table = tables.find((t) => t.name === spec.name);
    if (!table) {
      // Created by the caller before this pass; reaching here means that creation failed loudly.
      console.warn(`! table "${spec.name}" is still missing from the base`);
      continue;
    }
    for (const field of spec.fields) {
      if (table.fields.some((f) => f.name === field.name)) continue;
      await call(`/bases/${baseId}/tables/${table.id}/fields`, {
        method: 'POST',
        body: JSON.stringify({
          name: field.name,
          type: field.type,
          ...(field.description ? { description: field.description } : {}),
          ...(field.options ? { options: field.options } : {}),
        }),
      });
      console.log(`  + ${spec.name}.${field.name} (${field.type})`);
      added += 1;
    }
  }
  return added;
}

async function addLinks(baseId: string, tables: AirtableTable[]): Promise<number> {
  let added = 0;
  for (const link of LINKS) {
    const table = tables.find((t) => t.name === link.table);
    const target = tables.find((t) => t.name === link.linkedTable);
    if (!table || !target) {
      console.warn(`! cannot link ${link.table}.${link.field} → ${link.linkedTable}: a table is missing`);
      continue;
    }
    if (table.fields.some((f) => f.name === link.field)) continue;

    await call(`/bases/${baseId}/tables/${table.id}/fields`, {
      method: 'POST',
      body: JSON.stringify({
        name: link.field,
        type: 'multipleRecordLinks',
        ...(link.description ? { description: link.description } : {}),
        options: { linkedTableId: target.id },
      }),
    });
    console.log(`  + ${link.table}.${link.field} → ${link.linkedTable}`);
    added += 1;
  }
  return added;
}

async function main(): Promise<void> {
  const pat = env('AIRTABLE_PAT');
  if (!pat) {
    console.error(
      [
        'AIRTABLE_PAT is not set.',
        '',
        'Create a personal access token at https://airtable.com/create/tokens with:',
        '  scopes  schema.bases:read, schema.bases:write, data.records:read, data.records:write',
        '  access  the workspace you want the base created in',
        '',
        'Then add it to .env.local:',
        '  AIRTABLE_PAT=pat...',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  let baseId = env('AIRTABLE_BASE_ID') ?? (await findExistingBase());

  if (!baseId) {
    const workspaceId = env('AIRTABLE_WORKSPACE_ID');
    if (!workspaceId) {
      console.error(
        [
          `No base named "${BASE_NAME}" exists yet, and AIRTABLE_WORKSPACE_ID is not set.`,
          '',
          'Airtable has no API for listing workspaces, so this one has to be read off the URL:',
          'open airtable.com, click the workspace, and copy the wsp... segment out of the address bar.',
          '',
          'Then add it to .env.local:',
          '  AIRTABLE_WORKSPACE_ID=wsp...',
        ].join('\n'),
      );
      // exitCode rather than exit(): Node aborts with a libuv assertion if the process is torn down
      // while fetch keep-alive sockets are still open, turning a readable message into a crash dump.
      process.exitCode = 1;
      return;
    }
    console.log(`Creating base "${BASE_NAME}" with ${TABLES.length} tables…`);
    baseId = await createBase(workspaceId);
    console.log(`  base ${baseId}`);
  } else {
    console.log(`Using existing base ${baseId} — filling in anything missing.`);
  }

  // Re-read after creation: the link pass needs real table ids, and an existing base may have drifted.
  let tables = await tablesIn(baseId);
  const missing = TABLES.filter((spec) => !tables.some((t) => t.name === spec.name));
  for (const spec of missing) await createMissingTable(baseId, spec);
  if (missing.length > 0) tables = await tablesIn(baseId);
  const fieldsAdded = await addMissingFields(baseId, tables);
  const linksAdded = await addLinks(baseId, await tablesIn(baseId));

  console.log(
    `\nDone. ${TABLES.length} tables, ${fieldsAdded} field(s) added, ${linksAdded} link field(s) added.`,
  );

  if (!env('AIRTABLE_BASE_ID')) {
    appendFileSync('.env.local', `\nAIRTABLE_BASE_ID=${baseId}\n`, 'utf8');
    console.log(`Wrote AIRTABLE_BASE_ID=${baseId} to .env.local`);
  }

  console.log(
    [
      '',
      'Next:',
      '  pnpm airtable:push     seed the record tables and resolve every link',
      '  pnpm doctor            confirm the credentials actually work',
      '',
      `Two views still need creating by hand (Airtable has no API for them) — airtable/VIEWS.md`,
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  // exitCode, not exit(): tearing the process down while fetch keep-alive sockets are open aborts
  // with a libuv assertion on Windows, turning a readable error into a crash dump.
  process.exitCode = 1;
});

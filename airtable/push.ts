/**
 * Seeds the base and resolves every link.  `pnpm airtable:push`
 *
 * Two passes again, for the same reason as provisioning: a link field holds Airtable record ids, and a
 * row has no id until it has been written. So every row is created first, the slug-to-record-id map is
 * built from the results, and the links are patched in afterwards.
 *
 * Idempotent by slug. Re-running updates rows rather than duplicating them, which matters because the
 * likeliest reason to run this twice is that the first attempt hit a rate limit halfway through.
 */

import { existsSync, readFileSync } from 'node:fs';
import { seedSnapshot } from '../src/store/seed';

const MAX_RECORDS_PER_WRITE = 10; // Airtable's documented ceiling; exceed it and the whole request 422s
const MIN_REQUEST_GAP_MS = 220; // 5 requests/second per base, with headroom

function env(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess.trim();
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

const PAT = env('AIRTABLE_PAT');
const BASE_ID = env('AIRTABLE_BASE_ID');

let lastRequestAt = 0;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const response = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (response.status === 429) {
    // Airtable's documented penalty is a 30-second lockout, so one honest wait beats a tight retry loop.
    console.log('  rate limited — waiting 30s');
    await new Promise((r) => setTimeout(r, 30_000));
    return call<T>(path, init);
  }
  if (!response.ok) {
    throw new Error(`Airtable ${response.status} on ${path}\n${await response.text().catch(() => '')}`);
  }
  return (await response.json()) as T;
}

interface Record_ {
  id: string;
  fields: Record<string, unknown>;
}

/** slug → Airtable record id, across every table. Slugs are unique base-wide by construction. */
const recordByKey = new Map<string, string>();

async function loadExisting(table: string): Promise<void> {
  let offset: string | undefined;
  do {
    const query = new URLSearchParams({ pageSize: '100' });
    if (offset) query.set('offset', offset);
    const page = await call<{ records: Record_[]; offset?: string }>(`${encodeURIComponent(table)}?${query}`);
    for (const record of page.records) {
      const key = record.fields['Key'];
      if (typeof key === 'string' && key) recordByKey.set(key, record.id);
    }
    offset = page.offset;
  } while (offset);
}

async function writeRows(table: string, rows: Array<{ key: string; fields: Record<string, unknown> }>): Promise<void> {
  const creates = rows.filter((r) => !recordByKey.has(r.key));
  const updates = rows.filter((r) => recordByKey.has(r.key));

  for (let i = 0; i < creates.length; i += MAX_RECORDS_PER_WRITE) {
    const chunk = creates.slice(i, i + MAX_RECORDS_PER_WRITE);
    const result = await call<{ records: Record_[] }>(encodeURIComponent(table), {
      method: 'POST',
      body: JSON.stringify({ records: chunk.map((r) => ({ fields: { ...r.fields, Key: r.key } })) }),
    });
    result.records.forEach((record, at) => {
      const key = chunk[at]?.key;
      if (key) recordByKey.set(key, record.id);
    });
  }

  for (let i = 0; i < updates.length; i += MAX_RECORDS_PER_WRITE) {
    const chunk = updates.slice(i, i + MAX_RECORDS_PER_WRITE);
    await call(encodeURIComponent(table), {
      method: 'PATCH',
      body: JSON.stringify({
        records: chunk.map((r) => ({ id: recordByKey.get(r.key) as string, fields: r.fields })),
      }),
    });
  }

  console.log(`  ${table}: ${creates.length} created, ${updates.length} updated`);
}

/** Slugs → record ids, dropping anything the base does not have. A dangling link is worse than none. */
const refs = (keys: readonly string[]): string[] =>
  keys.map((k) => recordByKey.get(k)).filter((r): r is string => Boolean(r));

async function main(): Promise<void> {
  if (!PAT || !BASE_ID) {
    console.error('AIRTABLE_PAT and AIRTABLE_BASE_ID must both be set. Run pnpm airtable:provision first.');
    process.exitCode = 1;
    return;
  }

  const snapshot = seedSnapshot();
  console.log(`Pushing to base ${BASE_ID}`);

  console.log('\nReading what is already there…');
  for (const table of ['Candidates', 'Projects', 'Technologies', 'Capabilities', 'Evidence', 'Roles']) {
    await loadExisting(table);
  }
  console.log(`  ${recordByKey.size} existing row(s)`);

  // Pass 1 — every row, no links. Links reference record ids that do not exist until this finishes.
  console.log('\nPass 1: rows');
  await writeRows(
    'Candidates',
    snapshot.candidates.map((c) => ({
      key: c.id,
      fields: { Name: c.name, Contact: c.contact, Source: c.source, 'Ingested At': c.ingestedAt },
    })),
  );
  await writeRows(
    'Technologies',
    snapshot.technologies.map((t) => ({
      key: t.id,
      fields: { Name: t.name, Aliases: t.aliases.join(', '), Category: t.category },
    })),
  );
  await writeRows(
    'Evidence',
    snapshot.evidence.map((e) => ({
      key: e.id,
      fields: { Label: e.label, Kind: e.kind, Value: e.value, URL: e.url ?? '', 'Verified On': e.verifiedOn },
    })),
  );
  await writeRows(
    'Capabilities',
    snapshot.capabilities.map((c) => ({
      key: c.id,
      fields: { Name: c.name, Statement: c.statement, Tier: c.tier, 'Match Terms': c.matchTerms.join(', ') },
    })),
  );
  await writeRows(
    'Projects',
    snapshot.projects.map((p) => ({
      key: p.id,
      fields: {
        Name: p.name,
        Role: p.role,
        Started: p.started,
        Ended: p.ended ?? '',
        Status: p.status,
        Summary: p.summary,
        ...(p.metrics.loc !== undefined ? { LOC: p.metrics.loc } : {}),
        ...(p.metrics.tests !== undefined ? { Tests: p.metrics.tests } : {}),
        ...(p.metrics.commits !== undefined ? { Commits: p.metrics.commits } : {}),
        ...(p.metrics.files !== undefined ? { Files: p.metrics.files } : {}),
        'Review Status': p.reviewStatus,
        'Review Reason': p.reviewReason ?? '',
        Source: p.source,
        'Ingested At': p.ingestedAt,
      },
    })),
  );

  // Pass 2 — links, now that every slug has a record id.
  console.log('\nPass 2: links');
  await writeRows(
    'Projects',
    snapshot.projects.map((p) => ({
      key: p.id,
      fields: {
        Candidate: refs([p.candidate]),
        Technologies: refs(p.technologies),
        Capabilities: refs(p.capabilities),
        Evidence: refs(p.evidence),
      },
    })),
  );
  await writeRows(
    'Capabilities',
    snapshot.capabilities.map((c) => ({
      key: c.id,
      fields: { Candidate: refs([c.candidate]), Evidence: refs(c.evidence) },
    })),
  );
  await writeRows(
    'Evidence',
    snapshot.evidence.map((e) => ({ key: e.id, fields: { Candidate: refs([e.candidate]) } })),
  );

  // Pass 3 — remove rows the seed no longer has. Opt-in, because a base is a place people add things by
  // hand and a sync that silently deletes their work is a support ticket. Without it the base drifts:
  // dropping a capability from the seed leaves it sitting in Airtable forever, still linked.
  if (process.argv.includes('--prune')) {
    console.log('\nPass 3: prune');
    const seeded = new Set<string>([
      ...snapshot.projects.map((p) => p.id),
      ...snapshot.technologies.map((t) => t.id),
      ...snapshot.capabilities.map((c) => c.id),
      ...snapshot.evidence.map((e) => e.id),
    ]);

    for (const table of ['Technologies', 'Capabilities', 'Evidence', 'Projects']) {
      const stale: string[] = [];
      for (const [key, recordId] of recordByKey) {
        if (seeded.has(key)) continue;
        // Only prune keys this table actually owns: recordByKey is base-wide.
        const owned = await call<{ records: Record_[] }>(
          `${encodeURIComponent(table)}?pageSize=1&filterByFormula=${encodeURIComponent(`{Key}='${key}'`)}`,
        );
        if (owned.records.length > 0) stale.push(recordId);
      }
      for (let i = 0; i < stale.length; i += MAX_RECORDS_PER_WRITE) {
        const chunk = stale.slice(i, i + MAX_RECORDS_PER_WRITE);
        const query = chunk.map((id) => `records[]=${id}`).join('&');
        await call(`${encodeURIComponent(table)}?${query}`, { method: 'DELETE' });
      }
      console.log(`  ${table}: ${stale.length} pruned`);
    }
  } else {
    const orphans = [...recordByKey.keys()].filter(
      (k) =>
        !snapshot.projects.some((p) => p.id === k) &&
        !snapshot.technologies.some((t) => t.id === k) &&
        !snapshot.capabilities.some((c) => c.id === k) &&
        !snapshot.evidence.some((e) => e.id === k) &&
        !snapshot.candidates.some((c) => c.id === k) &&
        !k.startsWith('role-') &&
        // Live-ingested applicants are data, not drift; they are never the seed's to prune.
        !k.startsWith('candidate-'),
    );
    if (orphans.length > 0) {
      console.log(`\n${orphans.length} row(s) in the base are not in the seed: ${orphans.join(', ')}`);
      console.log('Re-run with --prune to delete them.');
    }
  }

  const unverified = snapshot.capabilities.filter((c) => c.evidence.length === 0).length;
  console.log(
    [
      '',
      `Done. ${snapshot.projects.length} projects, ${snapshot.technologies.length} technologies, ` +
        `${snapshot.capabilities.length} capabilities, ${snapshot.evidence.length} evidence rows.`,
      `${unverified} capability row(s) have no evidence linked and will show as unverified. That is correct.`,
      '',
      'Next: create the two views by hand — airtable/VIEWS.md — then the Interface: airtable/INTERFACE.md',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  // exitCode, not exit(): tearing the process down while fetch keep-alive sockets are open aborts
  // with a libuv assertion on Windows, turning a readable error into a crash dump.
  process.exitCode = 1;
});

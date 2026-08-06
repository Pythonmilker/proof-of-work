/**
 * Re-scores a role that is already in the live base, using the posting text the base itself holds.
 *
 *   pnpm tsx scripts/rescore-live.ts <role-key>
 *
 * Written 2026-08-05 for a specific reason worth recording. The Claude Code requirement scored proven
 * off an ALIAS on the Claude API technology row, and the rationale the base was showing said so out
 * loud: "proven familiarity with Claude Code through the use of the Claude API in Project 'Tendril'".
 * Fixing the seed does not fix that sentence — Results rows are written once, at scoring time — so the
 * base kept displaying the exact over-claim the code had stopped making, on the surface a recruiter
 * actually reads.
 *
 * Additive by design. It writes the new scoring and prints what is now stale; it deletes nothing. The
 * old row is removed by hand after the new one has been read and checked, so there is never a moment
 * when the base has no answer in it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { matchRole } from '../src/pipeline/index';
import { AirtableStore } from '../src/store/airtable';

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['.env', '.env.local']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match?.[1]) out[match[1]] = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
    }
  }
  return { ...out, ...process.env } as Record<string, string>;
}

const env = readEnvFile();
const pat = env.AIRTABLE_PAT ?? '';
const baseId = env.AIRTABLE_BASE_ID ?? '';
const apiKey = env.OPENROUTER_API_KEY ?? '';
const roleKey = process.argv[2] ?? '';

if (!pat || !baseId || !roleKey) {
  console.error('usage: pnpm tsx scripts/rescore-live.ts <role-key>   (needs AIRTABLE_PAT + AIRTABLE_BASE_ID)');
  process.exitCode = 1;
} else {
  const store = new AirtableStore({ pat, baseId });
  const snapshot = await store.read();
  const existing = snapshot.roles.find((r) => r.id === roleKey);

  if (!existing) {
    console.error(`no role "${roleKey}" in the base. Present: ${snapshot.roles.map((r) => r.id).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`re-scoring "${existing.title}" at ${existing.company}`);
    console.log(`  posting text: ${existing.postedText.length} chars, taken from the base`);
    console.log(`  previous: ${existing.score}%\n`);

    const report = await matchRole(existing.postedText, store, { apiKey });
    const c = report.coverage;

    console.log(`new row: ${report.role.id}`);
    console.log(`  ${c.score}%  ${c.proven} proven · ${c.partial} partial · ${c.gap} gaps`);
    console.log(`  weighing ${report.weighing}, ${report.demotedCount} of ${report.weighedCount} lowered`);
    console.log(`  retrieval ${report.retrieval}, parse ${report.parseVia}, rationales ${report.rationaleVia}`);

    const cc = report.role.results.find((r) => /claude code/i.test(r.requirementText));
    if (cc) {
      console.log(`\nthe requirement this was run for:`);
      console.log(`  status: ${cc.status}`);
      console.log(`  capabilities: ${cc.matchedCapabilities.join(', ') || '(none)'}`);
      console.log(`  technologies: ${cc.matchedTechnologies.join(', ') || '(none)'}`);
      console.log(`  rationale: ${cc.rationale}`);
    }

    for (const note of report.notes) console.log(`\nnote: ${note}`);
    if (report.role.id !== roleKey) {
      console.log(`\nSTALE, delete by hand once the above reads correctly: ${roleKey} and its Results rows`);
    }
  }
}

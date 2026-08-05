/**
 * Measures what the weighing pass actually does to a real report.  (DESIGN.md §v3.8)
 *
 * Runs the bundled posting against the seeded record twice — once with no model reachable, once with
 * the weighing model live — and prints both verdicts side by side. The point is not that the second
 * number is better. It is that the difference is known, printed, and decided on rather than absorbed:
 * the deterministic figure appears on a resume and in a live Airtable base, so a weighing pass that
 * silently moved it would be a worse outcome than one that moved it loudly.
 *
 *   pnpm tsx scripts/weigh-probe.ts
 *
 * Deliberately constructs a LocalStore over the seed and never touches Airtable, whatever is in
 * .env.local. A measurement script that writes to the live base is a measurement script that changes
 * what it is measuring.
 */

import { existsSync, readFileSync } from 'node:fs';
import { matchRole } from '../src/pipeline/index';
import { LocalStore } from '../src/store/local';

import { SAMPLE_POSTING } from '../src/ui/sample-posting';
import type { CoverageStatus } from '../src/store/types';

/** Same reader scripts/doctor.ts uses. This repo has two runtime dependencies and dotenv is not one. */
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

const apiKey = readEnvFile().OPENROUTER_API_KEY ?? '';
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is not set, so there is nothing to compare against.');
  process.exitCode = 1;
}

async function run(label: string, withModel: boolean) {
  // Defaults to an in-memory store over the seed, which is exactly the fixture this needs.
  const store = new LocalStore();
  // An empty key is what "no model reachable" looks like to the pipeline, which is the keyless lane
  // the hosted build runs on. Passing it explicitly beats an optional property under strict TS.
  const report = await matchRole(SAMPLE_POSTING, store, {
    apiKey: withModel ? apiKey : '',
    now: () => '2026-08-05T00:00:00.000Z',
  });
  return { label, report };
}

const [floor, live] = await Promise.all([run('deterministic', false), run('weighed', true)]);

const line = (r: Awaited<ReturnType<typeof run>>) => {
  const c = r.report.coverage;
  return (
    `${r.label.padEnd(14)} ${String(c.score).padStart(3)}%  ` +
    `${c.proven} proven · ${c.partial} partial · ${c.gap} gaps  ` +
    `(${r.report.role.requirements.length} requirements, retrieval ${r.report.retrieval}, ` +
    `weighing ${r.report.weighing})`
  );
};

console.log(line(floor));
console.log(line(live));
console.log(
  `\nweighed ${live.report.weighedCount} of ${live.report.role.requirements.length} requirements, ` +
    `demoted ${live.report.demotedCount}`,
);

const before = new Map(floor.report.role.results.map((r) => [r.requirementText, r.status]));
const moved: { text: string; from: CoverageStatus; to: CoverageStatus; why: string | null }[] = [];
for (const r of live.report.role.results) {
  const from = before.get(r.requirementText);
  if (from && from !== r.status) moved.push({ text: r.requirementText, from, to: r.status, why: r.shortfall });
}

if (moved.length === 0) {
  console.log('\nNo requirement changed status.');
} else {
  console.log(`\n${moved.length} requirement(s) changed:`);
  for (const m of moved) {
    console.log(`  ${m.from} -> ${m.to}: ${m.text.slice(0, 90)}`);
    if (m.why) console.log(`      ${m.why}`);
  }
}

for (const note of live.report.notes) console.log(`\nnote: ${note}`);

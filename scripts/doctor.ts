/**
 * `pnpm doctor` — what is actually connected, and what is not.
 *
 * Run it before filming. The failure this whole project argues against is the one where a credential
 * quietly stops working and everything keeps running on the deterministic path: green tests, working
 * demo, dead integration. This is the thirty-second check that catches it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { probe, type CapabilityStatus, type Env } from '../src/store';

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

const MARK: Record<CapabilityStatus['state'], string> = {
  ready: '✓',
  absent: '·',
  rejected: '✕',
  unreachable: '!',
};

function line(label: string, status: CapabilityStatus): void {
  console.log(`  ${MARK[status.state]} ${label.padEnd(12)} ${status.detail}`);
}

async function main(): Promise<void> {
  const env = readEnvFile();
  const report = await probe({
    OPENROUTER_API_KEY: env['OPENROUTER_API_KEY'],
    AIRTABLE_PAT: env['AIRTABLE_PAT'],
    AIRTABLE_BASE_ID: env['AIRTABLE_BASE_ID'],
  } satisfies Env);

  console.log(`\nProof of Work: ${report.label}\n`);
  line('models', report.llm);
  line('embeddings', report.embeddings);
  line('airtable', report.airtable);
  console.log(`  · store        ${report.store === 'airtable' ? 'Airtable' : 'local JSON, seeded from src/store/seed.ts'}`);

  const n8n = env['VITE_PIPELINE_ENDPOINT'];
  console.log(`  ${n8n ? '✓' : '·'} pipeline     ${n8n ? `delegated to ${n8n}` : 'running in-process (no n8n webhook configured)'}`);

  const problems = [report.llm, report.embeddings, report.airtable].filter(
    (s) => s.state === 'rejected' || s.state === 'unreachable',
  );

  console.log('');
  if (problems.length > 0) {
    // A rejected credential is reported as rejected, never folded into "demo mode". The two need
    // different fixes, and conflating them is how someone spends an afternoon on the wrong one.
    console.log('Something is set but not working. The app still runs — it will say so in the header —');
    console.log('but the live path is not what you think it is. Fix these before recording:\n');
    for (const p of problems) console.log(`  ${p.detail}`);
    console.log('');
    // `process.exitCode` rather than `process.exit()`. Node on Windows aborts with a libuv assertion
    // if the process is torn down while fetch's keep-alive sockets are still open, which turns a clean
    // "your key is wrong" into a crash dump — the exact opposite of what this script is for.
    process.exitCode = 1;
    return;
  }

  if (report.llm.state === 'absent' && report.airtable.state === 'absent') {
    console.log('Nothing is configured, and that is a supported way to run this.');
    console.log('Everything works: deterministic extraction, lexical matching, the local store.\n');
    console.log('To go live:');
    console.log('  OPENROUTER_API_KEY=sk-or-...   real models and hybrid retrieval');
    console.log('  pnpm airtable:provision        create the base from a single PAT');
    console.log('');
    return;
  }

  console.log('Everything configured is working.\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

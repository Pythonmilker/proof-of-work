/**
 * Captures every screenshot that needs no accounts.  `pnpm screenshots`
 *
 * Scripted rather than taken by hand so they can be regenerated. The likeliest reason to reshoot is
 * pasting the real job posting over the sample, and re-framing two screenshots by hand every time is how
 * a deliverable ends up with one current image and one stale one.
 *
 * Writes nine PNGs to docs/screenshots/. Needs the dev server running on 5273, and a reset first
 * (`rm -f data/session.json`) or the dedup branch fires where the shot expects a fresh record. The three
 * shots that need live n8n and Airtable accounts are described in docs/SHOTLIST.md.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env['POW_URL'] ?? 'http://localhost:5273';
const OUT = join(process.cwd(), 'docs', 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };

async function settle(page: Page, ms = 400): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function shoot(page: Page, name: string, selector?: string): Promise<void> {
  const target = selector ? page.locator(selector).first() : page;
  await target.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  wrote docs/screenshots/${name}.png`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  // Drives the Chrome that is already installed, so this needs no `playwright install` and no 150 MB
  // browser download. Set POW_BROWSER=bundled to use Playwright's own build instead.
  const useSystemChrome = process.env['POW_BROWSER'] !== 'bundled';
  const browser = await chromium.launch(useSystemChrome ? { channel: 'chrome' } : {});
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2, // retina, so the fit report is legible when a reviewer zooms in
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  console.log(`Capturing from ${BASE}`);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await settle(page);

  // ── 1. Intake, before anything has been ingested ────────────────────────────────────────────────
  await shoot(page, '01-intake');

  // ── 2. Before and after, from a real README ─────────────────────────────────────────────────────
  await page.getByRole('button', { name: /01-tendril-readme/ }).click();
  await settle(page, 200);
  await page.getByRole('button', { name: 'Ingest', exact: true }).click();
  await page.waitForSelector('text=Before — raw input', { timeout: 30_000 });
  await settle(page);

  await page.getByText('Before — raw input').scrollIntoViewIfNeeded();
  await settle(page, 250);
  await shoot(page, '02-before-after');

  // ── 3. The stage list, with dedup having fired ──────────────────────────────────────────────────
  await page.getByText('PIPELINE', { exact: false }).first().scrollIntoViewIfNeeded();
  await settle(page, 250);
  await shoot(page, '03-pipeline-stages');

  // ── 4. The error branch ─────────────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /11-broken-fragment/ }).click();
  await settle(page, 200);
  await page.getByRole('button', { name: 'Ingest', exact: true }).click();
  await page.waitForSelector('text=parked in Needs Review', { timeout: 30_000 });
  await settle(page);
  await shoot(page, '04-needs-review');

  // ── 5. The fit report, one row expanded, Gaps in frame ──────────────────────────────────────────
  await page.getByRole('button', { name: 'Match', exact: true }).click();
  await settle(page, 200);
  await page.getByRole('button', { name: 'Score this role' }).click();
  await page.waitForSelector('text=what this record does not cover', { timeout: 120_000 });
  await settle(page, 600);

  // Expand the Airtable row: a closed report is a list of verdicts, an open one shows the receipts.
  const airtableRow = page.locator('.req-head', { hasText: 'Airtable' }).first();
  if (await airtableRow.count()) {
    await airtableRow.click();
    await settle(page, 300);
  }

  await shoot(page, '05-fit-report-full');

  await page.locator('.gaps').scrollIntoViewIfNeeded();
  await settle(page, 300);
  await shoot(page, '06-gaps');

  // Full-page version, for the write-up rather than the application.
  await page.screenshot({ path: join(OUT, '07-fit-report-tall.png'), fullPage: true });
  console.log('  wrote docs/screenshots/07-fit-report-tall.png');

  // ── 6. The record browser ───────────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await settle(page, 400);
  await shoot(page, '08-record-projects');

  await page.getByRole('button', { name: /^Capabilities/ }).click();
  await settle(page, 400);
  await shoot(page, '09-record-capabilities');

  await browser.close();
  console.log('\nDone. The three that need live accounts are in docs/SHOTLIST.md.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

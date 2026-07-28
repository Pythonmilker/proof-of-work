/**
 * Captures every screenshot that needs no accounts.  `pnpm screenshots`
 *
 * Scripted rather than taken by hand so they can be regenerated. The likeliest reason to reshoot is
 * pasting the real job posting over the sample, and re-framing a set of screenshots by hand every time
 * is how a deliverable ends up with one current image and one stale one.
 *
 * Writes to docs/screenshots/. Needs the dev server on 5273 and a reset first (`rm -f data/session.json`)
 * or the dedup branch fires where a shot expects a fresh record. The three shots that need live n8n and
 * Airtable accounts are described in docs/SHOTLIST.md.
 *
 * Shot order follows the reviewer's path, not the pipeline's: the fit report first, because that is what
 * the app now opens on and what a hiring manager should see in the first frame.
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

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
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

  // ── 1. The landing screen: the product sentence and a pre-filled posting ────────────────────────
  await shoot(page, '01-landing');

  // ── 2. The scored report, first citation panel already open ─────────────────────────────────────
  await page.getByRole('button', { name: 'Score this role' }).click();
  await page.waitForSelector('text=what this record does not cover', { timeout: 120_000 });
  await settle(page, 600);
  await shoot(page, '02-fit-report');

  // ── 3. The Gaps section, framed on its own ──────────────────────────────────────────────────────
  await page.locator('.gaps').scrollIntoViewIfNeeded();
  await settle(page, 300);
  await shoot(page, '03-gaps');

  await page.screenshot({ path: join(OUT, '04-fit-report-tall.png'), fullPage: true });
  console.log('  wrote docs/screenshots/04-fit-report-tall.png');

  // ── 4. Intake, before anything has been ingested ────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Add evidence', exact: true }).click();
  await settle(page, 300);
  await shoot(page, '05-intake');

  // ── 5. Before and after, from a real README ─────────────────────────────────────────────────────
  await page.getByRole('button', { name: /01-tendril-readme/ }).click();
  await settle(page, 200);
  await page.getByRole('button', { name: 'Ingest', exact: true }).click();
  await page.waitForSelector('text=Before — raw input', { timeout: 30_000 });
  await settle(page);
  await page.getByText('Before — raw input').scrollIntoViewIfNeeded();
  await settle(page, 250);
  await shoot(page, '06-before-after');

  // ── 6. The error branch: a rejection renders as a rejection ─────────────────────────────────────
  await page.getByRole('button', { name: /11-broken-fragment/ }).click();
  await settle(page, 200);
  await page.getByRole('button', { name: 'Ingest', exact: true }).click();
  await page.waitForSelector('text=parked in Needs Review', { timeout: 30_000 });
  await settle(page);
  await shoot(page, '07-needs-review');

  // ── 7. The record browser ───────────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'The record', exact: true }).click();
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

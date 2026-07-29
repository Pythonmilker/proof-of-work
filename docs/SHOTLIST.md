# Screenshots

Eleven are in `docs/screenshots/` already, written by `pnpm screenshots` (Playwright driving the
installed Chrome, so it needs no browser download). Three more need the live accounts. The committed
set predates the v3 tabs (Applicants / Score / Fit report), so the app shots want a reshoot; the
framing below is written against the current UI.

The five to attach to an application are marked **PICK** below. The rest are working shots.

Regenerate any time with:

```bash
rm -f data/session.json && pnpm dev     # in one terminal
pnpm screenshots                        # in another
```

Before any of them:

```bash
rm -f data/session.json
pnpm dev
```

Browser at **1440 x 900** or wider. Anything narrower stacks the layouts and photographs badly.

## 1. The n8n canvas  (PICK)

**Needs n8n.** This is the shot most reviewers look at first.

Setup, about ten minutes:

1. `npx n8n` locally, or an n8n Cloud trial
2. Settings, then import `n8n/extract-project.json` and `n8n/match-role.json`
3. Add an Airtable credential named `Airtable Personal Access Token`
4. Set `OPENROUTER_API_KEY`, `AIRTABLE_BASE_ID` and `POW_APP_TOKEN` as environment variables in n8n
5. Activate both workflows

Capture `extract-project.json`. Frame it so all four of these are visible at once:

- the `Usable record?` IF node with both branches leaving it
- the true branch running through the candidate and taxonomy loads into the Airtable writes
- the false branch ending at `Write Needs Review`
- the `Error branch note` sticky, which explains why the false branch exists

Zoom to fit, then nudge in one step. A canvas zoomed all the way out reads as a diagram nobody wrote.

Worth also capturing: `match-role.json` with the `Scoring note` sticky legible. Optional sixth shot.

## 2. Airtable Projects, one record expanded  (PICK)

**Needs Airtable.**

```bash
pnpm airtable:provision
pnpm airtable:push
```

Then `airtable/VIEWS.md`, which takes about two minutes.

Open Projects, expand **Tendril**. The expanded record has to show:

- Technologies with 20 linked chips
- Capabilities with 12 linked chips
- Evidence with 7 linked rows, the Microsoft Store product id among them
- the metrics: 132,000 LOC, 660 tests, 125 commits

The grid behind it should still be readable, so all seven projects are visible in the background.

## 3. The Interface pages  (PICK) — CAPTURED

**Captured 2026-07-29** as `12-airtable-pipeline.png` (Needs review counter at 1, the parked
fragment with its reason, Scoring Runs naming the applicant) and `13-airtable-fit-report.png`
(Applicant, Verdict Summary, 75, Scored On, the Results list with the trust line). Both cropped
from full-screen snips; rebuild instructions live in `airtable/INTERFACE.md`.

## 4. Raw blob against structured record  (PICK)

**No accounts needed.** Already captured as `06-before-after.png`. The live-mode pair (`10-live-landing.png`, `11-live-confirmation.png`) shows the app writing to the real base.

Applicants tab, the supporting-documents slot below the roster. Click `01-tendril-readme.md`, press
Ingest, scroll to the before-and-after panel. Left is 2,471 characters of prose; right is the
structured record with the metrics, the chips and the receipts. The transform line between them reads
the character count against the field count.

To reshoot: reset the record first (footer link), or dedup fires and the stage list says "updating"
rather than "new project".

## 5. The fit report with Gaps  (PICK)

**No accounts needed.** Already captured as `02-fit-report.png`, with `03-gaps.png` framing the Gaps section
on its own and `04-fit-report-tall.png` as a full-page version for the write-up.

Score tab, seeded applicant selected, "Score Joel's fit", then frame the Fit report so the gauge and
the Gaps section are both in view. Both gap rows (the degree line and the collaborate-with-vendors
line) should be legible.

Expand one requirement row before capturing so the citation panel is open. A closed report is a list of
verdicts; an open one shows the receipts, and the receipts are the argument.

The bundled posting is the actual LinkedIn posting, captured 2026-07-28, so this shot needs no
preparation.

## Optional sixth: the Slack message

**Needs Zapier.** `zapier/ZAP.md`. One message in a channel with a real title and a real score. It is
evidence the integration runs, and it does not need to be more than that.

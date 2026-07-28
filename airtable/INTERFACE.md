# Click-script 2: the two Interface pages (~60–90 minutes)

Prerequisite: every field in `VIEWS.md` §A exists. Interfaces have no API; this is the by-hand half.

Plan reality (verified 2026-07-27): on the Free plan these pages **cannot be shared publicly** — they
reach only invited collaborators with Airtable accounts. That is fine and planned-for: page 1 is the
**screenshot embedded in the application** (and becomes a public URL if a Team seat is ever added);
page 2 is operator-only. The recruiter's actual link is the shared view from `VIEWS.md` §B.

Use the **modern layouts** when prompted. Do not pick the legacy "Blank" layout — it is excluded from
sharing and deep links, and the screenshot should show the current product, not the deprecated one.

## Page 1 — `Fit report` (the screenshot)

**Interfaces → Create → start from Record detail** (called "Record review" in some versions), source
table **Roles**.

Configure the page:

- Record picker: **hidden** — pin the page to the Arootah posting record (choose it as the default /
  "specific record" if offered; otherwise leave the picker but screenshot with it collapsed).
- Title element (static text): `Joel Brannan` on one line, then
  `Fit report — AI Product Engineer, Arootah` as the heading.
- Subtitle (static text): `Scored 27 Jul 2026 · against your posting as written`

Then, top to bottom:

1. **Verdict block**
   - Field element: `Verdict Summary`, large text size. This is the headline — a fraction grades
     itself; a lone percentage invites "is that good?".
   - Field element beside it: `Score`, label overridden to **`Overall match`**, with a static text
     footnote right under it: `Must-haves count double.`
   - The word "weighted" must not appear anywhere on the page.
2. **Requirement list**
   - Element: the `Results` linked-record field, displayed as a **list/grid**, grouped by `Kind`
     (required first), fields: `Requirement`, `Verdict`, `Rationale`,
     `Receipts`. Hide everything else, especially `Match Score` and
     `Rationale Source`.
   - Colour by `Status` if the element offers conditional colour; the `Verdict` emoji carries the
     signal either way.
3. **Not covered section**
   - Static text header: `Not covered`
   - Static text sub-line: `Listed here so nothing surfaces late in your process.`
   - Second `Results` element, filtered `Status is gap` OR (`Status is partial` AND `Kind is
     required`) if the element supports filters; otherwise skip this element — the grouped list above
     already shows the red rows — and keep just the two text lines above the footer.
   - Static text closing line: `Worth probing in a first call.`
   - Same typography as the wins. A report that shrinks its gaps is apologising; one that formats
     them identically is auditing.
4. **Footer trust line** (static text, small):
   `Every Proven line links to something you can check without contacting the candidate. Scores are
   computed by fixed rules, identical for every posting — never by an AI.`
5. **Owner button** (optional): Button element → action **Go to URL** → dynamic, field `Score Link`.
   Label: `Score this posting`. Read-only viewers can click URL buttons; only you will ever see this
   page anyway on Free.

**Screenshot** (this page is deliverable screenshot #3): full page at 1440px+, verdict block and at
least one 🟢 row AND the red rows in the same frame. Green and red together is the argument.

## Page 2 — `Pipeline` (operator only, never shared, screenshot #4 if wanted)

Same interface, add a page → **Dashboard** layout, source **Projects**.

- Number element: source `Projects`, filter `Review Status is needs-review`, aggregation **Count**,
  label `Records parked for review`.
- List element: source `Projects`, same filter, fields `Name`, `Review Reason`, `Source`. Label the
  section `Needs review — kept, with the reason attached`.
- List element: source `Roles`, fields `Title`, `Company`, `Score`, `Model`, `Matched At`. Label it
  `Scoring runs`. This is where `Model` and `Rationale Source` transparency lives — on the operator
  page, where "parked for review" reads as diligence, not as broken data.

## Order of operations

1. `VIEWS.md` §A fields (10 min) → §B shared view + incognito test (10 min) → §C operator views (3 min)
2. This file: page 1 (45 min), page 2 (15 min)
3. Tell Claude the incognito test result and paste the share link into `.env.local` — the React app's
   "Open the fit report ↗" button reads it.

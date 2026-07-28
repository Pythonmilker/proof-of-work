# Click-script 2: the two Interface pages (~60–90 minutes)

Prerequisite: every field in `VIEWS.md` §A exists. Interfaces have no API; this is the by-hand half.

Plan reality (verified 2026-07-27): on the Free plan these pages **cannot be shared publicly** — they
reach only invited collaborators with Airtable accounts. That is fine and planned-for: page 1 is the
**screenshot embedded in the application** (and becomes a public URL if a Team seat is ever added);
page 2 is operator-only. The recruiter's actual link is the shared view from `VIEWS.md` §B.

Use the **modern layouts** when prompted. Do not pick the legacy "Blank" layout — it is excluded from
sharing and deep links, and the screenshot should show the current product, not the deprecated one.

**Current-UI constraints** (verified against support.airtable.com, 2026-07-28): modern record
review/record detail pages are a configured field list, not a canvas. The Text element exists only on
Blank and legacy layouts, the left record list cannot be hidden or pinned, and a linked-record field
shown as cards ("Show as: Field") mirrors the linked table's own view — its fields cannot be chosen
per-interface. What the page type does offer: per-page **Label** overrides, per-field **Helper text**
(Appearance), **group descriptions** ("Show description"), and **Show as: View** on linked-record
fields, which embeds a real list whose fields, sort and filter are configurable. The script uses those.

## Page 1 — `Fit report` (the screenshot)

**Interfaces → Create → Record review**, source table **Roles**. In the wizard, toggle on only
`Title`, `Company`, `Score`, `Verdict Summary`, `Results`. Then, in edit mode:

1. **Fields** (right panel → Data → Fields · gear): visible = `Candidate` and `Scored On` (both
   built in step 3), `Verdict Summary`, `Score`, `Company`, `Results`, in that order — drag to
   reorder. `Title` goes **off** here: the X-Large page heading is driven by the separate *Title
   field* setting, and leaving the row on prints the title twice. Everything else off too,
   especially `Key`, `Posted Text` and `Matched At` (a raw ISO timestamp; `Scored On` is its
   readable face).
2. **Verdict block**
   - `Verdict Summary` is the headline — a fraction grades itself; a lone percentage invites "is
     that good?".
   - Click `Score` → properties → **Label** → override to `Overall match` (renames it on this page
     only). No footnote: the fraction above it is the explanation, and the word "weighted" must not
     appear anywhere on the page.
3. **Name and date, field-driven** (hand-typed page furniture goes stale; fields recompute on every
   scoring run). In the **Data** tab, on **Roles**, add two Formula fields:

   - `Candidate` — the formula is just the constant `"Joel Brannan"` — so every scored posting
     carries the name, including ones scored later on camera.
   - `Scored On`:

     ```
     DATETIME_FORMAT(DATETIME_PARSE({Matched At}), 'D MMM YYYY')
     ```

   The page name stays plain `Fit report`; with `Candidate` on the record, a name in the page title
   would print it twice.
4. **Requirement list**
   - Click `Results` → properties → **Appearance → Show as → View**, style **List**.
   - Click the embedded list on the canvas → **Data → Fields** → visible: `Requirement`, `Verdict`,
     `Rationale`, `Receipts`. Hide everything else, especially `Match Score` and `Rationale Source`.
   - **Sort**: `Status` Z→A, so proven rows lead and the red rows close the page. If the list offers
     grouping, group by `Status` instead, proven first — same effect with headers.
   - **Helper text** on the Results field: `Every Proven line links to something you can check
     without contacting the candidate. Scores are computed by fixed rules, identical for every
     posting — never by an AI.`
5. **No separate "Not covered" section.** The sort puts the two red rows last, formatted identically
   to the wins — a report that shrinks its gaps is apologising; one that formats them identically is
   auditing. The shared view (`VIEWS.md` §B) carries the "worth probing in a first call" framing.
6. **User actions**: Edit fields **Off**, Comments off, Buttons **None**. The `Score Link` button
   idea is dropped — it needed the optional A6 field.

**Screenshot** (this page is deliverable screenshot #3): Publish first, full page at 1440px+, verdict
block and at least one 🟢 row AND a red row in the same frame — green and red together is the
argument. Crop the record-list pane; it cannot be hidden on this layout.

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

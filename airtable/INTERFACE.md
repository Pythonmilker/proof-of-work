# The Interface dashboard

Interfaces have no API either, so this is a click-script. Fifteen minutes, and it is screenshot #3.

The goal is one screen a non-engineer can read without being walked through it: which role was scored,
how well it came out, and what the evidence is behind each line.

## Build it

**Interfaces → + → Start from scratch → Blank page.** Name it `Fit Report`.

### 1. Role header

- Add an **Element → Text**, set to a field from `Roles`: `Title`
- Below it, another **Text** bound to `Company`
- Add a **Filter** element at the top of the page, source `Roles`, so the page is per-record

Set the page's record picker to `Roles`, sorted by `Matched At` descending, so it opens on the most
recent run.

### 2. Coverage gauge

- **Element → Number** → source `Roles.Score`
- Set the label to `Weighted coverage`, suffix `%`
- **Conditional colour**: ≥ 75 green, 50–74 amber, < 50 red

Those breakpoints are for reading at a glance and are not the scoring thresholds — those live in
`src/pipeline/score.ts` and are the only ones that decide anything.

### 3. Requirement table

This used to be the awkward part of the page. `Results` was an escaped JSON string in a long-text field,
so the only options were to render the raw JSON or to put the React app next to the Interface and change
the subject. The sixth table fixed it, and this is now the best element on the dashboard.

- **Element → Grid**, source `Results`
- Filter: `Role` `is` the record picker's selection
- Sort: `Kind` ascending, then `Status` ascending, so required gaps land at the top
- Show `Requirement`, `Status`, `Match Score`, `Rationale`, `Evidence`
- **Conditional colour** on `Status`: proven green, partial amber, gap red
- Row click → open record, which shows the linked Technologies, Capabilities, Projects and Evidence

That last point is the one to capture. Clicking a requirement opens a record whose citations are real
links you can follow into the Projects and Evidence tables. When results were a JSON string, those
citations were slugs buried inside text and the base could not see them at all.

### 4. Evidence list

- **Element → List** → source `Evidence`
- Filter: `Projects` `has any of` → linked from the record picker
- Show `Label`, `Value`, `URL`
- Row click → open record

### 5. Needs Review counter

- **Element → Number** → source `Projects`, filtered to `Review Status is needs-review`, aggregation
  `Count`
- Label it `Records parked for review`

Small, and it is the element that makes the error branch visible on a dashboard rather than only in a
table.

## What to capture

Land on the most recent `Roles` record, gauge visible, Evidence list populated, Needs Review count at 1
after ingesting `raw/11-broken-fragment.txt`.

Widen the browser to at least 1440px first — Interfaces stack into a single column below about 1100px,
and a stacked dashboard photographs badly.

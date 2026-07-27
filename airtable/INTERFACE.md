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

`Results` is stored as JSON in one long-text field, which an Interface cannot expand into rows. Two
honest options:

**A. Show the JSON (two minutes).** Add a **Text** element bound to `Results`. Ugly, complete, and fine
for a working dashboard.

**B. Add a sixth table (do not).** Splitting results into their own table would make a lovely Interface
grid and would break the five-table constraint this project is built around. The constraint is worth
more than the grid.

**C. What is actually recommended.** Put the React fit report beside the Interface in the screenshot.
The Interface shows the record and the score; the app shows the requirement-by-requirement breakdown
with the citations expanded. They are two views of the same data, and saying so is more interesting
than pretending one tool does everything.

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

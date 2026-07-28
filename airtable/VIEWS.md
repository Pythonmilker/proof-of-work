# Click-script 1: fields and the shared view

Everything Airtable's API cannot create, in the order to build it. Formulas are copy-paste. Field names
matter — copy them exactly, including capitalisation; the React app and the docs refer to them.

Base: https://airtable.com/appbhjbhVTyt6lK3e

Stored values never change (`proven` / `partial` / `gap` stay lowercase — the pipeline writes them and
the tests pin them). Everything recruiter-facing below is a display formula over those values.

## A. Formula fields (~10 minutes)

### A1. Evidence table → field `Receipt`

Type: **Formula**

```
CONCATENATE(Label, " — ", Value, IF(URL, " · " & URL, ""), " · Verified ", {Verified On})
```

One line per receipt, self-contained, with the date. The rollup in A3 joins these.

### A2. Results table → field `Verdict`

Type: **Formula**

```
SWITCH(Status, "proven", "🟢 Proven", "partial", "🟠 Partial", "gap", "🔴 Not covered", Status)
```

This is the recruiter's status column. The raw `Status` select stays hidden everywhere.

### A3. Results table → field `Receipts`

Type: **Rollup** · linked field `Evidence` · rollup field `Receipt` · aggregation:

```
ARRAYJOIN(values, "\n")
```

Turn ON "Show each value on a new line" if the option appears.

### A4. Roles table → three counting rollups

All three: Type **Rollup** · linked field `Results` · rollup field `Status` · aggregation
`COUNTALL(values)` · **with a condition** ("Only include linked records from the Results table that
meet certain conditions"):

| Field name | Condition |
|---|---|
| `# Proven` | Status is proven |
| `# Partial` | Status is partial |
| `# Not covered` | Status is gap |

### A5. Roles table → field `Verdict Summary`

Type: **Formula**

```
CONCATENATE("Meets ", {# Proven}, " of ", {Requirement Count}, " requirements in full · ", {# Partial}, " in part · ", {# Not covered}, " not covered")
```

### A6 (optional, owner convenience). Roles table → field `Score Link`

Type: **Formula**

```
CONCATENATE("http://localhost:5273/?roleKey=", Key)
```

Only works on your machine with the dev server running — it opens the React trigger surface with this
posting pre-loaded. Recruiters never see this field.

## B. The shared view — the recruiter's link (~10 minutes)

Table: **Results** → create Grid view → name it exactly:

```
Fit report — Joel Brannan × Arootah
```

(Your name is deliberately in the view title; it is the only place the shared grid shows it.)

1. **Filter:** `Role` `is` the Arootah posting record.
2. **Group:** by `Kind` — drag **required** above **preferred**.
3. **Sort** inside groups: `Verdict` A→Z (🟢 sorts first, then 🟠, then 🔴 — emoji sort is what makes
   this work).
4. **Field order and visibility.** Visible, in this order — hide EVERYTHING else:
   - `Requirement`
   - `Verdict`
   - `Rationale` — rename its label in this view is not possible; leave the name, it reads fine
   - `Shortfall`
   - `Receipts`
   - `Projects`
   Hidden (the full list, check each): `Key`, `Kind` (it's the group header already), `Category`,
   `Status`, `Match Score`, `Rationale Source`, `Role`, `Technologies`, `Capabilities`, `Evidence`
   (the raw link — the rollup replaces it).
5. **Row height:** Medium. Wrap on for `Rationale` and `Receipts` if offered.
6. **Colour** (view menu → Color → by single select `Status`): proven green, partial amber, gap red.

### Share it

View menu → **Share view** → Create link.

- Turn **OFF** "Allow viewers to copy data out of this view".
- No password option exists on Free — the URL is the secret. When a search closes, come back here and
  disable the link. That is the documented operating step.

### Test it incognito — do not skip

Open the link in a private window (logged out):

- [ ] No login prompt, loads straight to the grid
- [ ] Group counts visible (the 9 · 3 · 2 tally)
- [ ] Expand a row: only the six visible fields appear — **if hidden fields leak into the expanded
      record, stop and tell Claude; the share settings need a different approach**
- [ ] Click an evidence URL from the rollup text: opens the Store listing / live site
- [ ] Colours render for the anonymous viewer

Paste the working link into `.env.local` as:

```
VITE_AIRTABLE_REPORT_URL=<the share link>
```

## C. Two operator views (~3 minutes, unchanged from v1)

1. **Projects → `Needs Review`:** filter `Review Status` is `needs-review`; show `Name`,
   `Review Reason`, `Source` first; colour needs-review red.
2. **Capabilities → `Proven Capabilities`:** filter `Tier` is `proven` AND `Evidence` is not empty;
   group by `Tier`; hide `Key`, `Match Terms`.

These are for you and the Pipeline interface page, never for the shared link.

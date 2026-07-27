# The two views

Airtable has no API for creating views, so these are the one part of the base that has to be clicked.
Both take under a minute.

## 1. Proven Capabilities — the recruiter view

Table: **Capabilities**

1. **Grid view → +** → name it `Proven Capabilities`
2. **Filter** → `Where` `Tier` `is` `proven`
3. **+ Add condition** → `Evidence` `is not empty`
4. **Group** → by `Tier`
5. Hide `Key` and `Match Terms` — they are plumbing, and they crowd the screenshot

What it is for: everything the record can actually stand behind. A capability that is proven but has
nothing linked drops out of this view, which is the whole point of the filter having two conditions
instead of one.

## 2. Needs Review — the operator view

Table: **Projects**

1. **Grid view → +** → name it `Needs Review`
2. **Filter** → `Where` `Review Status` `is` `needs-review`
3. Reorder fields so `Name`, `Review Reason` and `Source` come first
4. **Colour** → by `Review Status`, `needs-review` in red

What it is for: extraction failures, kept rather than dropped. Run the pipeline on
`raw/11-broken-fragment.txt` and a row appears here with the validator's reason attached.

A pipeline that discards what it cannot parse produces output that looks complete and is not, and the
omission is invisible — the report simply never mentions the thing. This view is that decision made
visible.

## Optional, and worth the thirty seconds

On **Capabilities**, add a colour rule: `Evidence` `is empty` → amber. Unverified rows then read as
unverified at a glance, in the grid as well as in the app.

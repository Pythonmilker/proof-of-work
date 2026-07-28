# The three views

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

## 3. Gaps — the one the sixth table bought

Table: **Results**

1. **Grid view → +** → name it `Gaps`
2. **Filter** → `Where` `Status` `is not` `proven`
3. **Group** → by `Kind`, so required items sit above preferred ones
4. **Colour** → by `Status`: `partial` amber, `gap` red
5. Show `Requirement`, `Status`, `Shortfall`, `Projects`, `Evidence`

This view could not exist at all until Results became rows. While each report was an escaped JSON string
in a long-text field on Roles, no filter could reach a status, no group could reach a kind, and no colour
rule could reach anything. That is the clearest single argument for the sixth table, and it is worth
saying out loud when someone asks why the count went from five to six.

## Optional, and worth the thirty seconds

On **Capabilities**, add a colour rule: `Evidence` `is empty` → amber. Unverified rows then read as
unverified at a glance, in the grid as well as in the app.

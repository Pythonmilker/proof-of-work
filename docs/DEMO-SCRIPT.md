# Demo script

Target 75 seconds. One take, no cuts. Everything below runs with no credentials, so nothing can fail on
camera because a key expired.

## Before recording

```bash
rm -f data/session.json
pnpm dev
```

Browser at 1440 x 900, no bookmarks bar, no other tabs. Land on Intake with the box empty.

If n8n and Airtable are running, keep them in two background tabs. They appear once each, for four
seconds, and are not driven live.

## The take

**0:00 to 0:10. What it is.**

> "This ingests messy evidence of what somebody built, turns it into a record where every claim links to
> something checkable, and scores it against a job description."

On screen: the Intake page, sample list visible. Do not move the mouse yet.

**0:10 to 0:25. The mess going in.**

Click `01-tendril-readme.md`. The box fills with a README.

> "This is a real README. Prose, a feature table, a version number, a store id buried in the last
> paragraph."

Scroll the textarea once so it is obvious there is more than fits.

**0:25 to 0:40. Ingest, and the stage list.**

Press Ingest. Five lines resolve.

> "Extract, validate, dedup, link, write. Validation is deterministic, so an implausible metric gets
> rejected rather than published. And it found this record already, so it updates instead of creating a
> second one."

Point at the `dedup` line reading `updating "Tendril" (same slug)`.

**0:40 to 0:50. The error branch.**

Click `11-broken-fragment.txt`, press Ingest.

> "Nothing checkable in that one. It does not get dropped, it gets a row in Needs Review with the reason
> attached."

The validate line goes red. Needs Review in the counts strip goes to 1.

This beat is worth the ten seconds. A pipeline that silently discards what it cannot parse produces
output that looks complete and is not.

**0:50 to 1:05. The match.**

Click Match. The posting is already in the box. Press "Score this role".

> "The posting gets parsed into requirements, matched against the record in code, and scored in code.
> 78 percent. Nine proven, three partial, two gaps."

Expand one proven row.

> "Every line cites the rows it matched and the receipts behind them. A Microsoft Store id, a test count,
> a live URL."

**1:05 to 1:15. The part that matters.**

Scroll to Gaps.

> "Airtable and n8n come out partial, and the only evidence for either one is this project. It says so.
> A capability with nothing linked to it cannot score as proven no matter how well it matches, which is
> the difference between a capability record and a resume."

Hold on the Gaps section for three seconds. Stop.

## If n8n and Airtable are live

Add ten seconds between the ingest beat and the match beat. Switch to the n8n tab:

> "Same pipeline, two committed workflows. This node is where the score is computed, in code, before any
> model is asked to write a sentence."

Then the Airtable tab, one second on the Needs Review view.

Do not run anything live in either tab. They are illustrations, and driving a SaaS UI on camera is how a
75-second take becomes a four-minute one.

## Compression

Windows Game Bar records at a high bitrate. ffmpeg brings a 75-second capture under 10 MB without
touching the text:

```bash
ffmpeg -i raw-capture.mp4 -c:v libx264 -crf 23 -preset slow -movflags +faststart -c:a copy proof-of-work-demo.mp4
```

Keep the full resolution. Downscaling makes the fit report unreadable, and the fit report is the point.

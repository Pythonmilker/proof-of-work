# Demo script

Target 75 seconds. One take, no cuts. Everything below runs with no credentials, so nothing can fail on
camera because a key expired. Every beat, including the promotion, is verified against the
credential-free path with the exact texts below.

## Before recording

```bash
rm -f data/session.json
pnpm dev
```

Browser at 1440 x 900, no bookmarks bar. One background tab: the shared Airtable view. Land on the
Applicants tab.

Put the two paste texts below in a scratch file. Copying them mid-take reads as fumbling.

The resume:

```
# Jane Doe
jane.doe@example.net

## Skills
React, TypeScript, AWS Lambda, Terraform, DynamoDB, Playwright

## Experience
### Platform Engineer - Initech
- Built an internal React dashboard over DynamoDB for workflow tracking
- Automated infrastructure deployments with Terraform
```

The supporting document:

```
# Initech workflow dashboard - delivery notes

Jane built an internal React dashboard over DynamoDB for workflow tracking; it went live in 2025-11.

- Stack: React, TypeScript, DynamoDB, AWS Lambda
- 214 tests passing
- Live at https://dashboard.initech.example
```

## The take

**0:00 to 0:10. The roster.**

> "This is a hiring tool, and the roster ships with one worked example: me. Every applicant is a claim
> sheet, and every claim either carries a receipt or is flagged unverified."

On screen: Applicants, the seeded applicant selected, 22 verified claim chips visible.

**0:10 to 0:25. A resume lands.**

Paste the resume into New applicant, press "Read the resume".

> "Paste a resume and every claim lands unverified. That is the honest default. A resume asserts, it
> does not prove, and nothing in this system gets credit for describing itself."

Both of Jane's chips read unverified.

**0:25 to 0:40. A claim earns its receipt.**

Paste the delivery notes into the supporting-documents slot below, press Ingest.

> "Supporting documents promote claims. This one carries a test count and a live URL, the receipts
> attach to the claim they back, and the chip flips. The chips that never flip are the interview
> questions."

One chip turns verified. The other stays unverified. Point at the one that stayed.

**0:40 to 1:00. The score.**

Open Score, select the seeded applicant in the radio list. The Arootah posting is pre-loaded. Press
"Score Joel's fit".

> "Any applicant against any posting. Requirements parsed out, matched against the record in code,
> scored in code. 75 percent: ten proven, four partial, two gaps. Every verdict cites the rows and
> receipts behind it."

Expand one proven row so the citations are visible.

**1:00 to 1:15. The gaps.**

Scroll to Gaps.

> "And it says what is missing. The degree, the vendor line: real gaps, on the record. A scorer that
> only reports hits is a flattery generator. The one that admits what is missing is the one you can
> trust. The whole record is a shared Airtable view, no login, one link."

Switch to the shared-view tab for the last two seconds. Stop.

## Timing notes

The spoken lines above total 180 words, roughly 75 seconds at demo pace. The hard ceiling is 90.
If a beat runs long, cut the second sentence of the roster beat first; never cut the gaps beat.

## Compression

Windows Game Bar records at a high bitrate. ffmpeg brings a 75-second capture under 10 MB without
touching the text:

```bash
ffmpeg -i raw-capture.mp4 -c:v libx264 -crf 23 -preset slow -movflags +faststart -c:a copy proof-of-work-demo.mp4
```

Keep the full resolution. Downscaling makes the fit report unreadable, and the fit report is the point.

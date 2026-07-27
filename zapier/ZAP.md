# The Zap

One Zap, about thirty minutes, and it is worth being straight about what it is for.

**n8n carries the pipeline. Zapier carries the notification.** The pipeline needs branching, code nodes,
and version control, and Zapier is not the tool for any of those. Notifying a channel when a row appears
is exactly what Zapier is good at, and reaching for n8n to do it would be the same mistake in the other
direction. A demo that pretended one tool did everything would be less convincing, not more.

## What it does

```
New record in Airtable · Roles
        │
        ▼
Filter · only continue if Score is set
        │
        ▼
Slack · send a channel message
```

## Build it

### 1. Trigger — Airtable, New Record

- **App**: Airtable
- **Event**: New Record
- **Base**: Proof of Work
- **Table**: Roles
- **Limit to view**: leave empty

Connect the same personal access token used elsewhere. Zapier polls on a schedule (every 1–15 minutes
depending on plan), so the Slack message arrives a little after the run finishes rather than instantly.
Say so in the demo rather than waiting on camera for it.

### 2. Filter — only continue if the row is finished

- **Condition**: `Score` — *Exists*

Airtable fires the trigger the moment a row is created, and the pipeline writes the row and its score
together — but a row created by hand, or a partially written one, should not page anybody. One condition,
and it removes the only false-positive this Zap can produce.

### 3. Action — Slack, Send Channel Message

- **Channel**: `#fit-reports` (or a DM to yourself while testing)
- **Message text**:

```
New fit report — {{Title}} at {{Company}}
Coverage {{Score}}%
Matched {{Matched At}} · rationales by {{Model}}
```

- **Send as a bot**: yes
- **Include a link back**: paste the base URL into the message footer; Airtable's record link is not
  exposed as a trigger field, so linking to the table is the honest version

## Test it without waiting for a real run

`sample-payload.json` in this folder is a real row shape from the Roles table. Two ways to use it:

- **In Zapier**: after setting up the trigger, use *Test trigger* — it pulls the newest real row, which
  after `pnpm airtable:push` and one match run is exactly this shape.
- **By hand**: add a row to Roles with `Title`, `Company` and `Score` filled in, then re-run the test.
  Delete the row afterwards.

## What to capture

The Slack message itself, in a channel, with a real title and a real score. One screenshot. It is
evidence that the integration exists and runs, and it does not need to be more than that.

## Known limits, stated plainly

- **Polling, not push.** Up to 15 minutes on the free plan. A webhook trigger would be instant and needs
  a paid Zapier plan plus an Airtable automation to call it.
- **No retry visibility.** A failed Zap shows in the task history and nowhere else. The n8n workflows
  have an explicit error branch; this does not, because a missed notification is recoverable and a
  missed record is not.
- **The record link is approximate.** Airtable does not expose a per-record URL through the Zapier
  trigger, so the message links to the table.

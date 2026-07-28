# VHD Outreach — runbook notes

internal notes, cleaned up enough to hand over. this is the cold-email engine that runs the agency's
prospecting. live since Feb 2026 as part of the viralhostdigital.com estate.

## what it does

- multi-step sequences: initial + follow-ups, each step its own template, advanced only if no reply
- EventBridge schedules drive every step. nothing runs from a laptop
- daily send caps per identity, so a bad list can't torch the domain reputation
- suppression list checked before every send (unsubs, bounces, complaints, manual blocks)
- CAN-SPAM: working unsubscribe link, physical address in footer, honored immediately
- per-prospect personalized review pages, generated and served behind CloudFront
- delivery split across Brevo and SES; bounces and complaints flow back through SNS into the
  suppression table

## moving parts

Brevo + Amazon SES for delivery. Lambda for the senders and the webhook handlers. EventBridge for the
schedules. DynamoDB for sequences, prospects and suppression. CloudFront for the review pages.
All of it in the same Terraform estate as the rest of viralhostdigital.com (outreach.tf,
outreach-studio.tf).

## operational rules

- never send to anyone on the suppression table, no exceptions, checked at send time not at enqueue
- a hard bounce suppresses immediately. a complaint suppresses the whole domain's contacts
- caps are per-day per-identity and the counter resets on UTC midnight
- pausing a sequence is one flag; the scheduled steps check it before doing anything

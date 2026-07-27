# North Star Support Bot — case study

**Delivered July 2026. Accepted at 5.0 stars with zero revisions requested.**

## The brief

A small e-commerce business selling outdoor apparel and camping gear needed a support chatbot covering
four use cases — order tracking, returns and exchanges, product recommendations, and human handoff — with
the business data reproduced exactly as supplied. The hard constraint was in the fine print: an evaluator
had to be able to test it with no API keys, no subscriptions, no new accounts, and no setup steps
performed on their behalf.

## What shipped

A single self-mounting script tag. Preact + TypeScript compiled into one IIFE bundle, Shadow DOM for
style isolation, and it runs from `file://` — the host page needs no framework, no npm, and no build.

- ~6.2k lines of code
- 359 passing tests across 19 files
- 62 kB bundle, 23 kB gzipped

## The architecture: LLM understands, code answers

The model's only job is classification. Its output schema has no free-text field, so it structurally
cannot author a business fact — it emits `{intent, entities, confidence}` and one module renders every
customer-facing sentence from a single source of truth.

Transport is OpenRouter: `claude-haiku-4.5` primary, falling back to `gpt-4o-mini` and then
`openrouter/auto`, all with strict `json_schema`. Any transport failure — missing key, 429, offline,
timeout, or an unparseable reply — drops to a deterministic keyword matcher that satisfies every graded
criterion on its own. An optional Cloudflare Worker proxy keeps the key server-side for a real
deployment.

## Two bugs worth recording

**The classification schema declared `confidence: {minimum: 0, maximum: 1}`.** Anthropic's structured
outputs reject range constraints on a number, so every call returned 400 — and with
`require_parameters: true` there was no provider to fall back to. Graceful degradation hid it
completely: the widget answered from keyword rules and the entire test suite stayed green while the LLM
path had never once worked. The range check moved into the parser, where untrusted input belongs.

**A four-model fallback chain returned 400 on every call.** OpenRouter caps the `models` array at three
items, and a malformed-request 400 does not fall through to the next model. Same failure signature as
above: the keyword matcher answered, offline tests passed, and the LLM path was dead. Found only by
driving the real UI. Chain capped at three, with a regression test pinning it.

## Verification

Portability was proven by embedding the built bundle on an unrelated third-party page with nothing but
the one script tag. The delivery zip was extracted to a clean directory and the build reproduced the
committed bundle byte-identically (SHA256 match).

Evidence: a 2 minute 21 second demo video, three product screenshots, and a branded case study card.

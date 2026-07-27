parastoria — working notes, jul 2026
====================================

(dumping this out of my head before I forget it. cleaned up later maybe)

what it is: cross-platform tabletop-RPG world & campaign app. procedural world generation, AI game
tools, offline-first sync, companion second-screen, paid membership. Jun–Jul 2026, currently in
polish/QA. installer built and installed locally, store submission planned, backend is deployed.

MONOREPO LAYOUT
  desktop/      Electron 32 + React 18 + PixiJS 8, better-sqlite3 in a sandboxed sidecar process
  companion/    PWA (second screen)
  mobile/       Capacitor 6 Android spike
  site/         Astro marketing site
  infra/        AWS SAM

backend bits that are actually deployed:
  - Cognito OAuth
  - Stripe subscriptions, $9.99/mo and $99/yr
  - DynamoDB single-table
  - WebSocket relay
  - S3 lease-based sync
  - Lambda response-streaming LLM proxy
  - SES

size right now:
  ~70k LOC, roughly 430 files
  65 test files / about 891 test cases
  185 commits

things I'm actually proud of
  * deterministic procedural worldgen — priority-flood watershed regions, locked down by
    golden-hash regression tests so a refactor can't silently change a generated world
  * conflict-safe cross-device sync with explicit anti-data-loss invariants, tested on BOTH the
    client and the server side. this took three attempts
  * hosted LLM streaming proxy with atomic usage reservation + free-tier device-hash metering
  * ONE renderer running in Electron, a browser, and Android, behind a clean window.api seam
  * full legal/compliance page set drafted and live in the site build (privacy, tos, eula)

predecessor: TTRPG_HUB, ~11.7k LOC python v1. gemini knowledge-graph RAG, multiple AI personas,
procedural generation. worth keeping around as evidence of the 2-generation trajectory.

domain: parastoria.app (SES-verified)

TODO before store submission
  - finish the account-deletion flow (platform compliance requires it)
  - android build signing
  - decide on the free tier limits

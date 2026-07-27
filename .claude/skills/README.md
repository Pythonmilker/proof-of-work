# Gig-scoped skills

Skills placed here load **only when working in this gig**, and they leave with the repo when it ends — so
there's nothing to clean up later. Put anything client-specific here (their data, their app, their acceptance
criteria).

Two ways to populate it:

1. **Copy a work-type pack** — if this gig matches a known shape:
   ```bash
   cp -r ../../_reference/skill-packs/<type>/. .claude/skills/
   ```
2. **Write bespoke skills** for this client's own procedures.

Also run **`/run-skill-generator`** once the app boots — it records the real launch recipe as a `run-<app>`
skill so every future session and subagent starts it correctly.

Before adding anything, run **`/skill-scoping`**: the narrowest tier that works is the right one, and
deterministic checks belong in tests, not skills.

# Tendril

**The agent-first IDE for multi-project orchestration.**

Tendril coordinates multiple AI agents that plan, code, audit, and ship — across all your projects
simultaneously. A knowledge graph connects everything, so agents learn from one project and apply that
knowledge to the next.

## Requirements

- **Git** (any recent version)
- **Node.js** 20+
- **Windows 10+**, **macOS 12+**, or **Linux** (x64/arm64)

## Quick Start

```bash
npm install
cd dashboard-ui && npm install && npm run build && cd ..
node server.js
# Open http://localhost:3847
```

## How It Works

1. **Create a project** — point Tendril at a local folder or clone from GitHub
2. **Describe what you want** — Tendril's discovery agent reads your codebase and plans subtasks
3. **Review the plan** — approve, edit, or reject before any code is written
4. **Agents execute** — multiple sub-agents work in parallel, each in an isolated git worktree
5. **Quality audit** — automated review scores the work and flags issues
6. **Commit & ship** — one-click merge, commit, and optional GitHub PR

## Architecture

- `server.js` — Backend server (WebSocket + HTTP)
- `dashboard-ui/` — React + Tailwind dashboard (Vite build)
- `src/core/` — Agent loop, knowledge graph, planning, git isolation
- `electron/` — Desktop app shell
- `lambda/` — AWS Lambda functions for licensing & payments

## Provider support

Bring your own key. Anthropic, OpenAI, or Google — every provider is normalised through a translation
layer into the Claude Agent SDK, so one agent runtime serves all three. The streaming translation proxy
(Anthropic ↔ OpenAI/Gemini SSE state machine) is 2,629 lines on its own.

## Knowledge graph

SQLite + sqlite-vec, tree-sitter parsers for 20 languages. Symbols, references, and file relationships
are indexed locally; nothing about your code leaves the machine.

## Status

v1.0.159. Published on the Microsoft Store, product ID 9NRC4P6JQ962. Passed store certification in
June 2026 after 10 rounds (R2 through R10 approved) with documented policy remediations — §10.1.5
runtime bundling and a §10.8 monetization redesign using a single-use JWT nonce handoff to web checkout.

Licensing backend: Stripe checkout + Cognito tiers + 3-device DynamoDB binding + JWT-authorized usage
metering. Code protection via bytenode + obfuscator. Clean-VM test rig runs in Windows Sandbox.

Roughly 132k lines across the repo. 125 commits.

https://tendrilapp.ai

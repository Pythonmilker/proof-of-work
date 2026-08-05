/**
 * The seed dataset.
 *
 * One candidate's record, and it is a fixture in exactly the way a CRM demo ships with sample contacts.
 * The product is generic; this is the data that happens to be loaded.
 *
 * **Every number here is traced to a real artifact and must not be adjusted for effect.**
 * `tests/seed-integrity.test.ts` checks each metric against the evidence row that backs it and fails the
 * build on a mismatch. A wrong test count is worse than no test count, because the entire argument this
 * project makes is that the numbers are verifiably real. Rounding one to make a sentence read better
 * would cost more than it buys.
 *
 * Typed as `Snapshot` on purpose — the compiler is the first check that the seed matches the schema.
 */

import { DEFAULT_CANDIDATE_ID, type Candidate, type Capability, type Evidence, type Project, type Snapshot, type Technology } from './types';

const VERIFIED = '2026-07-27';

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Candidates
 *
 * One row: the whole existing record, wrapped. The link arrays start empty and are mirrored from the
 * `candidate` stamp on every project, capability and evidence row — same pattern as the technologies'
 * reverse links below, and for the same reason: one declared direction cannot drift from the other.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const candidates: Candidate[] = [
  {
    id: DEFAULT_CANDIDATE_ID,
    name: 'Joel Brannan',
    contact: 'joelb@viralhostdigital.com',
    source: 'seed',
    ingestedAt: `${VERIFIED}T00:00:00.000Z`,
    projects: [],
    capabilities: [],
    evidence: [],
  },
];

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Technologies
 *
 * `aliases` is the reason lexical retrieval works at all. Every entry is a spelling a real job posting
 * has used. Widening a match is a row edit here, never a code change — which is the whole argument for
 * keeping the taxonomy as data.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const technologies: Technology[] = [
  // languages
  { id: 'typescript', name: 'TypeScript', aliases: ['ts', 'typescript'], category: 'language', projects: [] },
  { id: 'javascript', name: 'JavaScript', aliases: ['js', 'javascript', 'es6', 'ecmascript'], category: 'language', projects: [] },
  { id: 'python', name: 'Python', aliases: ['python', 'python3'], category: 'language', projects: [] },
  { id: 'csharp', name: 'C#', aliases: ['c#', 'csharp', 'c sharp', 'dotnet', '.net'], category: 'language', projects: [] },
  { id: 'sql', name: 'SQL', aliases: ['sql'], category: 'language', projects: [] },

  // frameworks and runtimes
  { id: 'react', name: 'React', aliases: ['react', 'react.js', 'reactjs', 'react-based', 'react 18', 'react 19'], category: 'framework', projects: [] },
  { id: 'preact', name: 'Preact', aliases: ['preact'], category: 'framework', projects: [] },
  { id: 'nodejs', name: 'Node.js', aliases: ['node', 'node.js', 'nodejs'], category: 'framework', projects: [] },
  { id: 'electron', name: 'Electron', aliases: ['electron', 'electron 32', 'electron 41'], category: 'framework', projects: [] },
  { id: 'astro', name: 'Astro', aliases: ['astro'], category: 'framework', projects: [] },
  { id: 'vite', name: 'Vite', aliases: ['vite'], category: 'framework', projects: [] },
  { id: 'tailwind', name: 'Tailwind CSS', aliases: ['tailwind', 'tailwind css', 'tailwindcss'], category: 'framework', projects: [] },
  { id: 'pixijs', name: 'PixiJS', aliases: ['pixi', 'pixijs', 'pixi.js'], category: 'framework', projects: [] },
  { id: 'capacitor', name: 'Capacitor', aliases: ['capacitor', 'capacitor 6'], category: 'framework', projects: [] },
  { id: 'threejs', name: 'Three.js', aliases: ['three.js', 'threejs', 'react-three-fiber', 'r3f'], category: 'framework', projects: [] },
  { id: 'unity', name: 'Unity', aliases: ['unity', 'unity3d'], category: 'framework', projects: [] },

  // cloud
  { id: 'aws-lambda', name: 'AWS Lambda', aliases: ['lambda', 'aws lambda', 'serverless functions'], category: 'cloud', projects: [] },
  { id: 'api-gateway', name: 'API Gateway', aliases: ['api gateway', 'apigateway', 'apigatewayv2'], category: 'cloud', projects: [] },
  { id: 'dynamodb', name: 'DynamoDB', aliases: ['dynamodb', 'dynamo'], category: 'cloud', projects: [] },
  { id: 's3', name: 'Amazon S3', aliases: ['s3', 'amazon s3'], category: 'cloud', projects: [] },
  { id: 'cloudfront', name: 'CloudFront', aliases: ['cloudfront', 'cdn'], category: 'cloud', projects: [] },
  { id: 'cognito', name: 'Cognito', aliases: ['cognito', 'aws cognito'], category: 'cloud', projects: [] },
  { id: 'ses', name: 'Amazon SES', aliases: ['ses', 'amazon ses', 'simple email service'], category: 'cloud', projects: [] },
  { id: 'eventbridge', name: 'EventBridge', aliases: ['eventbridge', 'event bridge'], category: 'cloud', projects: [] },
  { id: 'waf', name: 'AWS WAF', aliases: ['waf', 'aws waf', 'web application firewall'], category: 'cloud', projects: [] },
  { id: 'terraform', name: 'Terraform', aliases: ['terraform', 'hcl', 'infrastructure as code', 'iac'], category: 'cloud', projects: [] },
  { id: 'aws-sam', name: 'AWS SAM', aliases: ['sam', 'aws sam', 'serverless application model'], category: 'cloud', projects: [] },
  { id: 'codebuild', name: 'AWS CodeBuild', aliases: ['codebuild', 'aws codebuild'], category: 'cloud', projects: [] },

  // data
  { id: 'sqlite', name: 'SQLite', aliases: ['sqlite', 'better-sqlite3', 'sqlite3'], category: 'data', projects: [] },
  { id: 'sqlite-vec', name: 'sqlite-vec', aliases: ['sqlite-vec', 'vector index', 'vector database', 'vector store'], category: 'data', projects: [] },

  // ai
  // 'claude code' was an alias here until 2026-08-05 and should never have been. Calling the model
  // programmatically is not driving the agentic CLI, and the alias silently traded one for the other —
  // the same shape as `react` matching `react-three-fiber`. The weighing pass caught it on its first
  // real run. Claude Code now has its own capability row with its own receipt: cap-claude-code.
  { id: 'claude-api', name: 'Claude API', aliases: ['claude', 'anthropic', 'claude api', 'anthropic api', 'claude agent sdk'], category: 'ai', projects: [] },
  { id: 'openai-api', name: 'OpenAI API', aliases: ['openai', 'gpt', 'gpt-4', 'openai api', 'chatgpt'], category: 'ai', projects: [] },
  { id: 'gemini', name: 'Google Gemini', aliases: ['gemini', 'google gemini', 'vertex'], category: 'ai', projects: [] },
  { id: 'openrouter', name: 'OpenRouter', aliases: ['openrouter'], category: 'ai', projects: [] },
  { id: 'vercel-ai-sdk', name: 'Vercel AI SDK', aliases: ['vercel ai sdk', 'ai sdk'], category: 'ai', projects: [] },

  // automation — the two the record actually has
  { id: 'airtable', name: 'Airtable', aliases: ['airtable', 'air table'], category: 'automation', projects: [] },
  { id: 'n8n', name: 'n8n', aliases: ['n8n', 'n8n.io'], category: 'automation', projects: [] },

  { id: 'brevo', name: 'Brevo', aliases: ['brevo', 'sendinblue'], category: 'automation', projects: [] },

  // payments
  { id: 'stripe', name: 'Stripe', aliases: ['stripe', 'stripe billing', 'stripe checkout'], category: 'payments', projects: [] },

  // tooling
  { id: 'vitest', name: 'Vitest', aliases: ['vitest'], category: 'tooling', projects: [] },
  { id: 'playwright', name: 'Playwright', aliases: ['playwright', 'e2e testing', 'end-to-end testing'], category: 'tooling', projects: [] },
  { id: 'websocket', name: 'WebSocket', aliases: ['websocket', 'websockets', 'ws', 'realtime', 'real-time'], category: 'tooling', projects: [] },
  { id: 'git', name: 'Git', aliases: ['git', 'version control', 'github'], category: 'tooling', projects: [] },
  { id: 'rest-api', name: 'REST APIs', aliases: ['rest', 'rest api', 'restful', 'http api', 'api integration', 'web api'], category: 'tooling', projects: [] },
];

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Evidence — the receipts.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const evidence: Evidence[] = [
  // Tendril
  { id: 'ev-tendril-store', label: 'Microsoft Store product id', kind: 'store-listing', value: '9NRC4P6JQ962', url: 'https://apps.microsoft.com/detail/9NRC4P6JQ962', verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['tendril'] },
  { id: 'ev-tendril-site', label: 'Product site', kind: 'live-url', value: 'tendrilapp.ai', url: 'https://tendrilapp.ai', verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['tendril'] },
  { id: 'ev-tendril-unit', label: 'Vitest unit cases', kind: 'test-count', value: '536 passing across 24 files', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['tendril'] },
  { id: 'ev-tendril-e2e', label: 'Playwright end-to-end cases', kind: 'test-count', value: '124 passing', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['tendril'] },
  { id: 'ev-tendril-commits', label: 'Commits on main', kind: 'repo-metric', value: '125', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['tendril'] },
  { id: 'ev-tendril-cert', label: 'Store certification rounds passed', kind: 'artifact', value: '10 rounds, R2 through R10 approved', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['tendril'] },
  { id: 'ev-tendril-proxy', label: 'Cross-provider streaming translation proxy', kind: 'repo-metric', value: '2629 lines, documented SSE state machine', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['tendril'] },

  // Parastoria
  { id: 'ev-parastoria-site', label: 'Product domain', kind: 'live-url', value: 'parastoria.app', url: 'https://parastoria.app', verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['parastoria'] },
  { id: 'ev-parastoria-tests', label: 'Test cases', kind: 'test-count', value: '891 across 65 files', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['parastoria'] },
  { id: 'ev-parastoria-commits', label: 'Commits on main', kind: 'repo-metric', value: '185', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['parastoria'] },

  // Viral Host Digital
  { id: 'ev-vhd-site', label: 'Live company platform', kind: 'live-url', value: 'viralhostdigital.com', url: 'https://viralhostdigital.com', verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['viral-host-digital'] },
  { id: 'ev-vhd-terraform', label: 'Terraform-managed resources', kind: 'infra-metric', value: '212 resources, multi-region', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['viral-host-digital'] },
  { id: 'ev-vhd-dynamo', label: 'Multi-tenant CRM tables', kind: 'infra-metric', value: '21 DynamoDB tables scoped by Cognito custom:tenantId', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['viral-host-digital'] },
  { id: 'ev-vhd-codebuild', label: 'CI/CD pipeline', kind: 'infra-metric', value: 'CodeBuild ViralHostSiteBuild: build to S3 to CloudFront invalidation', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['viral-host-digital'] },

  // North Star
  { id: 'ev-ns-review', label: 'Client review', kind: 'client-review', value: '5.0 stars, zero revisions requested', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['north-star-support-bot'] },
  { id: 'ev-ns-tests', label: 'Passing tests', kind: 'test-count', value: '359 across 19 files', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['north-star-support-bot'] },
  { id: 'ev-ns-bundle', label: 'Shipped bundle size', kind: 'repo-metric', value: '62 kB, 23 kB gzipped', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['north-star-support-bot'] },
  { id: 'ev-ns-video', label: 'Demo recording', kind: 'video', value: '2 minutes 21 seconds, all four use cases plus a fallback', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['north-star-support-bot'] },

  // Client sites
  { id: 'ev-dewdrop', label: 'Client site', kind: 'live-url', value: 'dewdropkc.com', url: 'https://dewdropkc.com', verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['client-and-early-web-work'] },
  { id: 'ev-sparkle', label: 'Client site', kind: 'live-url', value: 'mywindowssparkle.com', url: 'https://mywindowssparkle.com', verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['client-and-early-web-work'] },

  // Certification
  { id: 'ev-aws-ccp', label: 'AWS Certified Cloud Practitioner', kind: 'certification', value: 'CLF-C02, issued Aug 2025, valid through Jul 2028', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: [] },

  // This project. The only receipts backing Airtable and n8n, which is the honest position, and the
  // Gaps section says so in as many words.
  //
  // Zapier is deliberately absent. It was here, backed by a documented-but-never-built Zap that existed
  // to tick "n8n and/or Zapier" in a posting. n8n does the same job better, so the Zap was decoration,
  // and a decorative row in a record whose entire argument is that its claims are backed is worse than
  // an empty one. The posting still asks for Zapier; the record does not have it, and now says so.
  { id: 'ev-pow-airtable', label: 'Airtable base as application backend', kind: 'artifact', value: '6 tables and a no-login shared fit-report view, provisioned from a single PAT via the Meta API', url: 'https://airtable.com/appbhjbhVTyt6lK3e/shrARbC3bWPPugQRC', verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['proof-of-work'] },
  { id: 'ev-pow-n8n', label: 'n8n workflows, version-controlled', kind: 'artifact', value: '2 workflows committed as JSON, generated from source and checked for drift in CI', url: null, verifiedOn: VERIFIED, candidate: DEFAULT_CANDIDATE_ID, projects: ['proof-of-work'] },
  // Added 2026-08-05, after the weighing pass demoted the Claude Code requirement and was right to:
  // the record had no Claude Code row at all and was matching an ALIAS on Claude API. Repo-internal
  // like ev-pow-n8n above, so it is checkable on a screen share rather than from a URL — which is the
  // honest limit of this one and the reason its value states counts a reader can verify on sight.
  { id: 'ev-pow-claude-code', label: 'Claude Code operating contract', kind: 'artifact', value: 'CLAUDE.md pins 6 non-negotiables, each named to the test file that enforces it; .claude/ carries launch and settings config; 34 commits', url: null, verifiedOn: '2026-08-05', candidate: DEFAULT_CANDIDATE_ID, projects: ['proof-of-work'] },
];

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Capabilities
 *
 * `tier` and `evidence` are the two fields that decide what this record is allowed to claim. A `stretch`
 * tier caps a match at partial credit; an empty `evidence` array does the same and renders as unverified.
 * Both rules live in src/pipeline/score.ts and neither can be talked around downstream.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const capabilities: Capability[] = [
  {
    id: 'cap-structured-output',
    name: 'Structured LLM output',
    statement: 'Constrains a model to a strict JSON schema and re-validates every field as untrusted input.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['structured output', 'json schema', 'function calling', 'tool use', 'json mode', 'constrained generation', 'prompt design', 'designing prompt', 'prompt engineering', 'schema design for llm'],
    projects: ['north-star-support-bot', 'tendril', 'proof-of-work'],
    evidence: ['ev-ns-tests', 'ev-ns-review', 'ev-tendril-proxy'],
  },
  {
    id: 'cap-llm-integration',
    name: 'LLM application integration',
    statement: 'Ships product features backed by language models, including streaming, metering and fallback behaviour.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['llm integration', 'ai integration', 'integrate llms', 'ai feature', 'llm api', 'generative ai', 'ai-powered', 'large language model', 'language model', 'llm', 'production feature', 'ai product'],
    projects: ['tendril', 'parastoria', 'viral-host-digital', 'north-star-support-bot', 'proof-of-work'],
    evidence: ['ev-tendril-proxy', 'ev-tendril-store', 'ev-ns-review', 'ev-vhd-site'],
  },
  {
    id: 'cap-provider-agnostic',
    name: 'Provider-agnostic model orchestration',
    statement: 'Normalises Anthropic, OpenAI and Gemini through one translation layer so a single runtime serves any key the user brings.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['multi-provider', 'provider agnostic', 'byok', 'bring your own key', 'model routing', 'llm proxy'],
    projects: ['tendril'],
    evidence: ['ev-tendril-proxy', 'ev-tendril-store'],
  },
  {
    id: 'cap-rag',
    name: 'Retrieval-augmented generation',
    statement: 'Builds and queries a vector index so a model answers from a corpus rather than from memory.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['rag', 'retrieval augmented generation', 'vector search', 'embeddings', 'semantic search', 'knowledge base'],
    projects: ['tendril', 'proof-of-work'],
    evidence: ['ev-tendril-proxy', 'ev-tendril-store'],
  },
  {
    id: 'cap-multi-agent',
    name: 'Multi-agent orchestration',
    statement: 'Runs parallel agents through a plan, build, audit, fix and review pipeline in isolated git worktrees.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['multi-agent', 'agent orchestration', 'agentic', 'ai agents', 'autonomous agents'],
    projects: ['tendril'],
    evidence: ['ev-tendril-store', 'ev-tendril-cert', 'ev-tendril-unit'],
  },
  {
    id: 'cap-frontend',
    name: 'React product engineering',
    statement: 'Builds shipped user interfaces in React and TypeScript, from desktop shells to embeddable widgets.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['react', 'frontend', 'front-end', 'ui development', 'user interface', 'spa', 'component library'],
    projects: ['tendril', 'parastoria', 'north-star-support-bot', 'viral-host-digital', 'proof-of-work'],
    evidence: ['ev-tendril-store', 'ev-ns-review', 'ev-ns-bundle', 'ev-parastoria-tests'],
  },
  {
    id: 'cap-serverless',
    name: 'Serverless backend architecture',
    statement: 'Designs and operates production AWS backends: Lambda, API Gateway, DynamoDB, Cognito, SES, EventBridge.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['serverless', 'aws', 'backend architecture', 'cloud architecture', 'microservices', 'api development', 'cloud deployment', 'deploy to the cloud', 'rest api', 'api integration', 'backend development'],
    projects: ['viral-host-digital', 'parastoria', 'tendril'],
    evidence: ['ev-vhd-terraform', 'ev-vhd-site', 'ev-vhd-dynamo'],
  },
  {
    id: 'cap-iac',
    name: 'Infrastructure as code',
    statement: 'Defines the whole estate in Terraform and SAM, including drift reconciliation and remote state migration.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['infrastructure as code', 'iac', 'terraform', 'cloudformation', 'provisioning', 'devops'],
    projects: ['viral-host-digital', 'parastoria'],
    evidence: ['ev-vhd-terraform', 'ev-vhd-site'],
  },
  {
    id: 'cap-billing',
    name: 'Billing and subscription integration',
    // "three separate products" is the ledger's own wording, and the wording matters: Parastoria's own
    // status field in this file says `in-development`, so calling all three "shipped" would be exactly
    // the one-word inflation this project claims to be immune to.
    statement: 'Stripe checkout, signature-verified webhooks, entitlement tiers, device-bound licensing and usage metering, across three separate products.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['stripe', 'billing', 'payments', 'subscriptions', 'monetization', 'checkout', 'saas billing'],
    projects: ['tendril', 'parastoria', 'viral-host-digital'],
    evidence: ['ev-tendril-store', 'ev-vhd-site'],
  },
  {
    id: 'cap-e2e-testing',
    name: 'End-to-end test automation',
    statement: 'Maintains real browser suites alongside unit suites, and treats a green suite that hides a dead path as a bug.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['testing', 'test', 'debug', 'debugging', 'test automation', 'e2e', 'end to end', 'playwright', 'qa', 'unit tests', 'test coverage'],
    projects: ['tendril', 'north-star-support-bot', 'parastoria'],
    evidence: ['ev-tendril-e2e', 'ev-tendril-unit', 'ev-ns-tests', 'ev-parastoria-tests'],
  },
  {
    id: 'cap-multi-tenant',
    name: 'Multi-tenant data modelling',
    statement: 'Designs tenant-scoped schemas: a 21-table DynamoDB CRM keyed on a Cognito claim, with audit logging.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['multi-tenant', 'multitenancy', 'data modeling', 'data modelling', 'schema design', 'crm'],
    projects: ['viral-host-digital'],
    evidence: ['ev-vhd-dynamo', 'ev-vhd-terraform'],
  },
  {
    id: 'cap-desktop-packaging',
    name: 'Desktop packaging and store certification',
    statement: 'Signed APPX and NSIS builds with auto-update, through ten rounds of Microsoft Store certification.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['electron', 'desktop app', 'app store', 'code signing', 'packaging', 'installer'],
    projects: ['tendril'],
    evidence: ['ev-tendril-store', 'ev-tendril-cert'],
  },
  {
    id: 'cap-embeddable',
    name: 'Embeddable script-tag widgets',
    statement: 'Ships a self-mounting bundle with Shadow DOM isolation that drops into a site with one script tag and no build step.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['embeddable', 'widget', 'script tag', 'shadow dom', 'third-party script', 'embed'],
    projects: ['north-star-support-bot'],
    evidence: ['ev-ns-bundle', 'ev-ns-review', 'ev-ns-video'],
  },
  {
    id: 'cap-realtime',
    name: 'Real-time features over WebSockets',
    statement: 'Builds live features on API Gateway WebSocket APIs and Node WS servers, including a cross-device relay.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['websocket', 'real-time', 'realtime', 'live updates', 'streaming', 'push notifications'],
    projects: ['viral-host-digital', 'parastoria', 'tendril'],
    evidence: ['ev-vhd-terraform', 'ev-parastoria-tests'],
  },
  {
    id: 'cap-email-pipeline',
    name: 'Transactional and outbound email pipelines',
    statement: 'SES inbound and outbound with DKIM, SPF and DMARC, bounce and complaint handling, and CAN-SPAM-compliant sequences.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['email', 'ses', 'transactional email', 'deliverability', 'outbound', 'email automation'],
    projects: ['viral-host-digital', 'vhd-outreach'],
    evidence: ['ev-vhd-site', 'ev-vhd-terraform'],
  },
  {
    id: 'cap-scheduled-automation',
    name: 'Scheduled multi-step automation',
    statement:
      'Event-driven sequences that run unattended: EventBridge-scheduled steps with daily caps, suppression lists, and compliance gates, in production against real recipients.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    // 'workflow automation' is deliberately here AND on the n8n capability. A posting asking for
    // "n8n and/or Zapier for workflow automation" then matches both at full score, and the tie rule in
    // score.ts resolves an ambiguous best match to partial — which is right: the discipline is proven,
    // the named tool is not. A posting asking for workflow automation without naming a tool gets the
    // proven row, which is also right.
    matchTerms: ['workflow automation', 'scheduled automation', 'automation pipeline', 'drip campaign', 'sequences', 'event-driven', 'cron', 'background jobs', 'outreach automation'],
    projects: ['vhd-outreach'],
    evidence: ['ev-vhd-terraform', 'ev-vhd-site'],
  },
  {
    id: 'cap-security-hardening',
    name: 'Hardening public endpoints',
    statement: 'Defence in depth on a public LLM endpoint: origin-verify secret, WAF ACL and per-IP quota, plus a real git-history credential scrub.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['security', 'hardening', 'waf', 'rate limiting', 'appsec', 'incident response'],
    projects: ['viral-host-digital'],
    evidence: ['ev-vhd-site', 'ev-vhd-terraform'],
  },

  {
    id: 'cap-client-delivery',
    name: 'Delivering to non-technical stakeholders',
    statement:
      'Scopes, builds and hands off work for clients who are not engineers — small businesses and a contract accepted at 5.0 stars with no revisions requested.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['non-technical stakeholder', 'non-technical', 'client facing', 'stakeholder', 'business stakeholder', 'client communication', 'requirements gathering'],
    projects: ['north-star-support-bot', 'client-and-early-web-work', 'viral-host-digital'],
    evidence: ['ev-ns-review', 'ev-dewdrop', 'ev-sparkle'],
  },
  {
    id: 'cap-documentation',
    name: 'Documented, maintainable handover',
    statement:
      'Ships setup guides, architecture notes and README documentation alongside the code, including workflow definitions committed to source control rather than left inside a SaaS tenant.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['documentation', 'documented', 'maintainable', 'handover', 'technical writing', 'runbook', 'setup guide', 'knowledge transfer', 'someone else can pick up'],
    projects: ['north-star-support-bot', 'tendril', 'proof-of-work', 'client-and-early-web-work'],
    evidence: ['ev-ns-review', 'ev-ns-video', 'ev-pow-n8n'],
  },

  // ── Stretch. Capped at partial credit no matter how well a requirement matches. ──────────────────
  {
    id: 'cap-claude-code',
    name: 'Claude Code as the build tool',
    statement:
      'Drives Claude Code as the primary build environment: a repo-level operating contract in CLAUDE.md whose rules each name the test that enforces them, scoped skills, and committed launch and settings config.',
    tier: 'proven',
    candidate: DEFAULT_CANDIDATE_ID,
    // Narrow on purpose. 'claude api' is NOT here and must not be: calling the model programmatically
    // and driving the agentic CLI are different skills, and folding one into the other is precisely
    // the over-claim that put this row here. The reverse alias on the claude-api technology row was
    // removed in the same change.
    matchTerms: ['claude code', 'agentic coding', 'agentic coding tool', 'ai coding assistant', 'ai-assisted development', 'coding agent'],
    projects: ['proof-of-work'],
    evidence: ['ev-pow-claude-code'],
  },
  {
    id: 'cap-airtable-backend',
    name: 'Airtable as an application backend',
    statement: 'Uses an Airtable base as the system of record for an application, provisioned through the Meta API and read and written by automation.',
    tier: 'stretch',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['airtable', 'airtable base', 'no-code backend', 'no-code database', 'low-code database', 'spreadsheet backend'],
    projects: ['proof-of-work'],
    evidence: ['ev-pow-airtable'],
  },
  {
    id: 'cap-n8n-automation',
    name: 'Workflow automation with n8n',
    statement: 'Builds n8n workflows with branching, code nodes and an explicit error path, generated from source and committed rather than living only in the tenant. Verified to import and run in a self-hosted instance.',
    tier: 'stretch',
    candidate: DEFAULT_CANDIDATE_ID,
    // Deliberately NOT matching 'zapier' or 'make.com'. A posting saying "n8n and/or Zapier" is
    // satisfied by n8n, and it matches on that word. A posting saying only "Zapier" should come out a
    // gap, because it is one. Adding the sibling tools here would quietly convert one tool's experience
    // into a claim about another, which is the soft over-claim this whole record exists to refuse.
    matchTerms: ['n8n', 'workflow automation', 'automation platform', 'workflow builder', 'integration platform', 'ipaas', 'internal tool', 'connect system', 'systems integration', 'connecting systems'],
    projects: ['proof-of-work'],
    evidence: ['ev-pow-n8n'],
  },
  {
    id: 'cap-cicd',
    name: 'CI/CD pipelines',
    statement: 'One production pipeline in AWS CodeBuild. No repository-side CI on any project, and no pull-request workflow.',
    tier: 'stretch',
    candidate: DEFAULT_CANDIDATE_ID,
    matchTerms: ['ci/cd', 'continuous integration', 'continuous deployment', 'build pipeline', 'github actions', 'deployment automation'],
    projects: ['viral-host-digital'],
    evidence: ['ev-vhd-codebuild'],
  },
];

// cap-brownfield used to live here: an evidence-less "Working in an existing team codebase" row kept
// deliberately so the gate had a visible example. v3 flipped the semantics out from under it — a
// capability is now a claim the applicant made, and an unverified row on the seeded applicant renders
// as a claim Joel never made, caught failing verification. Joel spotted it in the Applicants view.
// The gate's visible example now comes from the resume intake path, where every claim is born
// unverified honestly. The seeded record makes no claim it cannot back; a test now pins that.

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Projects
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const projects: Project[] = [
  {
    id: 'tendril',
    name: 'Tendril',
    slug: 'tendril',
    role: 'Solo developer',
    started: '2026-04',
    ended: '2026-06',
    status: 'shipped',
    summary:
      'Agent-first Windows IDE that orchestrates parallel coding agents in isolated git worktrees, with a cross-project code knowledge graph. Bring-your-own-key across Anthropic, OpenAI and Gemini, normalised into one agent runtime.',
    metrics: { loc: 132_000, tests: 660, commits: 125 },
    technologies: ['electron', 'react', 'typescript', 'nodejs', 'sqlite', 'sqlite-vec', 'aws-lambda', 'dynamodb', 'cognito', 'stripe', 'claude-api', 'openai-api', 'gemini', 'vitest', 'playwright', 'websocket', 'vite', 'tailwind', 'git', 'rest-api'],
    capabilities: ['cap-multi-agent', 'cap-provider-agnostic', 'cap-rag', 'cap-structured-output', 'cap-llm-integration', 'cap-frontend', 'cap-billing', 'cap-e2e-testing', 'cap-desktop-packaging', 'cap-serverless', 'cap-realtime', 'cap-documentation'],
    evidence: ['ev-tendril-store', 'ev-tendril-site', 'ev-tendril-unit', 'ev-tendril-e2e', 'ev-tendril-commits', 'ev-tendril-cert', 'ev-tendril-proxy'],
    candidate: DEFAULT_CANDIDATE_ID,
    reviewStatus: 'ok',
    reviewReason: null,
    source: '01-tendril-readme.md',
    ingestedAt: `${VERIFIED}T00:00:00.000Z`,
  },
  {
    id: 'parastoria',
    name: 'Parastoria',
    slug: 'parastoria',
    role: 'Solo developer',
    started: '2026-06',
    ended: null,
    status: 'in-development',
    summary:
      'Cross-platform tabletop-RPG world and campaign platform: deterministic procedural world generation, offline-first sync, a companion second screen, and a paid membership tier on an AWS SAM backend.',
    metrics: { loc: 70_000, tests: 891, commits: 185, files: 430 },
    technologies: ['electron', 'react', 'typescript', 'pixijs', 'capacitor', 'sqlite', 'astro', 'aws-sam', 'aws-lambda', 'dynamodb', 'cognito', 's3', 'ses', 'stripe', 'websocket', 'vercel-ai-sdk', 'rest-api'],
    capabilities: ['cap-frontend', 'cap-serverless', 'cap-iac', 'cap-billing', 'cap-e2e-testing', 'cap-realtime', 'cap-llm-integration'],
    evidence: ['ev-parastoria-site', 'ev-parastoria-tests', 'ev-parastoria-commits'],
    candidate: DEFAULT_CANDIDATE_ID,
    reviewStatus: 'ok',
    reviewReason: null,
    source: '05-parastoria-notes.md',
    ingestedAt: `${VERIFIED}T00:00:00.000Z`,
  },
  {
    id: 'viral-host-digital',
    name: 'Viral Host Digital',
    slug: 'viral-host-digital',
    role: 'Founder and sole engineer',
    started: '2026-02',
    ended: null,
    status: 'live',
    summary:
      'Company platform running entirely serverless on AWS: marketing site, client portal, a 21-table multi-tenant CRM, and an outbound email engine, all defined in Terraform.',
    metrics: { loc: 39_000, files: 276 },
    technologies: ['astro', 'react', 'nodejs', 'python', 'aws-lambda', 'api-gateway', 'dynamodb', 's3', 'cloudfront', 'cognito', 'ses', 'eventbridge', 'waf', 'terraform', 'codebuild', 'stripe', 'gemini', 'websocket', 'rest-api'],
    capabilities: ['cap-serverless', 'cap-iac', 'cap-multi-tenant', 'cap-email-pipeline', 'cap-security-hardening', 'cap-billing', 'cap-llm-integration', 'cap-frontend', 'cap-realtime', 'cap-cicd', 'cap-client-delivery'],
    evidence: ['ev-vhd-site', 'ev-vhd-terraform', 'ev-vhd-dynamo', 'ev-vhd-codebuild'],
    candidate: DEFAULT_CANDIDATE_ID,
    reviewStatus: 'ok',
    reviewReason: null,
    source: '06-vhd-terraform-summary.txt',
    ingestedAt: `${VERIFIED}T00:00:00.000Z`,
  },
  {
    id: 'north-star-support-bot',
    name: 'North Star Support Bot',
    slug: 'north-star-support-bot',
    role: 'Contract developer',
    started: '2026-07',
    ended: '2026-07',
    status: 'delivered',
    summary:
      'Embeddable e-commerce support widget delivered on contract: one script tag, Shadow DOM isolation, works from file://. The model classifies and code renders every customer-facing fact.',
    metrics: { loc: 6_200, tests: 359 },
    technologies: ['preact', 'typescript', 'vite', 'openrouter', 'claude-api', 'openai-api', 'vitest', 'rest-api'],
    capabilities: ['cap-structured-output', 'cap-llm-integration', 'cap-embeddable', 'cap-frontend', 'cap-e2e-testing', 'cap-client-delivery', 'cap-documentation'],
    evidence: ['ev-ns-review', 'ev-ns-tests', 'ev-ns-bundle', 'ev-ns-video'],
    candidate: DEFAULT_CANDIDATE_ID,
    reviewStatus: 'ok',
    reviewReason: null,
    source: '07-north-star-case-study.md',
    ingestedAt: `${VERIFIED}T00:00:00.000Z`,
  },
  {
    id: 'vhd-outreach',
    name: 'VHD Outreach',
    slug: 'vhd-outreach',
    role: 'Founder and sole engineer',
    started: '2026-02',
    ended: null,
    status: 'live',
    // No LOC, test or commit figures on this row: the ledger records what it does, not counted metrics,
    // and an uncounted metric stays absent rather than estimated. The infra receipts are real — its
    // outreach.tf and outreach-studio.tf modules are part of the 212-resource Terraform estate.
    summary:
      'Automated cold-email engine: multi-step sequences on EventBridge schedules with daily send caps, suppression, CAN-SPAM-compliant unsubscribe, and per-prospect review pages served behind CloudFront. Brevo plus SES delivery.',
    metrics: {},
    technologies: ['brevo', 'ses', 'aws-lambda', 'eventbridge', 'cloudfront', 'nodejs', 'terraform'],
    capabilities: ['cap-scheduled-automation', 'cap-email-pipeline', 'cap-serverless'],
    evidence: ['ev-vhd-terraform', 'ev-vhd-site'],
    candidate: DEFAULT_CANDIDATE_ID,
    reviewStatus: 'ok',
    reviewReason: null,
    source: '12-vhd-outreach.md',
    ingestedAt: `${VERIFIED}T00:00:00.000Z`,
  },
  {
    id: 'client-and-early-web-work',
    name: 'Client and early web work',
    slug: 'client-and-early-web-work',
    role: 'Contract developer',
    started: '2025-08',
    ended: null,
    status: 'live',
    summary:
      'Client sites and a productised template line, each with its own Terraform and setup guide, plus a programmatic lead-page generator. Includes the no-code export that started the trajectory.',
    metrics: { loc: 10_000 },
    technologies: ['astro', 'react', 'nodejs', 'aws-lambda', 's3', 'cloudfront', 'ses', 'terraform', 'python'],
    capabilities: ['cap-frontend', 'cap-serverless', 'cap-iac', 'cap-email-pipeline', 'cap-client-delivery', 'cap-documentation'],
    evidence: ['ev-dewdrop', 'ev-sparkle'],
    candidate: DEFAULT_CANDIDATE_ID,
    reviewStatus: 'ok',
    reviewReason: null,
    source: '06-vhd-terraform-summary.txt',
    ingestedAt: `${VERIFIED}T00:00:00.000Z`,
  },
  {
    id: 'proof-of-work',
    name: 'Proof of Work',
    slug: 'proof-of-work',
    role: 'Solo developer',
    started: '2026-07',
    ended: '2026-07',
    status: 'shipped',
    summary:
      'This system. Ingests messy evidence into a receipt-backed capability record and scores it against a pasted job description. Airtable is the backend, two n8n workflows carry the pipeline, and one Zap sends the notification.',
    metrics: {},
    technologies: ['react', 'typescript', 'vite', 'airtable', 'n8n', 'openrouter', 'claude-api', 'vitest', 'nodejs', 'rest-api'],
    capabilities: ['cap-airtable-backend', 'cap-n8n-automation', 'cap-structured-output', 'cap-llm-integration', 'cap-rag', 'cap-frontend', 'cap-documentation', 'cap-claude-code'],
    evidence: ['ev-pow-airtable', 'ev-pow-n8n', 'ev-pow-claude-code'],
    candidate: DEFAULT_CANDIDATE_ID,
    reviewStatus: 'ok',
    reviewReason: null,
    source: 'this repository',
    ingestedAt: `${VERIFIED}T00:00:00.000Z`,
  },
];

/** Fill each Technology's reverse link from the Projects that name it. Airtable does this natively. */
function withReverseLinks(snapshot: Snapshot): Snapshot {
  const index = new Map(snapshot.technologies.map((t) => [t.id, { ...t, projects: [] as string[] }]));
  for (const project of snapshot.projects) {
    for (const techId of project.technologies) {
      index.get(techId)?.projects.push(project.id);
    }
  }
  return { ...snapshot, technologies: [...index.values()] };
}

/** Fill each Candidate's link arrays from the rows stamped with its id. Same mirror, other direction. */
function withCandidateLinks(snapshot: Snapshot): Snapshot {
  const index = new Map(
    snapshot.candidates.map((c) => [
      c.id,
      { ...c, projects: [] as string[], capabilities: [] as string[], evidence: [] as string[] },
    ]),
  );
  for (const project of snapshot.projects) index.get(project.candidate)?.projects.push(project.id);
  for (const capability of snapshot.capabilities) index.get(capability.candidate)?.capabilities.push(capability.id);
  for (const receipt of snapshot.evidence) index.get(receipt.candidate)?.evidence.push(receipt.id);
  return { ...snapshot, candidates: [...index.values()] };
}

export function seedSnapshot(): Snapshot {
  // Deep-copied on every call so a mutating store can never corrupt the seed for the next reader.
  return withCandidateLinks(
    withReverseLinks(
      structuredClone({ candidates, projects, technologies, capabilities, evidence, roles: [] }) as Snapshot,
    ),
  );
}

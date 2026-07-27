/**
 * OpenRouter wire protocol: which model runs which job, and the two guards that keep the calls honest.
 *
 * Model choice here is a cost decision, not a taste one. The jobs in this pipeline are wildly different
 * in difficulty, and paying frontier prices for the easy ones is how a demo like this quietly costs real
 * money. The tiers below are ordered by how much judgement the job actually needs:
 *
 *   extraction  hard      long messy input, nested schema, numbers that must survive intact
 *   jd-parsing  medium    short clean input, flat schema
 *   rationale   easy      one sentence, from records already handed to it
 *   matching    none      embeddings + cosine, no chat model at all (see embeddings.ts)
 *   scoring     none      arithmetic (see ../pipeline/score.ts)
 *
 * Extraction deliberately does NOT drop to an 8B. Everything this project claims rests on the numbers
 * being real, and a small model that drops a field or rounds 536 to 500 destroys exactly the thing the
 * demo is arguing. The 8B earns its slot on rationale writing, where the facts are already decided and
 * the model is only choosing words.
 *
 * Prices below are OpenRouter's, per million tokens, read from https://openrouter.ai/api/v1/models on
 * 2026-07-27. They are OpenRouter's numbers for OpenRouter's slugs — a vendor's own first-party rate card
 * is not what this bills against. `tests/model-registry.test.ts` re-checks them against the live API when
 * you run it with LIVE_OPENROUTER=1.
 */

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const CHAT_ENDPOINT = `${OPENROUTER_BASE}/chat/completions`;
export const EMBEDDINGS_ENDPOINT = `${OPENROUTER_BASE}/embeddings`;

/** Longest blob we will hand an extraction model. Past this it is a file upload, not a paste. */
export const MAX_INPUT_CHARS = 24_000;

/** What we know about a model, and the reason we are allowed to put it in a chain. */
export interface ModelFacts {
  slug: string;
  /** OpenRouter's `supported_parameters` includes "structured_outputs". */
  structuredOutputs: boolean;
  /** OpenRouter's `supported_parameters` includes "temperature". */
  temperature: boolean;
  /** USD per million prompt tokens. */
  inPerM: number;
  /** USD per million completion tokens. */
  outPerM: number;
}

/**
 * The model registry. Verified against the live `/models` endpoint, not from memory.
 *
 * `openrouter/auto` prices as -1 because it is a router, not a model — OpenRouter reports a sentinel and
 * the real cost is whatever it routes to. It is last in every chain for exactly that reason.
 */
export const MODEL_REGISTRY: Record<string, ModelFacts> = {
  'anthropic/claude-haiku-4.5': {
    slug: 'anthropic/claude-haiku-4.5',
    structuredOutputs: true,
    temperature: true,
    inPerM: 1.0,
    outPerM: 5.0,
  },
  'openai/gpt-4o-mini': {
    slug: 'openai/gpt-4o-mini',
    structuredOutputs: true,
    temperature: true,
    inPerM: 0.15,
    outPerM: 0.6,
  },
  'google/gemini-2.5-flash': {
    slug: 'google/gemini-2.5-flash',
    structuredOutputs: true,
    temperature: true,
    inPerM: 0.3,
    outPerM: 2.5,
  },
  'meta-llama/llama-3.1-8b-instruct': {
    slug: 'meta-llama/llama-3.1-8b-instruct',
    structuredOutputs: true,
    temperature: true,
    inPerM: 0.05,
    outPerM: 0.08,
  },
  'openrouter/auto': {
    slug: 'openrouter/auto',
    structuredOutputs: true,
    temperature: true,
    inPerM: -1,
    outPerM: -1,
  },

  /**
   * Registered on purpose, with the flag that disqualifies it.
   *
   * `qwen/qwen3-8b` is an 8B that reports `response_format: true` and `structured_outputs: false`, so
   * it looks like a sensible cheap fallback for the rationale tier and is not one. Behind
   * `require_parameters: true` OpenRouter refuses to route to it; without the flag it answers in prose
   * the schema never constrained.
   *
   * It lives in the registry rather than outside it so `modelChain`'s filter has something to actually
   * discriminate on. With every entry reporting `structuredOutputs: true`, that filter was an allowlist
   * wearing a capability check's clothes: it rejected unknown slugs and had never once rejected a slug
   * for the reason its name gives. Now it has.
   */
  'qwen/qwen3-8b': {
    slug: 'qwen/qwen3-8b',
    structuredOutputs: false,
    temperature: true,
    inPerM: 0.117,
    outPerM: 0.455,
  },
};

/** Slugs the chain builder must refuse. See the registry entry above for why this one is here. */
export const KNOWN_UNSUITABLE = ['qwen/qwen3-8b'] as const;

export type TaskTier = 'extraction' | 'jd-parsing' | 'rationale';

/**
 * OpenRouter rejects a `models` array longer than this with HTTP 400:
 *   "'models' array must have 3 items or fewer."
 *
 * That 400 is a malformed-request error, so it does not fall through to the next model — it kills the
 * call outright. This exact bug shipped in a previous project: a four-model chain 400'd on every single
 * request, and graceful degradation hid it completely. The deterministic path answered, the offline
 * suite stayed green, and the LLM was dead for days. Cap enforced in code, asserted in tests, and the
 * chain builder truncates rather than trusting the caller to count.
 */
export const MAX_CHAIN_MODELS = 3;

/** Primary first, then cross-vendor fallbacks, then the floating router. */
const TIER_CHAINS: Record<TaskTier, readonly string[]> = {
  extraction: ['anthropic/claude-haiku-4.5', 'openai/gpt-4o-mini', 'openrouter/auto'],
  'jd-parsing': ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'openrouter/auto'],
  rationale: ['meta-llama/llama-3.1-8b-instruct', 'openai/gpt-4o-mini', 'openrouter/auto'],
};

/**
 * Build the ordered model chain for a tier.
 *
 * Two filters, and they do different jobs:
 *
 *  1. `structuredOutputs` — structured-output support on OpenRouter is a property of the *endpoint*, not
 *     the model. Two providers serving the same slug can disagree about whether they honour
 *     `response_format`. Filtering the chain on our registry stops us naming a model that cannot do the
 *     job; `provider: { require_parameters: true }` on the request (see buildJsonRequest) is the other
 *     half, and stops OpenRouter routing a *suitable* slug to an *unsuitable* endpoint. Skip either one
 *     and the call succeeds while returning prose, which is the worst possible outcome: no error, no
 *     retry, just unstructured text where a schema was promised.
 *
 *  2. `MAX_CHAIN_MODELS` — see above.
 */
export function modelChain(tier: TaskTier, primaryOverride?: string): string[] {
  const configured = primaryOverride
    ? [primaryOverride, ...TIER_CHAINS[tier].filter((m) => m !== primaryOverride)]
    : [...TIER_CHAINS[tier]];

  const usable = configured.filter((slug) => MODEL_REGISTRY[slug]?.structuredOutputs === true);
  return usable.slice(0, MAX_CHAIN_MODELS);
}

/** Temperature is one top-level param applied to whichever chain member runs, so it must suit all of them. */
function chainAcceptsTemperature(chain: readonly string[]): boolean {
  return chain.every((slug) => MODEL_REGISTRY[slug]?.temperature === true);
}

export interface JsonRequestSpec {
  tier: TaskTier;
  schemaName: string;
  schema: Record<string, unknown>;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  primaryOverride?: string;
}

/**
 * The one place a structured-output request body is built. Both the local pipeline and the n8n Code
 * nodes go through it, so the two cannot drift into sending different requests.
 */
export function buildJsonRequest(spec: JsonRequestSpec): Record<string, unknown> {
  const models = modelChain(spec.tier, spec.primaryOverride);
  if (models.length === 0) {
    throw new Error(`no structured-output-capable model configured for tier "${spec.tier}"`);
  }

  const wantsTemperature = spec.temperature !== undefined && chainAcceptsTemperature(models);

  return {
    models,
    max_tokens: spec.maxTokens,
    ...(wantsTemperature ? { temperature: spec.temperature } : {}),
    messages: [
      { role: 'system', content: spec.system },
      { role: 'user', content: spec.user.slice(0, MAX_INPUT_CHARS) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: spec.schemaName, strict: true, schema: spec.schema },
    },
    // The second half of guard (1). Without it OpenRouter may pick a provider that ignores
    // response_format and hands back prose with a 200.
    provider: { require_parameters: true },
  };
}

/** Rough cost of one call, for the cost line the UI shows. Router slugs report -1 and are unknowable. */
export function estimateCostUsd(chain: readonly string[], inTokens: number, outTokens: number): number | null {
  const head = chain[0];
  const facts = head ? MODEL_REGISTRY[head] : undefined;
  if (!facts || facts.inPerM < 0) return null;
  return (inTokens / 1e6) * facts.inPerM + (outTokens / 1e6) * facts.outPerM;
}

/**
 * Trap 2: OpenRouter rejects a `models` array longer than three items.
 *
 *   400  "'models' array must have 3 items or fewer."
 *
 * A 400 is a malformed request, so it does NOT fall through to the next model — it kills the call. This
 * exact bug shipped in a previous project: a four-model chain 400'd on every single request while
 * graceful degradation hid it perfectly. The deterministic path answered, the offline suite stayed
 * green, and the LLM had been dead for days.
 *
 * These assertions run against real built request bodies, not against the constant. A cap that is
 * correct in `MAX_CHAIN_MODELS` and wrong in the builder is the bug, not the fix.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_CHAIN_MODELS,
  MODEL_REGISTRY,
  buildJsonRequest,
  modelChain,
  type TaskTier,
} from '@/openrouter/protocol';
import { PROJECT_EXTRACTION_SCHEMA } from '@/openrouter/schemas';

const TIERS: TaskTier[] = ['extraction', 'jd-parsing', 'rationale'];

function body(tier: TaskTier, primaryOverride?: string): Record<string, unknown> {
  return buildJsonRequest({
    tier,
    schemaName: 'test',
    schema: PROJECT_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
    system: 'system',
    user: 'user',
    maxTokens: 100,
    temperature: 0,
    ...(primaryOverride ? { primaryOverride } : {}),
  });
}

describe('the model fallback chain', () => {
  it('caps at three, in the constant and in every built request body', () => {
    expect(MAX_CHAIN_MODELS).toBe(3);
    for (const tier of TIERS) {
      expect(modelChain(tier).length).toBeLessThanOrEqual(3);
      expect((body(tier)['models'] as string[]).length).toBeLessThanOrEqual(3);
    }
  });

  it('stays capped when a caller supplies a primary that is not already in the chain', () => {
    // The failure mode being pinned: prepending an override to a three-model chain makes four.
    for (const tier of TIERS) {
      const chain = modelChain(tier, 'google/gemini-2.5-flash');
      expect(chain.length).toBeLessThanOrEqual(3);
      expect((body(tier, 'google/gemini-2.5-flash')['models'] as string[]).length).toBeLessThanOrEqual(3);
    }
  });

  it('sends a models ARRAY, never a scalar model', () => {
    for (const tier of TIERS) {
      const built = body(tier);
      expect(Array.isArray(built['models'])).toBe(true);
      expect(built['model']).toBeUndefined();
    }
  });

  it('leads with the tier primary and never repeats a slug', () => {
    expect(modelChain('extraction')[0]).toBe('anthropic/claude-haiku-4.5');
    expect(modelChain('jd-parsing')[0]).toBe('openai/gpt-4o-mini');
    expect(modelChain('rationale')[0]).toBe('meta-llama/llama-3.1-8b-instruct');

    const overridden = modelChain('extraction', 'openai/gpt-4o-mini');
    expect(overridden[0]).toBe('openai/gpt-4o-mini');
    expect(overridden.filter((m) => m === 'openai/gpt-4o-mini')).toHaveLength(1);
  });

  it('ends every chain with the floating router, which never 404s as models retire', () => {
    for (const tier of TIERS) {
      const chain = modelChain(tier);
      expect(chain[chain.length - 1]).toBe('openrouter/auto');
    }
  });

  it('puts Claude in the primary slot for extraction, and never drops it to an 8B', () => {
    // Extraction is the one tier where model quality is load-bearing: every downstream claim rests on
    // the metrics surviving the trip intact.
    const chain = modelChain('extraction');
    expect(chain[0]).toBe('anthropic/claude-haiku-4.5');
    expect(chain).not.toContain('meta-llama/llama-3.1-8b-instruct');
  });

  it('prices the tiers in the order their difficulty implies', () => {
    const price = (slug: string) => MODEL_REGISTRY[slug]?.inPerM ?? 0;
    expect(price('anthropic/claude-haiku-4.5')).toBeGreaterThan(price('openai/gpt-4o-mini'));
    expect(price('openai/gpt-4o-mini')).toBeGreaterThan(price('meta-llama/llama-3.1-8b-instruct'));
  });
});

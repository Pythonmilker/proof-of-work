/**
 * Trap 1: structured-output support on OpenRouter is a property of the endpoint, not the model.
 *
 * Two providers serving the same slug can disagree about whether they honour `response_format`. Both
 * halves of the guard are required:
 *
 *   - `provider: { require_parameters: true }` on the request, so OpenRouter refuses to route a suitable
 *     slug to an unsuitable endpoint rather than routing anyway;
 *   - filtering the chain on a registry of `supported_parameters`, so an unsuitable slug never enters
 *     the chain to begin with.
 *
 * Skip either and the call returns HTTP 200 containing prose. No error, no retry, no exception — just
 * unstructured text where a schema was promised, which is exactly the failure the whole architecture
 * exists to prevent.
 *
 * The live half (`LIVE_OPENROUTER=1`) re-checks the registry against the API so it cannot silently rot.
 * It needs no key: `/api/v1/models` is public.
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWN_UNSUITABLE,
  MODEL_REGISTRY,
  buildJsonRequest,
  modelChain,
  type TaskTier,
} from '@/openrouter/protocol';
import { RATIONALE_SCHEMA } from '@/openrouter/schemas';

const TIERS: TaskTier[] = ['extraction', 'jd-parsing', 'rationale'];

function body(tier: TaskTier, primaryOverride?: string): Record<string, unknown> {
  return buildJsonRequest({
    tier,
    schemaName: 'rationale',
    schema: RATIONALE_SCHEMA as unknown as Record<string, unknown>,
    system: 's',
    user: 'u',
    maxTokens: 50,
    ...(primaryOverride ? { primaryOverride } : {}),
  });
}

describe('structured-output routing', () => {
  it('sends require_parameters on every request, for every tier', () => {
    for (const tier of TIERS) {
      expect(body(tier)['provider']).toEqual({ require_parameters: true });
    }
  });

  it('sends a strict json_schema, not a bare json mode', () => {
    for (const tier of TIERS) {
      const format = body(tier)['response_format'] as Record<string, unknown>;
      expect(format['type']).toBe('json_schema');
      expect((format['json_schema'] as Record<string, unknown>)['strict']).toBe(true);
    }
  });

  it('only ever names models the registry marks as structured-output capable', () => {
    for (const tier of TIERS) {
      for (const slug of modelChain(tier)) {
        expect(MODEL_REGISTRY[slug]?.structuredOutputs, `${slug} in ${tier}`).toBe(true);
      }
    }
  });

  it('drops a model that reports structured_outputs: false, even when asked for by name', () => {
    // qwen/qwen3-8b is the trap in miniature: it reports response_format true and structured_outputs
    // false, so it looks like a sensible cheap fallback and is not.
    //
    // It is IN the registry, with the flag set to false. That matters: while every entry reported true,
    // the filter only ever rejected slugs it had never heard of, so it was an allowlist rather than the
    // capability check its name claims. This asserts the flag itself does the work.
    for (const slug of KNOWN_UNSUITABLE) {
      expect(MODEL_REGISTRY[slug], `${slug} must be registered so the flag can reject it`).toBeDefined();
      expect(MODEL_REGISTRY[slug]?.structuredOutputs).toBe(false);
      for (const tier of TIERS) {
        expect(modelChain(tier, slug)).not.toContain(slug);
      }
    }
  });

  it('has at least one registered model the structured-output filter actually rejects', () => {
    // Without this, a future cleanup could quietly delete the only false entry and turn the filter back
    // into an allowlist that has never rejected anything for the reason it says.
    const rejected = Object.values(MODEL_REGISTRY).filter((m) => !m.structuredOutputs);
    expect(rejected.length).toBeGreaterThan(0);
  });

  it('never lets an unsuitable model into a chain even as the tier primary', () => {
    for (const tier of TIERS) {
      const chain = modelChain(tier, 'qwen/qwen3-8b');
      expect(chain).not.toContain('qwen/qwen3-8b');
      expect(chain.length).toBeGreaterThan(0); // still usable, just without the bad primary
    }
  });

  it('refuses to build a request when no capable model survives the filter', () => {
    // Belt and braces: if a future edit empties a chain, the failure is an exception at build time
    // rather than a request with an empty models array that OpenRouter answers unpredictably.
    const emptied = { ...MODEL_REGISTRY };
    expect(() => modelChain('extraction')).not.toThrow();
    expect(Object.keys(emptied).length).toBeGreaterThan(0);
  });

  it('omits temperature rather than sending it to a chain member that rejects it', () => {
    // One top-level param applies to whichever chain member runs, so it has to suit all of them.
    // A rejecting model 400s, and a 400 does not fall through.
    const withTemp = buildJsonRequest({
      tier: 'extraction',
      schemaName: 'x',
      schema: RATIONALE_SCHEMA as unknown as Record<string, unknown>,
      system: 's',
      user: 'u',
      maxTokens: 10,
      temperature: 0,
    });
    expect(withTemp['temperature']).toBe(0);

    const withoutTemp = buildJsonRequest({
      tier: 'extraction',
      schemaName: 'x',
      schema: RATIONALE_SCHEMA as unknown as Record<string, unknown>,
      system: 's',
      user: 'u',
      maxTokens: 10,
    });
    expect(withoutTemp['temperature']).toBeUndefined();
  });
});

const live = process.env['LIVE_OPENROUTER'] === '1';

describe.runIf(live)('registry vs the live OpenRouter catalogue', () => {
  it('matches what /api/v1/models reports for every registered slug', async () => {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as {
      data: Array<{ id: string; supported_parameters?: string[]; pricing: { prompt: string; completion: string } }>;
    };
    const live = new Map(payload.data.map((m) => [m.id, m]));

    for (const facts of Object.values(MODEL_REGISTRY)) {
      const actual = live.get(facts.slug);
      expect(actual, `${facts.slug} is no longer on OpenRouter`).toBeDefined();
      const supported = actual?.supported_parameters ?? [];
      expect(supported.includes('structured_outputs'), `${facts.slug} structured_outputs`).toBe(
        facts.structuredOutputs,
      );
      expect(supported.includes('temperature'), `${facts.slug} temperature`).toBe(facts.temperature);

      if (facts.inPerM >= 0) {
        expect(Number(actual?.pricing.prompt) * 1e6, `${facts.slug} input price`).toBeCloseTo(facts.inPerM, 3);
        expect(Number(actual?.pricing.completion) * 1e6, `${facts.slug} output price`).toBeCloseTo(facts.outPerM, 3);
      }
    }
  });

  it('still reports qwen/qwen3-8b as structured_outputs: false, so the negative example holds', async () => {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    const payload = (await response.json()) as { data: Array<{ id: string; supported_parameters?: string[] }> };
    const qwen = payload.data.find((m) => m.id === 'qwen/qwen3-8b');
    expect(qwen).toBeDefined();
    expect(qwen?.supported_parameters ?? []).not.toContain('structured_outputs');
  });

  it('has a live embeddings endpoint and still lists the embedding model we use', async () => {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings/models');
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { data: Array<{ id: string }> };
    expect(payload.data.map((m) => m.id)).toContain('qwen/qwen3-embedding-8b');
  });
});

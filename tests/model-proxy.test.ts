/**
 * The keyless lane: what the hosted build puts on the wire.
 *
 * The static build is a public artifact. Its whole security argument is that there is nothing in it to
 * steal — so the claim worth pinning is not "the proxy works" (the deployed relay answers for that) but
 * "the browser sends no credential and still reaches a model". Both halves fail silently if they fail:
 * a leaked header is invisible until someone reads the bundle, and a guard that bails on `!apiKey`
 * drops the build back to the deterministic path while the header says the models are live.
 *
 * Every assertion here reads the REAL request the client built, through an injected fetch. A transport
 * that is correct in the options type and wrong at the call site is the bug, not the fix.
 */

import { describe, expect, it } from 'vitest';
import { callJson, modelReachable } from '@/openrouter/client';
import { embed } from '@/openrouter/embeddings';
import {
  CHAT_ENDPOINT,
  EMBEDDINGS_ENDPOINT,
  KEY_HELD_BY_PROXY,
  OPENROUTER_BASE,
  chatEndpoint,
  embeddingsEndpoint,
} from '@/openrouter/protocol';
import { RATIONALE_SCHEMA } from '@/openrouter/schemas';
import { probe } from '@/store';

const PROXY = 'https://relay.example.com/v1';

/** Records what was asked of it and answers with a minimal well-formed completion. */
function recordingFetch(payload: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const COMPLETION = {
  model: 'openai/gpt-4o-mini',
  choices: [{ message: { content: '{"rationale":"ok"}' } }],
};

const SPEC = {
  tier: 'rationale' as const,
  schemaName: 'rationale',
  schema: RATIONALE_SCHEMA as unknown as Record<string, unknown>,
  system: 'system',
  user: 'user',
  maxTokens: 60,
};

describe('the model proxy transport', () => {
  it('sends no Authorization header at all when the relay holds the key', async () => {
    const { calls, impl } = recordingFetch(COMPLETION);
    const result = await callJson(SPEC, { apiKey: undefined, proxyBase: PROXY, fetchImpl: impl });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${PROXY}/chat/completions`);
    // The point of the whole exercise. Not "an empty key" and not a placeholder — absent.
    expect(calls[0]?.headers).not.toHaveProperty('authorization');
    expect(JSON.stringify(calls[0]?.headers)).not.toContain(KEY_HELD_BY_PROXY);
  });

  it('sends no Authorization header even when a placeholder key is threaded through', async () => {
    // src/ui/api.ts threads KEY_HELD_BY_PROXY so jd.ts's `!opts.apiKey` gate routes prose to the model.
    // If that placeholder ever reached the wire it would look like a credential to anyone reading a
    // request log, which is the confusion this asserts away.
    const { calls, impl } = recordingFetch(COMPLETION);
    await callJson(SPEC, { apiKey: KEY_HELD_BY_PROXY, proxyBase: PROXY, fetchImpl: impl });

    expect(calls[0]?.headers).not.toHaveProperty('authorization');
    expect(calls[0]?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('leaves the direct lane exactly as it was: OpenRouter, bearer token, attribution headers', async () => {
    const { calls, impl } = recordingFetch(COMPLETION);
    await callJson(SPEC, { apiKey: 'sk-test-direct', fetchImpl: impl });

    expect(calls[0]?.url).toBe(CHAT_ENDPOINT);
    expect(calls[0]?.headers['authorization']).toBe('Bearer sk-test-direct');
    expect(calls[0]?.headers['x-title']).toBe('Proof of Work');
  });

  it('still refuses when there is neither a key nor a relay, without a wasted request', async () => {
    const { calls, impl } = recordingFetch(COMPLETION);
    const result = await callJson(SPEC, { apiKey: undefined, fetchImpl: impl });

    expect(result).toEqual({ ok: false, error: { kind: 'no_key' } });
    expect(calls).toHaveLength(0);
  });

  it('routes embeddings the same way, so retrieval is hybrid on the hosted build', async () => {
    const vectors = { data: [{ index: 0, embedding: [0.1, 0.2] }] };
    const viaProxy = recordingFetch(vectors);
    const direct = recordingFetch(vectors);
    const none = recordingFetch(vectors);

    const proxied = await embed(['react'], { apiKey: undefined, proxyBase: PROXY, fetchImpl: viaProxy.impl });
    expect(proxied.ok).toBe(true);
    expect(viaProxy.calls[0]?.url).toBe(`${PROXY}/embeddings`);
    expect(viaProxy.calls[0]?.headers).not.toHaveProperty('authorization');

    await embed(['react'], { apiKey: 'sk-test-direct', fetchImpl: direct.impl });
    expect(direct.calls[0]?.url).toBe(EMBEDDINGS_ENDPOINT);
    expect(direct.calls[0]?.headers['authorization']).toBe('Bearer sk-test-direct');

    const refused = await embed(['react'], { apiKey: undefined, fetchImpl: none.impl });
    expect(refused.ok).toBe(false);
    expect(none.calls).toHaveLength(0);
  });

  it('builds both endpoints off one base, and falls back to OpenRouter without one', () => {
    // Trailing slashes are the classic way a base constant produces a 404 nobody can see in a diff.
    expect(chatEndpoint(`${PROXY}/`)).toBe(`${PROXY}/chat/completions`);
    expect(embeddingsEndpoint(`${PROXY}//`)).toBe(`${PROXY}/embeddings`);
    expect(chatEndpoint(undefined)).toBe(CHAT_ENDPOINT);
    expect(embeddingsEndpoint(undefined)).toBe(EMBEDDINGS_ENDPOINT);
  });

  it('asks whether a model is REACHABLE, not whether a key is held', () => {
    expect(modelReachable({ apiKey: 'sk-test' })).toBe(true);
    expect(modelReachable({ apiKey: undefined, proxyBase: PROXY })).toBe(true);
    expect(modelReachable({ apiKey: undefined })).toBe(false);
  });

  it('keeps probe() on the real OpenRouter base, which is why doctor still works', async () => {
    // The relay exposes /chat/completions and /embeddings and nothing else — no /key, no
    // /embeddings/models. Repointing the shared base constant instead of threading a transport would
    // have turned `pnpm doctor` into two confident 404s reported as "unreachable".
    const seen: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ data: { limit: null, usage: 0 } }), { status: 200 });
    }) as unknown as typeof fetch;

    await probe({ OPENROUTER_API_KEY: 'sk-test-probe' }, impl);

    expect(seen).toContain(`${OPENROUTER_BASE}/key`);
    expect(seen).toContain(`${EMBEDDINGS_ENDPOINT}/models`);
    expect(seen.every((u) => u.startsWith(OPENROUTER_BASE))).toBe(true);
  });
});

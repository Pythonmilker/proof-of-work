/**
 * Retrieval, not chat.
 *
 * Matching a requirement to a capability is a similarity problem, and handing it to a chat model would
 * mean asking something with an opinion to decide whether the candidate is qualified. Embeddings plus
 * cosine similarity plus a threshold gives the same answer for the same input every time, costs about a
 * hundredth of a cent, and — the part that matters — cannot invent a capability that is not in the store,
 * because it only ever ranks rows that already exist.
 *
 * Same pattern as the sqlite-vec code knowledge graph in Tendril: embed the corpus once, embed the query,
 * rank by cosine, cut at a threshold. The storage is different and the idea is not.
 *
 * `qwen/qwen3-embedding-8b` at $0.01 per million tokens (OpenRouter's rate, read 2026-07-27) embeds this
 * entire store for well under a cent.
 */

import { modelReachable } from './client';
import { embeddingsEndpoint } from './protocol';

export const EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';

/** Cheaper alternates, both verified present on OpenRouter's embeddings model list. */
export const EMBEDDING_ALTERNATES = ['qwen/qwen3-embedding-0.6b', 'openai/text-embedding-3-small'] as const;

export type Vector = readonly number[];

export interface EmbedResult {
  ok: boolean;
  vectors: Vector[];
  model: string;
  detail?: string;
}

/**
 * Embed a batch of strings. Returns `ok: false` rather than throwing — the caller drops to lexical-only
 * matching, which is a real degradation but a correct one, and the UI says so out loud.
 */
export async function embed(
  texts: readonly string[],
  opts: {
    apiKey: string | undefined;
    /** The keyless relay (see protocol.ts). Set, retrieval runs through it with no key on the wire. */
    proxyBase?: string | undefined;
    model?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<EmbedResult> {
  const model = opts.model ?? EMBEDDING_MODEL;
  // Same rule as callJson: a key or a relay is enough. Without this the hosted build would hold a
  // working embeddings path and refuse to use it, and the report would label real hybrid retrieval
  // "lexical only (no key set)" — a false degradation, which is as bad as a hidden one.
  const viaProxy = Boolean(opts.proxyBase);
  if (!modelReachable(opts)) return { ok: false, vectors: [], model, detail: 'no key' };
  if (texts.length === 0) return { ok: true, vectors: [], model };

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const response = await doFetch(embeddingsEndpoint(opts.proxyBase), {
      method: 'POST',
      headers: viaProxy
        ? { 'Content-Type': 'application/json' }
        : {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiKey}`,
          },
      body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
    });

    if (!response.ok) {
      return { ok: false, vectors: [], model, detail: `HTTP ${response.status}` };
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const rows = payload.data ?? [];
    if (rows.length !== texts.length) {
      return { ok: false, vectors: [], model, detail: `expected ${texts.length} vectors, got ${rows.length}` };
    }

    // The API is documented to return `index`, but ordering is not something to assume when a mismatch
    // would silently pair every requirement with the wrong capability.
    const ordered: Vector[] = new Array(texts.length);
    rows.forEach((row, i) => {
      ordered[row.index ?? i] = row.embedding ?? [];
    });
    if (ordered.some((v) => !v || v.length === 0)) {
      return { ok: false, vectors: [], model, detail: 'empty vector in response' };
    }

    return { ok: true, vectors: ordered, model };
  } catch (err) {
    return { ok: false, vectors: [], model, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Cosine similarity. Returns 0 for mismatched or empty vectors rather than NaN. */
export function cosine(a: Vector, b: Vector): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cosine over real text sits in a narrow band — unrelated strings rarely score below about 0.3, and a
 * good hit is rarely above 0.85. Stretching that band to 0..1 keeps the threshold in score.ts readable
 * as a percentage instead of a magic number that only makes sense to whoever tuned it.
 */
export const COSINE_FLOOR = 0.3;
export const COSINE_CEILING = 0.85;

export function normalizeCosine(raw: number): number {
  const clamped = Math.min(COSINE_CEILING, Math.max(COSINE_FLOOR, raw));
  return (clamped - COSINE_FLOOR) / (COSINE_CEILING - COSINE_FLOOR);
}

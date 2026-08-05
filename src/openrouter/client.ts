/**
 * The chat transport.
 *
 * Every failure is typed and none are swallowed. The pipeline needs to tell "no key" from "rate limited"
 * from "the model answered with prose" — because those three want different responses, and collapsing
 * them into one error is how a dead credential hides behind a working demo for a week.
 */

import { buildJsonRequest, chatEndpoint, modelChain, type JsonRequestSpec } from './protocol';

export type LlmFailureKind =
  | 'no_key'
  | 'rate_limited'
  | 'timeout'
  | 'offline'
  | 'bad_request'
  | 'unparseable';

export interface LlmFailure {
  kind: LlmFailureKind;
  detail?: string;
}

export type LlmResult<T> = { ok: true; value: T; model: string } | { ok: false; error: LlmFailure };

const TIMEOUT_MS = 45_000;

export interface LlmOptions {
  apiKey: string | undefined;
  /**
   * Base URL of the keyless model proxy (see protocol.ts). Set, it moves both endpoints onto the relay
   * and takes the key off the wire completely — the browser sends no Authorization header because it
   * has nothing to send. Unset, every line below behaves exactly as it did.
   *
   * Presence IS the transport: there is no second `transport: 'direct' | 'proxy'` field to fall out of
   * step with it. A discriminant plus an address can disagree; an address cannot disagree with itself.
   */
  proxyBase?: string | undefined;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Overrides the tier's primary model. Used by `--model` on the CLI. */
  primaryOverride?: string;
}

/**
 * Is there anywhere to send a model call?
 *
 * The question every gate in the pipeline is actually asking when it tests `opts.apiKey`. A key of our
 * own and a relay that holds one are both a yes, and spelling it out once stops the two lanes drifting
 * apart one guard at a time.
 */
export function modelReachable(opts: Pick<LlmOptions, 'apiKey' | 'proxyBase'>): boolean {
  return Boolean(opts.apiKey || opts.proxyBase);
}

/**
 * One structured-output call. Returns the parsed object or a typed failure — never a thrown error and
 * never a half-parsed value.
 */
export async function callJson<T>(spec: JsonRequestSpec, opts: LlmOptions): Promise<LlmResult<T>> {
  // A key or a relay: either one means there is somewhere to send this. On the proxy lane the caller
  // holds no key BY DESIGN — the relay attaches one server-side — so bailing on `!apiKey` alone would
  // report a working configuration as a missing credential and take the hosted build off the model
  // path entirely. Neither of the two is still an honest `no_key`.
  const viaProxy = Boolean(opts.proxyBase);
  if (!modelReachable(opts)) return { ok: false, error: { kind: 'no_key' } };

  const doFetch = opts.fetchImpl ?? fetch;
  const body = buildJsonRequest(
    opts.primaryOverride ? { ...spec, primaryOverride: opts.primaryOverride } : spec,
  );
  const chain = modelChain(spec.tier, opts.primaryOverride);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await doFetch(chatEndpoint(opts.proxyBase), {
      method: 'POST',
      headers: viaProxy
        ? // The content type and nothing else. The relay holds the key and ignores whatever
          // Authorization it is handed, so sending a placeholder would put something key-shaped on the
          // wire for no reason at all — and the attribution headers below belong to whoever is
          // actually paying for the traffic, which on this lane is the relay.
          { 'Content-Type': 'application/json' }
        : {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiKey}`,
            // OpenRouter attributes traffic with these. Harmless, and it keeps the dashboard readable.
            'HTTP-Referer': 'https://github.com/jbrannan/proof-of-work',
            'X-Title': 'Proof of Work',
          },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: { kind: 'no_key', detail: `HTTP ${response.status}` } };
    }
    if (response.status === 429 || response.status === 402) {
      return { ok: false, error: { kind: 'rate_limited', detail: `HTTP ${response.status}` } };
    }
    if (response.status === 400) {
      // The chain-length bug lived here. A 400 is a malformed request, so OpenRouter does NOT fall
      // through to the next model — surfacing the body is the difference between a five-minute fix and
      // a week of "the LLM path seems flaky".
      const detail = await response.text().catch(() => '');
      return { ok: false, error: { kind: 'bad_request', detail: detail.slice(0, 400) } };
    }
    if (!response.ok) {
      return { ok: false, error: { kind: 'bad_request', detail: `HTTP ${response.status}` } };
    }

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: { kind: 'unparseable', detail: 'empty completion' } };

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Reaching here means a provider ignored response_format. It is the exact failure that
      // `require_parameters: true` exists to prevent, so it is worth naming loudly rather than retrying.
      return {
        ok: false,
        error: { kind: 'unparseable', detail: 'model returned prose, not JSON. Check require_parameters' },
      };
    }

    return { ok: true, value: parsed as T, model: payload.model ?? chain[0] ?? 'unknown' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: { kind: 'timeout' } };
    }
    return { ok: false, error: { kind: 'offline', detail: err instanceof Error ? err.message : String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short reason, for a status line that has room for three words.
 *
 * The enum member is the wrong thing to render. `no_key` reaching the screen tells a reader that
 * something internal leaked out, which is a worse first impression than the degradation it describes.
 */
export function shortReason(kind: LlmFailureKind): string {
  switch (kind) {
    case 'no_key':
      return 'no key set';
    case 'rate_limited':
      return 'out of credit';
    case 'timeout':
      return 'model timed out';
    case 'offline':
      return 'network unreachable';
    case 'bad_request':
      return 'request rejected';
    case 'unparseable':
      return 'unreadable reply';
  }
}

/** Human-readable reason, for the status line the intake screen shows while it works. */
export function describeFailure(failure: LlmFailure): string {
  switch (failure.kind) {
    case 'no_key':
      return 'No OpenRouter key. Running the deterministic path';
    case 'rate_limited':
      return 'OpenRouter is rate-limited or out of credit. Running the deterministic path';
    case 'timeout':
      return 'Model timed out. Running the deterministic path';
    case 'offline':
      return 'Network unreachable. Running the deterministic path';
    case 'bad_request':
      return `OpenRouter rejected the request${failure.detail ? `: ${failure.detail}` : ''}`;
    case 'unparseable':
      return `Model reply could not be read${failure.detail ? `: ${failure.detail}` : ''}`;
  }
}

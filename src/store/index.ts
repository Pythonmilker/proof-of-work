/**
 * Mode detection — what is actually wired up, said out loud.  (DESIGN.md §8)
 *
 * The failure this file exists to prevent has happened twice in this codebase's history, and neither
 * time was the failure itself the problem. A dead OpenRouter key and a malformed model chain both
 * degraded gracefully into a working deterministic path, which meant the demo looked fine, the tests
 * stayed green, and the LLM had been dead for days. Falling back is correct. Falling back *quietly* is
 * the bug.
 *
 * So: every capability is detected on its own, reported on its own, and rendered in the UI header. A
 * credential that is present but rejected says exactly that — it does not silently become "demo mode",
 * and it does not throw a stack trace at someone who typed a placeholder into `.env.local`.
 */

import { EMBEDDINGS_ENDPOINT, OPENROUTER_BASE } from '../openrouter/protocol';
import { AirtableStore } from './airtable';
import { LocalStore, localStoragePersistence, memoryOnly, type Persistence } from './local';
import type { Store } from './types';

export type CapabilityState = 'ready' | 'absent' | 'rejected' | 'unreachable';

export interface CapabilityStatus {
  state: CapabilityState;
  /** One sentence a person can act on. Shown verbatim in the header and by `pnpm doctor`. */
  detail: string;
}

export interface ModeReport {
  /** Which store is backing this session. */
  store: 'local' | 'airtable';
  llm: CapabilityStatus;
  embeddings: CapabilityStatus;
  airtable: CapabilityStatus;
  /** Short label for the header pill, e.g. "demo · local store · no key". */
  label: string;
}

export interface Env {
  OPENROUTER_API_KEY?: string | undefined;
  AIRTABLE_PAT?: string | undefined;
  AIRTABLE_BASE_ID?: string | undefined;
}

/** Airtable base ids start `app`; PATs start `pat`. Catching a pasted-wrong value here saves a 401. */
const BASE_ID_SHAPE = /^app[A-Za-z0-9]{10,}$/;
const PAT_SHAPE = /^pat[A-Za-z0-9._-]{10,}$/;

/**
 * Shape-only detection. No network, so the UI can render a header immediately on first paint.
 * `probe` below is the version that actually asks the services whether the credentials work.
 */
export function detectMode(env: Env): ModeReport {
  const key = env.OPENROUTER_API_KEY?.trim();
  const pat = env.AIRTABLE_PAT?.trim();
  const baseId = env.AIRTABLE_BASE_ID?.trim();

  const llm: CapabilityStatus = key
    ? { state: 'ready', detail: 'OpenRouter key present' }
    : { state: 'absent', detail: 'No OPENROUTER_API_KEY. Deterministic extraction and lexical matching' };

  const embeddings: CapabilityStatus = key
    ? { state: 'ready', detail: 'Embeddings available for hybrid retrieval' }
    : { state: 'absent', detail: 'No key. Retrieval is lexical only' };

  let airtable: CapabilityStatus;
  if (!pat && !baseId) {
    airtable = { state: 'absent', detail: 'No Airtable credentials. Using the local store' };
  } else if (!pat) {
    airtable = { state: 'rejected', detail: 'AIRTABLE_BASE_ID is set but AIRTABLE_PAT is missing' };
  } else if (!baseId) {
    airtable = { state: 'rejected', detail: 'AIRTABLE_PAT is set but AIRTABLE_BASE_ID is missing. Run pnpm airtable:provision' };
  } else if (!PAT_SHAPE.test(pat)) {
    airtable = { state: 'rejected', detail: 'AIRTABLE_PAT does not look like a personal access token (expected it to start "pat")' };
  } else if (!BASE_ID_SHAPE.test(baseId)) {
    airtable = { state: 'rejected', detail: 'AIRTABLE_BASE_ID does not look like a base id (expected it to start "app")' };
  } else {
    airtable = { state: 'ready', detail: `Airtable base ${baseId}` };
  }

  const store = airtable.state === 'ready' ? 'airtable' : 'local';
  const storeLabel = store === 'airtable' ? 'Airtable' : 'local store';
  const keyLabel = llm.state === 'ready' ? 'Claude + embeddings' : 'no key';
  const modeLabel = store === 'airtable' || llm.state === 'ready' ? 'live' : 'demo';

  return { store, llm, embeddings, airtable, label: `${modeLabel} · ${storeLabel} · ${keyLabel}` };
}

/**
 * Ask the services whether the credentials actually work.
 *
 * Used by `pnpm doctor` and `/api/health`. A rejected credential is reported as rejected rather than
 * being folded into "absent", because the two need different fixes and conflating them is how someone
 * spends an afternoon on a key that was fine and a base id that was not.
 */
export async function probe(env: Env, fetchImpl: typeof fetch = fetch): Promise<ModeReport> {
  const report = detectMode(env);

  if (report.llm.state === 'ready') {
    try {
      const response = await fetchImpl(`${OPENROUTER_BASE}/key`, {
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      });
      if (response.status === 401 || response.status === 403) {
        report.llm = { state: 'rejected', detail: `OpenRouter rejected the key (HTTP ${response.status})` };
        report.embeddings = { state: 'rejected', detail: 'Same key, so embeddings are unavailable' };
      } else if (!response.ok) {
        report.llm = { state: 'unreachable', detail: `OpenRouter returned HTTP ${response.status}` };
        report.embeddings = { state: 'unreachable', detail: 'Not checked' };
      } else {
        const body = (await response.json().catch(() => null)) as
          | { data?: { limit?: number | null; usage?: number } }
          | null;
        const limit = body?.data?.limit;
        const usage = body?.data?.usage ?? 0;
        // Out of credit is the specific failure that killed the LLM path on a previous project, so it
        // gets its own message rather than being discovered later as a generic 402 at request time.
        if (typeof limit === 'number' && usage >= limit) {
          report.llm = { state: 'rejected', detail: `OpenRouter key is over its limit (${usage} of ${limit})` };
          report.embeddings = { state: 'rejected', detail: 'Same key, so embeddings are unavailable' };
        } else {
          report.llm = { state: 'ready', detail: 'OpenRouter key accepted' };
        }
      }
    } catch (err) {
      report.llm = { state: 'unreachable', detail: `Could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}` };
      report.embeddings = { state: 'unreachable', detail: 'Not checked' };
    }
  }

  if (report.embeddings.state === 'ready') {
    try {
      const response = await fetchImpl(`${EMBEDDINGS_ENDPOINT}/models`, {
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      });
      if (!response.ok) {
        report.embeddings = { state: 'unreachable', detail: `Embeddings model list returned HTTP ${response.status}` };
      }
    } catch {
      report.embeddings = { state: 'unreachable', detail: 'Could not reach the embeddings endpoint' };
    }
  }

  if (report.airtable.state === 'ready') {
    try {
      const response = await fetchImpl(
        `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Projects?pageSize=1`,
        { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } },
      );
      if (response.status === 401 || response.status === 403) {
        report.airtable = { state: 'rejected', detail: `Airtable rejected the token (HTTP ${response.status}) — check the PAT scopes and base access` };
      } else if (response.status === 404) {
        report.airtable = { state: 'rejected', detail: 'Base or Projects table not found. Run pnpm airtable:provision' };
      } else if (!response.ok) {
        report.airtable = { state: 'unreachable', detail: `Airtable returned HTTP ${response.status}` };
      }
    } catch (err) {
      report.airtable = { state: 'unreachable', detail: `Could not reach Airtable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // A store that was going to be Airtable and is not must fall back to local — visibly.
  if (report.airtable.state !== 'ready') report.store = 'local';
  return { ...report, ...recomputeLabel(report) };
}

function recomputeLabel(report: ModeReport): Pick<ModeReport, 'label'> {
  const storeLabel = report.store === 'airtable' ? 'Airtable' : 'local store';
  const keyLabel =
    report.llm.state === 'ready'
      ? 'Claude + embeddings'
      : report.llm.state === 'rejected'
        ? 'key rejected'
        : report.llm.state === 'unreachable'
          ? 'OpenRouter unreachable'
          : 'no key';
  const modeLabel = report.store === 'airtable' || report.llm.state === 'ready' ? 'live' : 'demo';
  return { label: `${modeLabel} · ${storeLabel} · ${keyLabel}` };
}

/** Build the store this session should use. Never throws — a bad credential means local, not a crash. */
export function createStore(env: Env, persistence?: Persistence): Store {
  const report = detectMode(env);
  if (report.store === 'airtable' && env.AIRTABLE_PAT && env.AIRTABLE_BASE_ID) {
    return new AirtableStore({ pat: env.AIRTABLE_PAT, baseId: env.AIRTABLE_BASE_ID });
  }
  return new LocalStore(persistence ?? memoryOnly);
}

/** Browser convenience: the local store, persisted to `localStorage` when the browser allows it. */
export function createBrowserStore(): LocalStore {
  const storage = typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
  return new LocalStore(storage ? localStoragePersistence(storage) : memoryOnly);
}

export { LocalStore, AirtableStore };
export type { Persistence };

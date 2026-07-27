/**
 * The `/api` surface, and the reason it exists.
 *
 * The OpenRouter key must not end up in a browser bundle, so the pipeline runs here, in Node, behind
 * four endpoints. Those four are deliberately the same shape n8n exposes — a webhook takes JSON and
 * returns JSON — so the React app talks to one contract and does not know or care which side answered.
 * Point `VITE_PIPELINE_ENDPOINT` at an n8n webhook and nothing in the UI changes.
 *
 * With no key at all, the browser skips this entirely and runs the same pipeline module client-side on
 * the deterministic path, which is why `pnpm build` still produces a working static site.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ingest, matchRole } from '../pipeline';
import { LocalStore } from '../store/local';
import { AirtableStore, detectMode, probe, type Env } from '../store';
import type { Store } from '../store/types';
import { filePersistence } from './persistence';

const STATE_FILE = join(process.cwd(), 'data', 'session.json');
const RAW_DIR = join(process.cwd(), 'raw');

let cached: { store: Store; signature: string } | null = null;

/**
 * One store per credential set, reused across requests.
 *
 * Keyed on the credentials so that editing `.env.local` mid-session swaps the backend on the next
 * request instead of quietly serving the old one — which would make testing the Airtable path a
 * restart-and-hope exercise.
 */
function storeFor(env: Env): Store {
  const mode = detectMode(env);
  const signature = `${mode.store}:${env.AIRTABLE_BASE_ID ?? ''}`;
  if (cached?.signature === signature) return cached.store;

  const store: Store =
    mode.store === 'airtable' && env.AIRTABLE_PAT && env.AIRTABLE_BASE_ID
      ? new AirtableStore({ pat: env.AIRTABLE_PAT, baseId: env.AIRTABLE_BASE_ID })
      : new LocalStore(filePersistence(STATE_FILE));

  cached = { store, signature };
  return store;
}

function llmOptions(env: Env): { apiKey: string | undefined } {
  const key = env.OPENROUTER_API_KEY?.trim();
  return { apiKey: key ? key : undefined };
}

export interface SampleFile {
  name: string;
  bytes: number;
  /** First line, for the sample list in the intake screen. */
  preview: string;
}

function listSamples(): SampleFile[] {
  try {
    return readdirSync(RAW_DIR)
      .filter((f) => /\.(md|txt|json)$/i.test(f))
      .sort()
      .map((name) => {
        const body = readFileSync(join(RAW_DIR, name), 'utf8');
        return {
          name,
          bytes: body.length,
          preview: body.split('\n').find((l) => l.trim().length > 0)?.slice(0, 90) ?? '',
        };
      });
  } catch {
    return [];
  }
}

export async function handle(path: string, body: unknown, rawEnv: Record<string, string>): Promise<unknown> {
  const env: Env = {
    OPENROUTER_API_KEY: rawEnv['OPENROUTER_API_KEY'],
    AIRTABLE_PAT: rawEnv['AIRTABLE_PAT'],
    AIRTABLE_BASE_ID: rawEnv['AIRTABLE_BASE_ID'],
  };
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  switch (path) {
    case '/api/health': {
      // The probe hits the real services, so a rejected credential is reported as rejected here rather
      // than being discovered mid-demo as a generic failure.
      return { mode: await probe(env), samples: listSamples(), store: storeFor(env).label };
    }

    case '/api/snapshot': {
      return await storeFor(env).read();
    }

    case '/api/sample': {
      const name = String(input['name'] ?? '');
      // Path traversal is the obvious risk on a read-a-file endpoint, and a basename check is the
      // complete fix: no separators, no dots, nothing outside raw/.
      if (!/^[\w.-]+\.(md|txt|json)$/i.test(name) || name.includes('..')) {
        throw new Error(`not a sample file: ${name}`);
      }
      return { name, body: readFileSync(join(RAW_DIR, name), 'utf8') };
    }

    case '/api/ingest': {
      const blob = String(input['blob'] ?? '');
      const sourceName = String(input['sourceName'] ?? 'pasted-input');
      if (!blob.trim()) throw new Error('nothing to ingest');
      return await ingest(blob, sourceName, storeFor(env), llmOptions(env));
    }

    case '/api/match': {
      const text = String(input['text'] ?? '');
      if (!text.trim()) throw new Error('no job description supplied');
      return await matchRole(text, storeFor(env), llmOptions(env));
    }

    case '/api/reset': {
      const store = storeFor(env);
      if (store instanceof LocalStore) {
        await store.reset();
        return { ok: true, reset: true };
      }
      // Wiping someone's real Airtable base from a demo button is not a recovery path, it is a support
      // ticket. The local store resets; Airtable is left to its owner.
      return { ok: false, reset: false, reason: 'reset only applies to the local store' };
    }

    default:
      throw new Error(`unknown endpoint: ${path}`);
  }
}

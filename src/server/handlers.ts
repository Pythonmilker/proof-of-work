/**
 * The `/api` surface, and the reason it exists.
 *
 * The OpenRouter key must not end up in a browser bundle, so the pipeline runs here, in Node, behind
 * the `/api` endpoints. They are deliberately the same shape n8n exposes — a webhook takes JSON and
 * returns JSON — so the React app talks to one contract and does not know or care which side answered.
 *
 * The n8n path goes through here too (`/api/pipeline/*`): the browser never calls the webhooks
 * directly, because the shared app token they require lives in THIS process's environment and must
 * never reach a bundle. See DESIGN.md §v3.7 — the client contains nothing exploitable.
 *
 * With no key at all, the browser skips this entirely and runs the same pipeline module client-side on
 * the deterministic path, which is why `pnpm build` still produces a working static site.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ingest, ingestResume, matchRole } from '../pipeline';
import { LocalStore } from '../store/local';
import { AirtableStore, detectMode, probe, type Env } from '../store';
import { DEFAULT_CANDIDATE_ID, deletionCounts, type Store } from '../store/types';
import { filePersistence } from './persistence';

const STATE_FILE = join(process.cwd(), 'data', 'session.json');
const RAW_DIR = join(process.cwd(), 'raw');

/**
 * An error that knows its HTTP status. The Vite middleware duck-types `status` off anything thrown
 * (it loads this module through its own graph, so `instanceof` across that boundary is unreliable);
 * everything without one stays a 500. Exists so the n8n proxy can answer 503 — "not configured" is a
 * service state, not a server bug.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

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

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The n8n proxy.  (DESIGN.md §v3.7 — the client never holds the token)
 *
 * The webhooks require an `x-pow-app-token` header. That token is attached HERE, from this process's
 * environment — the browser sends a plain request to `/api/pipeline/*` and never sees the secret. It
 * is deliberately not a VITE_ variable: a VITE_ prefix is a promise to bundle the value into client
 * code, which is exactly what must not happen.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

/** Webhook paths under the n8n base, matching the webhook nodes in n8n/build.ts exactly. */
const N8N_WEBHOOKS: Record<string, string> = {
  '/api/pipeline/extract': 'proof-of-work/extract',
  '/api/pipeline/match': 'proof-of-work/match',
};

function n8nBase(rawEnv: Record<string, string>): string {
  return (rawEnv['VITE_PIPELINE_ENDPOINT'] ?? process.env['VITE_PIPELINE_ENDPOINT'] ?? '')
    .trim()
    .replace(/\/+$/, '');
}

function appToken(rawEnv: Record<string, string>): string {
  return (rawEnv['POW_APP_TOKEN'] ?? process.env['POW_APP_TOKEN'] ?? '').trim();
}

/**
 * Forward one request to its n8n webhook, token attached.
 *
 * Missing configuration answers 503 with the reason named — 'POW_APP_TOKEN not configured' is a
 * message someone can act on, and a proxy that quietly forwarded without the token would just move
 * the failure into n8n's 401, one hop further from the person who can fix it.
 */
async function proxyToN8n(path: string, body: unknown, rawEnv: Record<string, string>): Promise<unknown> {
  const base = n8nBase(rawEnv);
  if (!base) throw new HttpError('n8n endpoint not configured (set VITE_PIPELINE_ENDPOINT)', 503);
  const token = appToken(rawEnv);
  if (!token) throw new HttpError('POW_APP_TOKEN not configured', 503);

  const upstream = await fetch(`${base}/${N8N_WEBHOOKS[path]}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pow-app-token': token },
    body: JSON.stringify(body ?? {}),
  });
  const payload: unknown = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const detail =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `n8n answered HTTP ${upstream.status}`;
    throw new HttpError(detail, upstream.status);
  }
  return payload;
}

export interface PipelineHealth {
  /** Is VITE_PIPELINE_ENDPOINT set server-side at all? */
  configured: boolean;
  /** Did the match webhook answer anything? Any HTTP response is proof of life. */
  reachable: boolean;
  /** Is POW_APP_TOKEN set server-side? Without it every proxied call is a labeled 503. */
  tokenConfigured: boolean;
  /** One sentence a person can act on when something above is false. */
  detail: string;
}

/** The n8n health probe, server-side — the browser asks this instead of touching the webhook. */
async function probePipeline(rawEnv: Record<string, string>): Promise<PipelineHealth> {
  const base = n8nBase(rawEnv);
  const tokenConfigured = appToken(rawEnv).length > 0;
  if (!base) {
    return { configured: false, reachable: false, tokenConfigured, detail: 'VITE_PIPELINE_ENDPOINT is not set' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    // n8n answers 404 on a GET to a POST-only webhook, which is still proof of life.
    await fetch(`${base}/${N8N_WEBHOOKS['/api/pipeline/match']}`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return {
      configured: true,
      reachable: true,
      tokenConfigured,
      detail: tokenConfigured
        ? `Webhook reachable at ${base}, token attached server-side`
        : 'Webhook reachable, but POW_APP_TOKEN is not configured — every call will answer 503',
    };
  } catch {
    return { configured: true, reachable: false, tokenConfigured, detail: `n8n at ${base} did not respond` };
  }
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

    case '/api/candidates': {
      // Counts come from the `candidate` stamp on each row, not from the mirror arrays on the
      // Candidate — the stamp is written by every pipeline path, so it cannot go stale.
      const snap = await storeFor(env).read();
      return {
        candidates: snap.candidates.map((c) => {
          const claims = snap.capabilities.filter((cap) => cap.candidate === c.id);
          return {
            id: c.id,
            name: c.name,
            contact: c.contact,
            source: c.source,
            ingestedAt: c.ingestedAt,
            projects: snap.projects.filter((p) => p.candidate === c.id && p.reviewStatus === 'ok').length,
            claims: {
              verified: claims.filter((cap) => cap.evidence.length > 0).length,
              unverified: claims.filter((cap) => cap.evidence.length === 0).length,
            },
          };
        }),
      };
    }

    /**
     * DELETE one applicant.  (vite.config.ts maps `DELETE /api/candidates/<id>` onto this)
     *
     * The counts are read off the snapshot BEFORE the delete and returned, so the roster can report
     * what actually went rather than claiming a number it did not check. The seeded candidate is
     * refused here as well as in the store: the store guard is the one that cannot be curled around,
     * and this one turns it into a labeled 403 instead of a 500.
     */
    case '/api/candidates/delete': {
      const candidateId = typeof input['candidateId'] === 'string' ? input['candidateId'].trim() : '';
      if (!candidateId) throw new HttpError('no applicant id supplied', 400);
      if (candidateId === DEFAULT_CANDIDATE_ID) {
        throw new HttpError(
          `${DEFAULT_CANDIDATE_ID} is the seeded applicant — the worked example the product ships with — and cannot be deleted`,
          403,
        );
      }
      const store = storeFor(env);
      const before = await store.read();
      const candidate = before.candidates.find((c) => c.id === candidateId);
      if (!candidate) throw new HttpError(`no applicant on file with id ${candidateId}`, 404);

      const removed = deletionCounts(before, candidateId);
      await store.deleteCandidate(candidateId);
      return { ok: true, candidateId, name: candidate.name, removed };
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
      const candidateId = typeof input['candidateId'] === 'string' ? input['candidateId'].trim() : '';
      if (!blob.trim()) throw new Error('nothing to ingest');
      return await ingest(blob, sourceName, storeFor(env), {
        ...llmOptions(env),
        ...(candidateId ? { candidateId } : {}),
      });
    }

    case '/api/ingest-resume': {
      const text = String(input['text'] ?? '');
      const sourceName = String(input['sourceName'] ?? 'pasted-resume');
      if (!text.trim()) throw new Error('nothing to read — paste the resume text');
      return await ingestResume(text, sourceName, storeFor(env), llmOptions(env));
    }

    case '/api/match': {
      const text = String(input['text'] ?? '');
      const candidateId = typeof input['candidateId'] === 'string' ? input['candidateId'].trim() : '';
      if (!text.trim()) throw new Error('no job description supplied');
      return await matchRole(text, storeFor(env), {
        ...llmOptions(env),
        ...(candidateId ? { candidateId } : {}),
      });
    }

    case '/api/pipeline/health': {
      return await probePipeline(rawEnv);
    }

    case '/api/pipeline/extract':
    case '/api/pipeline/match': {
      return await proxyToN8n(path, body, rawEnv);
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

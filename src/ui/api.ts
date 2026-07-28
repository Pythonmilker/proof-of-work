/**
 * One client, three possible backends, and the UI cannot tell them apart.
 *
 *   1. `VITE_PIPELINE_ENDPOINT` set  → an n8n webhook. This is the whole point of the workflows being
 *                                      real: swap one env var and the pipeline moves out of this repo.
 *   2. `/api/*` responds             → the Vite dev server, running the pipeline in Node with the key
 *                                      server-side.
 *   3. neither                       → the static build. The same pipeline module runs in the browser on
 *                                      the deterministic path, so `pnpm build` still produces something
 *                                      that works end to end with no server and no credentials.
 *
 * Which one is in use is reported, never inferred silently. The header says so.
 */

import { ingest as runIngest, matchRole as runMatch, type IngestResult, type MatchReport } from '../pipeline';
import { createBrowserStore } from '../store';
import type { LocalStore } from '../store/local';
import type { ModeReport } from '../store';
import type { Snapshot } from '../store/types';

export type Backend = 'n8n' | 'server' | 'browser';

export interface SampleFile {
  name: string;
  bytes: number;
  preview: string;
}

export interface Health {
  backend: Backend;
  mode: ModeReport;
  samples: SampleFile[];
  store: string;
}

/**
 * VITE_PIPELINE_ENDPOINT is the n8n BASE url (e.g. http://localhost:5678/webhook), not a full webhook
 * path. The two operations live at different paths, and the first version of this file posted both to
 * one endpoint — so n8n mode could never have worked. The paths are appended here, matching the
 * webhook nodes in n8n/build.ts exactly.
 */
const N8N_BASE = (import.meta.env['VITE_PIPELINE_ENDPOINT'] as string | undefined)?.trim()?.replace(/\/+$/, '');
const N8N_EXTRACT = N8N_BASE ? `${N8N_BASE}/proof-of-work/extract` : undefined;
const N8N_MATCH = N8N_BASE ? `${N8N_BASE}/proof-of-work/match` : undefined;

/** Where the delivered product lives. Read by the live-mode links, set in .env.local. */
export const AIRTABLE_BASE_URL = (import.meta.env['VITE_AIRTABLE_BASE_URL'] as string | undefined)?.trim();
export const AIRTABLE_REPORT_URL = (import.meta.env['VITE_AIRTABLE_REPORT_URL'] as string | undefined)?.trim();

/**
 * The raw fixtures, bundled at build time.
 *
 * `import.meta.glob` rather than fetching them, so the static build carries its own sample data and a
 * reviewer opening `dist/` gets the full demo instead of five dead buttons.
 */
const RAW_FILES = import.meta.glob('../../raw/*.{md,txt,json}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function bundledSamples(): SampleFile[] {
  return Object.entries(RAW_FILES)
    .map(([path, body]) => ({
      name: path.split('/').pop() as string,
      bytes: body.length,
      preview: body.split('\n').find((l) => l.trim().length > 0)?.slice(0, 90) ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function bundledSample(name: string): string | null {
  const hit = Object.entries(RAW_FILES).find(([path]) => path.endsWith(`/${name}`));
  return hit?.[1] ?? null;
}

let browserStore: LocalStore | null = null;
function localStore(): LocalStore {
  browserStore ??= createBrowserStore();
  return browserStore;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

let resolved: Backend | null = null;

/**
 * Ask what is actually available, once per session.
 *
 * The browser fallback is a real mode with a real report rather than an error state, because the static
 * build is a supported way to run this — someone who opens `dist/index.html` should see a working demo
 * that tells them plainly it is running deterministic-only.
 */
export async function health(): Promise<Health> {
  if (N8N_BASE && N8N_MATCH) {
    /**
     * PROBE, do not assume. The first version of this branch reported models/embeddings/airtable all
     * "ready" without a single network call, and routed snapshot() to the bundled local store — so the
     * UI would have rendered seed data while writes landed in Airtable. That is precisely the silent
     * fallback this repo exists to argue against.
     *
     * Any HTTP response proves the webhook is reachable (n8n answers 404 on a GET to a POST-only
     * webhook, which is still proof of life). A network error falls through to the server backend,
     * and the header says so rather than pretending.
     */
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      await fetch(N8N_MATCH, { method: 'GET', signal: controller.signal });
      clearTimeout(timer);
      resolved = 'n8n';
      return {
        backend: 'n8n',
        store: 'via n8n',
        samples: bundledSamples(),
        mode: {
          store: 'airtable',
          llm: { state: 'ready', detail: `Webhook reachable at ${N8N_BASE}` },
          embeddings: { state: 'ready', detail: 'Handled inside the workflow' },
          airtable: { state: 'ready', detail: 'Written by the workflow' },
          label: 'live · n8n · Airtable',
        },
      };
    } catch {
      // Fall through to the server backend, visibly: the label below names what happened.
    }
  }

  try {
    const response = await fetch('/api/health');
    if (response.ok) {
      const payload = (await response.json()) as Omit<Health, 'backend'>;
      resolved = 'server';
      if (N8N_BASE) {
        // n8n was configured and did not answer. Same pipeline runs server-side against the same
        // store, but the degradation is stated, not smoothed over.
        payload.mode.label = `${payload.mode.label} · n8n unreachable`;
        payload.mode.llm = {
          ...payload.mode.llm,
          detail: `n8n at ${N8N_BASE} did not respond; running the local pipeline. ${payload.mode.llm.detail}`,
        };
      }
      return { ...payload, backend: 'server' };
    }
  } catch {
    // No dev server. That is the static build, and it is fine.
  }

  resolved = 'browser';
  return {
    backend: 'browser',
    store: localStore().label,
    samples: bundledSamples(),
    mode: {
      store: 'local',
      llm: { state: 'absent', detail: 'Static build. No server to hold a key, so extraction is deterministic' },
      embeddings: { state: 'absent', detail: 'Retrieval is lexical only' },
      airtable: { state: 'absent', detail: 'Using the bundled local store' },
      label: 'demo · local store · no key',
    },
  };
}

export async function loadSample(name: string): Promise<string> {
  if (resolved === 'server') {
    const payload = await post<{ body: string }>('/api/sample', { name });
    return payload.body;
  }
  const body = bundledSample(name);
  if (body === null) throw new Error(`sample not bundled: ${name}`);
  return body;
}

/**
 * What the n8n workflows actually answer with. Deliberately NOT IngestResult/MatchReport: the Respond
 * nodes return operator summaries, and teaching the workflows to emit the app's full types would mean
 * maintaining the pipeline's whole shape in three places. Live mode renders these as a confirmation
 * card with a link into Airtable, where the real report lives.
 */
export interface LiveIngestSummary {
  ok: boolean;
  project?: string;
  key?: string;
  technologiesLinked?: number;
  capabilitiesLinked?: number;
  unresolved?: string[];
  evidenceWritten?: number;
  warnings?: string[];
  parked?: string;
  reason?: string;
}

export interface LiveMatchSummary {
  ok: boolean;
  role?: string;
  company?: string;
  coverage?: { score: number; proven: number; partial: number; gap: number };
  gaps?: Array<{ requirement: { text: string }; status?: string; note?: string }>;
}

export type IngestOutcome =
  | { kind: 'full'; result: IngestResult }
  | { kind: 'live'; summary: LiveIngestSummary };

export type MatchOutcome =
  | { kind: 'full'; report: MatchReport }
  | { kind: 'live'; summary: LiveMatchSummary };

export async function ingest(blob: string, sourceName: string): Promise<IngestOutcome> {
  if (resolved === 'n8n' && N8N_EXTRACT) {
    return { kind: 'live', summary: await post<LiveIngestSummary>(N8N_EXTRACT, { blob, sourceName }) };
  }
  if (resolved === 'server') {
    return { kind: 'full', result: await post<IngestResult>('/api/ingest', { blob, sourceName }) };
  }
  // apiKey is deliberately undefined: a browser bundle is a public artifact, and a key in one is a key
  // anyone can read. The deterministic path is the honest option here, not a compromise.
  return { kind: 'full', result: await runIngest(blob, sourceName, localStore(), { apiKey: undefined }) };
}

export async function match(text: string): Promise<MatchOutcome> {
  if (resolved === 'n8n' && N8N_MATCH) {
    return { kind: 'live', summary: await post<LiveMatchSummary>(N8N_MATCH, { text }) };
  }
  if (resolved === 'server') {
    return { kind: 'full', report: await post<MatchReport>('/api/match', { text }) };
  }
  return { kind: 'full', report: await runMatch(text, localStore(), { apiKey: undefined }) };
}

/**
 * In n8n mode there is no snapshot to read: the store is Airtable, written by the workflow, and the
 * browser holds no credential to read it back. Returning the bundled seed here is what the boundary
 * audit caught — the UI showing local fixture data while writes land in a real base. Null is the
 * honest answer, and the screens that need a snapshot link out to the base instead.
 */
export async function snapshot(): Promise<Snapshot | null> {
  if (resolved === 'n8n') return null;
  if (resolved === 'server') {
    const response = await fetch('/api/snapshot');
    return (await response.json()) as Snapshot;
  }
  return localStore().read();
}

export async function reset(): Promise<{ ok: boolean; reason?: string }> {
  if (resolved === 'n8n') {
    return { ok: false, reason: 'the record lives in Airtable; reset does not apply' };
  }
  if (resolved === 'server') {
    return await post<{ ok: boolean; reason?: string }>('/api/reset', {});
  }
  await localStore().reset();
  return { ok: true };
}

export type { IngestResult, MatchReport };

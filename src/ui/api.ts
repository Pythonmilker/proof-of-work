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

const N8N_ENDPOINT = (import.meta.env['VITE_PIPELINE_ENDPOINT'] as string | undefined)?.trim();

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
  if (N8N_ENDPOINT) {
    resolved = 'n8n';
    return {
      backend: 'n8n',
      store: 'via n8n',
      samples: bundledSamples(),
      mode: {
        store: 'airtable',
        llm: { state: 'ready', detail: `Pipeline delegated to ${N8N_ENDPOINT}` },
        embeddings: { state: 'ready', detail: 'Handled inside the workflow' },
        airtable: { state: 'ready', detail: 'Handled inside the workflow' },
        label: 'live · n8n · Airtable',
      },
    };
  }

  try {
    const response = await fetch('/api/health');
    if (response.ok) {
      const payload = (await response.json()) as Omit<Health, 'backend'>;
      resolved = 'server';
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

export async function ingest(blob: string, sourceName: string): Promise<IngestResult> {
  if (resolved === 'n8n') return post<IngestResult>(N8N_ENDPOINT as string, { blob, sourceName });
  if (resolved === 'server') return post<IngestResult>('/api/ingest', { blob, sourceName });
  // apiKey is deliberately undefined: a browser bundle is a public artifact, and a key in one is a key
  // anyone can read. The deterministic path is the honest option here, not a compromise.
  return runIngest(blob, sourceName, localStore(), { apiKey: undefined });
}

export async function match(text: string): Promise<MatchReport> {
  if (resolved === 'n8n') return post<MatchReport>(N8N_ENDPOINT as string, { text });
  if (resolved === 'server') return post<MatchReport>('/api/match', { text });
  return runMatch(text, localStore(), { apiKey: undefined });
}

export async function snapshot(): Promise<Snapshot> {
  if (resolved === 'server') {
    const response = await fetch('/api/snapshot');
    return (await response.json()) as Snapshot;
  }
  return localStore().read();
}

export async function reset(): Promise<void> {
  if (resolved === 'server') {
    await post('/api/reset', {});
    return;
  }
  await localStore().reset();
}

export type { IngestResult, MatchReport };

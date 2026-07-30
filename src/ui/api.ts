/**
 * One client, three possible backends, and the UI cannot tell them apart.
 *
 *   1. `VITE_PIPELINE_ENDPOINT` set  → n8n runs the pipeline. The browser still only ever talks to
 *                                      `/api/pipeline/*` on the dev server, which forwards to the
 *                                      webhooks with the shared app token attached SERVER-SIDE. The
 *                                      token never appears here, in any VITE_ variable, or in any
 *                                      bundle — see DESIGN.md §v3.7.
 *   2. `/api/*` responds             → the Vite dev server, running the pipeline in Node with the key
 *                                      server-side.
 *   3. neither                       → the static build. The same pipeline module runs in the browser on
 *                                      the deterministic path, so `pnpm build` still produces something
 *                                      that works end to end with no server and no credentials.
 *
 * Which one is in use is reported, never inferred silently. The header says so.
 */

import {
  ingest as runIngest,
  ingestResume as runIngestResume,
  matchRole as runMatch,
  type IngestResult,
  type MatchReport,
  type ResumeIngestResult,
} from '../pipeline';
import { createBrowserStore } from '../store';
import type { LocalStore } from '../store/local';
import type { ModeReport } from '../store';
import { deletionCounts, type Snapshot } from '../store/types';

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
 * VITE_PIPELINE_ENDPOINT here is a FLAG, not an address. Set, it means "prefer the n8n backend" — but
 * every request still goes to `/api/pipeline/*` on the dev server, which holds the actual webhook URL
 * and attaches the shared app token from its own environment. The browser fetching n8n directly is the
 * thing v3.7 forbids: it would require the token in client-reachable code, and a token in a bundle is
 * a token anyone has.
 */
const N8N_CONFIGURED = Boolean((import.meta.env['VITE_PIPELINE_ENDPOINT'] as string | undefined)?.trim());
const PROXY_EXTRACT = '/api/pipeline/extract';
const PROXY_MATCH = '/api/pipeline/match';

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
  let n8nDown: string | null = null;

  if (N8N_CONFIGURED) {
    /**
     * PROBE, do not assume — and probe THROUGH THE PROXY. The server holds the webhook URL and the
     * app token, so only the server can say whether n8n is genuinely usable; asking it also proves
     * the one path requests will actually take. A dead proxy, an unreachable webhook, or a missing
     * token each fall through to the server backend with the reason carried into the header label.
     */
    try {
      const response = await fetch('/api/pipeline/health');
      const payload = (await response.json()) as {
        configured: boolean;
        reachable: boolean;
        tokenConfigured: boolean;
        detail: string;
      };
      if (response.ok && payload.configured && payload.reachable && payload.tokenConfigured) {
        resolved = 'n8n';
        return {
          backend: 'n8n',
          store: 'via n8n',
          samples: bundledSamples(),
          mode: {
            store: 'airtable',
            llm: { state: 'ready', detail: payload.detail },
            embeddings: { state: 'ready', detail: 'Handled inside the workflow' },
            airtable: { state: 'ready', detail: 'Written by the workflow' },
            label: 'live · n8n · Airtable',
          },
        };
      }
      n8nDown = payload.detail || 'n8n is not usable';
    } catch {
      // No dev server to proxy through. n8n mode NEEDS the server — the token lives there — so this
      // falls through, and the static-build branch below names it.
      n8nDown = 'n8n mode needs the dev server (the app token lives server-side)';
    }
  }

  try {
    const response = await fetch('/api/health');
    if (response.ok) {
      const payload = (await response.json()) as Omit<Health, 'backend'>;
      resolved = 'server';
      if (n8nDown) {
        // n8n was configured and is not usable. Same pipeline runs server-side against the same
        // store, but the degradation is stated, not smoothed over.
        payload.mode.label = `${payload.mode.label} · n8n unavailable`;
        payload.mode.llm = {
          ...payload.mode.llm,
          detail: `${n8nDown}; running the local pipeline. ${payload.mode.llm.detail}`,
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
      llm: {
        state: 'absent',
        detail: n8nDown
          ? `Static build — ${n8nDown}. Extraction is deterministic`
          : 'Static build. No server to hold a key, so extraction is deterministic',
      },
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

export async function ingest(blob: string, sourceName: string, candidateId?: string): Promise<IngestOutcome> {
  if (resolved === 'n8n') {
    // Through the proxy — the token is attached server-side. The workflow writes to the seed
    // candidate's record; per-candidate routing inside n8n is not built, and saying so beats hiding it.
    return { kind: 'live', summary: await post<LiveIngestSummary>(PROXY_EXTRACT, { blob, sourceName }) };
  }
  if (resolved === 'server') {
    return { kind: 'full', result: await post<IngestResult>('/api/ingest', { blob, sourceName, candidateId }) };
  }
  // apiKey is deliberately undefined: a browser bundle is a public artifact, and a key in one is a key
  // anyone can read. The deterministic path is the honest option here, not a compromise.
  return {
    kind: 'full',
    result: await runIngest(blob, sourceName, localStore(), {
      apiKey: undefined,
      ...(candidateId ? { candidateId } : {}),
    }),
  };
}

/**
 * Resume intake. No n8n lane exists for this — the two committed workflows are extract and match — so
 * in n8n mode this refuses with the reason named rather than quietly running against the local store
 * while the header claims the record lives in Airtable.
 */
export async function ingestResume(text: string, sourceName: string): Promise<ResumeIngestResult> {
  if (resolved === 'n8n') {
    throw new Error('Resume intake is not one of the n8n workflows; run it against the dev server');
  }
  if (resolved === 'server') {
    return await post<ResumeIngestResult>('/api/ingest-resume', { text, sourceName });
  }
  return await runIngestResume(text, sourceName, localStore(), { apiKey: undefined });
}

export async function match(text: string, candidateId?: string): Promise<MatchOutcome> {
  if (resolved === 'n8n') {
    // Through the proxy; the workflow scores the seed candidate's record in Airtable.
    return { kind: 'live', summary: await post<LiveMatchSummary>(PROXY_MATCH, { text }) };
  }
  if (resolved === 'server') {
    return { kind: 'full', report: await post<MatchReport>('/api/match', { text, candidateId }) };
  }
  return {
    kind: 'full',
    report: await runMatch(text, localStore(), {
      apiKey: undefined,
      ...(candidateId ? { candidateId } : {}),
    }),
  };
}

/** One row of the Applicants list. Claim counts are the verified/unverified chips. */
export interface CandidateSummary {
  id: string;
  name: string;
  contact: string;
  source: string;
  ingestedAt: string;
  projects: number;
  claims: { verified: number; unverified: number };
}

/**
 * The applicant list. Null in n8n mode for the same reason snapshot() is null there: the record lives
 * in Airtable, this app holds no credential to read it back, and the seed pretending to be live data
 * is the exact lie the boundary audit caught.
 */
export async function candidates(): Promise<CandidateSummary[] | null> {
  if (resolved === 'n8n') return null;
  if (resolved === 'server') {
    const response = await fetch('/api/candidates');
    const payload = (await response.json()) as { candidates: CandidateSummary[] };
    return payload.candidates;
  }
  const snap = await localStore().read();
  return snap.candidates.map((c) => {
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
  });
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

/** What a delete removed. The roster reports these verbatim rather than saying "done". */
export interface DeleteResult {
  candidateId: string;
  name: string;
  removed: { projects: number; claims: number; evidence: number; results: number };
}

/**
 * Remove one applicant and everything they own.
 *
 * Three lanes, same as everything else here. n8n refuses for the reason `ingestResume` refuses: no
 * workflow deletes rows, and running this against the local store while the header says the record
 * lives in Airtable is the boundary lie. The seeded applicant is refused by the store and by the
 * server; the roster additionally never renders a control for it, so this throws only if someone
 * reaches past the UI.
 */
export async function deleteCandidate(candidateId: string): Promise<DeleteResult> {
  if (resolved === 'n8n') {
    throw new Error('The record lives in Airtable and no workflow removes rows; delete it in the base');
  }
  if (resolved === 'server') {
    const response = await fetch(`/api/candidates/${encodeURIComponent(candidateId)}`, { method: 'DELETE' });
    const payload = (await response.json()) as DeleteResult & { error?: string };
    if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
    return payload;
  }
  const store = localStore();
  const before = await store.read();
  const candidate = before.candidates.find((c) => c.id === candidateId);
  if (!candidate) throw new Error(`no applicant on file with id ${candidateId}`);
  const removed = deletionCounts(before, candidateId);
  await store.deleteCandidate(candidateId);
  return { candidateId, name: candidate.name, removed };
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

export type { IngestResult, MatchReport, ResumeIngestResult };

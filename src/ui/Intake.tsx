/**
 * The supporting-documents slot, and the before/after that shows what the pipeline did to the input.
 *
 * v3: this is no longer its own tab. It sits under the Applicants roster and everything it writes is
 * stamped with the SELECTED applicant — the artifact lands on their record, and any receipts it
 * carries attach to the claims it matches, which is how an unverified chip earns its promotion.
 *
 * Two older corrections still live here.
 *
 * **The failure branch no longer renders a success panel.** `IngestResult.ok` was computed and never
 * read, so a rejected extraction printed "AFTER — STRUCTURED RECORD" with fields populated from the very
 * output that had just failed validation, above a line counting fields that were never written. The one
 * screen built to prove the pipeline does not fail quietly was a picture of it failing quietly.
 *
 * **The source-type radio group is gone.** Seven options, never passed to `ingest()`, never read by the
 * pipeline. A control that does nothing teaches a false model of the product, and in a job-application
 * demo it reads as unfinished.
 */

import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../store/types';
import type { IntakeState } from './App';
import { AIRTABLE_BASE_URL, ingest, loadSample, type IngestResult, type SampleFile } from './api';

const STAGE_ORDER = ['extract', 'validate', 'dedup', 'link', 'write'] as const;

const MARK: Record<string, string> = { ok: '✓', failed: '✕', skipped: '–', running: '·' };

/** Shared with the resume intake on the Applicants screen — both pipelines report the same stages. */
export function StageList({
  result,
  running,
}: {
  result: Pick<IngestResult, 'stages'> | null;
  running: boolean;
}) {
  return (
    <ul className="stages">
      {STAGE_ORDER.map((stage) => {
        const report = result?.stages.find((s) => s.stage === stage);
        const state = report?.state ?? (running ? 'running' : 'skipped');
        return (
          <li key={stage}>
            <span className={`mark ${state}`}>{MARK[state]}</span>
            <span className="name">{stage}</span>
            <span>{report?.detail ?? (running ? 'working…' : 'not run')}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** What a rejected extraction looks like. No fields, no counts, no structured record. */
function Rejected({ result }: { result: IngestResult }) {
  return (
    <div className="card reject">
      <p className="section-label">Rejected — parked in Needs Review</p>
      <p style={{ marginTop: 0 }}>
        Validation refused this source, so nothing was written to the record except a row marking it for
        review. That row keeps the reason attached.
      </p>
      <ul className="problems">
        {result.warnings.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <dl className="fields">
        <dt>parked as</dt>
        <dd>{result.project?.name ?? '—'}</dd>
        <dt>source</dt>
        <dd>{result.project?.source ?? '—'}</dd>
      </dl>
    </div>
  );
}

function BeforeAfter({ blob, result }: { blob: string; result: IngestResult }) {
  const record = result.extracted as Record<string, unknown> | null;
  const metrics = (record?.['metrics'] ?? {}) as Record<string, number | null>;
  const stack = (record?.['stack'] ?? []) as string[];
  const capabilities = (record?.['capabilities'] ?? []) as string[];
  const evidence = (record?.['evidence'] ?? []) as Array<{ label: string; value: string }>;

  const fieldCount =
    Object.keys(record ?? {}).length + Object.values(metrics).filter((v) => v !== null).length;

  const newNames = new Set([
    ...result.createdTechnologies.map((t) => t.name),
    ...result.createdCapabilities.map((c) => c.name),
  ]);

  return (
    <>
      <div className="transform">
        {blob.length.toLocaleString()} characters of prose <span className="arrow">→</span> {fieldCount} fields,{' '}
        {evidence.length} evidence {evidence.length === 1 ? 'row' : 'rows'},{' '}
        {stack.length + capabilities.length} links
      </div>

      <div className="two-up">
        <div>
          <p className="section-label">Before — raw input</p>
          <pre className="blob">{blob}</pre>
        </div>

        <div>
          <p className="section-label">After — structured record</p>
          <div className="card">
            <dl className="fields">
              <dt>name</dt>
              <dd>{String(record?.['name'] ?? '—')}</dd>
              <dt>status</dt>
              <dd>{String(record?.['status'] ?? '—')}</dd>
              <dt>dates</dt>
              <dd>
                {record?.['started'] ? String(record['started']) : 'not stated'}
                {' to '}
                {record?.['ended'] ? String(record['ended']) : 'ongoing'}
              </dd>
              <dt>summary</dt>
              <dd>{String(record?.['summary'] ?? '—')}</dd>
              {Object.entries(metrics)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([key, value]) => (
                  <span key={key} style={{ display: 'contents' }}>
                    <dt>{key}</dt>
                    <dd className="num">{Number(value).toLocaleString()}</dd>
                  </span>
                ))}
              <dt>stack</dt>
              <dd>
                <div className="chips">
                  {stack.length === 0 ? <span className="chip">none read</span> : null}
                  {stack.map((s) => (
                    <span key={s} className={`chip${newNames.has(s) ? ' new' : ''}`}>
                      {s}
                    </span>
                  ))}
                </div>
              </dd>
              <dt>capabilities</dt>
              <dd>
                <div className="chips">
                  {capabilities.length === 0 ? <span className="chip">none read</span> : null}
                  {capabilities.map((c) => (
                    <span key={c} className={`chip${newNames.has(c) ? ' unverified' : ''}`}>
                      {c}
                      {newNames.has(c) ? ' · unverified' : ''}
                    </span>
                  ))}
                </div>
              </dd>
              <dt>evidence</dt>
              <dd>
                {evidence.length === 0 ? (
                  '—'
                ) : (
                  evidence.map((e) => (
                    <span className="receipt" key={`${e.label}:${e.value}`}>
                      <b>{e.label}</b> — {e.value}
                    </span>
                  ))
                )}
              </dd>
            </dl>
          </div>

          {result.createdCapabilities.length > 0 ? (
            <div className="notice" style={{ marginTop: 14, marginBottom: 0 }}>
              {result.createdCapabilities.length} new{' '}
              {result.createdCapabilities.length === 1 ? 'capability' : 'capabilities'} recorded as
              unverified. A capability enters the record with nothing linked to it, and stays capped at
              partial credit until someone attaches evidence a stranger can check.
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function Intake({
  samples,
  snapshot,
  live,
  candidateId,
  candidateName,
  state,
  onState,
  onChanged,
}: {
  samples: SampleFile[];
  snapshot: Snapshot | null;
  live: boolean;
  candidateId: string;
  candidateName: string;
  state: IntakeState;
  onState: (next: IntakeState) => void;
  onChanged: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const latest = useRef(state);
  latest.current = state;

  const { blob, sourceName, outcome, ingestedBlob } = state;
  const result: IngestResult | null = outcome?.kind === 'full' ? outcome.result : null;
  const patch = (next: Partial<IntakeState>) => onState({ ...latest.current, ...next });

  // Scoped to the selected applicant — this slot writes to one person's record, so counting anyone
  // else's rows here would show numbers the ingest cannot have changed. Technologies stay global.
  const own = {
    projects: snapshot?.projects.filter((p) => p.candidate === candidateId) ?? [],
    capabilities: snapshot?.capabilities.filter((c) => c.candidate === candidateId) ?? [],
    evidence: snapshot?.evidence.filter((e) => e.candidate === candidateId) ?? [],
  };
  const counts = {
    projects: own.projects.filter((p) => p.reviewStatus === 'ok').length,
    technologies: snapshot?.technologies.length ?? 0,
    capabilities: own.capabilities.length,
    evidence: own.evidence.length,
    unverified: own.capabilities.filter((c) => c.evidence.length === 0).length,
    review: own.projects.filter((p) => p.reviewStatus === 'needs-review').length,
  };

  async function pickSample(name: string) {
    setError(null);
    try {
      patch({ blob: await loadSample(name), sourceName: name, outcome: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function run() {
    if (!blob.trim() || running) return;
    setRunning(true);
    setError(null);
    patch({ outcome: null, ingestedBlob: blob });
    try {
      const next = await ingest(blob, sourceName, candidateId);
      patch({ outcome: next, ingestedBlob: blob });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    patch({ blob: await file.text(), sourceName: file.name, outcome: null });
  }

  useEffect(() => {
    // Clearing the box invalidates the panel below it. Showing a record beside input it did not come
    // from is exactly the quiet lie this project exists to avoid.
    if (!blob.trim() && latest.current.outcome) patch({ outcome: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob]);

  return (
    <>
      <h2>Add supporting documents</h2>
      <p className="lede">
        Paste any artifact from {candidateName}&rsquo;s work — a README, a package manifest, raw test
        output. Extraction reads it, validation checks every field, and what survives lands on their
        record with receipts attached; claims the artifact matches earn those receipts. What does not
        survive is parked for review rather than dropped.
      </p>

      {error ? <div className="notice bad">{error}</div> : null}

      <div className="split">
        <div className="card">
          <textarea
            value={blob}
            onChange={(e) => patch({ blob: e.target.value })}
            spellCheck={false}
            placeholder={'Paste a README, a package.json, raw test output, a store listing…'}
            aria-label="Raw evidence"
          />
          <div
            className={`drop${over ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            or drop a file here
          </div>

          <div className="actions">
            <button className="btn" onClick={run} disabled={!blob.trim() || running}>
              {running ? 'Ingesting…' : 'Ingest'}
            </button>
            <button
              className="btn ghost"
              onClick={() => patch({ blob: '', sourceName: 'pasted-input', outcome: null })}
              disabled={running || !blob}
            >
              Clear
            </button>
            <span className="mono" style={{ color: 'var(--text-faint)' }}>
              {blob.length.toLocaleString()} chars · {sourceName}
            </span>
          </div>

          <div style={{ marginTop: 18 }}>
            <p className="section-label">Pipeline</p>
            <StageList result={result} running={running} />
          </div>

          <p className="section-label" style={{ marginTop: 20, marginBottom: 8 }}>
            {candidateName}&rsquo;s record, right now
          </p>
          {!snapshot && live ? (
            // n8n mode: the record lives in Airtable and this app holds no credential to read it back.
            // Counting the bundled seed here would show fixture numbers while writes land in a real
            // base — the exact silent lie the boundary audit caught.
            <p className="hint" style={{ marginBottom: 0 }}>
              The record lives in Airtable.{' '}
              {AIRTABLE_BASE_URL ? (
                <a href={AIRTABLE_BASE_URL} target="_blank" rel="noreferrer">
                  Open the base ↗
                </a>
              ) : (
                'Set VITE_AIRTABLE_BASE_URL for a one-click link.'
              )}
            </p>
          ) : (
          <div className="counts">
            <div>
              <b className="num">{counts.projects}</b>
              <span>projects</span>
            </div>
            <div>
              <b className="num">{counts.technologies}</b>
              <span>technologies</span>
            </div>
            <div>
              <b className="num">{counts.capabilities}</b>
              <span>capabilities</span>
            </div>
            <div>
              <b className="num">{counts.evidence}</b>
              <span>evidence</span>
            </div>
            <div className={counts.unverified > 0 ? 'flag' : undefined} title="Capabilities with nothing linked to them. These can never score as proven.">
              <b className="num">{counts.unverified}</b>
              <span>unverified</span>
            </div>
            <div className={counts.review > 0 ? 'flag' : undefined} title="Sources that failed validation. Kept, with the reason attached.">
              <b className="num">{counts.review}</b>
              <span>needs review</span>
            </div>
          </div>
          )}
        </div>

        <div>
          <div className="card">
            <p className="section-label">Try one</p>
            <p className="hint">
              These are real artifacts from real projects, committed in <code>raw/</code>. Click one and
              press Ingest.
            </p>
            {samples.length === 0 ? <span className="mono">none bundled</span> : null}
            {samples.map((sample) => (
              <button
                key={sample.name}
                className={`sample${sample.name.includes('broken') ? ' warn' : ''}`}
                onClick={() => void pickSample(sample.name)}
                title={sample.preview}
              >
                {sample.name}
                {sample.name.includes('broken') ? ' ⚠' : ''}{' '}
                <span className="bytes">{(sample.bytes / 1024).toFixed(1)} kB</span>
              </button>
            ))}
            <p className="hint" style={{ marginBottom: 0, marginTop: 10 }}>
              For the seeded applicant: <b>10-genestrata</b> is new to the record, <b>01-tendril</b> is
              already in it so dedup fires, and <b>11-broken-fragment</b> fails validation on purpose.
            </p>
          </div>
        </div>
      </div>

      {result ? (
        <div style={{ marginTop: 28 }}>
          {result.ok ? (
            <BeforeAfter blob={ingestedBlob} result={result} />
          ) : (
            <div className="two-up">
              <div>
                <p className="section-label">Before — raw input</p>
                <pre className="blob">{ingestedBlob}</pre>
              </div>
              <div>
                <p className="section-label">After — nothing written</p>
                <Rejected result={result} />
              </div>
            </div>
          )}
        </div>
      ) : null}

      {outcome?.kind === 'live' ? (
        <div style={{ marginTop: 28 }}>
          {outcome.summary.ok ? (
            <div className="card">
              <p className="section-label">Written to the base</p>
              <dl className="fields">
                <dt>project</dt>
                <dd>{outcome.summary.project ?? '—'}</dd>
                <dt>linked</dt>
                <dd>
                  {outcome.summary.technologiesLinked ?? 0} technologies,{' '}
                  {outcome.summary.capabilitiesLinked ?? 0} capabilities,{' '}
                  {outcome.summary.evidenceWritten ?? 0} receipts
                </dd>
              </dl>
              {(outcome.summary.unresolved?.length ?? 0) > 0 ? (
                // The workflow deliberately links only what exists and hands back the rest — the
                // taxonomy is curated in the product the hiring team owns, not invented by a pipeline.
                <div className="notice" style={{ marginTop: 14, marginBottom: 0 }}>
                  {outcome.summary.unresolved?.length} term
                  {(outcome.summary.unresolved?.length ?? 0) === 1 ? '' : 's'} not in the taxonomy yet:{' '}
                  {outcome.summary.unresolved?.join(', ')}. Add the ones that belong as rows in the base;
                  the rest were noise worth dropping.
                </div>
              ) : null}
              {AIRTABLE_BASE_URL ? (
                <div className="actions" style={{ marginTop: 14 }}>
                  <a className="btn ghost" href={AIRTABLE_BASE_URL} target="_blank" rel="noreferrer">
                    Open the base ↗
                  </a>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="card reject">
              <p className="section-label">Rejected — parked in Needs Review</p>
              <p style={{ marginTop: 0 }}>
                Validation refused this source. A row named {outcome.summary.parked ?? 'Unparsed'} was
                written with the reason attached: {outcome.summary.reason ?? 'no reason returned'}
              </p>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

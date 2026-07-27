/**
 * Stage 1 and Stage 6b's before/after, on one screen.
 *
 * Two things have to be legible in a single screenshot: that the input is genuinely messy, and that
 * every stage of the pipeline reported what it did. The stage list is not decoration — it is the
 * argument that nothing here fails quietly.
 */

import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../store/types';
import { ingest, loadSample, type IngestResult, type SampleFile } from './api';

const SOURCE_TYPES = [
  { id: 'readme', label: 'README' },
  { id: 'manifest', label: 'Package manifest' },
  { id: 'test-output', label: 'Test output' },
  { id: 'listing', label: 'Store listing' },
  { id: 'infra', label: 'Infrastructure summary' },
  { id: 'resume', label: 'Career document' },
  { id: 'other', label: 'Something else' },
] as const;

const STAGE_ORDER = ['extract', 'validate', 'dedup', 'link', 'write'] as const;

const MARK: Record<string, string> = { ok: '✓', failed: '✕', skipped: '–', running: '·' };

function StageList({ result, running }: { result: IngestResult | null; running: boolean }) {
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
                {/* "not stated" rather than a bare dash. The source genuinely did not give a date, and
                    saying so reads as a finding instead of a rendering failure. */}
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
  onChanged,
}: {
  samples: SampleFile[];
  snapshot: Snapshot | null;
  onChanged: () => void;
}) {
  const [blob, setBlob] = useState('');
  const [sourceName, setSourceName] = useState('pasted-input');
  const [sourceType, setSourceType] = useState<string>('readme');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const ingestedBlob = useRef('');

  const counts = {
    projects: snapshot?.projects.filter((p) => p.reviewStatus === 'ok').length ?? 0,
    technologies: snapshot?.technologies.length ?? 0,
    capabilities: snapshot?.capabilities.length ?? 0,
    evidence: snapshot?.evidence.length ?? 0,
    review: snapshot?.projects.filter((p) => p.reviewStatus === 'needs-review').length ?? 0,
    unverified: snapshot?.capabilities.filter((c) => c.evidence.length === 0).length ?? 0,
  };

  async function pickSample(name: string) {
    setError(null);
    try {
      const body = await loadSample(name);
      setBlob(body);
      setSourceName(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function run() {
    if (!blob.trim() || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    ingestedBlob.current = blob;
    try {
      setResult(await ingest(blob, sourceName));
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
    setBlob(await file.text());
    setSourceName(file.name);
  }

  useEffect(() => {
    // Clearing the box invalidates the before/after — showing a record beside input it did not come
    // from is exactly the kind of quiet lie this project exists to avoid.
    if (!blob.trim()) setResult(null);
  }, [blob]);

  return (
    <>
      <h1>Ingest evidence</h1>
      <p className="lede">
        Paste any artifact from a piece of work — a README, a package manifest, raw test output, a store
        listing, an infrastructure summary. Extraction reads it, validation checks every field, and what
        survives becomes a record with receipts attached.
      </p>

      {error ? <div className="notice bad">{error}</div> : null}

      <div className="split">
        <div className="card">
          <textarea
            value={blob}
            onChange={(e) => setBlob(e.target.value)}
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
              onClick={() => {
                setBlob('');
                setSourceName('pasted-input');
              }}
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
            <div className={counts.unverified > 0 ? 'flag' : undefined}>
              <b className="num">{counts.unverified}</b>
              <span>unverified</span>
            </div>
            <div className={counts.review > 0 ? 'flag' : undefined}>
              <b className="num">{counts.review}</b>
              <span>needs review</span>
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <p className="section-label">Source type</p>
            <div className="radio-list">
              {SOURCE_TYPES.map((type) => (
                <label key={type.id}>
                  <input
                    type="radio"
                    name="source-type"
                    checked={sourceType === type.id}
                    onChange={() => setSourceType(type.id)}
                  />
                  {type.label}
                </label>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <p className="section-label">Samples</p>
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
          </div>
        </div>
      </div>

      {result ? (
        <div style={{ marginTop: 28 }}>
          <BeforeAfter blob={ingestedBlob.current} result={result} />
        </div>
      ) : null}
    </>
  );
}

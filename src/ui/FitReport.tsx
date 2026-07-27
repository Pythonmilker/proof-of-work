/**
 * The screen everything else is built backward from.
 *
 * Paste a posting, click one button, get a score where every claim links to something checkable — and a
 * Gaps section that says what is missing. The Gaps section is not a disclaimer and it is not collapsed
 * by default: it is the load-bearing claim, because a scoring system that only reports its hits is a
 * flattery generator and a reader can tell.
 */

import { useState } from 'react';
import type { CoverageStatus, Requirement, Snapshot } from '../store/types';
import { match, type MatchReport } from './api';
import { SAMPLE_POSTING, SAMPLE_POSTING_LABEL } from './sample-posting';

const MARKER: Record<CoverageStatus, string> = { proven: '●', partial: '◐', gap: '○' };

function Citations({ report, snapshot, requirementId }: { report: MatchReport; snapshot: Snapshot; requirementId: string }) {
  const result = report.role.results.find((r) => r.requirementId === requirementId);
  if (!result) return null;

  const name = <T extends { id: string; name: string }>(rows: T[], id: string) =>
    rows.find((r) => r.id === id)?.name ?? id;

  const receipts = result.evidence
    .map((id) => snapshot.evidence.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));

  return (
    <div className="citations">
      {result.matchedTechnologies.length > 0 ? (
        <div className="row">
          <span>technologies</span>
          <span className="chips">
            {result.matchedTechnologies.map((id) => (
              <span className="chip" key={id}>
                {name(snapshot.technologies, id)}
              </span>
            ))}
          </span>
        </div>
      ) : null}

      {result.matchedCapabilities.length > 0 ? (
        <div className="row">
          <span>capabilities</span>
          <span className="chips">
            {result.matchedCapabilities.map((id) => {
              const cap = snapshot.capabilities.find((c) => c.id === id);
              const unverified = cap?.evidence.length === 0;
              return (
                <span className={`chip${unverified ? ' unverified' : ''}`} key={id}>
                  {cap?.name ?? id}
                  {cap?.tier === 'stretch' ? ' · stretch' : ''}
                  {unverified ? ' · unverified' : ''}
                </span>
              );
            })}
          </span>
        </div>
      ) : null}

      {result.matchedProjects.length > 0 ? (
        <div className="row">
          <span>projects</span>
          <span className="chips">
            {result.matchedProjects.map((id) => (
              <span className="chip" key={id}>
                {name(snapshot.projects, id)}
              </span>
            ))}
          </span>
        </div>
      ) : null}

      <div className="row">
        <span>receipts</span>
        <span>
          {receipts.length === 0 ? (
            <span style={{ color: 'var(--partial)' }}>
              Nothing verifiable is linked. This is why the status is not proven.
            </span>
          ) : (
            receipts.map((e) => (
              <span className="receipt" key={e.id}>
                <b>{e.label}</b> — {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.value}</a> : e.value}
              </span>
            ))
          )}
        </span>
      </div>

      <div className="row">
        <span>match score</span>
        <span className="mono num">
          {result.score.toFixed(2)} · {report.retrieval} retrieval
        </span>
      </div>
    </div>
  );
}

function Row({
  requirement,
  report,
  snapshot,
}: {
  requirement: Requirement;
  report: MatchReport;
  snapshot: Snapshot;
}) {
  const [open, setOpen] = useState(false);
  const result = report.role.results.find((r) => r.requirementId === requirement.id);
  const status = result?.status ?? 'gap';

  return (
    <div className={`req ${status}`}>
      <button className="req-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="marker">{MARKER[status]}</span>
        <span className="title">{requirement.text}</span>
        <span className="kind">{requirement.kind}</span>
        <span className="status">{status}</span>
      </button>
      <p className="rationale">
        {result?.rationale}
        <span className="tag">{result?.rationaleSource === 'model' ? 'written' : 'computed'}</span>
      </p>
      {open ? <Citations report={report} snapshot={snapshot} requirementId={requirement.id} /> : null}
    </div>
  );
}

export function FitReport({ snapshot, onChanged }: { snapshot: Snapshot | null; onChanged: () => void }) {
  const [text, setText] = useState(SAMPLE_POSTING);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<MatchReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!text.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      setReport(await match(text));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  if (!report) {
    return (
      <>
        <h1>Score a role</h1>
        <p className="lede">
          Paste a job description. Requirements are parsed out of it, matched against the record in code,
          and scored in code. A language model writes one sentence per requirement from the records that
          matched — it never sees the store, so it cannot cite anything retrieval did not return.
        </p>

        {error ? <div className="notice bad">{error}</div> : null}

        <div className="card">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            aria-label="Job description"
            style={{ minHeight: 340 }}
          />
          <div className="actions">
            <button className="btn" onClick={run} disabled={!text.trim() || running}>
              {running ? 'Scoring…' : 'Score this role'}
            </button>
            <button className="btn ghost" onClick={() => setText(SAMPLE_POSTING)} disabled={running}>
              Reset to sample
            </button>
            <button className="btn ghost" onClick={() => setText('')} disabled={running}>
              Clear
            </button>
          </div>
          <p className="mono" style={{ color: 'var(--text-faint)', marginBottom: 0, marginTop: 12 }}>
            Loaded: {SAMPLE_POSTING_LABEL}. The requirement list is real; the company copy is assembled
            from the public site. Paste the actual posting over it for a real run.
          </p>
        </div>
      </>
    );
  }

  const { coverage, role, gaps } = report;
  const total = role.requirements.length || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;

  return (
    <>
      <div className="card">
        <div className="report-head">
          <div style={{ minWidth: 280, flex: 1 }}>
            <h1 style={{ marginBottom: 2 }}>{role.title}</h1>
            <p className="mono" style={{ color: 'var(--text-faint)', margin: 0 }}>
              {role.company || 'company not named'} · {role.matchedAt.slice(0, 10)} ·{' '}
              {role.model === 'none' ? 'deterministic' : role.model} + code
            </p>

            <div className="bar" aria-hidden="true">
              <i className="p" style={{ width: pct(coverage.proven) }} />
              <i className="a" style={{ width: pct(coverage.partial) }} />
              <i className="g" style={{ width: pct(coverage.gap) }} />
            </div>

            <div className="legend">
              <span style={{ color: 'var(--proven)' }}>● {coverage.proven} proven</span>
              <span style={{ color: 'var(--partial)' }}>◐ {coverage.partial} partial</span>
              <span style={{ color: 'var(--gap)' }}>○ {coverage.gap} gaps</span>
              <span>
                {coverage.requiredCovered}/{coverage.requiredTotal} required proven
              </span>
            </div>
          </div>

          <div className="gauge">
            <div className="value">{coverage.score}%</div>
            <div className="caption">weighted coverage</div>
          </div>
        </div>

        {report.notes.length > 0 ? (
          <div className="notice" style={{ marginTop: 18, marginBottom: 0 }}>
            {report.notes.join(' · ')}
          </div>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h2>Requirements</h2>
        {snapshot
          ? role.requirements.map((requirement) => (
              <Row key={requirement.id} requirement={requirement} report={report} snapshot={snapshot} />
            ))
          : null}
      </div>

      <section className="gaps">
        <h2>
          Gaps <small>what this record does not cover</small>
        </h2>
        {gaps.length === 0 ? (
          <p style={{ color: 'var(--text-dim)', margin: 0 }}>
            Every requirement came out proven. That is unusual enough to be worth double-checking against
            the posting rather than trusting.
          </p>
        ) : (
          gaps.map((gap) => (
            <div className="gap-row" key={gap.requirement.id}>
              <div className="what">
                {gap.requirement.text}
                <em>
                  {gap.requirement.kind} · {gap.status}
                </em>
              </div>
              <div className="why">
                {gap.note}
                {gap.closestEvidence ? (
                  <div className="closest">
                    Closest evidence: <b>{gap.closestEvidence.label}</b> —{' '}
                    {gap.closestEvidence.url ? (
                      <a href={gap.closestEvidence.url} target="_blank" rel="noreferrer">
                        {gap.closestEvidence.value}
                      </a>
                    ) : (
                      gap.closestEvidence.value
                    )}
                  </div>
                ) : (
                  <div className="closest" style={{ color: 'var(--text-faint)' }}>
                    No evidence on file for this.
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </section>

      <div className="actions" style={{ marginTop: 20 }}>
        <button className="btn ghost" onClick={() => setReport(null)}>
          Score another role
        </button>
        <span className="mono" style={{ color: 'var(--text-faint)' }}>
          scoring: pure code · rationales: {report.rationaleVia} · retrieval: {report.retrieval} ·
          JD parsing: {report.parseVia}
        </span>
      </div>
    </>
  );
}

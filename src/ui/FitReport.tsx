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
import type { MatchState } from './App';
import { AIRTABLE_BASE_URL, AIRTABLE_REPORT_URL, match, type MatchReport } from './api';
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
  defaultOpen,
}: {
  requirement: Requirement;
  report: MatchReport;
  snapshot: Snapshot;
  defaultOpen: boolean;
}) {
  // The first row opens by default. Citations are what this project is selling, and they were behind an
  // invisible click target on a button with no caret and no hover state.
  const [open, setOpen] = useState(defaultOpen);
  const result = report.role.results.find((r) => r.requirementId === requirement.id);
  const status = result?.status ?? 'gap';

  return (
    <div className={`req ${status}`}>
      <button className="req-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`caret${open ? ' open' : ''}`} aria-hidden="true">
          ▸
        </span>
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

/**
 * Live mode ends on this card, not on a second fit report.
 *
 * The delivered report is the Airtable surface; rendering a full duplicate here would leave a reviewer
 * with two reports and a question about which one is real. React confirms what it wrote — score,
 * counts, the gaps that matter — and hands over.
 */
function LiveConfirmation({
  score,
  proven,
  partial,
  gap,
  title,
  gapLines,
  onAgain,
}: {
  score: number;
  proven: number;
  partial: number;
  gap: number;
  title: string;
  gapLines: string[];
  onAgain: () => void;
}) {
  return (
    <div className="card">
      <h1 style={{ marginBottom: 2 }}>Written to the base</h1>
      <p className="mono" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {title} · one Roles row and {proven + partial + gap} Results rows, citations as links
      </p>

      <div className="report-head" style={{ marginTop: 8 }}>
        <div className="legend" style={{ flex: 1, alignItems: 'center' }}>
          <span style={{ color: 'var(--proven)' }}>● {proven} proven</span>
          <span style={{ color: 'var(--partial)' }}>◐ {partial} partial</span>
          <span style={{ color: 'var(--gap)' }}>○ {gap} not covered</span>
        </div>
        <div className="gauge">
          <div className="value">{score}%</div>
          <div className="caption">overall match</div>
        </div>
      </div>

      {gapLines.length > 0 ? (
        <p className="definitions" style={{ marginTop: 6 }}>
          Not covered: {gapLines.join(' · ')}
        </p>
      ) : null}

      <div className="actions" style={{ marginTop: 16 }}>
        {AIRTABLE_REPORT_URL ? (
          <a className="btn" href={AIRTABLE_REPORT_URL} target="_blank" rel="noreferrer">
            Open the fit report ↗
          </a>
        ) : (
          <span className="mono" style={{ color: 'var(--text-faint)' }}>
            Set VITE_AIRTABLE_REPORT_URL to the shared view link for a one-click handoff
          </span>
        )}
        {AIRTABLE_BASE_URL ? (
          <a className="btn ghost" href={AIRTABLE_BASE_URL} target="_blank" rel="noreferrer">
            Open the base ↗
          </a>
        ) : null}
        <button className="btn ghost" onClick={onAgain}>
          Score another role
        </button>
      </div>
    </div>
  );
}

export function FitReport({
  snapshot,
  live,
  state,
  onState,
  onChanged,
}: {
  snapshot: Snapshot | null;
  live: boolean;
  state: MatchState;
  onState: (next: MatchState) => void;
  onChanged: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { text, outcome, loadedFromRole } = state;
  const report = outcome?.kind === 'full' ? outcome.report : null;

  async function run() {
    if (!text.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      onState({ text, outcome: await match(text), loadedFromRole });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const clear = (nextText: string) => onState({ text: nextText, outcome: null, loadedFromRole: null });

  // Live outcomes end on the confirmation card, whichever backend produced them.
  if (outcome?.kind === 'live' && outcome.summary.ok) {
    const s = outcome.summary;
    return (
      <LiveConfirmation
        score={s.coverage?.score ?? 0}
        proven={s.coverage?.proven ?? 0}
        partial={s.coverage?.partial ?? 0}
        gap={s.coverage?.gap ?? 0}
        title={`${s.role ?? 'Role'}${s.company ? ` at ${s.company}` : ''}`}
        gapLines={(s.gaps ?? []).filter((g) => g.status !== 'partial').map((g) => g.requirement.text).slice(0, 4)}
        onAgain={() => clear(text)}
      />
    );
  }
  if (report && live) {
    return (
      <LiveConfirmation
        score={report.coverage.score}
        proven={report.coverage.proven}
        partial={report.coverage.partial}
        gap={report.coverage.gap}
        title={`${report.role.title}${report.role.company ? ` at ${report.role.company}` : ''}`}
        gapLines={report.gaps.filter((g) => g.status === 'gap').map((g) => g.requirement.text).slice(0, 4)}
        onAgain={() => clear(text)}
      />
    );
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
            onChange={(e) => onState({ text: e.target.value, outcome: null, loadedFromRole: null })}
            spellCheck={false}
            aria-label="Job description"
            style={{ minHeight: 340 }}
          />
          <div className="actions">
            <button className="btn" onClick={run} disabled={!text.trim() || running}>
              {running ? 'Scoring…' : 'Score this role'}
            </button>
            <button className="btn ghost" onClick={() => clear(SAMPLE_POSTING)} disabled={running}>
              Reset to sample
            </button>
            <button className="btn ghost" onClick={() => clear('')} disabled={running}>
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

        <p className="definitions">
          <b>Weighted</b> means a required item counts double a preferred one, and a partial counts half.{' '}
          <b className="proven-word">Proven</b> is matched with checkable evidence linked.{' '}
          <b className="partial-word">Partial</b> is matched, but the evidence is missing or the
          capability is recorded as a stretch rather than as shipped work.{' '}
          <b className="gap-word">Gap</b> is nothing in the record matches.
        </p>

        <p className="determinism">
          Every verdict below is arithmetic. A structured posting is read in code, keeping its own
          words; a model reads prose-heavy postings and writes one sentence per requirement. It never
          decides a status.
        </p>

        {report.notes.length > 0 ? (
          <div className="notice" style={{ marginTop: 18, marginBottom: 0 }}>
            {report.notes.join(' · ')}
          </div>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h2>Requirements</h2>
        {snapshot
          ? role.requirements.map((requirement, i) => (
              <Row
                key={requirement.id}
                requirement={requirement}
                report={report}
                snapshot={snapshot}
                defaultOpen={i === 0}
              />
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
        <button className="btn ghost" onClick={() => clear(text)}>
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

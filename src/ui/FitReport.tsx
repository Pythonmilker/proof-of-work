/**
 * The screen everything else is built backward from.
 *
 * One applicant's fit against one posting: a score where every claim links to something checkable —
 * and a Gaps section that says what is missing. The Gaps section is not a disclaimer and it is not
 * collapsed by default: it is the load-bearing claim, because a scoring system that only reports its
 * hits is a flattery generator and a reader can tell.
 *
 * v3: the run happens on the Score screen. This screen only renders what a run produced, headed by
 * the applicant it describes — the report is candidate-scoped and says so.
 */

import { useState } from 'react';
import type { CoverageStatus, Requirement, Snapshot } from '../store/types';
import type { MatchState } from './App';
import { AIRTABLE_BASE_URL, AIRTABLE_REPORT_URL, type Backend, type MatchReport } from './api';

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
  candidateName,
  gapLines,
  onAgain,
}: {
  score: number;
  proven: number;
  partial: number;
  gap: number;
  title: string;
  candidateName: string;
  gapLines: string[];
  onAgain: () => void;
}) {
  return (
    <div className="card">
      <p className="section-label">Applicant — {candidateName}</p>
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
          Score another posting
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
  candidateName,
  backend,
  onBack,
}: {
  snapshot: Snapshot | null;
  live: boolean;
  state: MatchState;
  onState: (next: MatchState) => void;
  /** Whose fit the outcome describes — the report is candidate-scoped and the header says so. */
  candidateName: string;
  /** Which lane ran the pipeline. Only `browser` may claim the run stayed in the visitor's browser. */
  backend: Backend | null;
  /** Back to the Score screen, where runs happen. */
  onBack: () => void;
}) {
  const { outcome } = state;
  const report = outcome?.kind === 'full' ? outcome.report : null;

  const again = () => {
    onState({ ...state, outcome: null });
    onBack();
  };

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
        candidateName={candidateName}
        gapLines={(s.gaps ?? []).filter((g) => g.status !== 'partial').map((g) => g.requirement.text).slice(0, 4)}
        onAgain={again}
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
        candidateName={candidateName}
        gapLines={report.gaps.filter((g) => g.status === 'gap').map((g) => g.requirement.text).slice(0, 4)}
        onAgain={again}
      />
    );
  }

  if (!report) {
    return (
      <>
        <h1>Fit report</h1>
        <p className="lede">
          Nothing scored yet. Pick an applicant and a posting on the Score screen; the report lands
          here, scoped to that applicant, with citations and a Gaps section.
        </p>
        <div className="actions">
          <button className="btn" onClick={onBack}>
            Go to Score
          </button>
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
        <p className="section-label">Applicant — {candidateName}</p>
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

      {/* Only demo runs reach this full render — live runs end on the confirmation card above — so
          this banner never claims a demo run wrote anything. It points at where production lands, and
          it is explicit that the link is one delivered example rather than the run just finished
          above: a visitor who reads it as a live feed of their own paste has been misled by us. */}
      <div className="card delivery" style={{ marginTop: 18 }}>
        <p className="section-label">Where this lands in production</p>
        <p className="cta-sub">
          {/* "In your browser" is only true on the static build; under the dev server the run
              happens in Node against a local store. Saying the wrong one is a small lie in the app
              whose whole argument is that it does not tell them. */}
          {backend === 'browser'
            ? 'This run scored in your browser and stays there.'
            : 'This run scored locally and stays on this machine.'}{' '}
          In production every run is delivered to Airtable, where a recruiter reads it without
          logging in. The link opens one real delivered report as an example.
        </p>
        {AIRTABLE_REPORT_URL ? (
          <div className="actions" style={{ marginTop: 10 }}>
            <a className="btn ghost" href={AIRTABLE_REPORT_URL} target="_blank" rel="noreferrer">
              Open a delivered fit report ↗
            </a>
          </div>
        ) : (
          <p className="mono" style={{ margin: '10px 0 0' }}>
            No delivery link configured — set VITE_AIRTABLE_REPORT_URL in .env.local to the shared fit
            report.
          </p>
        )}
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
        <button className="btn ghost" onClick={again}>
          Score another posting
        </button>
        <span className="mono" style={{ color: 'var(--text-faint)' }}>
          scoring: pure code · rationales: {report.rationaleVia} · retrieval: {report.retrieval} ·
          JD parsing: {report.parseVia}
        </span>
      </div>
    </>
  );
}

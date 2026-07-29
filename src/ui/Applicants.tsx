/**
 * The landing screen: the applicant roster and the two intake slots.  (DESIGN.md §v3.4)
 *
 * A resume is an artifact whose claims arrive with no receipts, so everything a new applicant asserts
 * lands as an unverified chip. Supporting documents are the other slot: they ingest as evidence,
 * attach to the claims they match, and the chips flip — the recruiter watches a resume turn from
 * asserted to proven, and the chips that never turn are the interview questions.
 */

import { useState } from 'react';
import type { Snapshot } from '../store/types';
import type { IntakeState, ResumeState } from './App';
import {
  AIRTABLE_BASE_URL,
  AIRTABLE_REPORT_URL,
  ingestResume,
  type Backend,
  type CandidateSummary,
  type ResumeIngestResult,
  type SampleFile,
} from './api';
import { Intake, StageList } from './Intake';

/**
 * The landing hero: what this is, how it works, where the data goes, and where to see it — in that
 * order, because a recruiter opening this cold should not have to reverse-engineer the product from a
 * roster. The Airtable card is the ONE solid-accent element on the landing; every other control here
 * stays ghost or quiet, so hierarchy does the pointing.
 *
 * The sub-caption is mode-honest. The static build runs the whole pipeline in the visitor's browser
 * and writes nothing anywhere; the dev server runs it against a local store; a live deployment writes
 * to the base. Each posture says which one it is — the demo never claims it writes to Airtable.
 */
function Hero({ live, backend }: { live: boolean; backend: Backend | null }) {
  const demoSub =
    backend === 'browser'
      ? 'This demo runs entirely in your browser — nothing you paste leaves the page. In production the pipeline delivers every record to Airtable; this link is that delivery, live.'
      : 'This demo writes to a local store, never to Airtable. In production the pipeline delivers every record to Airtable; this link is that delivery, live.';

  return (
    <section className="hero">
      <h1>Applicants</h1>
      <p className="purpose">
        A recruiter&rsquo;s tool for qualifying applicants: claims are verified against receipts, fit
        is scored against any posting by fixed rules, and the gaps are reported honestly.
      </p>

      <ol className="hero-steps">
        <li>
          <b>Paste an applicant&rsquo;s resume</b> — every claim lands unverified.
        </li>
        <li>
          <b>Add their supporting documents</b> — receipts attach and claims flip to verified.
        </li>
        <li>
          <b>Score them against any posting</b> — every verdict cites its receipts, and the gaps are
          listed.
        </li>
      </ol>

      <div className="cta">
        <div className="cta-copy">
          <p className="cta-title">
            {live ? 'This deployment writes to the Airtable base' : 'The delivered record lives in Airtable'}
          </p>
          <p className="cta-sub">
            {live
              ? 'Every ingest and every scoring run lands in the base as rows. The fit report link is that delivery, live.'
              : demoSub}
          </p>
        </div>
        {AIRTABLE_REPORT_URL ? (
          <a className="btn cta-btn" href={AIRTABLE_REPORT_URL} target="_blank" rel="noreferrer">
            {live
              ? 'Open the live fit report ↗'
              : 'See the delivered record — the live Airtable fit report ↗'}
          </a>
        ) : (
          // The env URL is baked at build time. Absent, the card stays and says so — a hidden card is
          // a silent fallback and a dead button is worse.
          <span className="mono cta-missing">
            No delivery link configured — set VITE_AIRTABLE_REPORT_URL in .env.local to the shared fit
            report.
          </span>
        )}
        {live && AIRTABLE_BASE_URL ? (
          <a className="btn ghost" href={AIRTABLE_BASE_URL} target="_blank" rel="noreferrer">
            Open the base ↗
          </a>
        ) : null}
      </div>
    </section>
  );
}

function ClaimReport({ result, snapshot }: { result: ResumeIngestResult; snapshot: Snapshot | null }) {
  const techName = (id: string) => snapshot?.technologies.find((t) => t.id === id)?.name ?? id;

  if (!result.ok) {
    return (
      <div className="card reject">
        <p className="section-label">Nothing written</p>
        <p style={{ marginTop: 0 }}>
          No name could be read from the text, and a candidate row keyed to nobody would collide with
          every other nameless paste. Nothing was recorded.
        </p>
        <StageList result={result} running={false} />
      </div>
    );
  }

  return (
    <div className="card">
      <p className="section-label">The claim sheet — everything below is asserted, not verified</p>
      <dl className="fields">
        <dt>name</dt>
        <dd>{result.name}</dd>
        <dt>contact</dt>
        <dd>{result.contact || '—'}</dd>
        <dt>positions</dt>
        <dd>
          {result.createdProjects.length === 0
            ? 'none read'
            : result.createdProjects.map((p) => p.name).join(' · ')}
        </dd>
        <dt>technologies</dt>
        <dd>
          <div className="chips">
            {result.resolvedTechnologies.length + result.createdTechnologies.length === 0 ? (
              <span className="chip">none read</span>
            ) : null}
            {result.resolvedTechnologies.map((id) => (
              <span className="chip" key={id} title="Matched an existing row in the taxonomy">
                {techName(id)}
              </span>
            ))}
            {result.createdTechnologies.map((t) => (
              <span className="chip new" key={t.id} title="Not in the taxonomy before this resume">
                {t.name} · new
              </span>
            ))}
          </div>
        </dd>
        <dt>claims</dt>
        <dd>
          <div className="chips">
            {result.createdCapabilities.length === 0 ? <span className="chip">none read</span> : null}
            {result.createdCapabilities.map((c) => (
              <span className="chip unverified" key={c.id}>
                {c.name} · unverified
              </span>
            ))}
          </div>
        </dd>
      </dl>

      {result.createdCapabilities.length > 0 ? (
        <div className="notice" style={{ marginTop: 14, marginBottom: 0 }}>
          {result.createdCapabilities.length} claim{result.createdCapabilities.length === 1 ? '' : 's'}{' '}
          recorded as unverified — the natural state of a resume in this system. Each one stays capped at
          partial credit until a supporting document attaches something a stranger can check.
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <p className="section-label">Pipeline</p>
        <StageList result={result} running={false} />
      </div>
    </div>
  );
}

export function Applicants({
  samples,
  backend,
  snapshot,
  roster,
  live,
  selectedId,
  onSelect,
  resumeState,
  onResumeState,
  intakeState,
  onIntakeState,
  onChanged,
}: {
  samples: SampleFile[];
  backend: Backend | null;
  snapshot: Snapshot | null;
  roster: CandidateSummary[] | null;
  live: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  resumeState: ResumeState;
  onResumeState: (next: ResumeState) => void;
  intakeState: IntakeState;
  onIntakeState: (next: IntakeState) => void;
  onChanged: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { text, sourceName, outcome } = resumeState;

  if (live && roster === null) {
    // n8n mode: the record lives in Airtable and this app holds no credential to read it back. A
    // roster rendered from the bundled seed would be fixture data posing as live — the boundary lie.
    return (
      <>
        <Hero live={live} backend={backend} />
        <p className="lede">
          The applicant record lives in Airtable, written by the n8n workflows. This app holds no
          credential to read it back, so the roster is browsed there. Resume intake runs on the dev
          server, not through the workflows.
        </p>
        <div className="actions">
          {AIRTABLE_BASE_URL ? (
            <a className="btn ghost" href={AIRTABLE_BASE_URL} target="_blank" rel="noreferrer">
              Open the base ↗
            </a>
          ) : (
            <span className="mono">Set VITE_AIRTABLE_BASE_URL in .env.local for a one-click link.</span>
          )}
        </div>
      </>
    );
  }

  const selected = roster?.find((c) => c.id === selectedId) ?? null;
  const selectedClaims = snapshot?.capabilities.filter((c) => c.candidate === selectedId) ?? [];

  async function readResume() {
    if (!text.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await ingestResume(text, sourceName.trim() || 'pasted-resume');
      onResumeState({ ...resumeState, outcome: result });
      if (result.ok) onSelect(result.candidateId);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Hero live={live} backend={backend} />

      {error ? <div className="notice bad">{error}</div> : null}

      <div className="split">
        <div>
          <div className="card">
            <p className="section-label">Applicants on file</p>
            {roster === null ? (
              <span className="mono">Loading…</span>
            ) : (
              <div className="applicant-list">
                {roster.map((c) => (
                  <button
                    key={c.id}
                    className="applicant"
                    aria-current={c.id === selectedId}
                    onClick={() => onSelect(c.id)}
                  >
                    <span className="who">
                      <b>{c.name}</b>
                      <span className="mono">
                        {c.source} · {c.ingestedAt.slice(0, 10)} · {c.projects}{' '}
                        {c.projects === 1 ? 'project' : 'projects'}
                      </span>
                    </span>
                    <span className="chips">
                      <span className="chip verified">{c.claims.verified} verified</span>
                      <span className="chip unverified">{c.claims.unverified} unverified</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p className="hint" style={{ marginBottom: 0, marginTop: 10 }}>
              A claim counts as verified once its capability has evidence linked — something checkable,
              not another assertion. The seeded applicant is the worked example the product ships with.
            </p>
          </div>

          {selected && selectedClaims.length > 0 ? (
            <div className="card" style={{ marginTop: 18 }}>
              <p className="section-label">Claims — {selected.name}</p>
              <div className="chips">
                {selectedClaims.map((c) => (
                  <span
                    key={c.id}
                    className={`chip${c.evidence.length === 0 ? ' unverified' : ' verified'}`}
                    title={c.statement}
                  >
                    {c.name}
                    {c.evidence.length === 0 ? ' · unverified' : ''}
                  </span>
                ))}
              </div>
              <p className="hint" style={{ marginBottom: 0, marginTop: 10 }}>
                These re-render after every supporting document, so a promotion is visible the moment a
                claim earns its receipt.
              </p>
            </div>
          ) : null}
        </div>

        <div className="card">
          <p className="section-label">New applicant</p>
          <textarea
            value={text}
            onChange={(e) => onResumeState({ ...resumeState, text: e.target.value, outcome: null })}
            spellCheck={false}
            placeholder={'Paste the resume text. v3 intake is paste-first — no PDF parsing, recruiters can paste.'}
            aria-label="Resume text"
            style={{ minHeight: 200 }}
          />
          <input
            className="text"
            type="text"
            value={sourceName}
            onChange={(e) => onResumeState({ ...resumeState, sourceName: e.target.value })}
            aria-label="Source name"
            placeholder="source name, e.g. jane-doe-resume.pdf"
            spellCheck={false}
          />
          <div className="actions">
            {/* Ghost, not solid: the landing reserves its one solid-accent button for the Airtable card. */}
            <button className="btn ghost" onClick={() => void readResume()} disabled={!text.trim() || running}>
              {running ? 'Reading…' : 'Read the resume'}
            </button>
            <button
              className="btn ghost"
              onClick={() => onResumeState(FRESH)}
              disabled={running || (!text && !outcome)}
            >
              Clear
            </button>
          </div>
          <p className="hint" style={{ marginBottom: 0, marginTop: 10 }}>
            Identity and claims are read from the text; nothing is verified by reading. Every claim
            arrives unverified until supporting documents back it.
          </p>
        </div>
      </div>

      {outcome ? (
        <div style={{ marginTop: 28 }}>
          <ClaimReport result={outcome} snapshot={snapshot} />
        </div>
      ) : null}

      <div style={{ marginTop: 28 }}>
        <Intake
          samples={samples}
          snapshot={snapshot}
          live={live}
          candidateId={selectedId}
          candidateName={selected?.name ?? 'the selected applicant'}
          state={intakeState}
          onState={onIntakeState}
          onChanged={onChanged}
        />
      </div>
    </>
  );
}

const FRESH: ResumeState = { text: '', sourceName: 'pasted-resume', outcome: null };

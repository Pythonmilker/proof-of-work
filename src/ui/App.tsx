/**
 * The shell: the recruiter seat.  (DESIGN.md §v3.4)
 *
 * Three tabs, in the order a recruiter works: **Applicants** (the landing — paste a resume, watch the
 * claims land unverified, add supporting documents until they earn receipts), **Score** (the posting
 * shelf plus paste-a-posting; pick who and against what), **Fit report** (the verdicts, candidate-
 * scoped). The record browser is no longer a tab — in live mode the record lives in Airtable and the
 * footer links out; in demo mode a footer link keeps the table view reachable for the screenshots.
 *
 * Two postures, unchanged from v2:
 *
 * **Demo** (local store, no credentials): everything renders here. This is the README's zero-setup
 * promise.
 *
 * **Live** (Airtable store, or the pipeline delegated to n8n through the server proxy): the record and
 * the report live in Airtable, so the screens that would duplicate them link out instead.
 *
 * The `?roleKey=` query param is the other half of the base's score button: a formula URL opens this
 * app pointed at one Roles row with the posting text pre-loaded, one click from a run.
 */

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_CANDIDATE_ID, type Snapshot } from '../store/types';
import {
  AIRTABLE_BASE_URL,
  candidates as loadCandidates,
  health,
  reset,
  snapshot as loadSnapshot,
  type CandidateSummary,
  type Health,
  type IngestOutcome,
  type MatchOutcome,
  type ResumeIngestResult,
} from './api';
import { Applicants } from './Applicants';
import { FitReport } from './FitReport';
import { ModeBanner } from './ModeBanner';
import { Records } from './Records';
import { Score } from './Score';
import { SAMPLE_POSTING } from './sample-posting';

type Screen = 'applicants' | 'score' | 'report' | 'records';

const SCREENS: Array<{ id: Screen; label: string }> = [
  { id: 'applicants', label: 'Applicants' },
  { id: 'score', label: 'Score' },
  { id: 'report', label: 'Fit report' },
];

/** Everything a screen would otherwise lose when it unmounts. */
export interface IntakeState {
  blob: string;
  sourceName: string;
  outcome: IngestOutcome | null;
  ingestedBlob: string;
}

export interface ResumeState {
  text: string;
  sourceName: string;
  outcome: ResumeIngestResult | null;
}

export interface MatchState {
  text: string;
  outcome: MatchOutcome | null;
  /** Set when the posting was pre-loaded via ?roleKey= or the shelf, so the screen can say where it came from. */
  loadedFromRole: string | null;
  /** Whose fit the outcome describes. */
  candidateId: string;
}

const FRESH_INTAKE: IntakeState = { blob: '', sourceName: 'pasted-input', outcome: null, ingestedBlob: '' };
const FRESH_RESUME: ResumeState = { text: '', sourceName: 'pasted-resume', outcome: null };
const freshMatch = (): MatchState => ({
  text: SAMPLE_POSTING,
  outcome: null,
  loadedFromRole: null,
  candidateId: DEFAULT_CANDIDATE_ID,
});

export function App() {
  const [screen, setScreen] = useState<Screen>('applicants');
  const [status, setStatus] = useState<Health | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [roster, setRoster] = useState<CandidateSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_CANDIDATE_ID);

  const [resumeState, setResumeState] = useState<ResumeState>(FRESH_RESUME);
  const [intakeState, setIntakeState] = useState<IntakeState>(FRESH_INTAKE);
  const [matchState, setMatchState] = useState<MatchState>(freshMatch());

  const live = status ? status.backend === 'n8n' || status.mode.store === 'airtable' : false;

  const refresh = useCallback(() => {
    void loadSnapshot().then(setSnapshot);
    void loadCandidates().then(setRoster);
  }, []);

  useEffect(() => {
    // health() decides the backend, so it has to settle before anything else asks for data.
    void health().then((h) => {
      setStatus(h);
      refresh();
    });
  }, [refresh]);

  useEffect(() => {
    // The base's score button lands here. Pre-load, never auto-run: an auto-run spends real API budget
    // on a page refresh, and the visible click on the honestly-labelled button is the demo beat anyway.
    const roleKey = new URLSearchParams(window.location.search).get('roleKey');
    if (!roleKey || !snapshot) return;
    const role = snapshot.roles.find((r) => r.id === roleKey);
    if (role?.postedText) {
      setMatchState((prev) => ({ ...prev, text: role.postedText, outcome: null, loadedFromRole: role.title }));
      setScreen('score');
    }
  }, [snapshot]);

  const selectedName =
    roster?.find((c) => c.id === selectedId)?.name ??
    snapshot?.candidates.find((c) => c.id === selectedId)?.name ??
    'the seeded applicant';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">
          <span className="glyph">P</span>
          Proof of Work
        </div>

        <nav className="tabs">
          {SCREENS.map((s) => (
            <button key={s.id} className="tab" aria-current={screen === s.id} onClick={() => setScreen(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>

        {status ? <ModeBanner mode={status.mode} backend={status.backend} /> : null}
      </header>

      {screen === 'applicants' ? null : (
        // The landing carries the hero, which says all of this and more; repeating it directly above
        // the hero would read as a stutter. The other screens keep the one-line framing.
        <p className="standfirst">
          Paste an applicant&rsquo;s resume; claims land unverified. Add their supporting documents;
          claims earn receipts. Then score any applicant against any posting — verdicts by fixed rules,
          in code.
          {live ? ' The record lives in Airtable; this app writes to it.' : ''}
        </p>
      )}

      {screen === 'applicants' ? (
        <Applicants
          samples={status?.samples ?? []}
          backend={status?.backend ?? null}
          snapshot={snapshot}
          roster={roster}
          live={live}
          selectedId={selectedId}
          onSelect={setSelectedId}
          resumeState={resumeState}
          onResumeState={setResumeState}
          intakeState={intakeState}
          onIntakeState={setIntakeState}
          onChanged={refresh}
        />
      ) : null}
      {screen === 'score' ? (
        <Score
          snapshot={snapshot}
          roster={roster}
          selectedId={selectedId}
          onSelect={setSelectedId}
          state={matchState}
          onState={setMatchState}
          onScored={() => setScreen('report')}
          onChanged={refresh}
        />
      ) : null}
      {screen === 'report' ? (
        <FitReport
          snapshot={snapshot}
          live={live}
          state={matchState}
          onState={setMatchState}
          candidateName={
            roster?.find((c) => c.id === matchState.candidateId)?.name ??
            snapshot?.candidates.find((c) => c.id === matchState.candidateId)?.name ??
            selectedName
          }
          onBack={() => setScreen('score')}
        />
      ) : null}
      {screen === 'records' ? <Records snapshot={snapshot} live={live} /> : null}

      <footer className="footer">
        <span className="mono">
          Ships with one worked example: the seeded applicant. The product is generic; the data is a
          fixture.
        </span>
        {live ? (
          // Resetting a real base from a demo button is a support ticket, not a recovery path. The
          // handler already refused; hiding the control removes the confusion of a button that "fails".
          AIRTABLE_BASE_URL ? (
            <a className="tab" href={AIRTABLE_BASE_URL} target="_blank" rel="noreferrer">
              open the base ↗
            </a>
          ) : null
        ) : (
          <>
            <button className="tab" aria-current={screen === 'records'} onClick={() => setScreen('records')}>
              browse the record →
            </button>
            <button
              className="tab"
              onClick={() => {
                void reset().then(() => {
                  setResumeState(FRESH_RESUME);
                  setIntakeState(FRESH_INTAKE);
                  setMatchState(freshMatch());
                  setSelectedId(DEFAULT_CANDIDATE_ID);
                  setScreen('applicants');
                  refresh();
                });
              }}
            >
              reset the record
            </button>
          </>
        )}
      </footer>
    </div>
  );
}

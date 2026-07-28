/**
 * The shell: three screens, one header that never lies about what is connected.
 *
 * Two things here are corrections, and both came out of watching someone open this cold.
 *
 * **The product sentence is on screen.** It used to live in the README and in this page's meta
 * description, which is to say it was written for crawlers and not for the person looking at it. The
 * owner's verdict on the old build was "the UI doesn't tell me what it does", and he had built it.
 *
 * **It lands on the fit report.** Intake was first because that is the order the pipeline runs in, which
 * is the wrong reason to order screens. The report is the thing worth seeing, it is one click from a
 * pre-filled posting, and a reviewer with a hundred applications will not paste a README into a
 * stranger's app to find out what the app is.
 *
 * Screen state is lifted here rather than living inside each screen, because the screens are mounted
 * conditionally: keeping the report inside FitReport meant clicking Record to check the data behind a
 * score and coming back to an empty form.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Snapshot } from '../store/types';
import { health, reset, snapshot as loadSnapshot, type Health, type IngestResult, type MatchReport } from './api';
import { FitReport } from './FitReport';
import { Intake } from './Intake';
import { ModeBanner } from './ModeBanner';
import { Records } from './Records';
import { SAMPLE_POSTING } from './sample-posting';

type Screen = 'match' | 'intake' | 'records';

const SCREENS: Array<{ id: Screen; label: string }> = [
  { id: 'match', label: 'Fit report' },
  { id: 'intake', label: 'Add evidence' },
  { id: 'records', label: 'The record' },
];

/** Everything a screen would otherwise lose when it unmounts. */
export interface IntakeState {
  blob: string;
  sourceName: string;
  result: IngestResult | null;
  ingestedBlob: string;
}

export interface MatchState {
  text: string;
  report: MatchReport | null;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('match');
  const [status, setStatus] = useState<Health | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const [intakeState, setIntakeState] = useState<IntakeState>({
    blob: '',
    sourceName: 'pasted-input',
    result: null,
    ingestedBlob: '',
  });
  const [matchState, setMatchState] = useState<MatchState>({ text: SAMPLE_POSTING, report: null });

  const refresh = useCallback(() => {
    void loadSnapshot().then(setSnapshot);
  }, []);

  useEffect(() => {
    // health() decides the backend, so it has to settle before anything else asks for data.
    void health().then((h) => {
      setStatus(h);
      refresh();
    });
  }, [refresh]);

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

      <p className="standfirst">
        Turns messy evidence of what someone has built, a README, a package manifest, raw test output,
        into a structured record where every claim links to something checkable. Then scores that record
        against a pasted job description.
      </p>

      {screen === 'match' ? (
        <FitReport
          snapshot={snapshot}
          state={matchState}
          onState={setMatchState}
          onChanged={refresh}
        />
      ) : null}
      {screen === 'intake' ? (
        <Intake
          samples={status?.samples ?? []}
          snapshot={snapshot}
          state={intakeState}
          onState={setIntakeState}
          onChanged={refresh}
        />
      ) : null}
      {screen === 'records' ? <Records snapshot={snapshot} /> : null}

      <footer className="footer">
        <span className="mono">
          Seeded with one candidate&rsquo;s record. The product is generic; the data is a fixture.
        </span>
        <button
          className="tab"
          onClick={() => {
            void reset().then(() => {
              setIntakeState({ blob: '', sourceName: 'pasted-input', result: null, ingestedBlob: '' });
              setMatchState({ text: SAMPLE_POSTING, report: null });
              refresh();
            });
          }}
        >
          reset the record
        </button>
      </footer>
    </div>
  );
}

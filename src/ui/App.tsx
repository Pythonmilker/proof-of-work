/**
 * The shell: three screens, one header that never lies about what is connected.
 *
 * v2: Airtable is the delivered product and this app is the write surface — the ingestion pipeline and
 * the score trigger. So the shell now has two postures:
 *
 * **Demo** (local store, no credentials): everything renders here, unchanged. This is the README's
 * zero-setup promise.
 *
 * **Live** (Airtable store, or the pipeline delegated to n8n): the record and the fit report live in
 * Airtable, so the screens that would duplicate them link out instead. Live mode never shows two fit
 * reports — React confirms what it wrote and hands over.
 *
 * The `?roleKey=` query param is the other half of the base's "Score this posting" button: a formula
 * URL opens this app pointed at one Roles row, and the posting text is pre-loaded for a one-click run.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Snapshot } from '../store/types';
import {
  AIRTABLE_BASE_URL,
  health,
  reset,
  snapshot as loadSnapshot,
  type Health,
  type IngestOutcome,
  type MatchOutcome,
} from './api';
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
  outcome: IngestOutcome | null;
  ingestedBlob: string;
}

export interface MatchState {
  text: string;
  outcome: MatchOutcome | null;
  /** Set when the posting was pre-loaded via ?roleKey=, so the screen can say where it came from. */
  loadedFromRole: string | null;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('match');
  const [status, setStatus] = useState<Health | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const [intakeState, setIntakeState] = useState<IntakeState>({
    blob: '',
    sourceName: 'pasted-input',
    outcome: null,
    ingestedBlob: '',
  });
  const [matchState, setMatchState] = useState<MatchState>({
    text: SAMPLE_POSTING,
    outcome: null,
    loadedFromRole: null,
  });

  const live = status ? status.backend === 'n8n' || status.mode.store === 'airtable' : false;

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

  useEffect(() => {
    // The base's "Score this posting" button lands here. Pre-load, never auto-run: an auto-run spends
    // real API budget on a page refresh, and a visible "Score this role" click is the demo beat anyway.
    const roleKey = new URLSearchParams(window.location.search).get('roleKey');
    if (!roleKey || !snapshot) return;
    const role = snapshot.roles.find((r) => r.id === roleKey);
    if (role?.postedText) {
      setMatchState({ text: role.postedText, outcome: null, loadedFromRole: role.title });
      setScreen('match');
    }
  }, [snapshot]);

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
        {live ? ' The record lives in Airtable; this app writes to it.' : ''}
      </p>

      {screen === 'match' ? (
        <FitReport
          snapshot={snapshot}
          live={live}
          state={matchState}
          onState={setMatchState}
          onChanged={refresh}
        />
      ) : null}
      {screen === 'intake' ? (
        <Intake
          samples={status?.samples ?? []}
          snapshot={snapshot}
          live={live}
          state={intakeState}
          onState={setIntakeState}
          onChanged={refresh}
        />
      ) : null}
      {screen === 'records' ? <Records snapshot={snapshot} live={live} /> : null}

      <footer className="footer">
        <span className="mono">
          Seeded with one candidate&rsquo;s record. The product is generic; the data is a fixture.
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
          <button
            className="tab"
            onClick={() => {
              void reset().then(() => {
                setIntakeState({ blob: '', sourceName: 'pasted-input', outcome: null, ingestedBlob: '' });
                setMatchState({ text: SAMPLE_POSTING, outcome: null, loadedFromRole: null });
                refresh();
              });
            }}
          >
            reset the record
          </button>
        )}
      </footer>
    </div>
  );
}

/**
 * The shell: three screens, one header that never lies about what is connected.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Snapshot } from '../store/types';
import { health, reset, snapshot as loadSnapshot, type Health } from './api';
import { FitReport } from './FitReport';
import { Intake } from './Intake';
import { ModeBanner } from './ModeBanner';
import { Records } from './Records';

type Screen = 'intake' | 'match' | 'records';

const SCREENS: Array<{ id: Screen; label: string }> = [
  { id: 'intake', label: 'Intake' },
  { id: 'match', label: 'Match' },
  { id: 'records', label: 'Record' },
];

export function App() {
  const [screen, setScreen] = useState<Screen>('intake');
  const [status, setStatus] = useState<Health | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

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

      {screen === 'intake' ? (
        <Intake samples={status?.samples ?? []} snapshot={snapshot} onChanged={refresh} />
      ) : null}
      {screen === 'match' ? <FitReport snapshot={snapshot} onChanged={refresh} /> : null}
      {screen === 'records' ? <Records snapshot={snapshot} /> : null}

      <footer style={{ marginTop: 44, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
        <p className="mono" style={{ color: 'var(--text-faint)', fontSize: 12, margin: 0 }}>
          Matching and scoring are deterministic. A model parses the posting and writes one sentence per
          requirement; it never decides a status.{' '}
          <button
            className="tab"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() => {
              void reset().then(refresh);
            }}
          >
            reset the record
          </button>
        </p>
      </footer>
    </div>
  );
}

/**
 * The posting shelf.  (DESIGN.md §v3.4)
 *
 * Every Roles row in the store is a posting anyone can be scored against — "if this position isn't a
 * fit, maybe another is" as a visible surface, not a sentence. Pick an applicant, pick or paste a
 * posting, and the button names the direction honestly: it scores the applicant's fit against the
 * posting, never the other way around.
 */

import { useState } from 'react';
import type { Snapshot } from '../store/types';
import type { MatchState } from './App';
import { AIRTABLE_BASE_URL, match, type CandidateSummary } from './api';
import { SAMPLE_POSTING, SAMPLE_POSTING_LABEL } from './sample-posting';

export function Score({
  snapshot,
  roster,
  selectedId,
  onSelect,
  state,
  onState,
  onScored,
  onChanged,
}: {
  snapshot: Snapshot | null;
  roster: CandidateSummary[] | null;
  selectedId: string;
  onSelect: (id: string) => void;
  state: MatchState;
  onState: (next: MatchState) => void;
  onScored: () => void;
  onChanged: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { text, loadedFromRole } = state;

  const selected = roster?.find((c) => c.id === selectedId) ?? null;
  const firstName = selected?.name.split(/\s+/)[0] ?? null;
  const nameOf = (id: string) =>
    roster?.find((c) => c.id === id)?.name ?? snapshot?.candidates.find((c) => c.id === id)?.name ?? id;

  async function run() {
    if (!text.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const outcome = await match(text, selectedId);
      onState({ text, outcome, loadedFromRole, candidateId: selectedId });
      onChanged();
      onScored();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const setText = (nextText: string, fromRole: string | null = null) =>
    onState({ ...state, text: nextText, outcome: null, loadedFromRole: fromRole });

  return (
    <>
      <h1>Score an applicant against a posting</h1>
      <p className="lede">
        Paste a job description, or pull one off the shelf. Requirements are parsed out of it, matched
        against the applicant&rsquo;s record in code, and scored in code. A language model writes one
        sentence per requirement from the records that matched — it never sees the store, so it cannot
        cite anything retrieval did not return.
      </p>

      {error ? <div className="notice bad">{error}</div> : null}

      <div className="split">
        <div className="card">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            aria-label="Job description"
            style={{ minHeight: 340 }}
          />
          <div className="actions">
            <button className="btn" onClick={() => void run()} disabled={!text.trim() || running}>
              {running
                ? 'Scoring…'
                : firstName
                  ? `Score ${firstName}'s fit`
                  : "Score the applicant's fit"}
            </button>
            <button className="btn ghost" onClick={() => setText(SAMPLE_POSTING)} disabled={running}>
              Reset to sample
            </button>
            <button className="btn ghost" onClick={() => setText('')} disabled={running}>
              Clear
            </button>
          </div>
          <p className="mono" style={{ color: 'var(--text-faint)', marginBottom: 0, marginTop: 12 }}>
            {loadedFromRole
              ? `Loaded from the shelf: ${loadedFromRole}.`
              : `Loaded: ${SAMPLE_POSTING_LABEL}. The requirement list is real; the company copy is assembled from the public site. Paste the actual posting over it for a real run.`}
          </p>
        </div>

        <div>
          <div className="card">
            <p className="section-label">Applicant</p>
            {roster === null ? (
              // n8n mode: the roster lives in Airtable, and the workflow scores the seeded record.
              <p className="hint" style={{ marginBottom: 0 }}>
                Scoring runs through the n8n workflow against the seeded applicant&rsquo;s record in
                Airtable.
              </p>
            ) : (
              <div className="radio-list">
                {roster.map((c) => (
                  <label key={c.id}>
                    <input
                      type="radio"
                      name="applicant"
                      checked={c.id === selectedId}
                      onChange={() => onSelect(c.id)}
                    />
                    {c.name}
                    <span className="mono" style={{ marginLeft: 'auto' }}>
                      {c.claims.verified}✓ {c.claims.unverified}?
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <p className="section-label">The posting shelf</p>
            {snapshot === null ? (
              AIRTABLE_BASE_URL ? (
                <p className="hint" style={{ marginBottom: 0 }}>
                  Scored postings live in Airtable.{' '}
                  <a href={AIRTABLE_BASE_URL} target="_blank" rel="noreferrer">
                    Open the base ↗
                  </a>
                </p>
              ) : (
                <p className="hint" style={{ marginBottom: 0 }}>
                  Scored postings live in Airtable. Set VITE_AIRTABLE_BASE_URL for a one-click link.
                </p>
              )
            ) : snapshot.roles.length === 0 ? (
              <p className="hint" style={{ marginBottom: 0 }}>
                Nothing on the shelf yet. Score the pre-loaded posting and it lands here, scoreable
                against every applicant.
              </p>
            ) : (
              <>
                {snapshot.roles.map((r) => {
                  const owner = r.results[0]?.candidate ?? null;
                  return (
                    <button
                      key={r.id}
                      className="sample"
                      onClick={() => setText(r.postedText, r.title)}
                      title="Load this posting into the box"
                    >
                      {r.title}
                      {r.company ? ` — ${r.company}` : ''}{' '}
                      <span className="bytes">
                        {owner === selectedId
                          ? `${r.score}% for ${nameOf(owner).split(/\s+/)[0]}`
                          : owner
                            ? `last scored for ${nameOf(owner).split(/\s+/)[0]}`
                            : 'not scored yet'}
                      </span>
                    </button>
                  );
                })}
                <p className="hint" style={{ marginBottom: 0, marginTop: 10 }}>
                  Any applicant can be scored against any posting. Click one to reload it; a re-run
                  keeps the shelf honest about whose fit the score describes.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

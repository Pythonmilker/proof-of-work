/**
 * The record browser — demo mode's copy of the tables Airtable holds.
 *
 * v3: no longer a tab. The footer's "browse the record" link lands here in demo mode, because the
 * table view is a demo beat worth keeping; in live mode this screen refuses to render — the base is
 * the record, and a local copy would be a duplicate at best and, on the n8n path, the bundled seed
 * masquerading as live data. Two things are called out visually because they are the schema's whole
 * argument: a project parked in Needs Review, and a capability with nothing linked to it.
 */

import { useState } from 'react';
import type { Snapshot } from '../store/types';
import { AIRTABLE_BASE_URL, AIRTABLE_REPORT_URL } from './api';

type Tab = 'candidates' | 'projects' | 'technologies' | 'capabilities' | 'evidence' | 'roles';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'candidates', label: 'Candidates' },
  { id: 'projects', label: 'Projects' },
  { id: 'technologies', label: 'Technologies' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'roles', label: 'Roles' },
];

export function Records({ snapshot, live }: { snapshot: Snapshot | null; live: boolean }) {
  const [tab, setTab] = useState<Tab>('projects');

  if (live) {
    // The record IS the Airtable base in live mode, and this screen rendering its own copy is a
    // duplicate at best — and in n8n mode a lie, since the only snapshot available here is the seed.
    return (
      <>
        <h1>The record lives in Airtable</h1>
        <p className="lede">
          Seven tables, the recruiter views, and the fit-report Interface are the delivered product.
          This app writes to them; it does not keep a second copy.
        </p>
        <div className="actions">
          {AIRTABLE_BASE_URL ? (
            <a className="btn" href={AIRTABLE_BASE_URL} target="_blank" rel="noreferrer">
              Open the base ↗
            </a>
          ) : (
            <span className="mono">Set VITE_AIRTABLE_BASE_URL in .env.local for a one-click link.</span>
          )}
          {AIRTABLE_REPORT_URL ? (
            <a className="btn ghost" href={AIRTABLE_REPORT_URL} target="_blank" rel="noreferrer">
              Open the shared fit report ↗
            </a>
          ) : null}
        </div>
      </>
    );
  }

  if (!snapshot) return <div className="empty">Loading the record…</div>;

  const name = <T extends { id: string; name: string }>(rows: T[], id: string) =>
    rows.find((r) => r.id === id)?.name ?? id;

  const unverified = snapshot.capabilities.filter((c) => c.evidence.length === 0).length;
  const parked = snapshot.projects.filter((p) => p.reviewStatus === 'needs-review').length;

  return (
    <>
      <h1>The record</h1>
      <p className="lede">
        Seven tables. Candidates own their records, Projects hold the work, Technologies and
        Capabilities describe it, Evidence proves it, Roles hold every posting, and Results hold each
        posting&rsquo;s verdicts per applicant. In Airtable these are the same seven tables with
        recruiter views over them.
      </p>

      {parked > 0 ? (
        <div className="notice">
          {parked} {parked === 1 ? 'record is' : 'records are'} parked in Needs Review. Extraction failed
          on {parked === 1 ? 'it' : 'them'}, and rather than dropping the input the pipeline wrote a row
          with the reason attached.
        </div>
      ) : null}

      <div className="tabs" style={{ marginLeft: 0, marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className="tab"
            aria-current={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}{' '}
            <span className="mono" style={{ color: 'var(--text-faint)' }}>
              {snapshot[t.id].length}
            </span>
          </button>
        ))}
      </div>

      <div className="card table-wrap">
        {tab === 'candidates' ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Contact</th>
                <th>Source</th>
                <th>Ingested</th>
                <th>Projects</th>
                <th>Claims</th>
                <th>Unverified</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.candidates.map((c) => {
                const claims = snapshot.capabilities.filter((cap) => cap.candidate === c.id);
                const unverified = claims.filter((cap) => cap.evidence.length === 0).length;
                return (
                  <tr key={c.id}>
                    <td>
                      <b>{c.name}</b>
                    </td>
                    <td className="mono">{c.contact || '—'}</td>
                    <td className="mono">{c.source}</td>
                    <td className="mono">{c.ingestedAt.slice(0, 10)}</td>
                    <td className="mono num">
                      {snapshot.projects.filter((p) => p.candidate === c.id && p.reviewStatus === 'ok').length}
                    </td>
                    <td className="mono num">{claims.length}</td>
                    <td className="mono num">
                      {unverified > 0 ? <span style={{ color: 'var(--partial)' }}>{unverified}</span> : 0}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}

        {tab === 'projects' ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Dates</th>
                <th>Metrics</th>
                <th>Tech</th>
                <th>Capabilities</th>
                <th>Evidence</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.projects.map((p) => (
                <tr key={p.id} className={p.reviewStatus === 'needs-review' ? 'needs-review' : undefined}>
                  <td>
                    <b>{p.name}</b>
                    {p.reviewReason ? (
                      <div className="mono" style={{ color: 'var(--partial)' }}>
                        {p.reviewReason}
                      </div>
                    ) : (
                      <div style={{ color: 'var(--text-dim)', maxWidth: 380 }}>{p.summary}</div>
                    )}
                  </td>
                  <td className="mono">{p.status}</td>
                  <td className="mono">
                    {p.started || '—'}
                    {p.ended ? ` → ${p.ended}` : ''}
                  </td>
                  <td className="mono num">
                    {Object.entries(p.metrics).length === 0
                      ? '—'
                      : Object.entries(p.metrics).map(([k, v]) => (
                          <div key={k}>
                            {Number(v).toLocaleString()} {k}
                          </div>
                        ))}
                  </td>
                  <td className="mono num">{p.technologies.length}</td>
                  <td className="mono num">{p.capabilities.length}</td>
                  <td className="mono num">{p.evidence.length}</td>
                  <td className="mono">{p.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {tab === 'technologies' ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Used in</th>
                <th>Aliases</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.technologies.map((t) => (
                <tr key={t.id}>
                  <td>
                    <b>{t.name}</b>
                  </td>
                  <td className="mono">{t.category}</td>
                  <td>
                    <div className="chips">
                      {t.projects.length === 0 ? <span className="chip">not linked</span> : null}
                      {t.projects.map((id) => (
                        <span className="chip" key={id}>
                          {name(snapshot.projects, id)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="mono" style={{ maxWidth: 320 }}>
                    {t.aliases.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {tab === 'capabilities' ? (
          <>
            {unverified > 0 ? (
              <div className="notice">
                {unverified} {unverified === 1 ? 'capability has' : 'capabilities have'} no evidence
                linked. {unverified === 1 ? 'It is' : 'They are'} shown as unverified and cannot score as
                proven against any requirement, however well {unverified === 1 ? 'it matches' : 'they match'}.
              </div>
            ) : null}
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Tier</th>
                  <th>Statement</th>
                  <th>Projects</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.capabilities.map((c) => (
                  <tr key={c.id} className={c.evidence.length === 0 ? 'needs-review' : undefined}>
                    <td>
                      <b>{c.name}</b>
                    </td>
                    <td className="mono" style={{ color: c.tier === 'stretch' ? 'var(--partial)' : undefined }}>
                      {c.tier}
                    </td>
                    <td style={{ color: 'var(--text-dim)', maxWidth: 420 }}>{c.statement}</td>
                    <td className="mono num">{c.projects.length}</td>
                    <td className="mono num">
                      {c.evidence.length === 0 ? (
                        <span style={{ color: 'var(--partial)' }}>unverified</span>
                      ) : (
                        c.evidence.length
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        {tab === 'evidence' ? (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Kind</th>
                <th>Value</th>
                <th>Projects</th>
                <th>Verified</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.evidence.map((e) => (
                <tr key={e.id}>
                  <td>
                    <b>{e.label}</b>
                  </td>
                  <td className="mono">{e.kind}</td>
                  <td>
                    {e.url ? (
                      <a href={e.url} target="_blank" rel="noreferrer">
                        {e.value}
                      </a>
                    ) : (
                      e.value
                    )}
                  </td>
                  <td className="mono">{e.projects.map((id) => name(snapshot.projects, id)).join(', ') || '—'}</td>
                  <td className="mono">{e.verifiedOn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {tab === 'roles' ? (
          snapshot.roles.length === 0 ? (
            <div className="empty">No roles scored yet. Paste a posting on the Match screen.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Company</th>
                  <th>Score</th>
                  <th>Requirements</th>
                  <th>Matched</th>
                  <th>Model</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.roles.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.title}</b>
                    </td>
                    <td>{r.company || '—'}</td>
                    <td className="mono num">{r.score}%</td>
                    <td className="mono num">{r.requirements.length}</td>
                    <td className="mono">{r.matchedAt.slice(0, 16).replace('T', ' ')}</td>
                    <td className="mono">{r.model}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </div>
    </>
  );
}

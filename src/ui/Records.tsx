/**
 * The record browser — the same five tables Airtable holds, rendered locally.
 *
 * It exists so the demo still reads when Airtable is not connected, and so the two can be put
 * side by side in a screenshot. Two things are called out visually because they are the schema's whole
 * argument: a project parked in Needs Review, and a capability with nothing linked to it.
 */

import { useState } from 'react';
import type { Snapshot } from '../store/types';

type Tab = 'projects' | 'technologies' | 'capabilities' | 'evidence' | 'roles';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'projects', label: 'Projects' },
  { id: 'technologies', label: 'Technologies' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'roles', label: 'Roles' },
];

export function Records({ snapshot }: { snapshot: Snapshot | null }) {
  const [tab, setTab] = useState<Tab>('projects');

  if (!snapshot) return <div className="empty">Loading the record…</div>;

  const name = <T extends { id: string; name: string }>(rows: T[], id: string) =>
    rows.find((r) => r.id === id)?.name ?? id;

  const unverified = snapshot.capabilities.filter((c) => c.evidence.length === 0).length;
  const parked = snapshot.projects.filter((p) => p.reviewStatus === 'needs-review').length;

  return (
    <>
      <h1>The record</h1>
      <p className="lede">
        Five tables. Projects hold the work, Technologies and Capabilities describe it, Evidence proves
        it, and Roles hold every posting scored against it. In Airtable these are five tables with two
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

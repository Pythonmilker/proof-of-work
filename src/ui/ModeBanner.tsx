/**
 * The header pill, and the panel behind it.
 *
 * This is the smallest component in the app and it carries the most weight. Everything else degrades
 * gracefully; this is what stops a degradation from being invisible. If the key is rejected, the pill
 * says "key rejected" — not "demo mode", and not nothing at all.
 */

import { useState } from 'react';
import type { CapabilityStatus, ModeReport } from '../store';
import type { Backend } from './api';

const BACKEND_LABEL: Record<Backend, string> = {
  n8n: 'n8n webhook',
  server: 'local API',
  browser: 'in browser',
};

function worst(mode: ModeReport): CapabilityStatus['state'] {
  const states = [mode.llm.state, mode.embeddings.state, mode.airtable.state];
  if (states.includes('rejected')) return 'rejected';
  if (states.includes('unreachable')) return 'unreachable';
  if (states.every((s) => s === 'ready')) return 'ready';
  return 'absent';
}

export function ModeBanner({ mode, backend }: { mode: ModeReport; backend: Backend }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mode">
      <button
        className="pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="What is actually connected"
      >
        <i className={`dot ${worst(mode)}`} aria-hidden="true" />
        {mode.label}
      </button>

      {open ? (
        <div className="mode-detail" role="region" aria-label="Connection detail">
          <dl>
            <dt>pipeline</dt>
            <dd>{BACKEND_LABEL[backend]}</dd>
            <dt>models</dt>
            <dd>
              <i className={`dot ${mode.llm.state}`} aria-hidden="true" /> {mode.llm.detail}
            </dd>
            <dt>embeddings</dt>
            <dd>
              <i className={`dot ${mode.embeddings.state}`} aria-hidden="true" /> {mode.embeddings.detail}
            </dd>
            <dt>store</dt>
            <dd>
              <i className={`dot ${mode.airtable.state}`} aria-hidden="true" /> {mode.airtable.detail}
            </dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Node-side persistence for the local store.
 *
 * Kept out of `src/store/local.ts` on purpose: that module is imported by the browser bundle, and a
 * top-level `node:fs` import there would break the static build. The persistence seam exists so this
 * file can be the only place that knows about a filesystem.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Persistence } from '../store/local';
import type { Snapshot } from '../store/types';

/**
 * A JSON file under `data/`. Gitignored, because it is session state rather than seed data — the seed
 * lives in `src/store/seed.ts` where the compiler can check it.
 */
export function filePersistence(path: string): Persistence {
  return {
    label: path,
    load() {
      try {
        if (!existsSync(path)) return null;
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Snapshot>;
        // `candidates` is checked too, so a pre-candidates session file resets to the seed rather
        // than serving a snapshot missing a table.
        if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.technologies) || !Array.isArray(parsed.candidates)) return null;
        return parsed as Snapshot;
      } catch {
        // A half-written file from an interrupted run resets to the seed rather than taking the app
        // down. Losing a session's ingests is recoverable; a dev server that will not boot is not.
        return null;
      }
    },
    save(snapshot) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8');
      } catch {
        // Read-only checkout or a locked file. The in-memory copy is still correct for this session.
      }
    },
  };
}

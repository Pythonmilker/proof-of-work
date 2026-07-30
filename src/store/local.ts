/**
 * The local store — same seven tables, no account required.
 *
 * This exists so the whole thing runs for someone who has not signed up for anything. That is not a
 * convenience: a reviewer who has to create an Airtable account before they can see the demo mostly does
 * not see the demo. Airtable becomes a swap rather than a prerequisite, and because both adapters satisfy
 * the same `Store` interface, the pipeline cannot tell which one it is talking to.
 *
 * Persistence is injected. In the browser that is `localStorage`, in Node a JSON file, in tests nothing
 * at all — and the store does not care which.
 */

import { seedSnapshot } from './seed';
import {
  DEFAULT_CANDIDATE_ID,
  ProtectedCandidateError,
  UnknownCandidateError,
  ownedRows,
  type Candidate,
  type Capability,
  type Evidence,
  type Project,
  type Role,
  type Snapshot,
  type Store,
  type Technology,
} from './types';

export interface Persistence {
  load(): Snapshot | null;
  save(snapshot: Snapshot): void;
  readonly label: string;
}

export const memoryOnly: Persistence = {
  load: () => null,
  save: () => {},
  label: 'in memory',
};

const STORAGE_KEY = 'proof-of-work:snapshot:v1';

/**
 * Browser persistence.
 *
 * A corrupt or stale payload resets to the seed rather than throwing. The alternative is a demo that
 * white-screens because of something a previous session wrote, which is a spectacularly bad way to lose
 * a screen recording.
 */
export function localStoragePersistence(storage: Storage): Persistence {
  return {
    label: 'browser storage',
    load() {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Snapshot>;
        // `candidates` is checked too, so a pre-candidates payload resets to the seed instead of
        // white-screening on a table the session never wrote.
        if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.technologies) || !Array.isArray(parsed.candidates)) return null;
        return parsed as Snapshot;
      } catch {
        return null;
      }
    },
    save(snapshot) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Quota or private mode. The in-memory copy is still correct for this session.
      }
    },
  };
}

function upsertById<T extends { id: string }>(rows: T[], row: T): T[] {
  const at = rows.findIndex((r) => r.id === row.id);
  if (at === -1) return [...rows, row];
  const next = [...rows];
  next[at] = row;
  return next;
}

export class LocalStore implements Store {
  readonly label: string;
  private snapshot: Snapshot;
  private readonly persistence: Persistence;

  constructor(persistence: Persistence = memoryOnly) {
    this.persistence = persistence;
    this.snapshot = persistence.load() ?? seedSnapshot();
    this.label = `local store (${persistence.label})`;
  }

  async read(): Promise<Snapshot> {
    // A copy, so a caller mutating what it reads cannot rewrite the store behind its own back.
    return structuredClone(this.snapshot);
  }

  async upsertCandidate(candidate: Candidate): Promise<void> {
    this.snapshot = { ...this.snapshot, candidates: upsertById(this.snapshot.candidates, candidate) };
    this.flush();
  }

  async upsertProject(project: Project): Promise<void> {
    this.snapshot = { ...this.snapshot, projects: upsertById(this.snapshot.projects, project) };
    this.flush();
  }

  async upsertEvidence(evidence: Evidence): Promise<void> {
    this.snapshot = { ...this.snapshot, evidence: upsertById(this.snapshot.evidence, evidence) };
    this.flush();
  }

  /**
   * Both sides of the link, always.
   *
   * Airtable maintains the reverse side of a linked-record field for free; here it is manual, and a
   * one-sided link is the kind of bug that shows up much later as a project mysteriously absent from a
   * technology's citation list.
   */
  async linkTechnologies(projectId: string, technologyIds: string[]): Promise<void> {
    this.snapshot = {
      ...this.snapshot,
      projects: this.snapshot.projects.map((p) =>
        p.id === projectId ? { ...p, technologies: [...new Set([...p.technologies, ...technologyIds])] } : p,
      ),
      technologies: this.snapshot.technologies.map((t) =>
        technologyIds.includes(t.id) ? { ...t, projects: [...new Set([...t.projects, projectId])] } : t,
      ),
    };
    this.flush();
  }

  async linkCapabilities(projectId: string, capabilityIds: string[]): Promise<void> {
    this.snapshot = {
      ...this.snapshot,
      projects: this.snapshot.projects.map((p) =>
        p.id === projectId ? { ...p, capabilities: [...new Set([...p.capabilities, ...capabilityIds])] } : p,
      ),
      capabilities: this.snapshot.capabilities.map((c) =>
        capabilityIds.includes(c.id) ? { ...c, projects: [...new Set([...c.projects, projectId])] } : c,
      ),
    };
    this.flush();
  }

  /**
   * A Role is global; its Results are per-candidate.
   *
   * Replacing the row wholesale used to drop every other applicant's results for that posting, so
   * scoring a second applicant against the same posting on the same day silently erased the first
   * one — the exact thing v3 exists to do. Airtable never had the bug because it upserts Results by
   * key. Here the incoming candidate's rows replace only their own; everyone else's survive.
   */
  async saveRole(role: Role): Promise<void> {
    const existing = this.snapshot.roles.find((r) => r.id === role.id);
    const incomingCandidates = new Set(role.results.map((r) => r.candidate));
    const kept = (existing?.results ?? []).filter((r) => !incomingCandidates.has(r.candidate));
    const merged: Role = { ...role, results: [...kept, ...role.results] };
    this.snapshot = { ...this.snapshot, roles: upsertById(this.snapshot.roles, merged) };
    this.flush();
  }

  async upsertTechnology(technology: Technology): Promise<void> {
    this.snapshot = { ...this.snapshot, technologies: upsertById(this.snapshot.technologies, technology) };
    this.flush();
  }

  async upsertCapability(capability: Capability): Promise<void> {
    this.snapshot = { ...this.snapshot, capabilities: upsertById(this.snapshot.capabilities, capability) };
    this.flush();
  }

  /**
   * Delete one candidate and everything they own.  (DESIGN.md §v3.2 — the ownership map)
   *
   * Two things make this more than a filter. First, the seeded candidate is refused HERE rather than
   * only in the UI: the same store answers the API, and a guard that only exists in a button is a
   * guard anyone can curl around. Second, removing rows is the easy half — the hard half is that
   * something still POINTS at them. Airtable maintains the reverse side of a link for free; here it is
   * manual, and a Technology left holding the id of a deleted project is this schema's recurring bug.
   * So every link array in the snapshot is walked, in every direction, against one set of dead ids.
   */
  async deleteCandidate(candidateId: string): Promise<void> {
    if (candidateId === DEFAULT_CANDIDATE_ID) throw new ProtectedCandidateError(candidateId);
    const snapshot = this.snapshot;
    if (!snapshot.candidates.some((c) => c.id === candidateId)) throw new UnknownCandidateError(candidateId);

    const owned = ownedRows(snapshot, candidateId);
    const gone = new Set([candidateId, ...owned.projects, ...owned.capabilities, ...owned.evidence]);
    const keep = (ids: readonly string[]): string[] => ids.filter((id) => !gone.has(id));

    this.snapshot = {
      candidates: snapshot.candidates.filter((c) => c.id !== candidateId),
      // Surviving rows keep their own links, minus anything that no longer exists. Another candidate's
      // rows cannot legitimately reference these — matching is candidate-scoped — but a dangling link
      // is not the kind of thing to leave to an invariant holding somewhere else.
      projects: snapshot.projects
        .filter((p) => !gone.has(p.id))
        .map((p) => ({
          ...p,
          technologies: keep(p.technologies),
          capabilities: keep(p.capabilities),
          evidence: keep(p.evidence),
        })),
      // Global, and the one row that always needs scrubbing: a Technology's `projects` is the reverse
      // side of a link owned by the candidate.
      technologies: snapshot.technologies.map((t) => ({ ...t, projects: keep(t.projects) })),
      capabilities: snapshot.capabilities
        .filter((c) => !gone.has(c.id))
        .map((c) => ({ ...c, projects: keep(c.projects), evidence: keep(c.evidence) })),
      evidence: snapshot.evidence
        .filter((e) => !gone.has(e.id))
        .map((e) => ({ ...e, projects: keep(e.projects) })),
      // The Role row and its requirements stay — a posting is scoreable by anyone. Only this
      // candidate's Results rows go.
      roles: snapshot.roles.map((role) => ({
        ...role,
        results: role.results
          .filter((r) => r.candidate !== candidateId)
          .map((r) => ({
            ...r,
            matchedTechnologies: keep(r.matchedTechnologies),
            matchedCapabilities: keep(r.matchedCapabilities),
            matchedProjects: keep(r.matchedProjects),
            evidence: keep(r.evidence),
          })),
      })),
    };
    this.flush();
  }

  /** Back to the seed. The demo's reset button, and how a recording gets a clean second take. */
  async reset(): Promise<void> {
    this.snapshot = seedSnapshot();
    this.flush();
  }

  private flush(): void {
    this.persistence.save(this.snapshot);
  }
}

/**
 * The local store — same six tables, no account required.
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
import type { Capability, Evidence, Project, Role, Snapshot, Store, Technology } from './types';

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
        if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.technologies)) return null;
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

  async saveRole(role: Role): Promise<void> {
    this.snapshot = { ...this.snapshot, roles: upsertById(this.snapshot.roles, role) };
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

  /** Back to the seed. The demo's reset button, and how a recording gets a clean second take. */
  async reset(): Promise<void> {
    this.snapshot = seedSnapshot();
    this.flush();
  }

  private flush(): void {
    this.persistence.save(this.snapshot);
  }
}

/**
 * The Airtable adapter.
 *
 * Treated as a remote API, not as a database — because that is what it is. It has no transactions, it
 * rate-limits at 5 requests per second per base, it accepts 10 records per write, and its schema is only
 * as stable as the last person who clicked in it. Code that pretends otherwise works fine in a demo and
 * falls over the first time two things happen at once.
 *
 * ## Keys
 *
 * Airtable identifies records with opaque `recXXXXXXXX` ids that do not exist until a row is written,
 * while everything else in this codebase identifies them with a slug. So every table carries a `Key`
 * text field holding our id, and this adapter maintains the translation in both directions. Linked-record
 * fields hold Airtable record ids on the wire and slugs everywhere else.
 *
 * That indirection is the price of using a spreadsheet as a backend, and it is worth naming plainly:
 * it is the seam where a real database would be simpler.
 */

import type { Capability, Evidence, Project, Role, Snapshot, Store, Technology } from './types';

export interface AirtableConfig {
  pat: string;
  baseId: string;
  fetchImpl?: typeof fetch;
}

export const TABLES = {
  projects: 'Projects',
  technologies: 'Technologies',
  capabilities: 'Capabilities',
  evidence: 'Evidence',
  roles: 'Roles',
} as const;

/** Airtable's documented write ceiling. Exceed it and the whole request 422s, not just the extra rows. */
const MAX_RECORDS_PER_WRITE = 10;
/** 5 requests/second per base. 220ms leaves headroom for clock jitter without being slow enough to notice. */
const MIN_REQUEST_GAP_MS = 220;

interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

function str(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return typeof v === 'string' ? v : '';
}

function num(fields: Record<string, unknown>, key: string): number | undefined {
  const v = fields[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function list(fields: Record<string, unknown>, key: string): string[] {
  const v = fields[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

export class AirtableStore implements Store {
  readonly label: string;
  private readonly config: AirtableConfig;
  private readonly doFetch: typeof fetch;
  /** Airtable record id → our slug, per table. Rebuilt on every read. */
  private keyByRecord = new Map<string, string>();
  private recordByKey = new Map<string, string>();
  private lastRequestAt = 0;

  constructor(config: AirtableConfig) {
    this.config = config;
    this.doFetch = config.fetchImpl ?? fetch;
    this.label = `Airtable base ${config.baseId}`;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    await this.throttle();
    const response = await this.doFetch(`https://api.airtable.com/v0/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.pat}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (response.status === 429) {
      // Airtable's documented penalty is a 30-second lockout, so one honest retry beats a tight loop.
      await new Promise((r) => setTimeout(r, 30_000));
      return this.request<T>(path, init);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Airtable ${response.status} on ${path}: ${body.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  private async listAll(table: string): Promise<AirtableRecord[]> {
    const out: AirtableRecord[] = [];
    let offset: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: '100' });
      if (offset) query.set('offset', offset);
      const page = await this.request<{ records: AirtableRecord[]; offset?: string }>(
        `${this.config.baseId}/${encodeURIComponent(table)}?${query}`,
      );
      out.push(...page.records);
      offset = page.offset;
    } while (offset);
    return out;
  }

  async read(): Promise<Snapshot> {
    const [projects, technologies, capabilities, evidence, roles] = await Promise.all([
      this.listAll(TABLES.projects),
      this.listAll(TABLES.technologies),
      this.listAll(TABLES.capabilities),
      this.listAll(TABLES.evidence),
      this.listAll(TABLES.roles),
    ]);

    this.keyByRecord = new Map();
    this.recordByKey = new Map();
    for (const record of [...projects, ...technologies, ...capabilities, ...evidence, ...roles]) {
      const key = str(record.fields, 'Key');
      if (!key) continue;
      this.keyByRecord.set(record.id, key);
      this.recordByKey.set(key, record.id);
    }

    // Resolved after the maps are built, so a link to any table in any direction translates.
    const links = (fields: Record<string, unknown>, field: string): string[] =>
      list(fields, field)
        .map((recordId) => this.keyByRecord.get(recordId))
        .filter((k): k is string => Boolean(k));

    return {
      projects: projects.map((r): Project => {
        const metrics: Project['metrics'] = {};
        const loc = num(r.fields, 'LOC');
        const tests = num(r.fields, 'Tests');
        const commits = num(r.fields, 'Commits');
        const files = num(r.fields, 'Files');
        if (loc !== undefined) metrics.loc = loc;
        if (tests !== undefined) metrics.tests = tests;
        if (commits !== undefined) metrics.commits = commits;
        if (files !== undefined) metrics.files = files;

        return {
          id: str(r.fields, 'Key'),
          name: str(r.fields, 'Name'),
          slug: str(r.fields, 'Key'),
          role: str(r.fields, 'Role'),
          started: str(r.fields, 'Started'),
          ended: str(r.fields, 'Ended') || null,
          status: (str(r.fields, 'Status') || 'in-development') as Project['status'],
          summary: str(r.fields, 'Summary'),
          metrics,
          technologies: links(r.fields, 'Technologies'),
          capabilities: links(r.fields, 'Capabilities'),
          evidence: links(r.fields, 'Evidence'),
          reviewStatus: (str(r.fields, 'Review Status') || 'ok') as Project['reviewStatus'],
          reviewReason: str(r.fields, 'Review Reason') || null,
          source: str(r.fields, 'Source'),
          ingestedAt: str(r.fields, 'Ingested At'),
        };
      }),
      technologies: technologies.map(
        (r): Technology => ({
          id: str(r.fields, 'Key'),
          name: str(r.fields, 'Name'),
          aliases: str(r.fields, 'Aliases').split(',').map((s) => s.trim()).filter(Boolean),
          category: (str(r.fields, 'Category') || 'tooling') as Technology['category'],
          projects: links(r.fields, 'Projects'),
        }),
      ),
      capabilities: capabilities.map(
        (r): Capability => ({
          id: str(r.fields, 'Key'),
          name: str(r.fields, 'Name'),
          statement: str(r.fields, 'Statement'),
          tier: (str(r.fields, 'Tier') || 'stretch') as Capability['tier'],
          matchTerms: str(r.fields, 'Match Terms').split(',').map((s) => s.trim()).filter(Boolean),
          projects: links(r.fields, 'Projects'),
          evidence: links(r.fields, 'Evidence'),
        }),
      ),
      evidence: evidence.map(
        (r): Evidence => ({
          id: str(r.fields, 'Key'),
          label: str(r.fields, 'Label'),
          kind: (str(r.fields, 'Kind') || 'artifact') as Evidence['kind'],
          value: str(r.fields, 'Value'),
          url: str(r.fields, 'URL') || null,
          verifiedOn: str(r.fields, 'Verified On'),
          projects: links(r.fields, 'Projects'),
        }),
      ),
      roles: roles.map((r): Role => {
        const parse = <T,>(field: string, fallback: T): T => {
          try {
            const raw = str(r.fields, field);
            return raw ? (JSON.parse(raw) as T) : fallback;
          } catch {
            return fallback;
          }
        };
        return {
          id: str(r.fields, 'Key'),
          title: str(r.fields, 'Title'),
          company: str(r.fields, 'Company'),
          postedText: str(r.fields, 'Posted Text'),
          requirements: parse('Requirements', []),
          results: parse('Results', []),
          score: num(r.fields, 'Score') ?? 0,
          matchedAt: str(r.fields, 'Matched At'),
          model: str(r.fields, 'Model'),
          source: str(r.fields, 'Source'),
          ingestedAt: str(r.fields, 'Ingested At'),
        };
      }),
    };
  }

  /** Translate our slugs into Airtable record ids, dropping any the base does not have yet. */
  private refs(keys: readonly string[]): string[] {
    return keys.map((k) => this.recordByKey.get(k)).filter((r): r is string => Boolean(r));
  }

  private async upsertByKey(table: string, key: string, fields: Record<string, unknown>): Promise<void> {
    const existing = this.recordByKey.get(key);
    if (existing) {
      await this.request(`${this.config.baseId}/${encodeURIComponent(table)}`, {
        method: 'PATCH',
        body: JSON.stringify({ records: [{ id: existing, fields }] }),
      });
      return;
    }
    const created = await this.request<{ records: AirtableRecord[] }>(
      `${this.config.baseId}/${encodeURIComponent(table)}`,
      { method: 'POST', body: JSON.stringify({ records: [{ fields: { ...fields, Key: key } }] }) },
    );
    const record = created.records[0];
    if (record) {
      this.recordByKey.set(key, record.id);
      this.keyByRecord.set(record.id, key);
    }
  }

  async upsertProject(project: Project): Promise<void> {
    await this.upsertByKey(TABLES.projects, project.id, {
      Name: project.name,
      Role: project.role,
      Started: project.started,
      Ended: project.ended ?? '',
      Status: project.status,
      Summary: project.summary,
      ...(project.metrics.loc !== undefined ? { LOC: project.metrics.loc } : {}),
      ...(project.metrics.tests !== undefined ? { Tests: project.metrics.tests } : {}),
      ...(project.metrics.commits !== undefined ? { Commits: project.metrics.commits } : {}),
      ...(project.metrics.files !== undefined ? { Files: project.metrics.files } : {}),
      Evidence: this.refs(project.evidence),
      'Review Status': project.reviewStatus,
      'Review Reason': project.reviewReason ?? '',
      Source: project.source,
      'Ingested At': project.ingestedAt,
    });
  }

  async upsertEvidence(evidence: Evidence): Promise<void> {
    await this.upsertByKey(TABLES.evidence, evidence.id, {
      Label: evidence.label,
      Kind: evidence.kind,
      Value: evidence.value,
      URL: evidence.url ?? '',
      'Verified On': evidence.verifiedOn,
      Projects: this.refs(evidence.projects),
    });
  }

  async upsertTechnology(technology: Technology): Promise<void> {
    await this.upsertByKey(TABLES.technologies, technology.id, {
      Name: technology.name,
      Aliases: technology.aliases.join(', '),
      Category: technology.category,
    });
  }

  async upsertCapability(capability: Capability): Promise<void> {
    await this.upsertByKey(TABLES.capabilities, capability.id, {
      Name: capability.name,
      Statement: capability.statement,
      Tier: capability.tier,
      'Match Terms': capability.matchTerms.join(', '),
      Evidence: this.refs(capability.evidence),
    });
  }

  async linkTechnologies(projectId: string, technologyIds: string[]): Promise<void> {
    const record = this.recordByKey.get(projectId);
    if (!record) return;
    await this.request(`${this.config.baseId}/${encodeURIComponent(TABLES.projects)}`, {
      method: 'PATCH',
      body: JSON.stringify({ records: [{ id: record, fields: { Technologies: this.refs(technologyIds) } }] }),
    });
  }

  async linkCapabilities(projectId: string, capabilityIds: string[]): Promise<void> {
    const record = this.recordByKey.get(projectId);
    if (!record) return;
    await this.request(`${this.config.baseId}/${encodeURIComponent(TABLES.projects)}`, {
      method: 'PATCH',
      body: JSON.stringify({ records: [{ id: record, fields: { Capabilities: this.refs(capabilityIds) } }] }),
    });
  }

  async saveRole(role: Role): Promise<void> {
    await this.upsertByKey(TABLES.roles, role.id, {
      Title: role.title,
      Company: role.company,
      'Posted Text': role.postedText,
      Requirements: JSON.stringify(role.requirements),
      Results: JSON.stringify(role.results),
      Score: role.score,
      'Matched At': role.matchedAt,
      Model: role.model,
      Source: role.source,
      'Ingested At': role.ingestedAt,
    });
  }

  /** Batched create, used by the seeding script. Chunked to the write ceiling, in order. */
  async createMany(table: string, rows: Array<{ key: string; fields: Record<string, unknown> }>): Promise<void> {
    for (let i = 0; i < rows.length; i += MAX_RECORDS_PER_WRITE) {
      const chunk = rows.slice(i, i + MAX_RECORDS_PER_WRITE);
      const created = await this.request<{ records: AirtableRecord[] }>(
        `${this.config.baseId}/${encodeURIComponent(table)}`,
        {
          method: 'POST',
          body: JSON.stringify({ records: chunk.map((r) => ({ fields: { ...r.fields, Key: r.key } })) }),
        },
      );
      created.records.forEach((record, at) => {
        const key = chunk[at]?.key;
        if (!key) return;
        this.recordByKey.set(key, record.id);
        this.keyByRecord.set(record.id, key);
      });
    }
  }

  async patchMany(table: string, rows: Array<{ key: string; fields: Record<string, unknown> }>): Promise<void> {
    const withIds = rows
      .map((r) => ({ id: this.recordByKey.get(r.key), fields: r.fields }))
      .filter((r): r is { id: string; fields: Record<string, unknown> } => Boolean(r.id));
    for (let i = 0; i < withIds.length; i += MAX_RECORDS_PER_WRITE) {
      await this.request(`${this.config.baseId}/${encodeURIComponent(table)}`, {
        method: 'PATCH',
        body: JSON.stringify({ records: withIds.slice(i, i + MAX_RECORDS_PER_WRITE) }),
      });
    }
  }

  /** Expose the key map so the seeding script can resolve links after the first pass. */
  resolve(key: string): string | undefined {
    return this.recordByKey.get(key);
  }
}

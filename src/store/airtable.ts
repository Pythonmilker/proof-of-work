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

import type {
  Candidate,
  Capability,
  Evidence,
  Project,
  Requirement,
  RequirementResult,
  Role,
  Snapshot,
  Store,
  Technology,
} from './types';

export interface AirtableConfig {
  pat: string;
  baseId: string;
  fetchImpl?: typeof fetch;
}

export const TABLES = {
  candidates: 'Candidates',
  projects: 'Projects',
  technologies: 'Technologies',
  capabilities: 'Capabilities',
  evidence: 'Evidence',
  roles: 'Roles',
  results: 'Results',
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
    const [candidates, projects, technologies, capabilities, evidence, roles, results] = await Promise.all([
      this.listAll(TABLES.candidates),
      this.listAll(TABLES.projects),
      this.listAll(TABLES.technologies),
      this.listAll(TABLES.capabilities),
      this.listAll(TABLES.evidence),
      this.listAll(TABLES.roles),
      this.listAll(TABLES.results),
    ]);

    this.keyByRecord = new Map();
    this.recordByKey = new Map();
    for (const record of [...candidates, ...projects, ...technologies, ...capabilities, ...evidence, ...roles, ...results]) {
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
      candidates: candidates.map(
        (r): Candidate => ({
          id: str(r.fields, 'Key'),
          name: str(r.fields, 'Name'),
          contact: str(r.fields, 'Contact'),
          source: str(r.fields, 'Source'),
          ingestedAt: str(r.fields, 'Ingested At'),
          projects: links(r.fields, 'Projects'),
          capabilities: links(r.fields, 'Capabilities'),
          evidence: links(r.fields, 'Evidence'),
        }),
      ),
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
          candidate: links(r.fields, 'Candidate')[0] ?? '',
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
          candidate: links(r.fields, 'Candidate')[0] ?? '',
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
          candidate: links(r.fields, 'Candidate')[0] ?? '',
          label: str(r.fields, 'Label'),
          kind: (str(r.fields, 'Kind') || 'artifact') as Evidence['kind'],
          value: str(r.fields, 'Value'),
          url: str(r.fields, 'URL') || null,
          verifiedOn: str(r.fields, 'Verified On'),
          projects: links(r.fields, 'Projects'),
        }),
      ),
      /**
       * Rebuilt from the Results table rather than parsed out of a JSON blob.
       *
       * Results rows carry their own requirement text, kind and category, so a row is readable on its
       * own in the base AND the Role can be reassembled without a second source of truth.
       */
      roles: roles.map((r): Role => {
        const roleKey = str(r.fields, 'Key');
        const mine = results
          .filter((row) => links(row.fields, 'Role').includes(roleKey))
          .sort((a, b) => str(a.fields, 'Key').localeCompare(str(b.fields, 'Key'), undefined, { numeric: true }));

        // A Results Key is `{candidateKey}-{roleKey}-req-N`; the requirement id is what is left once
        // both prefixes come off. The candidate prefix is stripped by the row's own Candidate link
        // rather than by position, so a slug containing a hyphen cannot shift the split.
        const requirementIdOf = (row: AirtableRecord): string => {
          const key = str(row.fields, 'Key');
          const candidateKey = links(row.fields, 'Candidate')[0] ?? '';
          let rest = key;
          if (candidateKey && rest.startsWith(`${candidateKey}-`)) rest = rest.slice(candidateKey.length + 1);
          if (rest.startsWith(`${roleKey}-`)) rest = rest.slice(roleKey.length + 1);
          return rest || key;
        };

        const requirements: Requirement[] = mine.map((row) => ({
          id: requirementIdOf(row),
          text: str(row.fields, 'Requirement'),
          kind: (str(row.fields, 'Kind') || 'required') as Requirement['kind'],
          category: (str(row.fields, 'Category') || 'process') as Requirement['category'],
        }));

        const roleResults: RequirementResult[] = mine.map((row, i) => ({
          requirementId: requirements[i]?.id ?? '',
          candidate: links(row.fields, 'Candidate')[0] ?? '',
          requirementText: str(row.fields, 'Requirement'),
          kind: (str(row.fields, 'Kind') || 'required') as Requirement['kind'],
          category: (str(row.fields, 'Category') || 'process') as Requirement['category'],
          status: (str(row.fields, 'Status') || 'gap') as RequirementResult['status'],
          shortfall: str(row.fields, 'Shortfall') || null,
          score: num(row.fields, 'Match Score') ?? 0,
          matchedTechnologies: links(row.fields, 'Technologies'),
          matchedCapabilities: links(row.fields, 'Capabilities'),
          matchedProjects: links(row.fields, 'Projects'),
          evidence: links(row.fields, 'Evidence'),
          rationale: str(row.fields, 'Rationale'),
          rationaleSource: (str(row.fields, 'Rationale Source') || 'template') as RequirementResult['rationaleSource'],
        }));

        return {
          id: roleKey,
          title: str(r.fields, 'Title'),
          company: str(r.fields, 'Company'),
          postedText: str(r.fields, 'Posted Text'),
          requirements,
          results: roleResults,
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

  async upsertCandidate(candidate: Candidate): Promise<void> {
    await this.upsertByKey(TABLES.candidates, candidate.id, {
      Name: candidate.name,
      Contact: candidate.contact,
      Source: candidate.source,
      'Ingested At': candidate.ingestedAt,
      Projects: this.refs(candidate.projects),
      Capabilities: this.refs(candidate.capabilities),
      Evidence: this.refs(candidate.evidence),
    });
  }

  async upsertProject(project: Project): Promise<void> {
    await this.upsertByKey(TABLES.projects, project.id, {
      Candidate: this.refs([project.candidate]),
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
      Candidate: this.refs([evidence.candidate]),
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
      Candidate: this.refs([capability.candidate]),
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

  /**
   * The Role row, then one Results row per requirement.
   *
   * The Role has to be written first: every Results row links back to it, and a link needs a record id
   * that does not exist until the Role is created. Same two-pass shape as everything else here.
   */
  async saveRole(role: Role): Promise<void> {
    await this.upsertByKey(TABLES.roles, role.id, {
      Title: role.title,
      Company: role.company,
      'Posted Text': role.postedText,
      Score: role.score,
      'Requirement Count': role.requirements.length,
      'Matched At': role.matchedAt,
      Model: role.model,
      Source: role.source,
      'Ingested At': role.ingestedAt,
    });

    for (const result of role.results) {
      // Results rows are candidate × role × requirement, so the candidate leads the Key.
      await this.upsertByKey(TABLES.results, `${result.candidate}-${role.id}-${result.requirementId}`, {
        Candidate: this.refs([result.candidate]),
        Requirement: result.requirementText,
        Kind: result.kind,
        Category: result.category,
        Status: result.status,
        Shortfall: result.shortfall ?? '',
        'Match Score': result.score,
        Rationale: result.rationale,
        'Rationale Source': result.rationaleSource,
        Role: this.refs([role.id]),
        Technologies: this.refs(result.matchedTechnologies),
        Capabilities: this.refs(result.matchedCapabilities),
        Projects: this.refs(result.matchedProjects),
        Evidence: this.refs(result.evidence),
      });
    }
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

/**
 * The orchestrator. Two entry points, and both of them are what the n8n workflows also run.
 *
 * `ingest`    Stage 2 — one messy blob becomes a Project row with links and receipts.
 * `matchRole` Stage 4 — a pasted posting becomes a scored, cited fit report.
 *
 * Nothing here decides anything. Extraction is in extract.ts, validation in validate.ts, retrieval in
 * match.ts, the verdict and the arithmetic in score.ts. This file wires them together and records what
 * happened at each step, because the intake screen shows that record live and a stage that fails
 * silently is the failure this project argues against.
 */

import { embed, type Vector } from '../openrouter/embeddings';
import type { LlmOptions } from '../openrouter/client';
import type {
  Capability,
  Evidence,
  Project,
  Requirement,
  RequirementResult,
  Role,
  Snapshot,
  Store,
  Technology,
} from '../store/types';
import { extract } from './extract';
import { parseRole } from './jd';
import { embedTextFor, match, topCandidates, vectorKey } from './match';
import { findDuplicate, linkCapabilities, linkTechnologies, mergeProject } from './link';
import { templateRationale, writeRationale, type RationaleContext } from './rationale';
import { coverage, gaps, resolve, type Coverage, type Gap, type Resolution } from './score';
import { slugify, toProject, toReviewStub, validateExtraction } from './validate';

export type StageState = 'ok' | 'skipped' | 'failed';

/** One line in the intake screen's live status list. */
export interface StageReport {
  stage: 'extract' | 'validate' | 'dedup' | 'link' | 'write';
  state: StageState;
  detail: string;
}

export interface IngestResult {
  ok: boolean;
  project: Project | null;
  stages: StageReport[];
  /** Rows this ingest brought into existence. Shown so new taxonomy entries are never a surprise. */
  createdTechnologies: Technology[];
  createdCapabilities: Capability[];
  createdEvidence: Evidence[];
  warnings: string[];
  /** Which extraction path ran, and which model if any. */
  via: 'model' | 'deterministic';
  model: string;
  /** The record as extracted, before it became a row. Powers the before/after view. */
  extracted: unknown;
  duplicateOf: string | null;
}

export interface PipelineOptions extends LlmOptions {
  /** Injectable so tests and the seed script get stable ids and timestamps. */
  now?: () => string;
}

function nowIso(opts: PipelineOptions): string {
  return opts.now ? opts.now() : new Date().toISOString();
}

function evidenceId(projectSlug: string, label: string, value: string): string {
  return `ev-${projectSlug}-${slugify(label)}-${slugify(value).slice(0, 24)}`.slice(0, 96);
}

export async function ingest(
  blob: string,
  sourceName: string,
  store: Store,
  opts: PipelineOptions,
): Promise<IngestResult> {
  const snapshot = await store.read();
  const ingestedAt = nowIso(opts);
  const stages: StageReport[] = [];

  const extraction = await extract(blob, { ...opts, snapshot, sourceName });
  stages.push({
    stage: 'extract',
    state: 'ok',
    detail:
      extraction.via === 'model'
        ? `${extraction.model}`
        : `deterministic reader (${extraction.note ?? 'no key'})`,
  });

  const validation = validateExtraction(extraction.raw);
  if (!validation.ok) {
    // The error branch. A rejection becomes a visible row, not a log line — see DESIGN.md §5.3.
    const stub = toReviewStub(sourceName, validation.problems, { source: sourceName, ingestedAt });
    await store.upsertProject(stub);
    stages.push({
      stage: 'validate',
      state: 'failed',
      detail: `${validation.problems.join('; ')}${validation.retryable ? ' (retryable)' : ''}`,
    });
    stages.push({ stage: 'dedup', state: 'skipped', detail: 'not reached' });
    stages.push({ stage: 'link', state: 'skipped', detail: 'not reached' });
    stages.push({ stage: 'write', state: 'ok', detail: 'parked in Needs Review' });

    return {
      ok: false,
      project: stub,
      stages,
      createdTechnologies: [],
      createdCapabilities: [],
      createdEvidence: [],
      warnings: validation.problems,
      via: extraction.via,
      model: extraction.model,
      extracted: extraction.raw,
      duplicateOf: null,
    };
  }

  stages.push({
    stage: 'validate',
    state: 'ok',
    detail: validation.warnings.length > 0 ? `${validation.warnings.length} field(s) repaired` : 'clean',
  });

  const verdict = findDuplicate(snapshot, validation.value.name);
  stages.push({
    stage: 'dedup',
    state: 'ok',
    detail: verdict.duplicate ? `updating "${verdict.duplicate.name}" (${verdict.reason})` : 'new project',
  });

  const techLink = linkTechnologies(snapshot, validation.value.stack);
  const capLink = linkCapabilities(snapshot, validation.value.capabilities);
  stages.push({
    stage: 'link',
    state: 'ok',
    detail:
      `${techLink.existing.length} technologies, ${capLink.existing.length} capabilities` +
      (techLink.created.length + capLink.created.length > 0
        ? ` (${techLink.created.length + capLink.created.length} new)`
        : ''),
  });

  let project = toProject(validation.value, { source: sourceName, ingestedAt });
  project.technologies = techLink.existing;
  project.capabilities = capLink.existing;

  // Written before the links that reference them. On Airtable a link to a record that does not exist
  // yet resolves to nothing and comes back as an empty field, with no error to notice.
  for (const t of techLink.created) await store.upsertTechnology(t);
  for (const c of capLink.created) await store.upsertCapability(c);

  const createdEvidence: Evidence[] = validation.value.evidence.map((e) => ({
    id: evidenceId(project.slug, e.label, e.value),
    label: e.label,
    kind: e.kind as Evidence['kind'],
    value: e.value,
    url: e.url,
    verifiedOn: ingestedAt.slice(0, 10),
    projects: [project.id],
  }));
  project.evidence = createdEvidence.map((e) => e.id);

  if (verdict.duplicate) {
    project = mergeProject(verdict.duplicate, project);
  }

  for (const e of createdEvidence) await store.upsertEvidence(e);
  await store.upsertProject(project);
  await store.linkTechnologies(project.id, project.technologies);
  await store.linkCapabilities(project.id, project.capabilities);

  stages.push({
    stage: 'write',
    state: 'ok',
    detail: `${verdict.duplicate ? 'updated' : 'created'} ${project.name} with ${createdEvidence.length} receipt(s)`,
  });

  return {
    ok: true,
    project,
    stages,
    createdTechnologies: techLink.created,
    createdCapabilities: capLink.created,
    createdEvidence,
    warnings: validation.warnings,
    via: extraction.via,
    model: extraction.model,
    extracted: extraction.raw,
    duplicateOf: verdict.duplicate?.id ?? null,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Stage 4 — matching.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

export interface MatchReport {
  role: Role;
  coverage: Coverage;
  gaps: Gap[];
  /** Which retrieval modes ran, so the report can say lexical-only when that is the truth. */
  retrieval: 'lexical' | 'hybrid';
  parseVia: 'model' | 'deterministic';
  rationaleVia: 'model' | 'template' | 'mixed';
  notes: string[];
}

/**
 * Embed the corpus and the requirements in one batch each.
 *
 * Two calls total for a whole report, not one per comparison — the vectors are compared in code, and the
 * cost of the embedding pass for this entire store is a fraction of a cent. Failure is not fatal:
 * retrieval drops to lexical and the report says so, which is a real degradation and an honest one.
 */
async function buildVectors(
  snapshot: Snapshot,
  requirements: readonly Requirement[],
  opts: PipelineOptions,
): Promise<{ entities: Map<string, Vector>; requirements: Map<string, Vector>; note: string | null }> {
  const entities = new Map<string, Vector>();
  const reqVectors = new Map<string, Vector>();

  if (!opts.apiKey) {
    return { entities, requirements: reqVectors, note: 'Retrieval is lexical only (no key set)' };
  }

  const keys: string[] = [];
  const texts: string[] = [];
  for (const tech of snapshot.technologies) {
    keys.push(vectorKey('technology', tech.id));
    texts.push(embedTextFor(tech));
  }
  for (const cap of snapshot.capabilities) {
    keys.push(vectorKey('capability', cap.id));
    texts.push(embedTextFor(cap));
  }

  const corpus = await embed(texts, opts);
  if (!corpus.ok) {
    return { entities, requirements: reqVectors, note: `embeddings unavailable (${corpus.detail}) , so retrieval is lexical only` };
  }
  keys.forEach((k, i) => entities.set(k, corpus.vectors[i] as Vector));

  const queries = await embed(requirements.map((r) => r.text), opts);
  if (!queries.ok) {
    return { entities: new Map(), requirements: reqVectors, note: `embeddings unavailable (${queries.detail}) , so retrieval is lexical only` };
  }
  requirements.forEach((r, i) => reqVectors.set(r.id, queries.vectors[i] as Vector));

  return { entities, requirements: reqVectors, note: null };
}

export async function matchRole(
  postedText: string,
  store: Store,
  opts: PipelineOptions,
): Promise<MatchReport> {
  const snapshot = await store.read();
  const matchedAt = nowIso(opts);
  const notes: string[] = [];

  const parsed = await parseRole(postedText, opts);
  if (parsed.note) notes.push(`Posting parsed without a model (${parsed.note})`);

  const vectors = await buildVectors(snapshot, parsed.role.requirements, opts);
  if (vectors.note) notes.push(vectors.note);
  const hybrid = vectors.entities.size > 0 && vectors.requirements.size > 0;

  const projectIndex = new Map(snapshot.projects.map((p) => [p.id, p]));
  const evidenceIndex = new Map(snapshot.evidence.map((e) => [e.id, e]));
  const techIndex = new Map(snapshot.technologies.map((t) => [t.id, t]));
  const capIndex = new Map(snapshot.capabilities.map((c) => [c.id, c]));

  const resolutions = new Map<string, Resolution>();
  const results: RequirementResult[] = [];
  let modelSentences = 0;
  let templateSentences = 0;

  for (const requirement of parsed.role.requirements) {
    const found = match({
      requirement,
      snapshot,
      ...(hybrid ? { vectors: vectors.entities } : {}),
      ...(hybrid ? { requirementVector: vectors.requirements.get(requirement.id) as Vector } : {}),
    });
    const cited = topCandidates(found);
    const resolution = resolve({ requirement, candidates: cited, best: found.best }, snapshot);
    resolutions.set(requirement.id, resolution);

    const context: RationaleContext = {
      requirement,
      status: resolution.status,
      technologies: resolution.matchedTechnologies.map((id) => techIndex.get(id)?.name ?? id),
      capabilities: resolution.matchedCapabilities.map((id) => capIndex.get(id)?.name ?? id),
      projects: resolution.matchedProjects.map((id) => projectIndex.get(id)).filter(Boolean) as Project[],
      evidence: resolution.evidence.map((id) => evidenceIndex.get(id)).filter(Boolean) as Evidence[],
      shortfall: resolution.shortfall,
    };

    // No key means no call at all — the template is the answer, not a fallback after a wasted request.
    const rationale = opts.apiKey
      ? await writeRationale(context, opts)
      : { text: templateRationale(context), source: 'template' as const };

    if (rationale.source === 'model') modelSentences += 1;
    else templateSentences += 1;

    results.push({
      requirementId: requirement.id,
      status: resolution.status,
      score: Number(found.best.toFixed(3)),
      matchedTechnologies: resolution.matchedTechnologies,
      matchedCapabilities: resolution.matchedCapabilities,
      matchedProjects: resolution.matchedProjects,
      evidence: resolution.evidence,
      rationale: rationale.text,
      rationaleSource: rationale.source,
    });
  }

  const cover = coverage(parsed.role.requirements, results);
  const gapList = gaps(parsed.role.requirements, results, resolutions, snapshot);

  const role: Role = {
    id: `role-${slugify(parsed.role.company || parsed.role.title)}-${matchedAt.slice(0, 10)}`,
    title: parsed.role.title,
    company: parsed.role.company,
    postedText,
    requirements: parsed.role.requirements,
    results,
    score: cover.score,
    matchedAt,
    model: parsed.via === 'model' ? parsed.model : 'none',
    source: 'intake',
    ingestedAt: matchedAt,
  };

  await store.saveRole(role);

  return {
    role,
    coverage: cover,
    gaps: gapList,
    retrieval: hybrid ? 'hybrid' : 'lexical',
    parseVia: parsed.via,
    rationaleVia:
      modelSentences > 0 && templateSentences > 0 ? 'mixed' : modelSentences > 0 ? 'model' : 'template',
    notes,
  };
}

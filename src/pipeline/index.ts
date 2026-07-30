/**
 * The orchestrator. Three entry points, and all of them are what the n8n workflows also run or will.
 *
 * `ingest`       Stage 2 — one messy blob becomes a Project row with links and receipts.
 * `ingestResume` v3 intake — a pasted resume becomes a Candidate plus receiptless claims. An explicit
 *                entry point: the caller declares the text is a resume, nothing here sniffs content.
 * `matchRole`    Stage 4 — a pasted posting becomes a scored, cited fit report for one candidate.
 *
 * Nothing here decides anything. Extraction is in extract.ts, resume parsing in resume.ts, validation in
 * validate.ts, retrieval in match.ts, the verdict and the arithmetic in score.ts. This file wires them
 * together and records what happened at each step, because the intake screen shows that record live and
 * a stage that fails silently is the failure this project argues against.
 */

import { embed, type Vector } from '../openrouter/embeddings';
import type { LlmOptions } from '../openrouter/client';
import {
  DEFAULT_CANDIDATE_ID,
  type Candidate,
  type Capability,
  type Evidence,
  type Project,
  type Requirement,
  type RequirementResult,
  type Role,
  type Snapshot,
  type Store,
  type Technology,
} from '../store/types';
import { extract } from './extract';
import { parseRole } from './jd';
import { embedTextFor, match, topCandidates, vectorKey } from './match';
import { findDuplicate, linkCapabilities, linkTechnologies, mergeProject } from './link';
import { templateRationale, writeRationale, type RationaleContext } from './rationale';
import { parseResume } from './resume';
import { coverage, gaps, resolve, type Coverage, type Gap, type Resolution } from './score';
import { containsTerm, normalize } from './text';
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

export interface IngestOptions extends PipelineOptions {
  /** Whose record this artifact supports. Defaults to the seed candidate, keeping every existing caller intact. */
  candidateId?: string;
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
  opts: IngestOptions,
): Promise<IngestResult> {
  const full = await store.read();
  const candidateId = opts.candidateId ?? DEFAULT_CANDIDATE_ID;

  // Scope before anything reads the snapshot, the same guarantee matchRole makes: dedup, capability
  // linking and extraction context only ever see this candidate's rows, so a supporting document can
  // never merge into another person's project or attach receipts to another person's claim.
  // Technologies stay global — React is React for everyone.
  const snapshot: Snapshot = {
    ...full,
    projects: full.projects.filter((p) => p.candidate === candidateId),
    capabilities: full.capabilities.filter((c) => c.candidate === candidateId),
    evidence: full.evidence.filter((e) => e.candidate === candidateId),
  };

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
    const stub = { ...toReviewStub(sourceName, validation.problems, { source: sourceName, ingestedAt }), candidate: candidateId };
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
  const capLink = linkCapabilities(snapshot, validation.value.capabilities, candidateId);
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
  project.candidate = candidateId;
  // Project ids for the seed candidate stay plain slugs (the seed and every test know them); any other
  // candidate's ids are candidate-scoped — the convention ingestResume set, so a supporting artifact
  // dedups into its resume stub and two people's "Tendril" rows never overwrite each other.
  if (candidateId !== DEFAULT_CANDIDATE_ID) project.id = `${candidateId}-${project.slug}`;
  project.technologies = techLink.existing;
  project.capabilities = capLink.existing;

  // Written before the links that reference them. On Airtable a link to a record that does not exist
  // yet resolves to nothing and comes back as an empty field, with no error to notice.
  for (const t of techLink.created) await store.upsertTechnology(t);
  for (const c of capLink.created) await store.upsertCapability(c);

  const evidenceScope =
    candidateId === DEFAULT_CANDIDATE_ID
      ? project.slug
      : `${candidateId.replace(/^candidate-/, '')}-${project.slug}`;
  const createdEvidence: Evidence[] = validation.value.evidence.map((e) => ({
    id: evidenceId(evidenceScope, e.label, e.value),
    candidate: candidateId,
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

  // The promotion path (DESIGN.md §v3.3): this artifact's receipts attach to the claims it matched.
  // A capability that arrived from a resume with an empty evidence array stops being unverified the
  // moment a supporting document making the same claim lands with something checkable in it.
  //
  // Only claims that existed BEFORE this ingest are promoted. A capability this document itself
  // invented gets nothing — its own source vouching for its own assertion is not verification, and
  // "created by ingest starts unverified" is the point of the evidence gate.
  if (createdEvidence.length > 0) {
    const evidenceIds = createdEvidence.map((e) => e.id);
    for (const capId of capLink.existing) {
      const cap = snapshot.capabilities.find((c) => c.id === capId);
      if (!cap) continue; // created this run — stays unverified.
      await store.upsertCapability({
        ...cap,
        projects: [...new Set([...cap.projects, project.id])],
        evidence: [...new Set([...cap.evidence, ...evidenceIds])],
      });
    }
  }

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
 * Resume intake — a Candidate plus receiptless claims.  (DESIGN.md §v3.3)
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

export interface ResumeIngestResult {
  ok: boolean;
  candidateId: string;
  name: string;
  contact: string;
  stages: StageReport[];
  /**
   * Experience statements written as Capability rows — every one tier `stretch` with an empty evidence
   * array. That is not a limitation, it is the design: unverified is the natural state of a resume
   * claim, and the evidence gate already caps a receiptless claim at partial. Supporting documents
   * ingest later and promote them.
   */
  createdCapabilities: Capability[];
  /** Position and project stubs from the experience sections, owned by this candidate. */
  createdProjects: Project[];
  /** Skill strings that resolved into taxonomy rows that already existed. */
  resolvedTechnologies: string[];
  /** Skill strings the taxonomy did not have, written as new rows — same path ingest uses. */
  createdTechnologies: Technology[];
  /** Which parsing path ran, and which model if any. Never silent: a fallback carries its note. */
  via: 'model' | 'deterministic';
  model: string;
  note: string | null;
}

/**
 * One pasted resume becomes a Candidate row plus its claim sheet.
 *
 * An explicit entry point on purpose. Nothing sniffs a blob to guess whether it is a resume — the caller
 * declares it, the same way the caller declares a posting by calling `matchRole`. Guessing would turn a
 * README with a name at the top into a person.
 */
export async function ingestResume(
  text: string,
  sourceName: string,
  store: Store,
  opts: PipelineOptions,
): Promise<ResumeIngestResult> {
  const snapshot = await store.read();
  const ingestedAt = nowIso(opts);
  const stages: StageReport[] = [];

  const parsed = await parseResume(text, opts);
  const resume = parsed.resume;
  stages.push({
    stage: 'extract',
    state: 'ok',
    detail:
      parsed.via === 'model'
        ? `${parsed.model}`
        : `deterministic reader (${parsed.note ?? 'structured resume'})`,
  });

  if (!resume.name) {
    // No name, no candidate. A row keyed to an empty slug would collide with every other nameless
    // resume, which is worse than stopping loudly here.
    stages.push({ stage: 'validate', state: 'failed', detail: 'no name could be read from the resume' });
    stages.push({ stage: 'dedup', state: 'skipped', detail: 'not reached' });
    stages.push({ stage: 'link', state: 'skipped', detail: 'not reached' });
    stages.push({ stage: 'write', state: 'skipped', detail: 'nothing written' });
    return {
      ok: false,
      candidateId: '',
      name: '',
      contact: resume.contact,
      stages,
      createdCapabilities: [],
      createdProjects: [],
      resolvedTechnologies: [],
      createdTechnologies: [],
      via: parsed.via,
      model: parsed.model,
      note: parsed.note,
    };
  }

  const candidateKey = slugify(resume.name);
  const candidateId = `candidate-${candidateKey}`;
  stages.push({
    stage: 'validate',
    state: 'ok',
    detail: `${resume.skills.length} skills, ${resume.claims.length} claims, ${resume.projects.length} positions`,
  });

  const existing = snapshot.candidates.find((c) => c.id === candidateId);
  stages.push({
    stage: 'dedup',
    state: 'ok',
    detail: existing ? `updating "${existing.name}"` : 'new candidate',
  });

  // Skills resolve against the global taxonomy through the same alias machinery every ingest uses;
  // whatever the taxonomy does not have becomes a new row rather than being dropped.
  const techLink = linkTechnologies(snapshot, resume.skills);
  const createdTechIds = new Set(techLink.created.map((t) => t.id));
  const resolvedTechnologies = techLink.existing.filter((id) => !createdTechIds.has(id));

  // Written before anything that links to them — on Airtable a link to a record that does not exist
  // yet resolves to nothing and comes back as an empty field, with no error to notice.
  for (const t of techLink.created) await store.upsertTechnology(t);

  // Experience statements become Capabilities: tier stretch, no evidence, stamped with this candidate.
  // Ids are scoped by candidate so two people making the same claim never share a row.
  const ownCapabilities = snapshot.capabilities.filter((c) => c.candidate === candidateId);
  const createdCapabilities: Capability[] = [];
  for (const claim of resume.claims) {
    const id = `cap-${candidateKey}-${slugify(claim).slice(0, 64)}`.replace(/-+$/, '');
    if (ownCapabilities.some((c) => c.id === id) || createdCapabilities.some((c) => c.id === id)) continue;
    createdCapabilities.push({
      id,
      candidate: candidateId,
      name: claim,
      statement: claim,
      tier: 'stretch',
      matchTerms: [claim.toLowerCase()],
      projects: [],
      evidence: [],
    });
  }
  for (const c of createdCapabilities) await store.upsertCapability(c);

  // Position stubs. Ids are candidate-scoped for the same reason capability ids are; slugs stay plain so
  // a supporting artifact ingested later dedups into its stub and starts promoting the claims.
  const technologyPool = [...snapshot.technologies, ...techLink.created];
  const ownProjects = new Set(snapshot.projects.filter((p) => p.candidate === candidateId).map((p) => p.id));
  const createdProjects: Project[] = [];
  for (const stub of resume.projects) {
    const id = `${candidateId}-${slugify(stub.name)}`;
    if (ownProjects.has(id) || createdProjects.some((p) => p.id === id)) continue;
    createdProjects.push({
      id,
      candidate: candidateId,
      name: stub.name,
      slug: slugify(stub.name),
      role: stub.role,
      started: '',
      ended: null,
      status: 'in-development',
      summary: stub.summary || `Claimed on ${sourceName}; no supporting artifact ingested yet.`,
      metrics: {},
      technologies: [],
      capabilities: [],
      evidence: [],
      reviewStatus: 'ok',
      reviewReason: null,
      source: sourceName,
      ingestedAt,
    });
  }

  let linkedToStubs = 0;
  for (const project of createdProjects) {
    await store.upsertProject(project);
    // Technologies the stub's own words name, wired both directions by the store — the existing pattern.
    const haystack = normalize(`${project.name} ${project.role} ${project.summary}`);
    const stubTech = technologyPool
      .filter((t) => [t.name, ...t.aliases].some((alias) => containsTerm(haystack, alias)))
      .map((t) => t.id);
    if (stubTech.length > 0) {
      await store.linkTechnologies(project.id, stubTech);
      linkedToStubs += stubTech.length;
    }
  }

  stages.push({
    stage: 'link',
    state: 'ok',
    detail:
      `${resolvedTechnologies.length} technologies resolved` +
      (techLink.created.length > 0 ? ` (${techLink.created.length} new)` : '') +
      `, ${linkedToStubs} linked to positions`,
  });

  // The candidate row last, carrying its side of every link just written — the same mirror the seed
  // maintains. Contact and source update on re-ingest; earlier rows the candidate owns are kept.
  const candidate: Candidate = {
    id: candidateId,
    name: resume.name,
    contact: resume.contact,
    source: sourceName,
    ingestedAt,
    projects: [...new Set([...(existing?.projects ?? []), ...createdProjects.map((p) => p.id)])],
    capabilities: [...new Set([...(existing?.capabilities ?? []), ...createdCapabilities.map((c) => c.id)])],
    evidence: existing?.evidence ?? [],
  };
  await store.upsertCandidate(candidate);

  stages.push({
    stage: 'write',
    state: 'ok',
    detail: `${existing ? 'updated' : 'created'} ${resume.name} with ${createdCapabilities.length} unverified claim(s)`,
  });

  return {
    ok: true,
    candidateId,
    name: resume.name,
    contact: resume.contact,
    stages,
    createdCapabilities,
    createdProjects,
    resolvedTechnologies,
    createdTechnologies: techLink.created,
    via: parsed.via,
    model: parsed.model,
    note: parsed.note,
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

export interface MatchOptions extends PipelineOptions {
  /** Whose record to score. Defaults to the seed candidate, which keeps every existing caller intact. */
  candidateId?: string;
}

export async function matchRole(
  postedText: string,
  store: Store,
  opts: MatchOptions,
): Promise<MatchReport> {
  const full = await store.read();
  const candidateId = opts.candidateId ?? DEFAULT_CANDIDATE_ID;

  /**
   * Scope before matching, not after. Projects, capabilities and evidence are owned per-candidate, so
   * only this candidate's rows go on the table; technologies and roles stay global — React is React for
   * everyone, and a posting is scoreable by anyone. Filtering here means the matcher, the resolver and
   * the gaps writer structurally cannot cite another person's record: the rows are not in the snapshot
   * they see, which is a stronger guarantee than remembering to check ownership at every read.
   */
  const snapshot: Snapshot = {
    ...full,
    projects: full.projects.filter((p) => p.candidate === candidateId),
    capabilities: full.capabilities.filter((c) => c.candidate === candidateId),
    evidence: full.evidence.filter((e) => e.candidate === candidateId),
  };

  const matchedAt = nowIso(opts);
  const notes: string[] = [];

  const parsed = await parseRole(postedText, opts);
  // The note is already a whole sentence in the reviewer's terms. It used to be wrapped in "Posting
  // parsed without a model (…)", written when the model was the primary path — since the flip to
  // deterministic-first that wrapper reported the design as a fault, on every run of the keyless
  // hosted demo. See PASS_NOTES in jd.ts.
  if (parsed.note) notes.push(parsed.note);

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
      candidate: candidateId,
      requirementText: requirement.text,
      kind: requirement.kind,
      category: requirement.category,
      status: resolution.status,
      shortfall: resolution.shortfall,
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

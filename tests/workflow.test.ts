/**
 * The committed n8n workflows.
 *
 * Version-controlled workflows are only worth anything if they are correct and current, so this checks
 * both: that the committed JSON still matches what the source generates, and that what it generates
 * would actually run. A Code node with a syntax error looks completely fine in a diff and fails the
 * moment someone imports the canvas.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_CHAIN_MODELS } from '@/openrouter/protocol';
import { THRESHOLD_PARTIAL, THRESHOLD_PROVEN } from '@/pipeline/score';
import { DEFAULT_CANDIDATE_ID } from '@/store/types';
import { WORKFLOWS } from '../n8n/build';

interface Node {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  /** [x, y]. n8n orders sibling branches by y under executionOrder v1, so this is behaviour. */
  position: [number, number];
  /** Run once regardless of input item count. Load-bearing on every Airtable read. */
  executeOnce?: boolean;
  /** Without this a webhook node has no production URL. */
  webhookId?: string;
  parameters: Record<string, unknown>;
}

interface Workflow {
  name: string;
  nodes: Node[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

function committed(file: string): Workflow {
  return JSON.parse(readFileSync(join(process.cwd(), 'n8n', file), 'utf8')) as Workflow;
}

const extract = committed('extract-project.json');
const matchRole = committed('match-role.json');
const both = [
  { file: 'extract-project.json', wf: extract },
  { file: 'match-role.json', wf: matchRole },
];

describe('the committed JSON matches the source', () => {
  it.each(WORKFLOWS.map((w) => w.file))('%s has not drifted', (file) => {
    // The same check `pnpm n8n:build --check` runs, so drift fails the suite and not only the build.
    // CRLF-normalised: on Windows a checkout rewrites the committed file's line endings, and a drift
    // check that fails on \r\n reports phantom drift on every fresh clone. .gitattributes pins the
    // files to LF; the normalisation here makes the check hold even where that hasn't applied yet.
    const generated = `${JSON.stringify(WORKFLOWS.find((w) => w.file === file)?.content, null, 2)}\n`;
    const committed = readFileSync(join(process.cwd(), 'n8n', file), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(generated);
  });
});

describe.each(both)('$file', ({ wf }) => {
  it('is importable: every node has an id, a name, a type and a version', () => {
    for (const n of wf.nodes) {
      expect(n.id, n.name).toMatch(/^[0-9a-f-]{8,}/);
      expect(n.type, n.name).toMatch(/^n8n-nodes-base\./);
      expect(typeof n.typeVersion, n.name).toBe('number');
    }
  });

  it('has unique node names, which is how connections are keyed', () => {
    const names = wf.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has no connection pointing at a node that does not exist', () => {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, conn] of Object.entries(wf.connections)) {
      expect(names, `source "${from}"`).toContain(from);
      for (const output of conn.main) {
        for (const target of output) {
          expect(names, `target "${target.node}" from "${from}"`).toContain(target.node);
        }
      }
    }
  });

  it('has every Code node parse as valid JavaScript', () => {
    // A syntax error here reads perfectly in a diff and blows up on import.
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      const source = n.parameters['jsCode'] as string;
      expect(typeof source, n.name).toBe('string');
      expect(() => new Function(source), `${n.name} does not parse`).not.toThrow();
    }
  });

  it('explains itself on the canvas with sticky notes', () => {
    // The canvas is the first screenshot a reviewer sees, and they read it before anything else.
    const notes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(String(note.parameters['content']).length).toBeGreaterThan(120);
    }
  });

  it('never hardcodes a credential — keys come from the environment', () => {
    const serialized = JSON.stringify(wf);
    expect(serialized).not.toMatch(/sk-or-v1-/);
    expect(serialized).not.toMatch(/\bpat[A-Za-z0-9]{14,}/);
    expect(serialized).not.toMatch(/\bapp[A-Za-z0-9]{14,}/);
  });
});

describe('OpenRouter calls inside the workflows', () => {
  const httpNodes = [...extract.nodes, ...matchRole.nodes].filter(
    (n) => n.type === 'n8n-nodes-base.httpRequest',
  );

  it('exists in both workflows', () => {
    expect(httpNodes.length).toBeGreaterThanOrEqual(3);
  });

  it('never sends more than three models, in every workflow', () => {
    // Trap 2, carried into the workflows. OpenRouter 400s on a longer array and a 400 does not fall
    // through, so a fourth model silently kills the call rather than adding resilience.
    //
    // The chain is not always in the HTTP node. `extract-project.json` builds its body in a Code node
    // and passes `={{ JSON.stringify($json.request) }}` to the request, so an earlier version of this
    // test found no literal `models` array there, skipped the node, and asserted nothing at all about
    // the extract workflow. A guard test that silently checks nothing is worse than no test: it reads
    // green while the thing it names goes unchecked.
    const sources = [
      ...extract.nodes.map((n) => ({ file: 'extract-project.json', n })),
      ...matchRole.nodes.map((n) => ({ file: 'match-role.json', n })),
    ]
      .filter(({ n }) => n.type === 'n8n-nodes-base.httpRequest' || n.type === 'n8n-nodes-base.code')
      .map(({ file, n }) => ({
        file,
        name: n.name,
        text: String(n.parameters['jsonBody'] ?? n.parameters['jsCode'] ?? ''),
      }));

    const checkedPerFile = new Map<string, number>();

    for (const source of sources) {
      for (const [, literal] of source.text.matchAll(/(?:"models"|MODELS\s*=)\s*:?\s*(\[[^\]]*\])/g)) {
        const models = JSON.parse(literal as string) as string[];
        expect(models.length, `${source.file} :: ${source.name}`).toBeLessThanOrEqual(MAX_CHAIN_MODELS);
        expect(models.length, `${source.file} :: ${source.name}`).toBeGreaterThan(0);
        checkedPerFile.set(source.file, (checkedPerFile.get(source.file) ?? 0) + 1);
      }
    }

    // The assertion that makes the rest of them mean something.
    expect(checkedPerFile.get('extract-project.json') ?? 0).toBeGreaterThan(0);
    expect(checkedPerFile.get('match-role.json') ?? 0).toBeGreaterThan(0);
  });

  it('enforces the cap inside the workflow at runtime, not only at generation time', () => {
    // The generated JSON is correct today. This asserts the Code node would also refuse a chain that
    // someone lengthened by hand after import, where no test of ours would ever run again.
    const builder = extract.nodes.find((n) => n.name === 'Build extraction request');
    const source = String(builder?.parameters['jsCode']);
    expect(source).toContain(`MAX_CHAIN_MODELS = ${MAX_CHAIN_MODELS}`);
    expect(source).toMatch(/if \(MODELS\.length > MAX_CHAIN_MODELS\)/);
    expect(source).toMatch(/throw new Error/);
  });

  it('sends require_parameters on every call', () => {
    // Trap 1. Without it OpenRouter may route to a provider that ignores response_format and answers
    // in prose with a 200 — no error, no retry, just unstructured text where a schema was promised.
    for (const n of httpNodes) {
      const body = String(n.parameters['jsonBody']);
      if (!body.includes('response_format')) continue;
      expect(body, n.name).toContain('require_parameters');
    }
  });

  it('asks for a strict json_schema, not a bare json mode', () => {
    for (const n of httpNodes) {
      const body = String(n.parameters['jsonBody']);
      if (!body.includes('response_format')) continue;
      expect(body, n.name).toContain('"strict":true');
    }
  });
});

/**
 * Data flow into the Airtable writes.
 *
 * This is the bug class that made it all the way to a committed deliverable: every node type, version and
 * parameter shape was verified against real published workflows, the JSON imported cleanly, and the write
 * still did nothing. `autoMapInputData` maps TOP-LEVEL json keys onto Airtable field names, and the
 * upstream Code node was returning `{ valid, sourceName, project: {...}, ... }` with every real field one
 * level down. Nothing matched, nothing was written, and nothing errored.
 *
 * Structural validity is not correctness. These assert the shape of the data, not the shape of the nodes.
 */
describe('Airtable writes receive the shape they auto-map', () => {
  const INTERNAL_KEYS = ['valid', 'sourceName', 'warnings', 'project', 'duplicateOf', 'action', 'stack'];

  function upstreamOf(wf: Workflow, target: string): Node | undefined {
    const from = Object.entries(wf.connections).find(([, conn]) =>
      conn.main.some((output) => output.some((t) => t.node === target)),
    )?.[0];
    return wf.nodes.find((n) => n.name === from);
  }

  it.each([
    ['extract-project.json', 'Write project'],
    ['extract-project.json', 'Write evidence rows'],
    ['extract-project.json', 'Write Needs Review'],
  ])('%s :: %s is fed a flat record', (file, target) => {
    const wf = file === 'extract-project.json' ? extract : matchRole;
    const node = wf.nodes.find((n) => n.name === target);
    expect(String((node?.parameters['columns'] as Record<string, unknown>)?.['mappingMode'])).toBe(
      'autoMapInputData',
    );

    const upstream = upstreamOf(wf, target);
    expect(upstream, `nothing feeds ${target}`).toBeDefined();
    if (upstream?.type !== 'n8n-nodes-base.code') return; // an Airtable-to-Airtable hop needs no check

    const returned = String(upstream.parameters['jsCode']).split('return').slice(-1)[0] ?? '';

    // The row's own Key must be emitted, because matchingColumns is ["Key"].
    expect(returned, `${upstream.name} does not emit a top-level Key`).toMatch(/\bKey:/);

    // And none of the pipeline's internal bookkeeping may sit at the top level, where auto-mapping
    // would try to turn it into an Airtable column.
    for (const internal of INTERNAL_KEYS) {
      expect(returned, `${upstream.name} leaks internal key "${internal}" into the row`).not.toMatch(
        new RegExp(`\\n\\s*${internal}:`),
      );
    }
  });

  it('fans evidence out to one item per record', () => {
    // n8n writes one Airtable record per ITEM. A single item carrying an `evidence` array wrote exactly
    // one row however many receipts the extraction found.
    const fan = extract.nodes.find((n) => n.name === 'Fan out evidence');
    expect(fan, 'there is no fan-out node before the evidence write').toBeDefined();

    const source = String(fan?.parameters['jsCode']);
    expect(source).toMatch(/\.map\(/);
    expect(source).toMatch(/evidence \|\| \[\]/);

    expect(extract.connections['Fan out evidence']?.main[0]?.[0]?.node).toBe('Write evidence rows');
  });

  it('references only nodes that exist in $() lookups', () => {
    // $('Some Node') against a renamed or missing node fails at runtime, long after import.
    for (const wf of [extract, matchRole]) {
      const names = new Set(wf.nodes.map((n) => n.name));
      for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
        const source = String(node.parameters['jsCode']);
        for (const [, referenced] of source.matchAll(/\$\('([^']+)'\)/g)) {
          expect(names, `${node.name} references a missing node "${referenced}"`).toContain(referenced);
        }
      }
    }
  });
});

describe('the extract workflow', () => {
  it('branches on validity and routes failures to Needs Review', () => {
    // The error branch is the design decision worth defending: nothing is dropped, so the output cannot
    // look complete while quietly missing a record.
    //
    // By name, not by type: the token gate added a second IF node ahead of this one, and the first
    // IF in the array is now the auth check, whose false branch legitimately ends at Unauthorized.
    const gate = extract.nodes.find((n) => n.name === 'Usable record?');
    expect(gate).toBeDefined();
    expect(gate?.type).toBe('n8n-nodes-base.if');
    if (!gate) return;

    const outputs = extract.connections[gate.name]?.main ?? [];
    expect(outputs.length, 'the IF node must have both a true and a false branch').toBe(2);

    const falseBranch = outputs[1]?.[0]?.node;
    expect(falseBranch).toBeDefined();

    // Walk the false branch and confirm it ends at a write, not at nothing.
    const visited: string[] = [];
    let cursor: string | undefined = falseBranch;
    while (cursor && !visited.includes(cursor)) {
      visited.push(cursor);
      cursor = extract.connections[cursor]?.main?.[0]?.[0]?.node;
    }
    expect(visited.join(' → ')).toMatch(/Needs Review/);
  });

  it('carries the validator ceilings that stop an inflated metric being published', () => {
    const validator = extract.nodes.find((n) => n.name === 'Validate extraction');
    const source = String(validator?.parameters['jsCode']);
    expect(source).toContain('METRIC_CEILING');
    expect(source).toContain('exceeds the plausible ceiling');
    expect(source).toMatch(/retryable/);
  });

  it('distinguishes a retryable failure from one that is not worth asking again', () => {
    const validator = extract.nodes.find((n) => n.name === 'Validate extraction');
    const source = String(validator?.parameters['jsCode']);
    expect(source).toMatch(/retryable: false/);
    expect(source).toMatch(/retryable: true/);
  });
});

describe('the match workflow', () => {
  const scorer = matchRole.nodes.find((n) => n.name === 'Retrieve and score');
  const source = String(scorer?.parameters['jsCode']);

  it('scores with the same thresholds the application uses', () => {
    expect(source).toContain(`THRESHOLD_PROVEN = ${THRESHOLD_PROVEN}`);
    expect(source).toContain(`THRESHOLD_PARTIAL = ${THRESHOLD_PARTIAL}`);
  });

  it('computes the verdict and the coverage number without calling a model', () => {
    // The architectural claim: by the time a model is asked for prose, the outcome is already fixed.
    expect(source).not.toMatch(/openrouter\.ai|chat\/completions/);
    expect(source).toContain('WEIGHT');
    expect(source).toContain('Math.round((earned / possible) * 100)');
  });

  it('carries the evidence gate', () => {
    expect(source).toContain('nothing verifiable is linked to it');
    expect(source).toContain('recorded as a stretch');
  });

  it('excludes a project parked in Needs Review from counting as evidence', () => {
    expect(source).toContain("reviewStatus === 'needs-review'");
  });

  it('guards generated prose against numbers that are not in the records', () => {
    const guard = matchRole.nodes.find((n) => n.name === 'Guard rationales');
    const guardSource = String(guard?.parameters['jsCode']);
    expect(guardSource).toContain('numbersIn');
    expect(guardSource).toMatch(/rationaleSource: usable \? 'model' : 'template'/);
  });

  it('scores before it writes prose, not after', () => {
    // Walk the graph rather than pinning the immediate next node. The claim is that the verdict is
    // already fixed before any prose model runs, and that survives inserting a node between them —
    // which is exactly what the rationale fan-out did. Pinning the edge made this fail on a change it
    // has no opinion about.
    const hops = (from: string, to: string, seen = new Set<string>()): boolean => {
      if (from === to) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (matchRole.connections[from]?.main.flat() ?? []).some((c) => hops(c!.node, to, seen));
    };
    expect(hops('Retrieve and score', 'Write rationales')).toBe(true);
    expect(hops('Write rationales', 'Retrieve and score')).toBe(false);
  });

  it('calls the rationale model once per requirement, not once per posting', () => {
    // The regression this pins: a single call carrying every requirement, under a system prompt that
    // says "you write one sentence" and a 160-token ceiling. The guard then indexed one reply per
    // requirement, so requirement 1 got a sentence composed from all of them and the rest silently
    // fell back to the template.
    const fan = matchRole.nodes.find((n) => n.name === 'Fan out rationales');
    expect(fan, 'the fan-out node is missing').toBeDefined();
    // Emitting an array of items is what makes n8n run the HTTP node once per requirement.
    expect(String(fan?.parameters['jsCode'])).toMatch(/return scored\.results\.map\(/);

    // The request is assembled in the Code node, because a jsonBody that does not start with `=` is a
    // fixed string whose nested {{ }} n8n never resolves. Asserting `toContain('$json.context')` was
    // the original check here and it passed on the literal, unresolved string — a green test sitting
    // directly on top of the defect.
    expect(String(fan?.parameters['jsCode'])).toMatch(/request:\s*\{/);

    const http = matchRole.nodes.find((n) => n.name === 'Write rationales');
    const body = String(http?.parameters['jsonBody']);
    expect(body).toBe('={{ JSON.stringify($json.request) }}');
  });
});

/**
 * An n8n parameter is an EXPRESSION only when it starts with `=`.
 *
 * `isExpression` in n8n's own source is `expr.charAt(0) === '='`, and `resolveSimpleParameterValue`
 * returns any other string untouched — so `{{ }}` nested inside a fixed value is sent verbatim. Both
 * match-lane HTTP nodes shipped that way: OpenRouter received the literal `={{ $json.body.text }}` as
 * the job posting and the model scored a real applicant against it. Nothing caught it, because import,
 * round-trip and drift checks all pass on a workflow that cannot run.
 *
 * `jsCode` is excluded: a Code node's body is JavaScript, which n8n does not template.
 */
describe('every templated parameter is actually an expression', () => {
  it.each([
    ['extract-project.json', extract],
    ['match-role.json', matchRole],
  ])('%s resolves every {{ }} it contains', (_file, wf) => {
    const literals: string[] = [];
    for (const node of wf.nodes) {
      for (const [key, value] of Object.entries(node.parameters ?? {})) {
        if (key === 'jsCode') continue;
        if (typeof value === 'string' && value.includes('{{') && !value.startsWith('=')) {
          literals.push(`${node.name}.${key}`);
        }
      }
    }
    expect(literals, 'these parameters send {{ }} as literal text').toEqual([]);
  });
});

/**
 * The webhook auth gate (docs/DESIGN.md §v3.7).
 *
 * Same anti-silent-skip shape as the models-array test above: each workflow must CONTRIBUTE guard
 * assertions, because a filter that matches no node reads green while the thing it names goes
 * unchecked. A workflow with no guard node is a failure here, not a skip.
 */
describe('the webhook auth guard', () => {
  it('checks the shared token in a Code node in both workflows, fail closed', () => {
    const checkedPerFile = new Map<string, number>();

    for (const { file, wf } of both) {
      for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
        const source = String(n.parameters['jsCode']);
        if (!source.includes('x-pow-app-token')) continue;
        expect(source, `${file} :: ${n.name}`).toContain('POW_APP_TOKEN');
        // Fail closed: an unset token on the n8n side must reject with the reason named, never
        // fall through open.
        expect(source, `${file} :: ${n.name}`).toContain('POW_APP_TOKEN not configured');
        checkedPerFile.set(file, (checkedPerFile.get(file) ?? 0) + 1);
      }
    }

    // The assertion that makes the rest of them mean something.
    expect(checkedPerFile.get('extract-project.json') ?? 0).toBeGreaterThan(0);
    expect(checkedPerFile.get('match-role.json') ?? 0).toBeGreaterThan(0);
  });

  it('sits immediately after the webhook trigger, before any model call or write', () => {
    for (const { file, wf } of both) {
      const trigger = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
      expect(trigger, `${file} has no webhook trigger`).toBeDefined();
      if (!trigger) continue;
      expect(wf.connections[trigger.name]?.main[0]?.[0]?.node, file).toBe('Verify app token');
    }
  });

  it('routes a rejected token to a 401 respond node in both workflows', () => {
    for (const { file, wf } of both) {
      const unauthorized = wf.nodes.find((n) => n.name === 'Unauthorized');
      expect(unauthorized, `${file} has no Unauthorized respond node`).toBeDefined();
      expect(unauthorized?.type, file).toBe('n8n-nodes-base.respondToWebhook');
      expect((unauthorized?.parameters['options'] as Record<string, unknown>)?.['responseCode'], file).toBe(401);
      expect(String(unauthorized?.parameters['responseBody']), file).toContain('unauthorized');
      expect(String(unauthorized?.parameters['responseBody']), file).toContain('authDetail');
    }
  });
});

/**
 * Candidate resolution (docs/DESIGN.md §v3.2).
 *
 * The workflows write the same shapes as src/store/airtable.ts: every created Projects, Evidence and
 * Results row carries its Candidate link, and Results keys are candidate × role × requirement. Same
 * anti-silent-skip shape as the guard tests above — each workflow must CONTRIBUTE assertions, because
 * a filter that matches no node reads green while the thing it names goes unchecked.
 */
describe('candidate resolution', () => {
  it('loads the Candidates table in both workflows', () => {
    for (const { file, wf } of both) {
      const loads = wf.nodes.filter(
        (n) => n.type === 'n8n-nodes-base.airtable' && JSON.stringify(n.parameters).includes('"Candidates"'),
      );
      expect(loads.length, `${file} never reads the Candidates table`).toBeGreaterThan(0);
    }
  });

  it('accepts candidateId in the body, defaulting to the seed candidate, in both workflows', () => {
    const checkedPerFile = new Map<string, number>();

    for (const { file, wf } of both) {
      for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
        const source = String(n.parameters['jsCode']);
        // Only the nodes that READ THE BODY. Selecting on "declares DEFAULT_CANDIDATE_ID" was the
        // original filter and it widened silently: key-scoping nodes now declare that constant too,
        // without going near the webhook body, and the test failed on them for not defaulting
        // something they never read.
        if (!/body\.candidateId|body\)\s*\|\|\s*\{\}\)\.candidateId/.test(source)) continue;
        if (!source.includes(`DEFAULT_CANDIDATE_ID = "${DEFAULT_CANDIDATE_ID}"`)) continue;
        // The node that reads the body must default rather than reject an absent candidateId, so
        // every pre-v3 caller keeps working unchanged.
        expect(source, `${file} :: ${n.name}`).toMatch(/candidateId \|\| ''/);
        checkedPerFile.set(file, (checkedPerFile.get(file) ?? 0) + 1);
      }
    }

    // The assertion that makes the rest of them mean something.
    expect(checkedPerFile.get('extract-project.json') ?? 0).toBeGreaterThan(0);
    expect(checkedPerFile.get('match-role.json') ?? 0).toBeGreaterThan(0);
  });

  it('fails loudly on an unknown candidateId instead of typecasting a row into being', () => {
    for (const { file, wf } of both) {
      const loud = wf.nodes.filter((n) =>
        String(n.parameters['jsCode'] ?? '').includes('is not in the Candidates table'),
      );
      expect(loud.length, `${file} would silently accept an unknown candidate`).toBeGreaterThan(0);
      for (const n of loud) {
        expect(String(n.parameters['jsCode']), `${file} :: ${n.name}`).toMatch(/throw new Error/);
      }
    }
  });

  it('stamps every created row with its Candidate link', () => {
    const checkedPerFile = new Map<string, number>();

    for (const { file, wf } of both) {
      for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
        const source = String(n.parameters['jsCode']);
        if (!/Candidate: \[/.test(source)) continue;
        checkedPerFile.set(file, (checkedPerFile.get(file) ?? 0) + 1);
      }
    }

    // extract stamps the project row, the evidence fan-out and the review stub; match stamps results.
    expect(checkedPerFile.get('extract-project.json') ?? 0).toBeGreaterThanOrEqual(3);
    expect(checkedPerFile.get('match-role.json') ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('keys Results as candidate × role × requirement, the exact adapter format', () => {
    // src/store/airtable.ts writes `${result.candidate}-${role.id}-${result.requirementId}` and its
    // reader strips the prefixes back off by the row's own Candidate link. A drifted key format here
    // would round-trip into requirement ids that exist nowhere else.
    const fan = matchRole.nodes.find((n) => n.name === 'Fan out results');
    expect(fan, 'match-role.json has no Fan out results node').toBeDefined();
    const source = String(fan?.parameters['jsCode']);
    expect(source).toContain(`candidate.key + '-' + roleKey + '-' + r.requirementId`);
    expect(source).toContain('Candidate: [candidate.id]');
  });

  it('writes every link as a record id, never as a display name', () => {
    /**
     * REGRESSION, and the one with the worst blast radius. Links used to be written as the target's
     * primary-field value under `typecast`, so Airtable resolved them by Name / Title / Label — none of
     * which are unique. Two candidates can share a name (the bundled fixture creates exactly that pair:
     * the seed is "Joel Brannan" and pasting raw/08-joel-resume.md makes a second one), and two people
     * can each own a project called "Acme CRM". A link could therefore land on the wrong person's row —
     * written at insert time, invisible to every candidate-scoped read, and impossible to undo after.
     *
     * Record ids are unique by construction, so this asserts the shape rather than any one call site.
     */
    const linkFields = ['Candidate', 'Role', 'Projects', 'Technologies', 'Capabilities', 'Evidence'];
    let checked = 0;

    for (const [file, workflow] of [['extract-project.json', extract], ['match-role.json', matchRole]] as const) {
      for (const node of workflow.nodes) {
        const source = node.parameters['jsCode'];
        if (typeof source !== 'string') continue;

        for (const field of linkFields) {
          // Any assignment of a link field in a written row.
          const assignments = source.match(new RegExp(`${field}:\\s*\\[[^\\]]*\\]`, 'g')) ?? [];
          for (const assignment of assignments) {
            checked += 1;
            expect(
              assignment,
              `${file} / ${node.name}: ${field} is written by display name, which Airtable resolves ` +
                `by a non-unique primary field. Write the record id instead.`,
            ).not.toMatch(/\b(name|Name|label|Label|title|Title)\b/);
          }
        }
      }
    }

    // A test that scans nothing passes forever.
    expect(checked, 'no link-field assignments were scanned').toBeGreaterThanOrEqual(4);
  });

  it('scopes matching to the candidate before scoring, not after', () => {
    // The same guarantee src/pipeline/index.ts makes: rows the scorer never sees are rows it
    // structurally cannot cite. Technologies stay global.
    const load = matchRole.nodes.find((n) => n.name === 'Load the record');
    const source = String(load?.parameters['jsCode']);
    expect(source).toMatch(/projectAll\.filter\(mine\)/);
    expect(source).toMatch(/capAll\.filter\(mine\)/);
    expect(source).toMatch(/evidenceAll\.filter\(mine\)/);
    expect(source).not.toMatch(/techRows\.filter\(mine\)/);
  });
});

/**
 * Branch ordering, which n8n decides by POSITION.
 *
 * Under `executionOrder: v1` sibling branches run top-to-bottom by node y. Both Respond nodes used to
 * sit ABOVE their write branch, so each webhook answered ok:true before its rows were written — the
 * extract lane reporting a count taken from the validator rather than from Airtable, the match lane
 * reporting a coverage score with zero Results linked. An Airtable 429 on the write then left a
 * half-written record and a caller who had already been told it succeeded.
 *
 * Pinned because it is invisible in the graph: the connections are identical either way, and only the
 * coordinates say which runs first.
 */
describe('a webhook answers only after its writes have run', () => {
  it.each([
    ['extract-project.json', extract],
    ['match-role.json', matchRole],
  ])('%s puts Respond below its sibling write branch', (_file, wf) => {
    const position = new Map(wf.nodes.map((n) => [n.name, n.position]));
    const parents = Object.entries(wf.connections).filter(([, conn]) =>
      conn.main.some((branch) => branch.some((c) => c.node === 'Respond')),
    );
    expect(parents.length, 'Respond has no parent').toBeGreaterThan(0);

    const respondY = position.get('Respond')![1];
    const siblings = parents
      .flatMap(([, conn]) => conn.main.flat())
      .map((c) => c.node)
      .filter((name) => name !== 'Respond');

    expect(siblings.length, 'Respond is not sharing a fan-out, so ordering is moot').toBeGreaterThan(0);
    for (const sibling of siblings) {
      expect(position.get(sibling)![1], `${sibling} must run before Respond`).toBeLessThan(respondY);
    }
  });

  it('the extract lane counts evidence from a node that always executes', () => {
    // A project with no receipts is legitimate, and an empty branch simply stops — so the write node
    // never executes and reading it would throw. 'Fan out evidence' always runs, and emits one item
    // per row including none.
    const respond = extract.nodes.find((n) => n.name === 'Respond');
    const body = String(respond?.parameters['responseBody']);
    expect(body).toContain("$('Fan out evidence').all().length");
    expect(body, 'counting what we meant to write, not what ran').not.toContain("$('Validate extraction').first().json.evidence");
  });
});

/**
 * Every Airtable load runs exactly once, and the graph says so structurally.
 *
 * Two n8n behaviours had to be discovered by RUNNING the thing, because both look fine in a diff.
 *
 * An Airtable node executes once per INPUT ITEM, so a chain of loads multiplies calls: with 44
 * technologies feeding it, `Load capabilities` fired 44 sequential searches past Airtable's 5 req/s cap.
 *
 * Fanning them off a shared parent is the obvious fix and is wrong. A node with several incoming
 * connections runs as soon as the FIRST delivers, so `Load the record` executed while four of its five
 * sources were still pending and threw "Node 'Load projects' hasn't been executed". An earlier version
 * of THIS test asserted the fan was correct, which is a reminder that a test written from a plausible
 * theory pins the theory rather than the behaviour.
 *
 * `executeOnce` settles both: chained for ordering, once each for the rate limit.
 */
describe('every Airtable load runs exactly once', () => {
  it.each([
    ['extract-project.json', extract],
    ['match-role.json', matchRole],
  ])('%s sets executeOnce on every Airtable read', (_file, wf) => {
    const reads = wf.nodes.filter(
      (n) => n.type === 'n8n-nodes-base.airtable' && n.parameters['operation'] === 'search',
    );
    expect(reads.length, 'no Airtable reads found').toBeGreaterThan(0);
    const unguarded = reads.filter((n) => n.executeOnce !== true).map((n) => n.name);
    expect(unguarded, 'a chained Airtable read without executeOnce runs once per input item').toEqual([]);
  });

  it.each([
    ['extract-project.json', extract],
    ['match-role.json', matchRole],
  ])('%s never has two sources feeding one node', (_file, wf) => {
    // The fan-in shape that silently half-executed. Any node with more than one inbound connection is
    // reachable before all of them have delivered.
    const inbound = new Map<string, string[]>();
    for (const [from, conn] of Object.entries(wf.connections)) {
      for (const target of conn.main.flat()) {
        inbound.set(target.node, [...(inbound.get(target.node) ?? []), from]);
      }
    }
    // One convergence is legitimate and named here rather than excluded by a loose rule. Both sources of
    // 'Posting requirements' sit on opposite branches of the same IF, so exactly one can ever deliver —
    // which is the property that makes convergence safe. A fan has no such guarantee.
    const IF_CONVERGENCE = new Set(['Posting requirements']);
    const converging = [...inbound.entries()]
      .filter(([node, froms]) => froms.length > 1 && !IF_CONVERGENCE.has(node));
    expect(converging.map(([n, f]) => `${n} <- ${f.join(', ')}`)).toEqual([]);
  });
});

/**
 * A webhook node without a `webhookId` has no production URL.
 *
 * n8n registers it under a composite `{workflowId}/{node name}/{path}` key that nothing serves, so
 * `POST /webhook/proof-of-work/match` answers 404 "not registered" — indistinguishable from a workflow
 * nobody activated. Both were activated. Verified against n8n 2.31.7 in the official container.
 */
describe('the production webhook URL exists', () => {
  it.each([
    ['extract-project.json', extract],
    ['match-role.json', matchRole],
  ])('%s gives every webhook node a webhookId', (_file, wf) => {
    const hooks = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
    expect(hooks.length).toBeGreaterThan(0);
    for (const h of hooks) {
      expect(h.webhookId, `${h.name} has no webhookId`).toMatch(/^[0-9a-f]{8}-0000-4000-8000-/);
    }
  });
});

/**
 * Airtable nodes must be typeVersion 2.2 or higher, because below it the record shape changes.
 *
 * `legacyFlattenOutput` in the node's own source returns the record untouched at >= 2.2 and hoists
 * `fields` to the top level below it. Every Code node here reads `r.fields.Key`, so at 2.1 they all read
 * undefined and the first candidate lookup threw against a table that plainly contained the row.
 */
describe('Airtable nodes return records with fields nested', () => {
  it.each([
    ['extract-project.json', extract],
    ['match-role.json', matchRole],
  ])('%s pins Airtable at 2.2 or newer', (_file, wf) => {
    const nodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.airtable');
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(n.typeVersion, `${n.name} would flatten fields to the top level`).toBeGreaterThanOrEqual(2.2);
    }
  });
});

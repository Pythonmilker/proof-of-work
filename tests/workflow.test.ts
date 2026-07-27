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
import { WORKFLOWS } from '../n8n/build';

interface Node {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
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
    const generated = `${JSON.stringify(WORKFLOWS.find((w) => w.file === file)?.content, null, 2)}\n`;
    expect(readFileSync(join(process.cwd(), 'n8n', file), 'utf8')).toBe(generated);
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

describe('the extract workflow', () => {
  it('branches on validity and routes failures to Needs Review', () => {
    // The error branch is the design decision worth defending: nothing is dropped, so the output cannot
    // look complete while quietly missing a record.
    const gate = extract.nodes.find((n) => n.type === 'n8n-nodes-base.if');
    expect(gate).toBeDefined();
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
    const order = matchRole.nodes.map((n) => n.name);
    expect(order.indexOf('Retrieve and score')).toBeLessThan(order.indexOf('Write rationales'));
    expect(matchRole.connections['Retrieve and score']?.main[0]?.[0]?.node).toBe('Write rationales');
  });
});

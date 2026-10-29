import {
  extractActionManifestFacts,
  extractWorkflowFacts,
} from '../extract/workflow-extractor';
import type { NonCodeExtractorInput } from '../extract/extractor-registry';
import { CodeGraphParserRuntime } from '../parser/runtime';
import { fileQualifiedName, symbolQualifiedName } from '../ids';
import type {
  CodeGraphEdgeRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';

const REPO = 'fixture';
const RELATIVE_PATH = '.github/workflows/ci.yml';

describe('github workflow extractor', () => {
  let runtime: CodeGraphParserRuntime;

  beforeAll(async () => {
    // extractWorkflowFacts never touches web-tree-sitter, but `runtime` is a
    // required field on `NonCodeExtractorInput` -- same rationale as
    // manifest-extractors.test.ts.
    runtime = await CodeGraphParserRuntime.create();
  });

  afterAll(() => {
    runtime.dispose();
  });

  function input(relativePath: string, source: string): NonCodeExtractorInput {
    return {
      repoId: REPO,
      relativePath,
      absolutePath: `/repo/${relativePath}`,
      source,
      sizeBytes: Buffer.byteLength(source, 'utf8'),
      mtimeNs: '1',
      contentHash: 'hash',
      runtime,
    };
  }

  function bySymbolName(
    symbols: readonly CodeGraphSymbolRecord[],
    name: string,
  ): CodeGraphSymbolRecord | undefined {
    return symbols.find((symbol) => symbol.name === name);
  }

  function edgesOfKind(
    edges: readonly CodeGraphEdgeRecord[],
    kind: CodeGraphEdgeRecord['kind'],
  ): CodeGraphEdgeRecord[] {
    return edges.filter((edge) => edge.kind === kind);
  }

  const REAL_WORKFLOW_SOURCE = [
    'name: CI',
    'on:',
    '  push:',
    '    branches: [main]',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: Install deps',
    '        run: npm ci',
    '      - uses: ./.github/actions/local-thing',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    needs: build',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: npm test',
    '',
  ].join('\n');

  it('extracts a workflow symbol, one workflow_job per job, CONTAINS edges, and USES_PIPELINE_ACTION edges per uses step (external + local refs unresolved; run-only step produces no edge)', () => {
    const facts = extractWorkflowFacts(
      input(RELATIVE_PATH, REAL_WORKFLOW_SOURCE),
    );

    expect(facts.file.language).toBe('github-workflow');
    expect(facts.file.grammarId).toBe('github-workflow');
    expect(facts.file.grammarAbi).toBeNull();
    expect(facts.file.parseStatus).toBe('parsed');
    expect(facts.file.hasErrors).toBe(false);

    const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
    expect(fileSymbol).toBeDefined();

    const workflowSymbol = facts.symbols.find(
      (symbol) => symbol.kind === 'workflow',
    );
    expect(workflowSymbol?.name).toBe('CI');
    expect(workflowSymbol?.qualifiedName).toBe(
      symbolQualifiedName(RELATIVE_PATH, [], 'workflow'),
    );
    expect(workflowSymbol?.parentSymbolId).toBeNull();
    expect(workflowSymbol?.lineStart).toBe(1);

    const jobSymbols = facts.symbols.filter(
      (symbol) => symbol.kind === 'workflow_job',
    );
    expect(jobSymbols).toHaveLength(2);

    const build = bySymbolName(facts.symbols, 'build');
    expect(build?.kind).toBe('workflow_job');
    expect(build?.qualifiedName).toBe(
      symbolQualifiedName(RELATIVE_PATH, ['jobs'], 'build'),
    );
    expect(build?.parentSymbolId).toBe(workflowSymbol?.id);
    expect(build?.lineStart).toBe(6);

    const test = bySymbolName(facts.symbols, 'test');
    expect(test?.qualifiedName).toBe(
      symbolQualifiedName(RELATIVE_PATH, ['jobs'], 'test'),
    );
    expect(test?.parentSymbolId).toBe(workflowSymbol?.id);
    expect(test?.lineStart).toBe(13);

    const containsEdges = edgesOfKind(facts.edges, 'CONTAINS');
    expect(containsEdges).toHaveLength(3); // file->workflow, workflow->build, workflow->test
    const fileToWorkflow = containsEdges.find(
      (edge) => edge.targetSymbolId === workflowSymbol?.id,
    );
    expect(fileToWorkflow?.sourceSymbolId).toBe(fileSymbol?.id);
    const workflowToBuild = containsEdges.find(
      (edge) => edge.targetSymbolId === build?.id,
    );
    expect(workflowToBuild?.sourceSymbolId).toBe(workflowSymbol?.id);
    const workflowToTest = containsEdges.find(
      (edge) => edge.targetSymbolId === test?.id,
    );
    expect(workflowToTest?.sourceSymbolId).toBe(workflowSymbol?.id);

    const usesEdges = edgesOfKind(facts.edges, 'USES_PIPELINE_ACTION');
    expect(usesEdges).toHaveLength(3);
    for (const edge of usesEdges) {
      expect(edge.targetSymbolId).toBeNull();
      expect(edge.confidenceTier).toBe('EXTRACTED');
      expect(edge.confidenceScore).toBe(1.0);
    }

    const buildUsesEdges = usesEdges.filter(
      (edge) => edge.sourceSymbolId === build?.id,
    );
    expect(buildUsesEdges).toHaveLength(2);
    const checkoutFromBuild = buildUsesEdges.find(
      (edge) => edge.targetRef === 'actions/checkout@v4',
    );
    expect(checkoutFromBuild?.evidence).toEqual({ stepIndex: 0 });
    expect(checkoutFromBuild?.line).toBe(9);
    const localFromBuild = buildUsesEdges.find(
      (edge) => edge.targetRef === './.github/actions/local-thing',
    );
    expect(localFromBuild?.evidence).toEqual({ stepIndex: 2 });
    expect(localFromBuild?.line).toBe(12);
    // The EXTRACTOR never resolves anything itself -- both refs leave
    // targetSymbolId null here regardless of phase. Since Phase 6,
    // resolve/workflow-action-resolver.ts binds the local ref in a later
    // post-pass (see that module) when a matching action.yml/action.yaml
    // file symbol exists in the graph; the external ref never resolves.
    expect(localFromBuild?.targetSymbolId).toBeNull();

    const testUsesEdges = usesEdges.filter(
      (edge) => edge.sourceSymbolId === test?.id,
    );
    expect(testUsesEdges).toHaveLength(1);
    expect(testUsesEdges[0].targetRef).toBe('actions/checkout@v4');
    expect(testUsesEdges[0].evidence).toEqual({ stepIndex: 0 });
    expect(testUsesEdges[0].line).toBe(17);
  });

  it('names the workflow from the basename when there is no top-level name field', () => {
    const source = [
      'on: push',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
    ].join('\n');
    const facts = extractWorkflowFacts(input(RELATIVE_PATH, source));
    const workflowSymbol = facts.symbols.find(
      (symbol) => symbol.kind === 'workflow',
    );
    expect(workflowSymbol?.name).toBe('ci.yml');
    expect(workflowSymbol?.lineStart).toBe(1);
  });

  it('caps job extraction at 100 and records truncatedFacts on the file symbol', () => {
    const jobBlocks = Array.from(
      { length: 150 },
      (_, i) =>
        `  job${i}:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`,
    ).join('');
    const source = `name: Many Jobs\njobs:\n${jobBlocks}`;

    const facts = extractWorkflowFacts(input(RELATIVE_PATH, source));
    const jobSymbols = facts.symbols.filter(
      (symbol) => symbol.kind === 'workflow_job',
    );
    expect(jobSymbols).toHaveLength(100);
    expect(bySymbolName(facts.symbols, 'job0')).toBeDefined();
    expect(bySymbolName(facts.symbols, 'job99')).toBeDefined();
    expect(bySymbolName(facts.symbols, 'job100')).toBeUndefined();

    const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
    expect(fileSymbol?.extra.truncatedFacts).toBe(50);

    // Only the retained jobs' uses steps are extracted (100), well under the
    // 200/file edge cap, so no edges are dropped for this fixture.
    expect(edgesOfKind(facts.edges, 'USES_PIPELINE_ACTION')).toHaveLength(100);
  });

  it('caps USES_PIPELINE_ACTION edges at 200/file and records truncatedFacts on the file symbol', () => {
    const stepLines = Array.from(
      { length: 250 },
      (_, i) => `      - uses: actions/checkout@v${i}`,
    ).join('\n');
    const source = `name: Big Job\njobs:\n  build:\n    steps:\n${stepLines}\n`;

    const facts = extractWorkflowFacts(input(RELATIVE_PATH, source));
    expect(edgesOfKind(facts.edges, 'USES_PIPELINE_ACTION')).toHaveLength(200);
    const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
    expect(fileSymbol?.extra.truncatedFacts).toBe(50);
  });

  it('gives distinct edge ids to two identical `uses` steps in a flow-style single-line job block (F3d regression: a shared approximate line must not collapse the edges)', () => {
    // Flow-style YAML puts the whole job on one line, so `uses:` never
    // appears at a line START -- advanceToKeyLine's line-start regex finds no
    // match for either occurrence and falls back to the SAME cursor line for
    // both, meaning `usage.uses` + `usesLine` alone would hash to the SAME
    // edgeRowId for both steps without the stepIndex discriminator.
    const source = [
      'name: Flow',
      'jobs:',
      '  build: {runs-on: ubuntu-latest, steps: [{uses: actions/checkout@v4}, {uses: actions/checkout@v4}]}',
      '',
    ].join('\n');
    const facts = extractWorkflowFacts(input(RELATIVE_PATH, source));
    const usesEdges = edgesOfKind(facts.edges, 'USES_PIPELINE_ACTION');
    expect(usesEdges).toHaveLength(2);
    const ids = new Set(usesEdges.map((edge) => edge.id));
    expect(ids.size).toBe(2);
    expect(usesEdges[0].targetRef).toBe('actions/checkout@v4');
    expect(usesEdges[1].targetRef).toBe('actions/checkout@v4');
    expect(usesEdges[0].evidence).toEqual({ stepIndex: 0 });
    expect(usesEdges[1].evidence).toEqual({ stepIndex: 1 });
  });

  it('throws on invalid YAML', () => {
    expect(() =>
      extractWorkflowFacts(input(RELATIVE_PATH, 'name: [unterminated')),
    ).toThrow();
  });

  it('throws when the parsed root is not a mapping (a workflow file is always a top-level mapping)', () => {
    expect(() =>
      extractWorkflowFacts(input(RELATIVE_PATH, '- just\n- a\n- list\n')),
    ).toThrow();
  });

  it('treats a job with no steps array as having zero uses edges instead of crashing', () => {
    const source = 'name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
    const facts = extractWorkflowFacts(input(RELATIVE_PATH, source));
    expect(edgesOfKind(facts.edges, 'USES_PIPELINE_ACTION')).toEqual([]);
    expect(bySymbolName(facts.symbols, 'build')).toBeDefined();
  });
});

describe('github action-manifest extractor (Phase 6: gives local uses: refs a real file symbol to resolve to)', () => {
  let runtime: CodeGraphParserRuntime;

  beforeAll(async () => {
    runtime = await CodeGraphParserRuntime.create();
  });

  afterAll(() => {
    runtime.dispose();
  });

  function input(relativePath: string, source: string): NonCodeExtractorInput {
    return {
      repoId: REPO,
      relativePath,
      absolutePath: `/repo/${relativePath}`,
      source,
      sizeBytes: Buffer.byteLength(source, 'utf8'),
      mtimeNs: '1',
      contentHash: 'hash',
      runtime,
    };
  }

  const ACTION_MANIFEST_SOURCE = [
    'name: Local Thing',
    'description: does a thing',
    'inputs: {}',
    'runs:',
    '  using: node20',
    '  main: index.js',
    '',
  ].join('\n');

  it('produces file-symbol-only facts -- no attempt to parse the manifest schema (name/inputs/outputs/runs) is in scope here', () => {
    const relativePath = '.github/actions/local-thing/action.yml';
    const facts = extractActionManifestFacts(
      input(relativePath, ACTION_MANIFEST_SOURCE),
    );

    expect(facts.file.language).toBe('github-action-manifest');
    expect(facts.file.grammarId).toBe('github-action-manifest');
    expect(facts.file.grammarAbi).toBeNull();
    expect(facts.file.parseStatus).toBe('parsed');
    expect(facts.file.hasErrors).toBe(false);
    expect(facts.file.relativePath).toBe(relativePath);

    expect(facts.symbols).toHaveLength(1);
    const fileSymbol = facts.symbols[0];
    expect(fileSymbol.kind).toBe('file');
    expect(fileSymbol.name).toBe('action.yml');
    expect(fileSymbol.qualifiedName).toBe(fileQualifiedName(relativePath));
    expect(fileSymbol.parentSymbolId).toBeNull();

    expect(facts.edges).toEqual([]);
  });

  it('works the same for an action.yaml basename', () => {
    const relativePath = '.github/actions/local-thing/action.yaml';
    const facts = extractActionManifestFacts(
      input(relativePath, ACTION_MANIFEST_SOURCE),
    );
    expect(facts.symbols).toHaveLength(1);
    expect(facts.symbols[0].qualifiedName).toBe(
      fileQualifiedName(relativePath),
    );
  });

  it('never throws even on content that is not valid YAML -- this extractor does not parse the manifest body at all', () => {
    const relativePath = '.github/actions/broken/action.yml';
    expect(() =>
      extractActionManifestFacts(
        input(relativePath, 'this: [is not valid yaml'),
      ),
    ).not.toThrow();
  });
});

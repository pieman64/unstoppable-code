import {
  buildGitHubWorkflowDefinitionGraph,
  githubWorkflowGraphDepths,
  listGitHubWorkflowCalls,
  MAX_GITHUB_WORKFLOW_GRAPH_JOBS,
} from '../github-workflow-definition-graph';

// Trimmed from the repository's own Internal Release workflow: a gate job, a
// reusable-workflow call, static include matrices in the called file, and a
// dynamic matrix fed by a previous job's output.
const ROOT = `
name: Internal Release
on:
  workflow_dispatch:
jobs:
  should-release:
    name: Check for changes
    runs-on: ubuntu-latest
    steps:
      - run: echo
  release-brands:
    name: Resolve release brands
    needs: should-release
    steps:
      - run: echo
  ui-automation:
    name: Gate UI automation
    needs: should-release
    uses: ./.github/workflows/ui-automation.yml
    secrets: inherit
  build-macos:
    name: Build internal macOS (\${{ matrix.brand }})
    needs: [should-release, release-brands, ui-automation]
    strategy:
      matrix:
        brand: \${{ fromJSON(needs.release-brands.outputs.brands) }}
    steps:
      - run: echo
  publish:
    name: Publish (\${{ matrix.platform.name }}, \${{ matrix.brand }})
    needs:
      - build-macos
    strategy:
      matrix:
        brand: \${{ fromJSON(needs.release-brands.outputs.brands) }}
        platform:
          - name: macOS
    steps:
      - run: echo
  notify:
    name: Notify Slack
    needs: [publish]
    if: \${{ always() }}
    steps:
      - run: echo
`;

const CALLED = `
name: UI Automation
on:
  workflow_call:
jobs:
  build-e2e:
    name: Build E2E Electron bundle
    steps:
      - run: echo
  web-e2e:
    name: Web E2E (\${{ matrix.shard }})
    strategy:
      matrix:
        include:
          - name: shard-1
            shard: 1/2
          - name: shard-2
            shard: 2/2
    steps:
      - run: echo
  electron:
    name: Electron UI Automation (\${{ matrix.name }})
    needs: build-e2e
    strategy:
      matrix:
        include:
          - name: parallel-1
            shard: 1/2
          - name: parallel-2
            shard: 2/2
    steps:
      - run: echo
`;

describe('buildGitHubWorkflowDefinitionGraph', () => {
  const build = (
    root = ROOT,
    called: Array<[string, string]> = [
      ['./.github/workflows/ui-automation.yml', CALLED],
    ],
  ): ReturnType<typeof buildGitHubWorkflowDefinitionGraph> =>
    buildGitHubWorkflowDefinitionGraph({
      sha: 'a'.repeat(40),
      observedAt: '2026-09-13T00:00:00.000Z',
      root,
      called: new Map(called),
    });

  it('lists reusable-workflow calls so the caller can fetch them', () => {
    expect(listGitHubWorkflowCalls(ROOT)).toEqual([
      './.github/workflows/ui-automation.yml',
    ]);
    expect(listGitHubWorkflowCalls('not: [valid')).toEqual([]);
  });

  it('expands reusable workflows, static matrices, and dynamic matrices into one graph', () => {
    const graph = build();
    expect(graph).not.toBeNull();
    if (!graph) return;
    expect(graph.sha).toBe('a'.repeat(40));
    expect(graph.jobs.map((job) => job.id)).toEqual([
      'should-release',
      'release-brands',
      'ui-automation/build-e2e',
      'ui-automation/web-e2e',
      'ui-automation/electron',
      'build-macos',
      'publish',
      'notify',
    ]);
    const byId = new Map(graph.jobs.map((job) => [job.id, job]));
    expect(byId.get('should-release')).toMatchObject({
      template: 'Check for changes',
      names: ['Check for changes'],
      needs: [],
      dynamic: false,
    });
    // Inner roots inherit the caller's dependencies; inner dependents are
    // namespaced under the caller; names carry GitHub's `Caller / Job` prefix.
    expect(byId.get('ui-automation/build-e2e')).toMatchObject({
      template: 'Gate UI automation / Build E2E Electron bundle',
      names: ['Gate UI automation / Build E2E Electron bundle'],
      needs: ['should-release'],
    });
    expect(byId.get('ui-automation/web-e2e')?.names).toEqual([
      'Gate UI automation / Web E2E (1/2)',
      'Gate UI automation / Web E2E (2/2)',
    ]);
    expect(byId.get('ui-automation/electron')).toMatchObject({
      names: [
        'Gate UI automation / Electron UI Automation (parallel-1)',
        'Gate UI automation / Electron UI Automation (parallel-2)',
      ],
      needs: ['ui-automation/build-e2e'],
    });
    // A dependent of the reusable caller waits on every inner job.
    expect(byId.get('build-macos')).toMatchObject({
      template: 'Build internal macOS (${{ matrix.brand }})',
      names: [],
      dynamic: true,
      needs: [
        'should-release',
        'release-brands',
        'ui-automation/build-e2e',
        'ui-automation/web-e2e',
        'ui-automation/electron',
      ],
    });
    expect(byId.get('publish')).toMatchObject({
      dynamic: true,
      needs: ['build-macos'],
    });
    expect(byId.get('notify')).toMatchObject({
      names: ['Notify Slack'],
      needs: ['publish'],
    });
    expect(Object.fromEntries(githubWorkflowGraphDepths(graph.jobs))).toEqual({
      'should-release': 0,
      'release-brands': 1,
      'ui-automation/build-e2e': 1,
      'ui-automation/web-e2e': 1,
      'ui-automation/electron': 2,
      'build-macos': 3,
      publish: 4,
      notify: 5,
    });
  });

  it('follows GitHub matrix naming for cartesian, include, and exclude', () => {
    const graph = build(`
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu, windows]
        node: [20, 22]
        include:
          - os: ubuntu
            node: 22
            coverage: true
          - os: macos
            node: 22
          - os: windows
            node: 20
            restored: true
        exclude:
          - os: windows
            node: 20
    steps:
      - run: echo
  named:
    name: 'Named \${{ matrix.os }} #\${{ strategy.job-index }}/\${{ strategy.job-total }}'
    strategy:
      matrix:
        os: [a, b]
    steps:
      - run: echo
`);
    expect(graph?.jobs[0]).toMatchObject({
      id: 'test',
      // No matrix expression in the name: GitHub appends the values.
      names: [
        'test (ubuntu, 20)',
        'test (ubuntu, 22, true)',
        'test (windows, 22)',
        'test (macos, 22)',
        'test (windows, 20, true)',
      ],
    });
    expect(graph?.jobs[1].names).toEqual(['Named a #0/2', 'Named b #1/2']);
  });

  it('applies include-only keys to every original matrix combination', () => {
    const graph = build(`
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22]
        include:
          - coverage: true
    steps:
      - run: echo
`);
    expect(graph?.jobs[0]).toMatchObject({
      id: 'test',
      names: ['test (20, true)', 'test (22, true)'],
    });
  });

  it('bounds cyclic YAML alias graphs instead of recursing indefinitely', () => {
    expect(
      build(`
jobs:
  test:
    strategy:
      matrix: &matrix
        axis: [*matrix]
    steps:
      - run: echo
`)?.jobs[0],
    ).toMatchObject({ id: 'test', dynamic: true, names: [] });
  });

  it('collapses a reusable workflow it cannot read into one dynamic node', () => {
    const graph = build(ROOT, []);
    const caller = graph?.jobs.find((job) => job.id === 'ui-automation');
    expect(caller).toMatchObject({
      dynamic: true,
      template: 'Gate UI automation / ${{ job }}',
      needs: ['should-release'],
    });
    expect(graph?.jobs.find((job) => job.id === 'build-macos')?.needs).toEqual([
      'should-release',
      'release-brands',
      'ui-automation',
    ]);
  });

  it('marks a nested reusable-workflow call as a dynamic descendant prefix', () => {
    const graph = build(
      `
jobs:
  pr:
    name: PR
    uses: ./.github/workflows/lint.yml
`,
      [
        [
          './.github/workflows/lint.yml',
          `
jobs:
  lint:
    name: Lint
    uses: ./.github/workflows/eslint.yml
`,
        ],
      ],
    );

    expect(graph?.jobs).toEqual([
      {
        id: 'pr/lint',
        template: 'PR / Lint',
        names: [],
        needs: [],
        dynamic: true,
      },
    ]);
  });

  it('drops unknown needs, self references, and unparseable or empty definitions', () => {
    const graph = build(`
jobs:
  a:
    needs: [a, missing]
    steps: []
`);
    expect(graph?.jobs).toEqual([
      { id: 'a', template: 'a', names: ['a'], needs: [], dynamic: false },
    ]);
    expect(build('jobs: [')).toBeNull();
    expect(build('name: empty\njobs: {}\n')).toBeNull();
    expect(build('name: no jobs\n')).toBeNull();
  });

  it('treats oversized definitions as unavailable rather than truncating', () => {
    const many = Array.from(
      { length: MAX_GITHUB_WORKFLOW_GRAPH_JOBS + 1 },
      (_, index) => `  job-${index}:\n    steps: []`,
    ).join('\n');
    expect(build(`jobs:\n${many}\n`)).toBeNull();
    expect(
      build(`
jobs:
  wide:
    strategy:
      matrix:
        a: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26]
        b: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]
    steps: []
`)?.jobs[0],
    ).toMatchObject({ dynamic: true, names: [] });
  });

  it('stops expanding matrix names as soon as the graph name budget is exhausted', () => {
    const axis = '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]';
    const secondTemplate = 'Second ${{ matrix.a }} ${{ matrix.b }}';
    const replaceSpy = jest.spyOn(String.prototype, 'replace');

    try {
      expect(
        build(`
jobs:
  first:
    name: First \${{ matrix.a }} \${{ matrix.b }}
    strategy:
      matrix:
        a: ${axis}
        b: ${axis}
    steps: []
  second:
    name: Second \${{ matrix.a }} \${{ matrix.b }}
    strategy:
      matrix:
        a: ${axis}
        b: ${axis}
    steps: []
`),
      ).toBeNull();
      expect(
        replaceSpy.mock.contexts.filter(
          (context) => String(context) === secondTemplate,
        ),
      ).toHaveLength(0);
    } finally {
      replaceSpy.mockRestore();
    }
  });

  it('computes depths without looping on cycles', () => {
    expect(
      Object.fromEntries(
        githubWorkflowGraphDepths([
          {
            id: 'a',
            template: 'a',
            names: ['a'],
            needs: ['b'],
            dynamic: false,
          },
          {
            id: 'b',
            template: 'b',
            names: ['b'],
            needs: ['a'],
            dynamic: false,
          },
          {
            id: 'c',
            template: 'c',
            names: ['c'],
            needs: ['a'],
            dynamic: false,
          },
        ]),
      ),
    ).toEqual({ a: 2, b: 1, c: 3 });
  });
});

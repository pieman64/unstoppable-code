/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  GitHubWorkflowRunRow,
  githubWorkflowJobDagStatus,
  githubWorkflowRunRowStatus,
  githubWorkflowRunRowTitle,
  type GitHubWorkflowRunRowData,
  type GitHubWorkflowRunRowJob,
} from '../github/GitHubWorkflowRunRow';
import { githubWorkflowJobTiers } from '../github/github-workflow-job-tiers';
import {
  githubWorkflowDefinitionTiers,
  type GitHubWorkflowRunRowGraph,
} from '../github/github-workflow-definition-tiers';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { escape: (value: string): string => value },
});
// jsdom has no layout: the progress bar centers the active dot with
// `scrollTo`, which the element prototype does not implement there.
Object.defineProperty(Element.prototype, 'scrollTo', {
  configurable: true,
  value: (): void => undefined,
});

const run: GitHubWorkflowRunRowData = {
  repository: 'acme/api',
  runId: '101',
  runAttempt: 1,
  workflowName: 'CI',
  runNumber: 42,
  htmlUrl: 'https://github.com/acme/api/actions/runs/101',
  state: { kind: 'intermediate', status: 'in_progress' },
  startedAt: '2026-07-20T00:00:00.000Z',
  observedAt: '2026-07-20T00:00:05.000Z',
  jobs: [
    {
      jobId: '501',
      name: 'Build macOS',
      status: 'completed',
      conclusion: 'success',
      htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/501',
    },
    {
      jobId: '502',
      name: 'Test',
      status: 'in_progress',
      conclusion: null,
      htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/502',
    },
    {
      jobId: '503',
      name: 'Publish',
      status: 'queued',
      conclusion: null,
      htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/503',
    },
  ],
};

describe('GitHubWorkflowRunRow', () => {
  it('maps run states to pill presentation and job states to DAG dots', () => {
    expect(
      githubWorkflowRunRowStatus({
        kind: 'intermediate',
        status: 'in_progress',
      }),
    ).toEqual({
      label: 'in progress',
      tone: 'active',
      muted: false,
      active: true,
    });
    expect(
      githubWorkflowRunRowStatus({ kind: 'intermediate', status: 'queued' }),
    ).toMatchObject({ label: 'queued', tone: 'paused', active: true });
    expect(
      githubWorkflowRunRowStatus({ kind: 'terminal', conclusion: 'success' }),
    ).toMatchObject({ label: 'success', tone: 'success', active: false });
    expect(
      githubWorkflowRunRowStatus({ kind: 'terminal', conclusion: 'timed_out' }),
    ).toMatchObject({ label: 'timed out', tone: 'failed', active: false });
    expect(
      githubWorkflowRunRowStatus({
        kind: 'unsupported',
        status: 'mystery',
        conclusion: null,
        terminal: false,
      }),
    ).toMatchObject({ label: 'mystery', tone: 'neutral', active: true });

    expect(
      githubWorkflowJobDagStatus({
        status: 'completed',
        conclusion: 'success',
      }),
    ).toBe('success');
    expect(
      githubWorkflowJobDagStatus({
        status: 'completed',
        conclusion: 'failure',
      }),
    ).toBe('failure');
    expect(
      githubWorkflowJobDagStatus({
        status: 'completed',
        conclusion: 'skipped',
      }),
    ).toBe('skipped');
    expect(
      githubWorkflowJobDagStatus({ status: 'in_progress', conclusion: null }),
    ).toBe('running');
    expect(
      githubWorkflowJobDagStatus({ status: 'queued', conclusion: null }),
    ).toBe('pending');
    expect(
      githubWorkflowJobDagStatus({ status: 'weird', conclusion: null }),
    ).toBeUndefined();

    expect(githubWorkflowRunRowTitle(run)).toBe('CI #42');
    expect(
      githubWorkflowRunRowTitle({
        ...run,
        runAttempt: 2,
        workflowName: undefined,
      }),
    ).toBe('Run #42 · attempt 2');
    expect(
      githubWorkflowRunRowTitle({
        ...run,
        runNumber: undefined,
        workflowName: undefined,
      }),
    ).toBe('Run #101');
  });

  it('infers dependency tiers from when GitHub created each job', () => {
    // Shaped like a real Internal Release run: a gate job, a fan-out tier
    // created the second the gate completed, and a matrix tier created when
    // one fan-out job (the bundle build) completed while others still ran.
    const job = (
      jobId: string,
      createdAt: string,
      completedAt?: string,
    ): GitHubWorkflowRunRowJob => ({
      jobId,
      name: `Job ${jobId}`,
      status: completedAt ? 'completed' : 'in_progress',
      conclusion: completedAt ? 'success' : null,
      htmlUrl: `https://github.com/acme/api/actions/runs/101/job/${jobId}`,
      createdAt,
      ...(completedAt ? { completedAt } : {}),
    });
    const jobs = [
      job('1', '2026-09-12T19:27:02Z', '2026-09-12T19:27:46Z'),
      job('2', '2026-09-12T19:27:47Z', '2026-09-12T19:29:05Z'),
      job('3', '2026-09-12T19:27:47Z'),
      job('4', '2026-09-12T19:27:47Z', '2026-09-12T19:30:19Z'),
      job('5', '2026-09-12T19:30:19Z'),
      job('6', '2026-09-12T19:30:19Z', '2026-09-12T19:33:06Z'),
    ];
    expect(githubWorkflowJobTiers(jobs)).toEqual([
      ['1'],
      ['2', '3', '4'],
      ['5', '6'],
    ]);
    // Order of the input never changes the placement, only the order within
    // a tier follows the input.
    expect(githubWorkflowJobTiers([...jobs].reverse())).toEqual([
      ['1'],
      ['4', '3', '2'],
      ['6', '5'],
    ]);
    // Nothing completed before anything was created: one tier.
    expect(
      githubWorkflowJobTiers([
        job('1', '2026-09-12T19:27:02Z'),
        job('2', '2026-09-12T19:27:02Z', '2026-09-12T19:30:00Z'),
      ]),
    ).toEqual([['1', '2']]);
    // Cursors persisted before created_at was captured, or with a malformed
    // value, fall back to the flat layout rather than guessing.
    const { createdAt: _dropped, ...legacy } = job('7', '2026-09-12T19:30:19Z');
    void _dropped;
    expect(githubWorkflowJobTiers([jobs[0], legacy])).toEqual([['1', '7']]);
    expect(
      githubWorkflowJobTiers([jobs[0], job('8', 'not a timestamp')]),
    ).toEqual([['1', '8']]);
    expect(githubWorkflowJobTiers([])).toEqual([]);
  });

  it('renders inferred tiers as separate dot groups', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <GitHubWorkflowRunRow
          run={{
            ...run,
            jobs: [
              {
                ...run.jobs[0],
                createdAt: '2026-07-20T00:00:00.000Z',
                completedAt: '2026-07-20T00:01:00.000Z',
              },
              { ...run.jobs[1], createdAt: '2026-07-20T00:01:00.000Z' },
              { ...run.jobs[2], createdAt: '2026-07-20T00:01:00.000Z' },
            ],
          }}
          onOpen={jest.fn()}
          onJobClick={jest.fn()}
        />,
      );
    });
    const tiers = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="dag-progress-tier"]',
      ),
    );
    expect(
      tiers.map((tier) =>
        Array.from(tier.querySelectorAll('[data-job-id]')).map((dot) =>
          dot.getAttribute('data-job-id'),
        ),
      ),
    ).toEqual([['501'], ['502', '503']]);
    act(() => root.unmount());
    container.remove();
  });

  it('lays observed jobs onto the declared graph and fills the rest with pending placeholders', () => {
    const observedJob = (
      jobId: string,
      name: string,
      status = 'completed',
      conclusion: string | null = 'success',
    ): GitHubWorkflowRunRowJob => ({
      jobId,
      name,
      status,
      conclusion,
      htmlUrl: `https://github.com/acme/api/actions/runs/101/job/${jobId}`,
    });
    // Shaped like the Internal Release definition: a gate, a reusable
    // workflow with a matrix, a dynamic matrix, and a final notify job.
    const graph: GitHubWorkflowRunRowGraph = {
      sha: 'a'.repeat(40),
      jobs: [
        {
          id: 'gate',
          template: 'Check',
          names: ['Check'],
          needs: [],
          dynamic: false,
        },
        {
          id: 'ui/e2e',
          template: 'Gate / E2E (${{ matrix.shard }})',
          names: ['Gate / E2E (1/2)', 'Gate / E2E (2/2)'],
          needs: ['gate'],
          dynamic: false,
        },
        {
          id: 'build',
          template: 'Build (${{ matrix.brand }})',
          names: [],
          needs: ['ui/e2e'],
          dynamic: true,
        },
        {
          id: 'notify',
          template: 'Notify ${{ github.ref_name }}',
          names: ['Notify ${{ github.ref_name }}'],
          needs: ['build'],
          dynamic: false,
        },
      ],
    };
    // Mid-run: the gate and one shard exist; the build matrix and notify do not.
    const early = githubWorkflowDefinitionTiers(graph, [
      observedJob('1', 'Check'),
      observedJob('2', 'Gate / E2E (1/2)', 'in_progress', null),
    ]);
    expect(early.tiers).toEqual([
      ['1'],
      ['2', 'definition:ui/e2e:1'],
      ['definition:build'],
      ['definition:notify:0'],
    ]);
    expect(early.jobs['definition:ui/e2e:1']).toEqual({
      jobId: 'definition:ui/e2e:1',
      name: 'Gate / E2E (2/2)',
      status: 'pending',
    });
    expect(early.jobs['definition:build'].name).toBe(
      'Build (${{ matrix.brand }})',
    );
    expect(early.jobs['2'].status).toBe('running');
    expect(early.unplaced).toEqual([]);

    // Later: the dynamic matrix materialized two brands, one skipped build
    // kept GitHub's literal template, notify resolved its expression, and one
    // job the definition never mentioned still shows up in a final tier.
    const late = githubWorkflowDefinitionTiers(graph, [
      observedJob('1', 'Check'),
      observedJob('2', 'Gate / E2E (1/2)'),
      observedJob('3', 'Gate / E2E (2/2)'),
      observedJob('4', 'Build (canopy)'),
      observedJob('5', 'Build (${{ matrix.brand }})', 'completed', 'skipped'),
      observedJob('6', 'Notify develop', 'queued', null),
      observedJob('7', 'Surprise'),
    ]);
    expect(late.tiers).toEqual([['1'], ['2', '3'], ['5', '4'], ['6'], ['7']]);
    expect(late.jobs['5'].status).toBe('skipped');
    expect(late.unplaced).toEqual(['7']);
  });

  it('keeps additional observed jobs that match one expression-derived name pattern', () => {
    const graph: GitHubWorkflowRunRowGraph = {
      sha: 'a'.repeat(40),
      jobs: [
        {
          id: 'deploy',
          template: 'Deploy ${{ github.ref_name }}',
          names: ['Deploy ${{ github.ref_name }}'],
          needs: [],
          dynamic: false,
        },
      ],
    };
    const observed = [
      {
        ...run.jobs[0],
        jobId: 'deploy-main',
        name: 'Deploy main',
      },
      {
        ...run.jobs[1],
        jobId: 'deploy-release',
        name: 'Deploy release',
      },
    ];

    const result = githubWorkflowDefinitionTiers(graph, observed);

    expect(result.tiers).toEqual([['deploy-main'], ['deploy-release']]);
    expect(result.unplaced).toEqual(['deploy-release']);
    expect(result.jobs['deploy-release']).toBeDefined();
  });

  it('matches dynamic matrix jobs whose constant name gains matrix values', () => {
    const graph: GitHubWorkflowRunRowGraph = {
      sha: 'a'.repeat(40),
      jobs: [
        {
          id: 'build',
          template: 'Build',
          names: [],
          needs: [],
          dynamic: true,
        },
      ],
    };
    const observed = [
      { ...run.jobs[0], jobId: 'linux', name: 'Build (ubuntu-latest)' },
      { ...run.jobs[1], jobId: 'windows', name: 'Build (windows-latest)' },
    ];

    const result = githubWorkflowDefinitionTiers(graph, observed);

    expect(result.tiers).toEqual([['linux', 'windows']]);
    expect(result.unplaced).toEqual([]);
    expect(result.jobs['definition:build']).toBeUndefined();
  });

  it('matches descendants reported for a nested reusable-workflow job', () => {
    const graph: GitHubWorkflowRunRowGraph = {
      sha: 'a'.repeat(40),
      jobs: [
        {
          id: 'pr/lint',
          template: 'PR / Lint',
          names: [],
          needs: [],
          dynamic: true,
        },
      ],
    };
    const observed = [
      {
        ...run.jobs[0],
        jobId: 'eslint',
        name: 'PR / Lint / ESLint',
      },
    ];

    const result = githubWorkflowDefinitionTiers(graph, observed);

    expect(result.tiers).toEqual([['eslint']]);
    expect(result.unplaced).toEqual([]);
    expect(result.jobs['definition:pr/lint']).toBeUndefined();
  });

  it('matches a template expression that resolves to an empty string', () => {
    const graph: GitHubWorkflowRunRowGraph = {
      sha: 'a'.repeat(40),
      jobs: [
        {
          id: 'deploy',
          template: 'Deploy-${{ inputs.suffix }}',
          names: ['Deploy-${{ inputs.suffix }}'],
          needs: [],
          dynamic: false,
        },
      ],
    };

    const result = githubWorkflowDefinitionTiers(graph, [
      { ...run.jobs[0], jobId: 'deploy', name: 'Deploy-' },
    ]);

    expect(result.tiers).toEqual([['deploy']]);
    expect(result.unplaced).toEqual([]);
    expect(result.jobs['definition:deploy:0']).toBeUndefined();
  });

  it('does not let an expression-only dynamic job consume a later static job', () => {
    const graph: GitHubWorkflowRunRowGraph = {
      sha: 'a'.repeat(40),
      jobs: [
        {
          id: 'matrix',
          template: '${{ matrix.label }}',
          names: [],
          needs: [],
          dynamic: true,
        },
        {
          id: 'deploy',
          template: 'Deploy',
          names: ['Deploy'],
          needs: ['matrix'],
          dynamic: false,
        },
      ],
    };
    const observed = [
      { ...run.jobs[0], jobId: 'matrix-linux', name: 'linux' },
      { ...run.jobs[1], jobId: 'deploy', name: 'Deploy' },
    ];

    const result = githubWorkflowDefinitionTiers(graph, observed);

    expect(result.tiers).toEqual([
      ['definition:matrix'],
      ['deploy'],
      ['matrix-linux'],
    ]);
    expect(result.unplaced).toEqual(['matrix-linux']);
  });

  it('matches remote expression templates without constructing a backtracking regex', () => {
    const dangerousTemplate = Array.from(
      { length: 20 },
      (_, index) => `\${{ matrix.value_${index} }}x`,
    ).join('');
    const graph: GitHubWorkflowRunRowGraph = {
      sha: 'a'.repeat(40),
      jobs: [
        {
          id: 'dynamic',
          template: dangerousTemplate,
          names: [],
          needs: [],
          dynamic: true,
        },
      ],
    };
    const regexpConstructor = jest
      .spyOn(globalThis, 'RegExp')
      .mockImplementation((): RegExp => {
        throw new Error('dynamic RegExp construction is unsafe');
      });

    try {
      const result = githubWorkflowDefinitionTiers(graph, [
        { ...run.jobs[0], jobId: 'unplaced', name: 'not-a-match' },
      ]);

      expect(result.tiers).toEqual([['definition:dynamic'], ['unplaced']]);
      expect(result.unplaced).toEqual(['unplaced']);
    } finally {
      regexpConstructor.mockRestore();
    }
  });

  it('renders the declared graph with placeholder dots that do not open anything', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onJobClick = jest.fn();
    act(() => {
      root.render(
        <GitHubWorkflowRunRow
          run={{
            ...run,
            jobs: [run.jobs[0]],
            definition: {
              sha: 'a'.repeat(40),
              jobs: [
                {
                  id: 'build',
                  template: 'Build macOS',
                  names: ['Build macOS'],
                  needs: [],
                  dynamic: false,
                },
                {
                  id: 'test',
                  template: 'Test',
                  names: ['Test'],
                  needs: ['build'],
                  dynamic: false,
                },
                {
                  id: 'publish',
                  template: 'Publish',
                  names: ['Publish'],
                  needs: ['test'],
                  dynamic: false,
                },
              ],
            },
          }}
          onOpen={jest.fn()}
          onJobClick={onJobClick}
        />,
      );
    });
    const tiers = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="dag-progress-tier"]',
      ),
    ).map((tier) =>
      Array.from(tier.querySelectorAll<HTMLElement>('[data-job-id]')).map(
        (dot) => [
          dot.getAttribute('data-job-id'),
          dot.getAttribute('aria-label'),
        ],
      ),
    );
    expect(tiers).toEqual([
      [['501', 'Build macOS: success']],
      [['definition:test:0', 'Test: pending']],
      [['definition:publish:0', 'Publish: pending']],
    ]);
    const placeholder = container.querySelector<HTMLButtonElement>(
      '[data-job-id="definition:test:0"]',
    );
    if (!placeholder) throw new Error('Expected a placeholder dot');
    act(() => placeholder.click());
    expect(onJobClick).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it('renders the run card with one dot per job and opens run and jobs on GitHub', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onOpen = jest.fn();
    const onJobClick = jest.fn();

    act(() => {
      root.render(
        <GitHubWorkflowRunRow
          run={run}
          onOpen={onOpen}
          onJobClick={onJobClick}
          renderWatcherButton={() => <span data-testid="watcher-slot" />}
        />,
      );
    });

    const card = container.querySelector<HTMLElement>(
      '[data-testid="github-workflow-run-card-101"]',
    );
    if (!card) throw new Error('Expected the run card');
    expect(card.textContent).toContain('in progress');
    expect(card.textContent).toContain('CI #42');
    expect(card.textContent).toContain('acme/api');
    expect(card.getAttribute('data-run-status')).toBe('in progress');
    expect(
      container.querySelector('[data-testid="watcher-slot"]'),
    ).not.toBeNull();
    expect(card.getAttribute('role')).toBeNull();
    expect(card.querySelector('[role="button"] button')).toBeNull();
    const runButton = card.querySelector<HTMLButtonElement>(
      '[data-testid="github-workflow-run-open-101"]',
    );
    if (!runButton) throw new Error('Expected the accessible run button');
    expect(runButton.tagName).toBe('BUTTON');

    const dots = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-job-id]'),
    );
    expect(dots.map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'Build macOS: success',
      'Test: running',
      'Publish: pending',
    ]);

    act(() => dots[1].click());
    expect(onJobClick).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: '502' }),
    );
    expect(onOpen).not.toHaveBeenCalled();

    act(() => runButton.click());
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() =>
      root.render(
        <GitHubWorkflowRunRow
          run={{
            ...run,
            state: { kind: 'terminal', conclusion: 'failure' },
            jobs: undefined,
          }}
          onOpen={onOpen}
          onJobClick={onJobClick}
        />,
      ),
    );
    expect(container.querySelectorAll('[data-job-id]')).toHaveLength(0);
    expect(card.textContent).toContain('failure');

    act(() => root.unmount());
    container.remove();
  });
});

/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
const fetchGitHubWorkflowRun = jest.fn();
const fetchGitHubWorkflowRunJobs = jest.fn();
const fetchGitHubWorkflowDefinitionGraph = jest.fn();
jest.mock('../lib/github-broker/workflow-definitions', () => ({
  fetchGitHubWorkflowDefinitionGraph: (...args: unknown[]) =>
    fetchGitHubWorkflowDefinitionGraph(...args),
}));
jest.mock('../lib/github-broker/workflow-runs', () => ({
  fetchGitHubWorkflowRun: (...args: unknown[]) =>
    fetchGitHubWorkflowRun(...args),
  fetchGitHubWorkflowRunJobs: (...args: unknown[]) =>
    fetchGitHubWorkflowRunJobs(...args),
}));

import {
  GitHubWorkflowRunObserver,
  MAX_DEFINITION_READ_ATTEMPTS,
  type GitHubWorkflowRunObservation,
  githubWorkflowRunBackoffDelayMs,
  githubWorkflowRunNextDelayMs,
  githubWorkflowRunPollDelayMs,
} from '../lib/github-workflow-run-observer';
import { GitHubBrokerError } from '../lib/github-broker';

const queuedSnapshot = {
  state: { kind: 'intermediate' as const, status: 'queued' as const },
  runAttempt: 1,
  htmlUrl: 'https://github.com/acme/api/actions/runs/1',
  workflowName: 'CI',
  runNumber: 1,
  observedAt: '2026-07-20T00:00:00.000Z',
};

describe('GitHubWorkflowRunObserver', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    fetchGitHubWorkflowRun.mockReset();
    fetchGitHubWorkflowRunJobs.mockReset();
    fetchGitHubWorkflowDefinitionGraph.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('coalesces duplicate subscriptions into one resource fetch and fans out through one batch', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const listSubscriptions = jest.fn().mockResolvedValue([
      {
        watcherId: 'watcher-a',
        repository: 'acme/api',
        runId: '1',
        runAttempt: 1,
        last: queuedSnapshot,
      },
      {
        watcherId: 'watcher-b',
        repository: 'acme/api',
        runId: '1',
        runAttempt: 1,
        last: queuedSnapshot,
      },
    ]);
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: true,
      snapshot: {
        ...queuedSnapshot,
        state: { kind: 'intermediate', status: 'in_progress' },
        observedAt: '2026-07-20T00:00:05.000Z',
      },
    });
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({ listSubscriptions, applyObservation });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);

    expect(fetchGitHubWorkflowRun).toHaveBeenCalledTimes(1);
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [
        expect.objectContaining({
          kind: 'snapshot',
          repository: 'acme/api',
          runId: '1',
        }),
      ],
    });
    observer.stop();
  });

  it('coalesces the same explicit attempt but keeps different attempts isolated', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const subscriptions = [
      {
        watcherId: 'attempt-1a',
        repository: 'acme/api',
        runId: '1',
        requestedAttempt: 1,
        runAttempt: 1,
        last: queuedSnapshot,
      },
      {
        watcherId: 'attempt-1b',
        repository: 'acme/api',
        runId: '1',
        requestedAttempt: 1,
        runAttempt: 1,
        last: queuedSnapshot,
      },
      {
        watcherId: 'attempt-2',
        repository: 'acme/api',
        runId: '1',
        requestedAttempt: 2,
        runAttempt: 2,
        last: { ...queuedSnapshot, runAttempt: 2 },
      },
    ];
    fetchGitHubWorkflowRun.mockImplementation(
      ({ requestedAttempt }: { requestedAttempt?: number }) =>
        Promise.resolve({
          changed: false,
          snapshot: {
            ...queuedSnapshot,
            runAttempt: requestedAttempt ?? 1,
          },
        }),
    );
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue(subscriptions),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);

    expect(fetchGitHubWorkflowRun).toHaveBeenCalledTimes(2);
    expect(fetchGitHubWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAttempt: 1 }),
    );
    expect(fetchGitHubWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAttempt: 2 }),
    );
    expect(applyObservation).toHaveBeenCalledWith({
      observations: expect.arrayContaining([
        expect.objectContaining({ requestedAttempt: 1 }),
        expect.objectContaining({ requestedAttempt: 2 }),
      ]),
    });
    observer.stop();
  });

  it('fetches jobs once for coalesced job-progress subscribers', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: false,
      snapshot: queuedSnapshot,
    });
    fetchGitHubWorkflowRunJobs.mockResolvedValue({
      changed: true,
      jobs: [
        {
          jobId: '10',
          name: 'Build',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/acme/api/actions/runs/1/job/10',
          observedAt: '2026-07-20T00:00:05.000Z',
        },
      ],
    });
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue([
        {
          watcherId: 'jobs-a',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: true,
        },
        {
          watcherId: 'jobs-b',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: true,
        },
      ]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);

    expect(fetchGitHubWorkflowRunJobs).toHaveBeenCalledTimes(1);
    expect(fetchGitHubWorkflowRunJobs).toHaveBeenCalledWith(
      expect.objectContaining({ runAttempt: 1, priority: 'watcher' }),
    );
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [
        expect.objectContaining({
          pinnedRunAttempt: 1,
          jobs: [expect.objectContaining({ jobId: '10' })],
        }),
      ],
    });
    observer.stop();
  });

  it('keeps observing the run when a best-effort jobs read fails', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: true,
      snapshot: {
        ...queuedSnapshot,
        state: { kind: 'intermediate', status: 'in_progress' },
      },
    });
    fetchGitHubWorkflowRunJobs.mockRejectedValue(new Error('jobs unavailable'));
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue([
        {
          watcherId: 'run-only',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: false,
        },
      ]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);

    expect(fetchGitHubWorkflowRunJobs).toHaveBeenCalledTimes(1);
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [
        expect.objectContaining({
          kind: 'snapshot',
          snapshot: expect.objectContaining({
            state: { kind: 'intermediate', status: 'in_progress' },
          }),
        }),
      ],
    });
    const observed: GitHubWorkflowRunObservation[] =
      applyObservation.mock.calls.map(([observation]) => observation);
    expect(observed[0]?.observations[0]).not.toHaveProperty('jobs');
    observer.stop();
  });

  it('retries a transient final jobs read before emitting a terminal run-only snapshot', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const terminalSnapshot = {
      ...queuedSnapshot,
      state: { kind: 'terminal' as const, conclusion: 'success' as const },
      observedAt: '2026-07-20T00:00:05.000Z',
    };
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: true,
      snapshot: terminalSnapshot,
    });
    fetchGitHubWorkflowRunJobs
      .mockRejectedValueOnce(new Error('jobs temporarily unavailable'))
      .mockResolvedValueOnce({
        changed: true,
        jobs: [
          {
            jobId: '10',
            name: 'Build',
            status: 'completed',
            conclusion: 'success',
            htmlUrl: 'https://github.com/acme/api/actions/runs/1/job/10',
            observedAt: '2026-07-20T00:00:05.000Z',
          },
        ],
      });
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue([
        {
          watcherId: 'run-only',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: false,
        },
      ]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);

    expect(applyObservation).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_100);
    expect(fetchGitHubWorkflowRunJobs).toHaveBeenCalledTimes(2);
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [
        expect.objectContaining({
          kind: 'snapshot',
          subscriberIds: ['run-only'],
          snapshot: terminalSnapshot,
          jobs: [expect.objectContaining({ jobId: '10' })],
        }),
      ],
    });
    observer.stop();
  });

  it('scopes a shared jobs failure while preserving run-only progress', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: true,
      snapshot: {
        ...queuedSnapshot,
        state: { kind: 'intermediate', status: 'in_progress' },
      },
    });
    fetchGitHubWorkflowRunJobs.mockRejectedValue(
      new GitHubBrokerError('not_found', 'jobs unavailable'),
    );
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue([
        {
          watcherId: 'run-only',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: false,
        },
        {
          watcherId: 'jobs-required',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: true,
        },
      ]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);

    expect(fetchGitHubWorkflowRun).toHaveBeenCalledTimes(1);
    expect(fetchGitHubWorkflowRunJobs).toHaveBeenCalledTimes(1);
    expect(applyObservation).toHaveBeenCalledWith({
      observations: expect.arrayContaining([
        expect.objectContaining({
          kind: 'snapshot',
          subscriberIds: ['run-only'],
          snapshot: expect.objectContaining({
            state: { kind: 'intermediate', status: 'in_progress' },
          }),
        }),
        expect.objectContaining({
          kind: 'source_failure',
          subscriberIds: ['jobs-required'],
        }),
      ]),
    });
    observer.stop();
  });

  it('surfaces a failed jobs read when a subscriber promised job events', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: true,
      snapshot: {
        ...queuedSnapshot,
        state: { kind: 'intermediate', status: 'in_progress' },
      },
    });
    fetchGitHubWorkflowRunJobs.mockRejectedValue(new Error('jobs unavailable'));
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue([
        {
          watcherId: 'jobs-required',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: true,
        },
      ]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);

    expect(fetchGitHubWorkflowRunJobs).toHaveBeenCalledTimes(1);
    const observed: GitHubWorkflowRunObservation[] =
      applyObservation.mock.calls.map(([observation]) => observation);
    expect(observed.flatMap((entry) => entry.observations)).toEqual([]);
    observer.stop();
  });

  it('reads the declared job graph best-effort for a bounded number of cycles', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const definitionSource = {
      path: '.github/workflows/ci.yml',
      sha: 'e'.repeat(40),
      referenced: [],
    };
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: false,
      snapshot: queuedSnapshot,
    });
    fetchGitHubWorkflowRunJobs.mockResolvedValue({ changed: false, jobs: [] });
    fetchGitHubWorkflowDefinitionGraph.mockRejectedValue(new Error('offline'));
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue([
        {
          watcherId: 'w',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: false,
          wantsDefinition: true,
          definitionSource,
        },
      ]),
      applyObservation,
    });
    await Promise.resolve();
    // Each cycle retries while the read keeps failing, then stops asking.
    for (let cycle = 0; cycle < MAX_DEFINITION_READ_ATTEMPTS + 2; cycle += 1) {
      await jest.advanceTimersByTimeAsync(15_000);
    }
    expect(fetchGitHubWorkflowDefinitionGraph).toHaveBeenCalledTimes(
      MAX_DEFINITION_READ_ATTEMPTS,
    );
    expect(fetchGitHubWorkflowDefinitionGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'acme/api',
        source: definitionSource,
        priority: 'watcher',
      }),
    );
    // The run itself was still observed on every cycle.
    expect(fetchGitHubWorkflowRun.mock.calls.length).toBeGreaterThanOrEqual(
      MAX_DEFINITION_READ_ATTEMPTS + 1,
    );
    observer.stop();
  });

  it('takes the definition source from a fresh poll when the persisted snapshot lacks it', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const definitionSource = {
      path: '.github/workflows/ci.yml',
      sha: 'e'.repeat(40),
      referenced: [],
    };
    const graph = {
      sha: 'e'.repeat(40),
      observedAt: '2026-07-20T00:00:05.000Z',
      jobs: [
        { id: 'a', template: 'A', names: ['A'], needs: [], dynamic: false },
      ],
    };
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: false,
      snapshot: { ...queuedSnapshot, definitionSource },
    });
    fetchGitHubWorkflowRunJobs.mockResolvedValue({ changed: false, jobs: [] });
    fetchGitHubWorkflowDefinitionGraph.mockResolvedValue(graph);
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue([
        {
          watcherId: 'w',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: false,
          wantsDefinition: true,
        },
      ]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);
    expect(fetchGitHubWorkflowDefinitionGraph).toHaveBeenCalledWith(
      expect.objectContaining({ source: definitionSource }),
    );
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [expect.objectContaining({ definition: graph })],
    });
    observer.stop();
  });

  it('delivers the graph with the observation once a read succeeds', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const graph = {
      sha: 'e'.repeat(40),
      observedAt: '2026-07-20T00:00:05.000Z',
      jobs: [
        { id: 'a', template: 'A', names: ['A'], needs: [], dynamic: false },
      ],
    };
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: false,
      snapshot: queuedSnapshot,
    });
    fetchGitHubWorkflowRunJobs.mockResolvedValue({ changed: false, jobs: [] });
    fetchGitHubWorkflowDefinitionGraph.mockResolvedValue(graph);
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue([
        {
          watcherId: 'w',
          repository: 'acme/api',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
          jobsRequired: false,
          wantsDefinition: true,
          definitionSource: {
            path: '.github/workflows/ci.yml',
            sha: 'e'.repeat(40),
            referenced: [],
          },
        },
      ]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [
        expect.objectContaining({ kind: 'snapshot', definition: graph }),
      ],
    });
    // Once read, the same resource does not read it again.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(fetchGitHubWorkflowDefinitionGraph).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it('delivers a cached definition when a later coalesced subscriber needs it', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const definitionSource = {
      path: '.github/workflows/ci.yml',
      sha: 'e'.repeat(40),
      referenced: [],
    };
    const graph = {
      sha: 'e'.repeat(40),
      observedAt: '2026-07-20T00:00:05.000Z',
      jobs: [
        { id: 'a', template: 'A', names: ['A'], needs: [], dynamic: false },
      ],
    };
    let subscriptions = [
      {
        watcherId: 'first',
        repository: 'acme/api',
        runId: '1',
        runAttempt: 1,
        last: queuedSnapshot,
        jobsRequired: false,
        wantsDefinition: true,
        definitionSource,
      },
    ];
    const listSubscriptions = jest
      .fn()
      .mockImplementation(() => Promise.resolve(subscriptions));
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: false,
      snapshot: queuedSnapshot,
    });
    fetchGitHubWorkflowRunJobs.mockResolvedValue({ changed: false, jobs: [] });
    fetchGitHubWorkflowDefinitionGraph.mockResolvedValue(graph);
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({ listSubscriptions, applyObservation });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);
    expect(fetchGitHubWorkflowDefinitionGraph).toHaveBeenCalledTimes(1);

    subscriptions = [
      { ...subscriptions[0], wantsDefinition: false },
      {
        ...subscriptions[0],
        watcherId: 'later',
        wantsDefinition: true,
      },
    ];
    applyObservation.mockClear();
    await observer.rescan();
    await jest.advanceTimersByTimeAsync(10_100);

    expect(fetchGitHubWorkflowDefinitionGraph).toHaveBeenCalledTimes(1);
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [
        expect.objectContaining({
          kind: 'snapshot',
          subscriberIds: ['first', 'later'],
          definition: graph,
        }),
      ],
    });
    observer.stop();
  });

  it('uses 15 seconds for waiting and backs unchanged active states to 10 seconds', () => {
    expect(
      githubWorkflowRunPollDelayMs(
        {
          ...queuedSnapshot,
          state: { kind: 'intermediate', status: 'waiting' },
        },
        true,
      ),
    ).toBe(15_000);
    expect(githubWorkflowRunPollDelayMs(queuedSnapshot, false)).toBe(10_000);
    expect(githubWorkflowRunPollDelayMs(queuedSnapshot, true)).toBe(5_000);
    expect([0, 1, 2, 3, 4].map(githubWorkflowRunBackoffDelayMs)).toEqual([
      10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });

  it('never jitters a cadence below the server poll-interval floor', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);

    expect(githubWorkflowRunNextDelayMs(5_000, 10_000)).toBe(10_000);
  });

  it('enqueues simultaneously due resources by oldest due time', async () => {
    jest
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.75)
      .mockReturnValueOnce(0.25)
      .mockReturnValue(0.5);
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: false,
      snapshot: queuedSnapshot,
    });
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn().mockResolvedValue([
        {
          watcherId: 'later',
          repository: 'acme/later',
          runId: '2',
          runAttempt: 1,
          last: queuedSnapshot,
        },
        {
          watcherId: 'earlier',
          repository: 'acme/earlier',
          runId: '1',
          runAttempt: 1,
          last: queuedSnapshot,
        },
      ]),
      applyObservation: jest.fn().mockResolvedValue(undefined),
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(6_000);

    expect(
      fetchGitHubWorkflowRun.mock.calls.map(([request]) => request),
    ).toEqual([
      expect.objectContaining({ repository: 'acme/earlier', runId: '1' }),
      expect.objectContaining({ repository: 'acme/later', runId: '2' }),
    ]);
    observer.stop();
  });

  it('discards an older rescan that completes after a newer subscription snapshot', async () => {
    let resolveFirst!: (
      value: Array<{
        watcherId: string;
        repository: string;
        runId: string;
        runAttempt: number;
        last: typeof queuedSnapshot;
      }>,
    ) => void;
    let resolveSecond!: typeof resolveFirst;
    const first = new Promise<Parameters<typeof resolveFirst>[0]>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Parameters<typeof resolveSecond>[0]>(
      (resolve) => {
        resolveSecond = resolve;
      },
    );
    const listSubscriptions = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockResolvedValue([]);
    fetchGitHubWorkflowRun.mockResolvedValue({
      changed: false,
      snapshot: queuedSnapshot,
    });
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions,
      applyObservation: jest.fn().mockResolvedValue(undefined),
    });
    await Promise.resolve();

    const newerRescan = observer.rescan();
    resolveSecond([
      {
        watcherId: 'newer',
        repository: 'acme/newer',
        runId: '2',
        runAttempt: 1,
        last: queuedSnapshot,
      },
    ]);
    await newerRescan;
    resolveFirst([
      {
        watcherId: 'stale',
        repository: 'acme/stale',
        runId: '1',
        runAttempt: 1,
        last: queuedSnapshot,
      },
    ]);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);

    expect(fetchGitHubWorkflowRun).toHaveBeenCalledTimes(1);
    expect(fetchGitHubWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'acme/newer', runId: '2' }),
    );
    observer.stop();
  });

  it('discards a late result after the last subscription is removed', async () => {
    let subscriptions = [
      {
        watcherId: 'watcher-a',
        repository: 'acme/api',
        runId: '1',
        runAttempt: 1,
        last: queuedSnapshot,
      },
    ];
    let release!: (value: unknown) => void;
    fetchGitHubWorkflowRun.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const observer = new GitHubWorkflowRunObserver();
    observer.configure({
      listSubscriptions: jest.fn(() => Promise.resolve(subscriptions)),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_100);
    subscriptions = [];
    await observer.rescan();
    release({ changed: true, snapshot: queuedSnapshot });
    await Promise.resolve();
    await Promise.resolve();
    expect(applyObservation).not.toHaveBeenCalled();
    observer.stop();
  });
});

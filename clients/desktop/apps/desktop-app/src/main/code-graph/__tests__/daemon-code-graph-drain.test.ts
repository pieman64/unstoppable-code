const mockGet = jest.fn<Promise<{ client: unknown }>, [unknown, unknown]>();
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonConnections: (): unknown => ({
    get: (caller: unknown, signal: unknown) => mockGet(caller, signal),
  }),
  getElectronDaemonFilesContext: (): Promise<unknown> =>
    Promise.resolve({ authorityId: 'local' }),
}));
jest.mock('../../canopy-runtime/electron-daemon-health', () => ({
  getElectronDaemonHealth: (): unknown => ({
    setConsumerEnabled: (): void => undefined,
    isLatched: (): boolean => false,
    noteFallback: (): void => undefined,
  }),
}));
const mockUnreachable = new WeakMap<object, string>();
jest.mock('../../canopy-runtime/electron-daemon-connection', () => ({
  daemonUnreachableReason: (error: object): string | null =>
    mockUnreachable.get(error) ?? null,
  markUnreachable: (error: object, reason: string): object => {
    mockUnreachable.set(error, reason);
    return error;
  },
}));
const mockExperimentEnabled = jest.fn<boolean, []>(() => false);
jest.mock('../../services/labs-experiments-runtime', () => ({
  getLabsExperimentsService: (): unknown => ({
    getSnapshot: () => ({
      ready: true,
      experiments: [
        { id: 'daemon-code-graph', enabled: mockExperimentEnabled() },
      ],
    }),
  }),
}));
const mockWarn = jest.fn();
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): void => {
    mockWarn(...args);
  },
}));

import {
  buildCodeGraphInDaemon,
  drainDaemonCodeGraphWorktree,
  noteDaemonCodeGraphFallback,
  queryCodeGraphInDaemon,
} from '../daemon-code-graph-route';

const SCOPE = {
  kind: 'worktree' as const,
  workspaceId: 'project',
  worktreeId: 'task',
  mode: 'verified' as const,
};

function daemon(cancel: () => Promise<unknown>): {
  instructions: Array<[string, unknown]>;
} {
  const instructions: Array<[string, unknown]> = [];
  mockGet.mockResolvedValue({
    client: {
      instruction: (name: string, params: unknown): Promise<unknown> => {
        instructions.push([name, params]);
        return name === 'worker.codeGraph.builds.cancel'
          ? cancel()
          : Promise.resolve({ kind: 'worktree' });
      },
    },
  });
  return { instructions };
}

describe('daemon code-graph worktree drain (CAN-5089)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockWarn.mockReset();
    mockExperimentEnabled.mockReturnValue(false);
  });

  it('never contacts the daemon for a worktree it neither built nor routes', async () => {
    await drainDaemonCodeGraphWorktree('project', 'never-built');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("ends a built worktree's daemon builds through worker.codeGraph.builds.cancel and waits for it", async () => {
    let finish: () => void = () => undefined;
    const { instructions } = daemon(
      () =>
        new Promise((resolve) => {
          finish = (): void => resolve({ canceled: 1 });
        }),
    );
    await buildCodeGraphInDaemon(SCOPE);
    let drained = false;
    const draining = drainDaemonCodeGraphWorktree('project', 'task').then(
      () => {
        drained = true;
      },
    );
    for (let turn = 0; turn < 20 && instructions.length < 2; turn += 1)
      await Promise.resolve();
    expect(instructions[1]).toEqual([
      'worker.codeGraph.builds.cancel',
      { workspaceId: 'project', worktreeId: 'task' },
    ]);
    expect(drained).toBe(false);
    finish();
    await draining;
    expect(drained).toBe(true);
  });

  it('asks the daemon while the experiment routes to it, even after a restart', async () => {
    mockExperimentEnabled.mockReturnValue(true);
    const { instructions } = daemon(() => Promise.resolve({ canceled: 0 }));
    await drainDaemonCodeGraphWorktree('project', 'other');
    expect(instructions).toEqual([
      [
        'worker.codeGraph.builds.cancel',
        { workspaceId: 'project', worktreeId: 'other' },
      ],
    ]);
  });

  it('logs a drain the daemon could not take and lets the cleanup go on', async () => {
    daemon(() => Promise.reject(new Error('refused')));
    await buildCodeGraphInDaemon({ ...SCOPE, worktreeId: 'failing' });
    await expect(
      drainDaemonCodeGraphWorktree('project', 'failing'),
    ).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('reads a summary whose session dropped under it as an unreachable daemon', async () => {
    const session = new AbortController();
    const dropped = new Error('connection closed');
    mockGet.mockResolvedValue({
      client: {
        signal: session.signal,
        query: (): Promise<unknown> => {
          session.abort();
          return Promise.reject(dropped);
        },
      },
    });
    const failure = await queryCodeGraphInDaemon({
      scope: { workspaceId: 'project', worktreeId: 'task' },
      queryKind: 'ui-summary',
      read: { kind: 'summary' },
    }).catch((error: unknown) => error);
    expect(failure).toBe(dropped);
    expect(noteDaemonCodeGraphFallback(failure)).toBe(true);
  });

  it('keeps a refusal from a live session as the answer', async () => {
    const refused = new Error('refused');
    mockGet.mockResolvedValue({
      client: {
        signal: new AbortController().signal,
        query: (): Promise<unknown> => Promise.reject(refused),
      },
    });
    const failure = await queryCodeGraphInDaemon({
      scope: { workspaceId: 'project', worktreeId: 'task' },
      queryKind: 'ui-summary',
      read: { kind: 'summary' },
    }).catch((error: unknown) => error);
    expect(noteDaemonCodeGraphFallback(failure)).toBe(false);
  });
});

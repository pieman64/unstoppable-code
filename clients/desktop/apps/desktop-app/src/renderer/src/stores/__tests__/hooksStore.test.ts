import type {
  HookDescriptor,
  HookRunResponse,
} from '@canopy/desktop-shared/types';
import { useHooksStore, flushPendingHookOutputs } from '../hooksStore';

function createTestDescriptor(
  overrides: Partial<HookDescriptor> = {},
): HookDescriptor {
  return {
    hookKey: 'project:pr:create',
    triggerName: 'pr:create',
    label: 'PR Created',
    actions: [{ type: 'command', command: 'echo hello' }],
    target: 'project',
    ...overrides,
  };
}

function createSuccessResponse(): HookRunResponse {
  return {
    success: true,
    exitCode: 0,
    output: 'done',
    timedOut: false,
    durationMs: 100,
  };
}

function createFailureResponse(): HookRunResponse {
  return {
    success: false,
    exitCode: 1,
    output: 'error',
    timedOut: false,
    durationMs: 200,
  };
}

function createStoppedResponse(): HookRunResponse {
  return {
    success: false,
    stopped: true,
    exitCode: 2,
    output: 'stopped',
    timedOut: false,
    durationMs: 150,
  };
}

beforeEach(() => {
  useHooksStore.setState({ runs: {} });
});

describe('hooksStore', () => {
  describe('loadWorktreeRuns', () => {
    it('restores the active action index from a running snapshot', async () => {
      const hook = createTestDescriptor({
        actions: [
          { type: 'command', command: 'echo first' },
          { type: 'command', command: 'read value', interactive: true },
        ],
      });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          api: {
            loadWorktreeHookRuns: jest.fn().mockResolvedValue([
              {
                projectId: 'proj-hydrate',
                worktreeId: 'wt-hydrate',
                hook,
                status: 'running',
                outputLines: ['waiting for input'],
                exitCode: null,
                timedOut: false,
                durationMs: 10,
                startedAt: '2026-08-10T12:00:00.000Z',
                activeActionIndex: 1,
              },
            ]),
          },
        },
      });

      await useHooksStore
        .getState()
        .loadWorktreeRuns('proj-hydrate', 'wt-hydrate');

      expect(
        useHooksStore.getState().runs['proj-hydrate/wt-hydrate'][
          'project:pr:create'
        ].activeActionIndex,
      ).toBe(1);
    });
  });

  describe('startRun', () => {
    it('creates a running hook entry', () => {
      const hook = createTestDescriptor();
      useHooksStore.getState().startRun('proj-1', 'wt-1', hook);

      const runs = useHooksStore.getState().runs['proj-1/wt-1'];
      expect(runs).toBeDefined();
      const entry = runs['project:pr:create'];
      expect(entry).toBeDefined();
      expect(entry.status).toBe('running');
      expect(entry.label).toBe('PR Created');
      expect(entry.triggerName).toBe('pr:create');
    });
  });

  describe('startRunFromEvent', () => {
    it('delegates to startRun via event shape', () => {
      const hook = createTestDescriptor();
      useHooksStore.getState().startRunFromEvent({
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        hook,
      });

      const entry =
        useHooksStore.getState().runs['proj-1/wt-1']['project:pr:create'];
      expect(entry.status).toBe('running');
    });
  });

  describe('completeRun', () => {
    it('marks a running hook as success', () => {
      const hook = createTestDescriptor();
      useHooksStore.getState().startRun('proj-1', 'wt-1', hook);
      useHooksStore
        .getState()
        .completeRun(
          'proj-1',
          'wt-1',
          'project:pr:create',
          createSuccessResponse(),
        );

      const entry =
        useHooksStore.getState().runs['proj-1/wt-1']['project:pr:create'];
      expect(entry.status).toBe('success');
      expect(entry.exitCode).toBe(0);
      expect(entry.durationMs).toBe(100);
    });

    it('marks a running hook as failed', () => {
      const hook = createTestDescriptor();
      useHooksStore.getState().startRun('proj-1', 'wt-1', hook);
      useHooksStore
        .getState()
        .completeRun(
          'proj-1',
          'wt-1',
          'project:pr:create',
          createFailureResponse(),
        );

      const entry =
        useHooksStore.getState().runs['proj-1/wt-1']['project:pr:create'];
      expect(entry.status).toBe('failed');
      expect(entry.exitCode).toBe(1);
    });

    it('marks a running hook as stopped', () => {
      const hook = createTestDescriptor();
      useHooksStore.getState().startRun('proj-1', 'wt-1', hook);
      useHooksStore
        .getState()
        .completeRun(
          'proj-1',
          'wt-1',
          'project:pr:create',
          createStoppedResponse(),
        );

      const entry =
        useHooksStore.getState().runs['proj-1/wt-1']['project:pr:create'];
      expect(entry.status).toBe('stopped');
      expect(entry.exitCode).toBe(2);
    });

    it('is a no-op when worktree runs do not exist', () => {
      const before = useHooksStore.getState();
      useHooksStore
        .getState()
        .completeRun(
          'proj-1',
          'wt-1',
          'project:pr:create',
          createSuccessResponse(),
        );
      expect(useHooksStore.getState()).toBe(before);
    });
  });

  describe('completeRunFromEvent', () => {
    it('creates and completes a run from an event', () => {
      const hook = createTestDescriptor();
      useHooksStore.getState().completeRunFromEvent({
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        hook,
        result: createSuccessResponse(),
      });

      const entry =
        useHooksStore.getState().runs['proj-1/wt-1']['project:pr:create'];
      expect(entry.status).toBe('success');
    });
  });

  describe('appendOutput + flush', () => {
    it('batches output and flushes to the store', () => {
      const hook = createTestDescriptor();
      useHooksStore.getState().startRun('proj-1', 'wt-1', hook);

      useHooksStore.getState().appendOutput({
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        hook,
        lines: ['line-1', 'line-2'],
      });

      // Before flush, output may or may not be applied (buffered)
      flushPendingHookOutputs();

      const entry =
        useHooksStore.getState().runs['proj-1/wt-1']['project:pr:create'];
      expect(entry.outputLines).toEqual(['line-1', 'line-2']);
    });

    it('retains active runs without buffering output after unload', () => {
      const hook = createTestDescriptor();
      useHooksStore.getState().startRun('proj-1', 'wt-1', hook);
      useHooksStore.getState().appendOutput({
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        hook,
        lines: ['visible output'],
      });
      flushPendingHookOutputs();

      useHooksStore.getState().unloadWorktreeRuns('proj-1', 'wt-1');

      let entry =
        useHooksStore.getState().runs['proj-1/wt-1']['project:pr:create'];
      expect(entry.status).toBe('running');
      expect(entry.outputLines).toEqual([]);

      useHooksStore.getState().appendOutput({
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        hook,
        lines: ['hidden output'],
      });
      flushPendingHookOutputs();

      entry = useHooksStore.getState().runs['proj-1/wt-1']['project:pr:create'];
      expect(entry.outputLines).toEqual([]);

      useHooksStore.getState().completeRunFromEvent({
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        hook,
        result: createSuccessResponse(),
      });

      entry = useHooksStore.getState().runs['proj-1/wt-1']['project:pr:create'];
      expect(entry.status).toBe('success');
    });
  });

  describe('cleanupWorktree', () => {
    it('removes all runs for the specified worktree', () => {
      const hook = createTestDescriptor();
      useHooksStore.getState().startRun('proj-1', 'wt-1', hook);
      useHooksStore.getState().startRun('proj-1', 'wt-2', hook);

      useHooksStore.getState().cleanupWorktree('proj-1', 'wt-1');

      expect(useHooksStore.getState().runs['proj-1/wt-1']).toBeUndefined();
      expect(useHooksStore.getState().runs['proj-1/wt-2']).toBeDefined();
    });

    it('is a no-op for non-existent worktree', () => {
      useHooksStore.getState().cleanupWorktree('proj-1', 'wt-999');
      expect(useHooksStore.getState().runs).toEqual({});
    });
  });
});

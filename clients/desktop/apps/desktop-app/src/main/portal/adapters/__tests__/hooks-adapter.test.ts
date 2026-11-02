import type {
  PortalEntityEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import {
  handlePortalHookCancel,
  handlePortalHookPause,
  handlePortalHookRun,
} from '../hooks-adapter';
import type { PortalAdapterContext } from '../types';
import {
  runHookCommand,
  cancelHook,
  changeWorktreeHookPause,
  listHooks,
} from '../../../services/hooks-service';
import { logMainProcessError } from '../../../lib/main-process-logging';
import { PortalServiceError } from '../../../services/portal-service-error';

jest.mock('../../../services/hooks-service', () => ({
  cancelHook: jest.fn(),
  changeWorktreeHookPause: jest.fn(),
  getHookSourceInfo: jest.fn(),
  hookToPortalEntity: (hook: {
    hookId: string;
    workspaceLocalId: string;
    worktreeLocalId: string;
  }): PortalEntityEnvelope => ({
    entityType: 'hook_descriptor',
    localId: hook.hookId,
    parentLocalId: `${hook.workspaceLocalId}:${hook.worktreeLocalId}`,
    payload: hook,
  }),
  listHooks: jest.fn(),
  runHookCommand: jest.fn(),
}));
jest.mock('../../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

const mockedRunHookCommand = jest.mocked(runHookCommand);
const mockedCancelHook = jest.mocked(cancelHook);
const mockedListHooks = jest.mocked(listHooks);
const mockedChangeWorktreeHookPause = jest.mocked(changeWorktreeHookPause);
const mockedLogMainProcessError = jest.mocked(logMainProcessError);

function adapterContext(events: PortalEventEnvelope[]): PortalAdapterContext {
  return {
    getWindow: () => null,
    enqueueEvent: (event) => events.push(event),
    complete: (command, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: command.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (command, code, message): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: command.id,
        payload: { error: { code, message } },
      } as PortalEventEnvelope);
    },
  };
}

describe('hooks portal adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completes immediately while the hook remains active', async () => {
    const events: PortalEventEnvelope[] = [];
    let registered = false;
    mockedRunHookCommand.mockImplementation((_request, options) => {
      registered = true;
      options?.onEnqueued?.();
      return new Promise<never>(() => undefined);
    });
    mockedCancelHook.mockImplementation(() => {
      if (!registered) {
        throw new Error('run was not registered');
      }
      return Promise.resolve({
        success: false,
        stopped: true,
        exitCode: null,
        output: '',
        timedOut: false,
        durationMs: 1,
      });
    });
    const context = adapterContext(events);

    await handlePortalHookRun(
      {
        id: 'cmd-1',
        sequence: 7,
        type: 'portal.hook.run',
        payload: {
          target: 'project',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          triggerName: 'pre-commit',
        },
        createdAt: '2026-05-06T00:00:00.000Z',
        expiresAt: null,
      },
      context,
    );

    expect(mockedRunHookCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ portalCommandId: 'cmd-1' }),
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
    expect(events[0]).toMatchObject({ payload: { result: { ok: true } } });

    await handlePortalHookCancel(
      {
        id: 'cmd-2',
        sequence: 8,
        type: 'portal.hook.cancel',
        payload: {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          hookKey: 'hook-1',
        },
        createdAt: '2026-05-06T00:00:00.000Z',
        expiresAt: null,
      },
      context,
    );
    expect(mockedCancelHook).toHaveBeenCalled();
  });

  it('fails the command when PR snapshot resolution rejects before start', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedRunHookCommand.mockRejectedValue(
      new PortalServiceError(
        'execution_failed',
        'No current PR snapshot exists for this worktree.',
      ),
    );

    await handlePortalHookRun(
      {
        id: 'cmd-1',
        sequence: 7,
        type: 'portal.hook.run',
        payload: {
          target: 'project',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          triggerName: 'pre-commit',
        },
        createdAt: '2026-05-06T00:00:00.000Z',
        expiresAt: null,
      },
      adapterContext(events),
    );

    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
    expect(events[0]).toMatchObject({
      payload: {
        error: {
          code: 'execution_failed',
          message: 'No current PR snapshot exists for this worktree.',
        },
      },
    });
    expect(mockedLogMainProcessError).not.toHaveBeenCalled();
  });

  it('cancel passes command correlation to the hook service before command completion', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedCancelHook.mockResolvedValue({
      success: false,
      stopped: true,
      exitCode: null,
      output: '',
      timedOut: false,
      durationMs: 1,
    });

    await handlePortalHookCancel(
      {
        id: 'cmd-2',
        sequence: 8,
        type: 'portal.hook.cancel',
        payload: {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          hookKey: 'hook-1',
        },
        createdAt: '2026-05-06T00:00:00.000Z',
        expiresAt: null,
      },
      adapterContext(events),
    );

    expect(mockedCancelHook).toHaveBeenCalledWith(expect.any(Object), {
      portalCommandId: 'cmd-2',
    });
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('logs a detached hook rejection after acknowledging start', async () => {
    const events: PortalEventEnvelope[] = [];
    const failure = new Error('hook failed after start');
    mockedRunHookCommand.mockImplementation((_request, options) => {
      options?.onEnqueued?.();
      return Promise.reject(failure);
    });

    await handlePortalHookRun(
      {
        id: 'cmd-3',
        sequence: 9,
        type: 'portal.hook.run',
        payload: {
          target: 'project',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          triggerName: 'pre-commit',
        },
        createdAt: '2026-05-06T00:00:00.000Z',
        expiresAt: null,
      },
      adapterContext(events),
    );
    await Promise.resolve();

    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
    expect(mockedLogMainProcessError).toHaveBeenCalledWith(
      'Portal hook execution failed after it started.',
      failure,
    );
  });

  it.each([
    ['portal.hook.pause', 'hook-a', true],
    ['portal.hook.resume', 'hook-a', false],
  ] as const)(
    '%s updates one hook and re-emits refreshed descriptors',
    async (type, hookKey, paused) => {
      const events: PortalEventEnvelope[] = [];
      const before = [
        {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          hookId: 'hook-a',
          hookKey: 'hook-a',
          name: 'Hook A',
          triggerName: 'pre-commit',
          target: 'project' as const,
          source: 'project',
          paused: !paused,
        },
      ];
      mockedListHooks
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce([{ ...before[0], paused }]);
      mockedChangeWorktreeHookPause.mockResolvedValue({
        worktree: {} as never,
        pausedHookKeys: paused ? ['hook-a'] : [],
      });

      await handlePortalHookPause(
        {
          id: 'cmd-pause',
          sequence: 10,
          type,
          payload: { projectId: 'ws-1', worktreeId: 'wt-1', hookKey },
          createdAt: '2026-05-06T00:00:00.000Z',
          expiresAt: null,
        },
        adapterContext(events),
      );

      // The change names the key, so a competing pause or resume is kept.
      expect(mockedChangeWorktreeHookPause).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        change: { kind: paused ? 'pause' : 'resume', hookKeys: ['hook-a'] },
        source: 'portal',
      });
      expect(events[0]).toMatchObject({
        type: 'portal.hook.event',
        commandId: 'cmd-pause',
        payload: {
          kind: 'upsert',
          entity: {
            entityType: 'hook_descriptor',
            localId: 'hook-a',
            payload: { paused },
          },
        },
      });
      expect(events[1]).toMatchObject({
        type: 'portal.command.completed',
        payload: { result: { pausedHookKeys: paused ? ['hook-a'] : [] } },
      });
    },
  );

  it('pauses all hooks through the same payload contract', async () => {
    const events: PortalEventEnvelope[] = [];
    const hooks = ['hook-a', 'hook-b'].map((hookKey) => ({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      hookId: hookKey,
      hookKey,
      name: hookKey,
      triggerName: 'pre-commit',
      target: 'project' as const,
      source: 'project',
      paused: false,
    }));
    mockedListHooks
      .mockResolvedValueOnce(hooks)
      .mockResolvedValueOnce(hooks.map((hook) => ({ ...hook, paused: true })));
    mockedChangeWorktreeHookPause.mockResolvedValue({
      worktree: {} as never,
      pausedHookKeys: ['deleted-hook', 'hook-a', 'hook-b'],
    });

    await handlePortalHookPause(
      {
        id: 'cmd-all',
        sequence: 11,
        type: 'portal.hook.pause',
        payload: { projectId: 'ws-1', worktreeId: 'wt-1', all: true },
        createdAt: '2026-05-06T00:00:00.000Z',
        expiresAt: null,
      },
      adapterContext(events),
    );

    expect(mockedChangeWorktreeHookPause).toHaveBeenCalledWith(
      expect.objectContaining({
        change: { kind: 'pause', hookKeys: ['hook-a', 'hook-b'] },
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'portal.command.completed',
      payload: {
        result: { pausedHookKeys: ['deleted-hook', 'hook-a', 'hook-b'] },
      },
    });
    expect(
      events.filter((event) => event.type === 'portal.hook.event'),
    ).toHaveLength(2);
  });

  it('fails with not_found when a single hookKey is absent', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedListHooks.mockResolvedValueOnce([]);

    await handlePortalHookPause(
      {
        id: 'cmd-missing',
        sequence: 12,
        type: 'portal.hook.pause',
        payload: {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          hookKey: 'missing-hook',
        },
        createdAt: '2026-05-06T00:00:00.000Z',
        expiresAt: null,
      },
      adapterContext(events),
    );

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'not_found' } },
    });
    expect(mockedChangeWorktreeHookPause).not.toHaveBeenCalled();
  });

  it.each([{ hookKey: 'hook-a', all: true }, {}])(
    'rejects both-or-neither hook selection: %p',
    async (payload) => {
      const events: PortalEventEnvelope[] = [];

      await handlePortalHookPause(
        {
          id: 'cmd-invalid',
          sequence: 12,
          type: 'portal.hook.pause',
          payload: { projectId: 'ws-1', worktreeId: 'wt-1', ...payload },
          createdAt: '2026-05-06T00:00:00.000Z',
          expiresAt: null,
        },
        adapterContext(events),
      );

      expect(events[0]).toMatchObject({
        type: 'portal.command.failed',
        payload: { error: { code: 'invalid_payload' } },
      });
      expect(mockedChangeWorktreeHookPause).not.toHaveBeenCalled();
    },
  );
});

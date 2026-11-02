const mockScores: Record<string, number> = {};
const mockSetups: { watchers: Record<string, unknown>[] }[] = [];
const mockArmedByKey = new Map<string, { id: string }>();
let mockSetupStatus: 'created' | 'deduped' = 'created';
const mockSettledChecks: [string, string | null][] = [];

jest.mock('../../lib/workspace-registry', () => ({
  ...jest.requireActual<object>('../../lib/workspace-registry'),
  isCoworkWorkspace: (projectId: string): boolean => projectId === 'cowork',
}));

jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): object => ({
    fireIfTurnSettled: (
      watcherId: string,
      _destination: unknown,
      turnUserMessageId: string | null,
    ): Promise<boolean> => {
      mockSettledChecks.push([watcherId, turnUserMessageId]);
      return Promise.resolve(false);
    },
    findWatcherCreatedBy: (toolUseId: string): Promise<object | null> =>
      Promise.resolve(mockArmedByKey.get(toolUseId) ?? null),
    setup: (
      input: {
        watchers: Record<string, unknown>[];
      },
      _destination: unknown,
      context?: { toolUseId?: string },
    ): Promise<object> => {
      mockSetups.push(input);
      if (context?.toolUseId) {
        mockArmedByKey.set(context.toolUseId, {
          id: `watcher-${mockSetups.length}`,
        });
      }
      return Promise.resolve({
        ok: true,
        results: [
          {
            status: mockSetupStatus,
            watcher: { id: `watcher-${mockSetups.length}` },
          },
        ],
      });
    },
    search: (input: { trigger: string }): Promise<object> =>
      Promise.resolve({
        catalog:
          mockScores[input.trigger] === undefined
            ? []
            : [
                {
                  trigger: input.trigger,
                  title: input.trigger,
                  targetKind: 'chat',
                  setupTool: 'setup_watchers',
                  requiredFields: [],
                  optionalFields: [],
                  optionalEntryFields: [],
                  score: mockScores[input.trigger],
                },
              ],
        activeWatchers: [],
      }),
  }),
}));

import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import {
  desktopChatWatcherPort,
  desktopWatcherPort,
} from '../desktop-watcher-port';
import { agentWriteMessageId } from '../desktop-write-turns';

function runtime(projectId: string): CanopyInjectedToolRuntime {
  return {
    requestUserAnswers: () => Promise.resolve([]),
    loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
    worktreeWatcherRuntime: { projectId, worktreeId: 'wt-1', chatId: 'chat-1' },
  };
}

async function searchedTriggers(
  projectId: string,
  limit: number,
): Promise<unknown> {
  const result = await desktopWatcherPort.search(
    { query: 'run', limit, includeActive: false },
    { host: runtime(projectId) },
  );
  const json: unknown = JSON.parse(result.text);
  return typeof json === 'object' && json !== null && 'catalog' in json
    ? (json.catalog as { trigger: string }[]).map((entry) => entry.trigger)
    : undefined;
}

describe('desktop watcher search', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockScores)) delete mockScores[key];
    mockScores.github_workflow_runs_changed = 9;
    mockScores.worktree_hook_triggered = 8;
    mockScores.automation_run = 5;
  });

  it('limits a Cowork search after dropping the triggers Cowork does not offer', async () => {
    await expect(searchedTriggers('cowork', 2)).resolves.toEqual([
      'github_workflow_runs_changed',
      'automation_run',
    ]);
  });

  it('keeps every searchable trigger in a worktree chat', async () => {
    await expect(searchedTriggers('project', 3)).resolves.toEqual([
      'github_workflow_runs_changed',
      'worktree_hook_triggered',
      'automation_run',
    ]);
  });
});

describe('desktop chat watcher port', () => {
  it('passes allowDuplicate to the watcher service only when it is set', async () => {
    mockSetups.length = 0;
    const call = {
      host: runtime('project'),
      scope: { workspaceId: 'project', worktreeId: 'wt-1', chatId: 'chat-1' },
    };
    const target = {
      workspaceId: 'project',
      worktreeId: 'wt-2',
      chatId: 'chat-2',
    };
    await desktopChatWatcherPort.armChatCompletion(
      { target, armForNextCompletion: true, idempotencyKey: 'k1' },
      call,
    );
    await desktopChatWatcherPort.armChatCompletion(
      {
        target,
        armForNextCompletion: true,
        allowDuplicate: true,
        idempotencyKey: 'k2',
      },
      call,
    );
    expect(
      mockSetups.map((setup) => setup.watchers[0]?.allowDuplicate),
    ).toEqual([undefined, true]);
    expect(mockSetups[0]?.watchers[0]).not.toHaveProperty('allowDuplicate');
  });

  it('reports whether the watcher service created the watcher or returned an existing one', async () => {
    mockSetups.length = 0;
    const call = {
      host: runtime('project'),
      scope: { workspaceId: 'project', worktreeId: 'wt-1', chatId: 'chat-1' },
    };
    const input = {
      target: { workspaceId: 'project', worktreeId: 'wt-2', chatId: 'chat-2' },
      armForNextCompletion: true,
      idempotencyKey: 'k3',
    };
    mockSetupStatus = 'created';
    await expect(
      desktopChatWatcherPort.armChatCompletion(input, call),
    ).resolves.toEqual({ watcherId: 'watcher-1', created: true });
    mockSetupStatus = 'deduped';
    await expect(
      desktopChatWatcherPort.armChatCompletion(
        { ...input, idempotencyKey: 'k4' },
        call,
      ),
    ).resolves.toEqual({ watcherId: 'watcher-2', created: false });
    mockSetupStatus = 'created';
  });

  it.each(['project', 'cowork'])(
    'binds a %s inline watcher to the turn its write submits',
    async (workspaceId) => {
      mockSetups.length = 0;
      const call = {
        host: runtime(workspaceId),
        scope: { workspaceId, worktreeId: 'wt-1', chatId: 'chat-1' },
      };
      const target = { workspaceId, worktreeId: 'wt-2', chatId: 'chat-2' };
      await desktopChatWatcherPort.armChatCompletion(
        {
          target,
          armForNextCompletion: true,
          allowDuplicate: true,
          forWrite: { idempotencyKey: `write-${workspaceId}` },
          idempotencyKey: `write-${workspaceId}:watcher-0`,
        },
        call,
      );
      await desktopChatWatcherPort.armChatCompletion(
        { target, armForNextCompletion: true, idempotencyKey: 'setup-0' },
        call,
      );
      expect(
        mockSetups.map(
          (setup) =>
            (setup.watchers[0]?.target as Record<string, unknown> | undefined)
              ?.turnUserMessageId,
        ),
      ).toEqual([agentWriteMessageId(`write-${workspaceId}`), undefined]);
    },
  );

  it('resolves a bound watcher against its write turn whenever it is armed or returned', async () => {
    mockSetups.length = 0;
    mockSettledChecks.length = 0;
    mockArmedByKey.clear();
    const call = {
      host: runtime('project'),
      scope: { workspaceId: 'project', worktreeId: 'wt-1', chatId: 'chat-1' },
    };
    const target = { workspaceId: 'project', worktreeId: 'wt-2', chatId: 'c2' };
    const bound = {
      target,
      armForNextCompletion: false,
      allowDuplicate: true,
      forWrite: { idempotencyKey: 'settled-write' },
      idempotencyKey: 'settled-write:watcher-0',
    };
    const armed = await desktopChatWatcherPort.armChatCompletion(bound, call);
    await desktopChatWatcherPort.armChatCompletion(bound, call);
    await desktopChatWatcherPort.armChatCompletion(
      { target, armForNextCompletion: true, idempotencyKey: 'settled-setup' },
      call,
    );
    expect(mockSettledChecks).toEqual([
      [armed.watcherId, agentWriteMessageId('settled-write')],
      [armed.watcherId, agentWriteMessageId('settled-write')],
    ]);
    expect(
      mockSetups.map((setup) => setup.watchers[0]?.armForNextCompletion),
    ).toEqual([true, true]);
  });

  it('reuses the watcher a key already armed instead of arming another', async () => {
    mockSetups.length = 0;
    mockArmedByKey.clear();
    const call = {
      host: runtime('project'),
      scope: { workspaceId: 'project', worktreeId: 'wt-1', chatId: 'chat-1' },
    };
    const input = {
      target: { workspaceId: 'project', worktreeId: 'wt-2', chatId: 'chat-2' },
      armForNextCompletion: true,
      allowDuplicate: true,
      idempotencyKey: 'write-1:watcher-0',
    };
    const first = await desktopChatWatcherPort.armChatCompletion(input, call);
    await expect(
      desktopChatWatcherPort.armChatCompletion(input, call),
    ).resolves.toEqual(first);
    expect(mockSetups).toHaveLength(1);
  });
});

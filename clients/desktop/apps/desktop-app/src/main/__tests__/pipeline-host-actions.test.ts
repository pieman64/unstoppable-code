jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
  readWorkspaceWorktreesDetailed: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  readWorkEntriesFileStrict: jest.fn(),
}));
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));
jest.mock('../services/sidebar-item-groups-service', () => ({
  SidebarItemGroupRefusalError: jest.requireActual<
    typeof SidebarItemGroupsServiceModule
  >('../services/sidebar-item-groups-service').SidebarItemGroupRefusalError,
  sidebarItemGroupsService: {
    assignItemToNamedGroup: jest.fn(),
    moveItem: jest.fn(),
    list: jest.fn(),
  },
}));

import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import type * as SidebarItemGroupsServiceModule from '../services/sidebar-item-groups-service';
import type {
  CoworkWorkEntriesFile,
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  PipelineHostRefusal,
  type MoveToGroupInputs,
} from '@canopy/desktop-shared/pipelines/host-actions';
import type {
  PipelineHostActionCaller,
  PipelineHostActionResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from '../lib/workspace-persistence';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  sidebarItemGroupsService,
  SidebarItemGroupRefusalError,
} from '../services/sidebar-item-groups-service';
import { createDesktopPipelineHostActions } from '../pipelines/host-actions';

const readConfig = jest.mocked(readWorkspaceConfigDetailed);
const readEntries = jest.mocked(readWorkEntriesFileStrict);
const resolveCowork = jest.mocked(resolveCoworkWorkspaceId);
const readWorktrees = jest.mocked(readWorkspaceWorktreesDetailed);
const logError = jest.mocked(logMainProcessError);
const service = jest.mocked(sidebarItemGroupsService);

const caller: PipelineHostActionCaller = {
  executionId: 'exec-1',
  jobId: 'job-a',
  stepId: 'move',
  attempt: 1,
  iteration: 1,
  idempotencyKey: 'pipeline-host:exec-1:job-a::move:1:1',
};

function group(overrides: Partial<SidebarItemGroup> = {}): SidebarItemGroup {
  return {
    id: 'grp-1',
    name: 'Reviews',
    color: 'categorical-2',
    collapsed: false,
    memberIds: ['wt-1'],
    ...overrides,
  };
}

function config(
  type: WorkspaceConfigFile['type'],
): Awaited<ReturnType<typeof readWorkspaceConfigDetailed>> {
  return {
    config: { version: 1, type } satisfies WorkspaceConfigFile,
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  };
}

function worktree(id: string): WorktreeData {
  return { id, branchName: `feature/${id}`, createdAt: '2026-10-19T00:00:00Z' };
}

function entries(...ids: string[]): CoworkWorkEntriesFile {
  return {
    version: 1,
    entries: ids.map((id) => ({
      id,
      title: id,
      createdAt: '2026-10-19T00:00:00Z',
    })),
  };
}

function projectInputs(
  target: MoveToGroupInputs['target'],
  projectId = 'ws-1',
  taskId = 'wt-1',
): MoveToGroupInputs {
  return { task: { kind: 'project', projectId, taskId }, target };
}

function run(
  inputs: MoveToGroupInputs,
  port = createDesktopPipelineHostActions(),
): Promise<PipelineHostActionResult> {
  return port.run(
    { action: 'move-to-group', inputs },
    caller,
    new AbortController().signal,
  );
}

const NOT_FOUND_OUTPUTS = {
  group_id: '',
  group_name: '',
  group_created: '',
  grouped: 'false',
  not_grouped_reason: '',
};

describe('createDesktopPipelineHostActions move-to-group', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    readConfig.mockResolvedValue(config('single-repo'));
    readWorktrees.mockResolvedValue({
      worktrees: [worktree('wt-1')],
      authority: 'ok',
    });
    resolveCowork.mockImplementation((id) => id);
    service.assignItemToNamedGroup.mockResolvedValue({
      group: group(),
      created: true,
    });
    service.moveItem.mockResolvedValue(undefined);
    service.list.mockResolvedValue([group()]);
  });

  it('assigns a worktree to a new named group with its color', async () => {
    const result = await run(
      projectInputs({ kind: 'name', name: 'Reviews', color: 'categorical-2' }),
    );

    expect(service.assignItemToNamedGroup).toHaveBeenCalledWith({
      scope: { workspaceLocalId: 'ws-1' },
      itemId: 'wt-1',
      name: 'Reviews',
      color: 'categorical-2',
    });
    expect(readWorktrees).toHaveBeenCalledWith('ws-1', {
      persistRemovalCleanup: false,
    });
    expect(result).toEqual({
      status: 'success',
      outputs: {
        group_id: 'grp-1',
        group_name: 'Reviews',
        group_created: 'true',
        grouped: 'true',
        not_grouped_reason: '',
      },
    });
  });

  it('reports an existing group as not created', async () => {
    service.assignItemToNamedGroup.mockResolvedValue({
      group: group(),
      created: false,
    });

    const result = await run(projectInputs({ kind: 'name', name: 'Reviews' }));

    expect(service.assignItemToNamedGroup).toHaveBeenCalledWith({
      scope: { workspaceLocalId: 'ws-1' },
      itemId: 'wt-1',
      name: 'Reviews',
    });
    expect(result.outputs.group_created).toBe('false');
  });

  it('moves a cowork Work Entry into a group by id and reads its name', async () => {
    resolveCowork.mockImplementation((id) => `resolved-${id}`);
    readConfig.mockResolvedValue(config('cowork'));
    readEntries.mockResolvedValue(entries('entry-1'));

    const result = await run(
      projectInputs({ kind: 'id', groupId: 'grp-1' }, 'cw-1', 'entry-1'),
    );

    expect(resolveCowork).toHaveBeenCalledWith('cw-1');
    expect(readConfig).toHaveBeenCalledWith('resolved-cw-1');
    expect(readEntries).toHaveBeenCalledWith('resolved-cw-1');
    expect(readWorktrees).not.toHaveBeenCalled();
    expect(service.moveItem).toHaveBeenCalledWith({
      scope: { workspaceLocalId: 'cw-1' },
      itemId: 'entry-1',
      groupId: 'grp-1',
    });
    expect(result).toEqual({
      status: 'success',
      outputs: {
        group_id: 'grp-1',
        group_name: 'Reviews',
        group_created: 'false',
        grouped: 'true',
        not_grouped_reason: '',
      },
    });
  });

  it('keeps grouped true with an empty name when the group is no longer listed', async () => {
    service.list.mockResolvedValue([]);

    const result = await run(projectInputs({ kind: 'id', groupId: 'grp-1' }));

    expect(result.outputs).toMatchObject({
      group_id: 'grp-1',
      group_name: '',
      grouped: 'true',
    });
  });

  it('removes a task from its group', async () => {
    const result = await run(projectInputs({ kind: 'remove' }));

    expect(service.moveItem).toHaveBeenCalledWith({
      scope: { workspaceLocalId: 'ws-1' },
      itemId: 'wt-1',
      groupId: null,
    });
    expect(result).toEqual({
      status: 'success',
      outputs: {
        group_id: '',
        group_name: '',
        group_created: 'false',
        grouped: 'false',
        not_grouped_reason: 'removed',
      },
    });
  });

  it('groups an App Advisor Work Entry through the bot scope', async () => {
    readEntries.mockResolvedValue(entries('advisor-1'));

    const result = await run({
      task: { kind: 'bot', botId: 'app_advisor', taskId: 'advisor-1' },
      target: { kind: 'name', name: 'Reviews' },
    });

    expect(readEntries).toHaveBeenCalledWith('app-advisor');
    expect(readConfig).not.toHaveBeenCalled();
    expect(service.assignItemToNamedGroup).toHaveBeenCalledWith({
      scope: { appAdvisor: true },
      itemId: 'advisor-1',
      name: 'Reviews',
    });
    expect(result.status).toBe('success');
  });

  it.each([
    [
      'an unknown bot',
      (): MoveToGroupInputs => ({
        task: { kind: 'bot', botId: 'other', taskId: 't' },
        target: { kind: 'remove' },
      }),
      "Bot `other` isn't available to this pipeline",
    ],
    [
      'the App Advisor project id',
      (): MoveToGroupInputs =>
        projectInputs({ kind: 'remove' }, 'app-advisor', 't'),
      "Project `app-advisor` isn't available to this pipeline",
    ],
    [
      'the shared-container viewer project id',
      (): MoveToGroupInputs =>
        projectInputs({ kind: 'remove' }, 'shared-container-viewer', 't'),
      "Project `shared-container-viewer` isn't available to this pipeline",
    ],
    [
      'a missing project',
      (): MoveToGroupInputs => {
        readConfig.mockResolvedValue({
          ...config('single-repo'),
          authority: 'absent',
        });
        return projectInputs({ kind: 'remove' });
      },
      "Project `ws-1` isn't available to this pipeline",
    ],
    [
      'an unknown worktree',
      (): MoveToGroupInputs => {
        readWorktrees.mockResolvedValue({
          worktrees: [worktree('other')],
          authority: 'ok',
        });
        return projectInputs({ kind: 'remove' });
      },
      "Task `wt-1` isn't in project `ws-1`",
    ],
    [
      'a project with no worktree list yet',
      (): MoveToGroupInputs => {
        readWorktrees.mockResolvedValue({ worktrees: [], authority: 'absent' });
        return projectInputs({ kind: 'remove' });
      },
      "Task `wt-1` isn't in project `ws-1`",
    ],
    [
      'an unknown cowork Work Entry',
      (): MoveToGroupInputs => {
        readConfig.mockResolvedValue(config('cowork'));
        readEntries.mockResolvedValue(entries('other'));
        return projectInputs({ kind: 'remove' }, 'cw-1', 'entry-1');
      },
      "Task `entry-1` isn't in project `cw-1`",
    ],
    [
      'an unknown App Advisor Work Entry',
      (): MoveToGroupInputs => {
        readEntries.mockResolvedValue(entries('other'));
        return {
          task: { kind: 'bot', botId: 'app_advisor', taskId: 'advisor-1' },
          target: { kind: 'remove' },
        };
      },
      "Task `advisor-1` isn't in bot `app_advisor`",
    ],
  ])('fails %s with not_found', async (_label, setup, message) => {
    const inputs = setup();

    const result = await run(inputs);

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'not_found',
      error: message,
      outputs: NOT_FOUND_OUTPUTS,
    });
    expect(service.moveItem).not.toHaveBeenCalled();
    expect(service.assignItemToNamedGroup).not.toHaveBeenCalled();
  });

  it('does not read the App Advisor project as a project', async () => {
    await run(projectInputs({ kind: 'remove' }, 'app-advisor', 't'));

    expect(readConfig).not.toHaveBeenCalled();
  });

  it.each([
    'group_limit_reached',
    'item_not_groupable',
    'group_not_found',
  ] as const)(
    'succeeds without grouping when the sidebar refuses with %s',
    async (code) => {
      service.assignItemToNamedGroup.mockRejectedValue(
        new SidebarItemGroupRefusalError(code, 'refused'),
      );

      const result = await run(
        projectInputs({ kind: 'name', name: 'Reviews' }),
      );

      expect(result).toEqual({
        status: 'success',
        outputs: {
          group_id: '',
          group_name: '',
          group_created: 'false',
          grouped: 'false',
          not_grouped_reason: code,
        },
      });
    },
  );

  it('logs and rethrows an unexpected sidebar error without the group name', async () => {
    service.assignItemToNamedGroup.mockRejectedValue(new Error('disk'));

    await expect(
      run(projectInputs({ kind: 'name', name: 'Secret Group' })),
    ).rejects.toThrow('disk');

    expect(logError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logError.mock.calls[0])).not.toContain(
      'Secret Group',
    );
  });

  it('does not report not_found from an unreadable project config', async () => {
    readConfig.mockResolvedValue({
      ...config('single-repo'),
      authority: 'unreadable',
    });

    await expect(run(projectInputs({ kind: 'remove' }))).rejects.toThrow(
      "Project `ws-1` couldn't be read",
    );
    expect(service.moveItem).not.toHaveBeenCalled();
  });

  it.each([
    [
      'project config',
      (): void => {
        readConfig.mockRejectedValue(new Error('io'));
      },
    ],
    [
      'worktree list',
      (): void => {
        readWorktrees.mockRejectedValue(new Error('io'));
      },
    ],
  ])(
    'rethrows a %s read error instead of reporting not_found',
    async (_label, setup) => {
      setup();

      await expect(run(projectInputs({ kind: 'remove' }))).rejects.toThrow(
        'io',
      );

      expect(logError).toHaveBeenCalledTimes(1);
      expect(service.moveItem).not.toHaveBeenCalled();
    },
  );

  it.each(['unreadable', 'partial'] as const)(
    'does not report not_found from a %s worktree list',
    async (authority) => {
      readWorktrees.mockResolvedValue({
        worktrees: [worktree('other')],
        authority,
      });

      await expect(run(projectInputs({ kind: 'remove' }))).rejects.toThrow(
        "Worktrees for project `ws-1` couldn't be fully read",
      );
      expect(service.moveItem).not.toHaveBeenCalled();
    },
  );

  it('finds a worktree in a partial list', async () => {
    readWorktrees.mockResolvedValue({
      worktrees: [worktree('wt-1')],
      authority: 'partial',
    });

    const result = await run(projectInputs({ kind: 'remove' }));

    expect(result.status).toBe('success');
  });

  it('rethrows a Work Entry read error instead of reporting not_found', async () => {
    readEntries.mockRejectedValue(new Error('EACCES'));

    await expect(
      run({
        task: { kind: 'bot', botId: 'app_advisor', taskId: 'advisor-1' },
        target: { kind: 'remove' },
      }),
    ).rejects.toThrow('EACCES');

    expect(logError).toHaveBeenCalledTimes(1);
    expect(service.moveItem).not.toHaveBeenCalled();
  });

  it('leaves the sidebar alone once the step is withdrawn', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      createDesktopPipelineHostActions().run(
        {
          action: 'move-to-group',
          inputs: projectInputs({ kind: 'name', name: 'Reviews' }),
        },
        caller,
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(service.assignItemToNamedGroup).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('awaits the owner check with the resolved target before the sidebar call', async () => {
    const order: string[] = [];
    const assertTargetOwner = jest.fn(() => {
      order.push('owner');
      return Promise.resolve();
    });
    service.assignItemToNamedGroup.mockImplementation(() => {
      order.push('service');
      return Promise.resolve({ group: group(), created: true });
    });

    await run(
      projectInputs({ kind: 'name', name: 'Reviews' }),
      createDesktopPipelineHostActions({ assertTargetOwner }),
    );

    expect(assertTargetOwner).toHaveBeenCalledWith(caller, {
      kind: 'project',
      projectId: 'ws-1',
      taskId: 'wt-1',
      workspaceType: 'single-repo',
    });
    expect(order).toEqual(['owner', 'service']);
  });

  it('turns an owner refusal into a typed failure without a sidebar call', async () => {
    const port = createDesktopPipelineHostActions({
      assertTargetOwner: () =>
        Promise.reject(new PipelineHostRefusal('not_found', 'not yours')),
    });

    const result = await run(projectInputs({ kind: 'remove' }), port);

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'not_found',
      error: 'not yours',
      outputs: NOT_FOUND_OUTPUTS,
    });
    expect(service.moveItem).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected owner check error', async () => {
    const port = createDesktopPipelineHostActions({
      assertTargetOwner: () => Promise.reject(new Error('owner store down')),
    });

    await expect(run(projectInputs({ kind: 'remove' }), port)).rejects.toThrow(
      'owner store down',
    );
    expect(service.moveItem).not.toHaveBeenCalled();
  });

  it('repeats the same membership change for the same request', async () => {
    const inputs = projectInputs({ kind: 'name', name: 'Reviews' });

    const first = await run(inputs);
    const second = await run(inputs);

    expect(second).toEqual(first);
    expect(service.assignItemToNamedGroup).toHaveBeenCalledTimes(2);
    expect(service.assignItemToNamedGroup.mock.calls[0]).toEqual(
      service.assignItemToNamedGroup.mock.calls[1],
    );
  });
});

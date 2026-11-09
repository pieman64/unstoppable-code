jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockQueries: unknown[][] = [];
const mockInstruction = jest.fn();
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    query: (...args: unknown[]): Promise<{ content: string }> => {
      mockQueries.push(args);
      return Promise.resolve({ content: '# Project rules' });
    },
    instruction: (...args: unknown[]): unknown => mockInstruction(...args),
  }),
}));

let mockCowork = false;
jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => mockCowork,
}));

const mockTrackedPlanLists: unknown[] = [];
jest.mock('../../services/plans-service', () => ({
  listTrackedPlanData: (request: unknown): Promise<Array<{ id: string }>> => {
    mockTrackedPlanLists.push(request);
    return Promise.resolve([{ id: 'p' }]);
  },
  readTrackedPlanData: (): Promise<null> => Promise.resolve(null),
}));

let mockOrgProjectsEnabled = true;
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: (): boolean => mockOrgProjectsEnabled,
  }),
}));

const mockCatalogLists: unknown[] = [];
jest.mock('../../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): object => ({
    list: (
      context: unknown,
    ): Promise<{ projects: Array<{ id: string }>; stale: boolean }> => {
      mockCatalogLists.push(context);
      return Promise.resolve({ projects: [{ id: 'op-1' }], stale: false });
    },
  }),
}));

const mockSends: unknown[][] = [];
jest.mock('../../lib/window-send', () => ({
  sendToAllWindows: (...args: unknown[]): void => {
    mockSends.push(args);
  },
}));

const mockContextInitialize = jest.fn(() => Promise.resolve());
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): object => ({
    initialize: (): Promise<void> => mockContextInitialize(),
    getState: (): object => ({
      context: { kind: 'organization', organizationId: 'org-1' },
      revision: 3,
      organizations: [],
    }),
  }),
}));

import { CORE_WORKSPACE_INSTRUCTIONS_GRANTS } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { mainAdvisorWorkspaceActionHost } from '../advisor-workspace-action-host';

const ORG = { kind: 'organization', organizationId: 'org-1' } as const;

beforeEach(() => {
  mockQueries.length = 0;
  mockInstruction.mockClear();
  mockTrackedPlanLists.length = 0;
  mockCatalogLists.length = 0;
  mockSends.length = 0;
  mockContextInitialize.mockClear();
  mockCowork = false;
  mockOrgProjectsEnabled = true;
});

describe('App Advisor workspace action host (CAN-5998)', () => {
  it('reads CLAUDE.md through core.workspace.instructions.get as the Advisor chat, with only the read grant', async () => {
    const content = await mainAdvisorWorkspaceActionHost({
      chatId: 'advisor-chat',
    }).readInstructions('proj');

    expect(content).toBe('# Project rules');
    expect(mockQueries).toEqual([
      [
        'core.workspace.instructions.get',
        { workspaceId: 'proj' },
        {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-action:advisor-chat',
            authorityId: 'local-desktop',
            interfaceKind: 'mcp',
            grants: [CORE_WORKSPACE_INSTRUCTIONS_GRANTS.read],
          },
        },
      ],
    ]);
    expect(mockInstruction).not.toHaveBeenCalled();
  });

  it('refuses an invalid project id before dispatching the read', async () => {
    await expect(
      mainAdvisorWorkspaceActionHost({ chatId: 'c' }).readInstructions('../x'),
    ).rejects.toThrow();
    expect(mockQueries).toEqual([]);
  });

  it('lists no tracked plans for a Cowork project, as the window does', async () => {
    const host = mainAdvisorWorkspaceActionHost({ chatId: 'c' });
    mockCowork = true;
    await expect(
      host.listTrackedPlans({ projectId: 'cowork', worktreeId: 'w' }),
    ).resolves.toEqual([]);
    expect(mockTrackedPlanLists).toEqual([]);

    mockCowork = false;
    await expect(
      host.listTrackedPlans({ projectId: 'proj', worktreeId: 'w' }),
    ).resolves.toEqual([{ id: 'p' }]);
  });

  it('reads the selected organization from main and answers the disabled catalog while the feature is off', async () => {
    const host = mainAdvisorWorkspaceActionHost({ chatId: 'c' });
    await expect(host.readWorkspaceContext()).resolves.toMatchObject({
      context: ORG,
    });
    expect(mockContextInitialize).toHaveBeenCalledTimes(1);

    await expect(host.listOrgProjects(ORG)).resolves.toMatchObject({
      projects: [{ id: 'op-1' }],
    });
    mockOrgProjectsEnabled = false;
    await expect(host.listOrgProjects(ORG)).resolves.toEqual({
      context: 'org:org-1',
      revision: '',
      projects: [],
      fetchedAt: new Date(0).toISOString(),
      stale: true,
      error: 'unavailable',
    });
    expect(mockCatalogLists).toHaveLength(1);
  });

  it('announces a project reload to every window, which reloads its worktrees', () => {
    mainAdvisorWorkspaceActionHost({ chatId: 'c' }).announceWorktrees('proj');

    expect(mockSends).toEqual([
      [IPC_CHANNELS.workspaceWorktreesUpdated, { workspaceId: 'proj' }],
    ]);
  });
});

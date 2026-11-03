/** @jest-environment jsdom */
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { offerWorktreeDiscard } from '@canopy/app-state';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardResult,
} from '@canopy/protocol/portal/worktree-discard';
import { WORKTREE_DISCARD_DIALOG_TEST_ID } from '@canopy/ui-shared/components/WorktreeDiscardDialog';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mockReconcile = jest.fn<
  Promise<void>,
  [string, string, { removedTemporaryWorkspaceId?: string }?]
>(() => Promise.resolve());
const mockFinish = jest.fn();
const mockSettleDeleted = jest.fn<Promise<void>, [string, string]>(() =>
  Promise.resolve(),
);
const mockDiscardResults: WorktreeDiscardResult[] = [];

function mockClient(): CanopyClient {
  const capabilities: CanopyCapabilities = {
    localExecution: true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: true,
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
    overviewNotifications: true,
    worktreeDiscard: true,
  };
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(name: CommandName, args: unknown): Promise<unknown> {
    void args;
    const next = mockDiscardResults.shift();
    if (name === 'worktree.discard' && next) return Promise.resolve(next);
    return Promise.reject(new Error(`Unexpected command: ${name}`));
  }
  return {
    capabilities,
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      void args;
      return Promise.reject(new Error(`Unexpected query: ${name}`));
    },
    command,
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

jest.mock('@/client/ipc-canopy-client', () => ({
  ipcCanopyClient: mockClient(),
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { reconcileArchivedWorktree: typeof mockReconcile } => ({
      reconcileArchivedWorktree: mockReconcile,
    }),
  },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: jest.fn() }),
  },
}));
jest.mock('@/stores/archivedContainersStore', () => ({
  useArchivedContainersStore: {
    getState: (): { settleDeleted: typeof mockSettleDeleted } => ({
      settleDeleted: mockSettleDeleted,
    }),
  },
}));
jest.mock('../finishWorktreeArchive', () => ({
  finishWorktreeArchive: (input: unknown): unknown => mockFinish(input),
}));

import { DesktopWorktreeDiscardHost } from '../DesktopWorktreeDiscardHost';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const DISCARDABLE: WorktreeDiscardDescription = {
  version: 1,
  workspaceId: 'workspace-temp',
  worktreeId: 'wt-1',
  createdAt: '2026-10-30T00:00:00.000Z',
  status: 'discardable',
  causes: ['source-gone'],
  sources: [{ repoId: 'a', path: '/repos/a', state: 'gone-absent' }],
  targets: [],
  alsoDeleted: ['chats'],
  preserved: ['branches'],
  mayRemain: [],
  confirmation: 'token-1',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockReconcile.mockClear();
  mockFinish.mockClear();
  mockSettleDeleted.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

async function discard(
  result: WorktreeDiscardResult,
  description: WorktreeDiscardDescription = DISCARDABLE,
): Promise<void> {
  mockDiscardResults.push(result);
  act(() => root.render(<DesktopWorktreeDiscardHost />));
  act(() =>
    offerWorktreeDiscard({
      workspaceId: 'workspace-temp',
      worktreeId: 'wt-1',
      worktreeName: 'owl',
      message: 'refused',
      description,
      retry: jest.fn(),
    }),
  );
  await flush();
  const confirm = document.querySelector<HTMLButtonElement>(
    `[data-testid="${WORKTREE_DISCARD_DIALOG_TEST_ID}-confirm"]`,
  );
  if (!confirm) throw new Error('Missing the discard confirmation');
  act(() => confirm.click());
  await flush();
}

describe('DesktopWorktreeDiscardHost (CAN-5336)', () => {
  it('drops the temporary project a discard of its last worktree left empty, as archive does', async () => {
    await discard({
      status: 'discarded',
      removed: ['live-checkout'],
      gitCleanup: [],
      warnings: [],
      removedTemporaryWorkspaceId: 'workspace-temp',
    });
    expect(mockReconcile).toHaveBeenCalledWith('workspace-temp', 'wt-1', {
      removedTemporaryWorkspaceId: 'workspace-temp',
    });
    expect(mockFinish).toHaveBeenCalledWith({
      projectId: 'workspace-temp',
      worktreeId: 'wt-1',
      refreshReferenceRepos: false,
    });
  });

  it('reconciles only the worktree when the project keeps others', async () => {
    await discard({
      status: 'discarded',
      removed: ['live-checkout'],
      gitCleanup: [],
      warnings: [],
    });
    expect(mockReconcile).toHaveBeenCalledWith('workspace-temp', 'wt-1', {});
  });

  it('CAN-5338 settles a discarded retained archive as a deletion does, without touching worktree rows or panels', async () => {
    await discard(
      {
        status: 'discarded',
        removed: ['retained-archive'],
        gitCleanup: [],
        warnings: [],
      },
      {
        ...DISCARDABLE,
        targets: [
          {
            kind: 'retained-archive',
            path: '/data/workspace-temp/archived-containers/wt-1',
            identity: '1:2:3',
            identityVerified: false,
            reason: 'source-gone',
          },
        ],
      },
    );
    expect(mockSettleDeleted).toHaveBeenCalledWith('workspace-temp', 'wt-1');
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
  });
});

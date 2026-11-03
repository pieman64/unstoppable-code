import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CoreWorkspaceAddressRefusedError } from '@canopy/core-runtime/node/workspace/metadata-wire-errors';
import { createWorkspaceIndexRepository } from '@canopy/core-runtime/node/w5/workspace-index-repository';
import type { W5FileRead } from '@canopy/core-runtime/node/w5/file-store';
import { W5AuthorityUnreachableError } from '../w5-file-store';

/*
 * RR5 addressing in the desktop `core.workspace.*` metadata host: a wire
 * call's workspace is admitted from the index before any key is reserved.
 */

const mockReadIndex = jest.fn();
jest.mock('../sidebar-items', () => ({
  getWorkspaceIndexRepository: (): object => ({ read: mockReadIndex }),
}));

// The command host runs its addressing as the commands' first step.
jest.mock('../w5-workspace-command-host', () => ({
  desktopW5WireCommandHost: (
    _principalId: string,
    admitAddress: () => Promise<void>,
  ): object => ({ admitAddress }),
}));
jest.mock('../workspace-metadata', () => ({
  WorkspaceMetadataRefusedError: class extends Error {},
  createDesktopWorkspaceMetadataCommands: (host: {
    admitAddress: () => Promise<void>;
  }): object => ({
    update: async (): Promise<never> => {
      await host.admitAddress();
      throw new Error('Expected addressing to refuse');
    },
  }),
}));
jest.mock('../../canopy-runtime/core-workspace-adapter', () => ({
  readDecidedCoreWorkspace: jest.fn(),
}));
jest.mock('../../canopy-runtime/workspace-metadata-dispatch', () => ({
  runWorkspaceMetadataProjection: jest.fn(),
  takeWorkspaceMetadataProjection: (): undefined => undefined,
  WorkspaceMetadataProjectionAnswered: class extends Error {},
}));
jest.mock('../workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
  WorkspaceConfigUnreadableError: class extends Error {},
}));
jest.mock('../workspace-private-memory', () => ({
  createDesktopWorkspacePrivateMemoryCommand: jest.fn(),
}));
jest.mock('../workspace-repositories', () => ({
  createDesktopWorkspaceRepositoryCommands: jest.fn(),
  WorkspaceRepositoryRefusedError: class extends Error {},
}));
jest.mock('../workspace-script-hook-settings', () => ({
  createDesktopWorkspaceSettingsCommands: jest.fn(),
}));

import {
  admitWorkspace,
  desktopWorkspaceMetadataHost,
} from '../workspace-metadata-host';

const caller: CanopyCallerDescriptor = {
  principalId: 'agent-1',
  clientInstanceId: 'client-1',
  authorityId: 'authority-1',
  interfaceKind: 'desktop',
  grants: [],
};

async function refusalOfUpdate(): Promise<unknown> {
  return desktopWorkspaceMetadataHost
    .update(
      { workspaceId: 'ws-1', patch: { name: 'Renamed' } },
      { caller, idempotencyKey: 'key-1' },
    )
    .catch((error: unknown) => error);
}

describe('desktop metadata host addressing over an unreadable index', () => {
  beforeEach(() => mockReadIndex.mockReset());

  it('GB4: an index read that could not reach the background service refuses with its message', async () => {
    const unreachable = new W5AuthorityUnreachableError('refused', 'connect');
    mockReadIndex.mockResolvedValue({
      entries: [],
      authority: 'unreadable',
      unserved: unreachable,
    });
    const refusal = await refusalOfUpdate();
    expect(refusal).toBeInstanceOf(CoreWorkspaceAddressRefusedError);
    expect(refusal).toMatchObject({
      reason: 'index-unavailable',
      message: unreachable.message,
    });
  });

  it('keeps the project list copy for an index that is unreadable on disk', async () => {
    mockReadIndex.mockResolvedValue({ entries: [], authority: 'unreadable' });
    await expect(refusalOfUpdate()).resolves.toMatchObject({
      reason: 'index-unavailable',
      message:
        "Couldn't update this project because the project list couldn't be read. Try again.",
    });
  });

  it('carries the real repository refusal, then counts unreadable duplicate rows after recovery', async () => {
    const unreachable = new W5AuthorityUnreachableError('refused', 'lost');
    let read: W5FileRead = { state: 'unreadable', error: unreachable };
    const replace = jest.fn(() => Promise.resolve());
    const onRefused = jest.fn();
    const index = createWorkspaceIndexRepository({
      store: {
        read: () => Promise.resolve(read),
        replace,
        remove: () =>
          Promise.reject(new Error('Admission never removes records')),
      },
      filePath: () => '/w5/workspaces/index.json',
      storage: { namespace: 'workspace_index', writer: 'electron_main' },
      normalizeActivitySectionOrder: () => undefined,
      onCommitted: jest.fn(),
      onRefused,
    });
    mockReadIndex.mockImplementation(() => index.read());
    await expect(admitWorkspace('ws-1', 'not-found')).rejects.toMatchObject({
      reason: 'index-unavailable',
      message: unreachable.message,
    });

    const workspace = {
      id: 'ws-1',
      name: 'Project',
      type: 'single-repo',
      color: 'blue',
    };
    read = {
      state: 'present',
      raw: JSON.stringify({
        version: 1,
        workspaces: [workspace, { id: 'ws-1', type: 'notebook' }],
      }),
    };
    await expect(admitWorkspace('ws-1', 'not-found')).rejects.toMatchObject({
      reason: 'duplicate-workspace',
    });

    // An unreadable row for another ID does not prevent addressing this one.
    read = {
      state: 'present',
      raw: JSON.stringify({
        version: 1,
        workspaces: [workspace, { id: 'other', type: 'notebook' }],
      }),
    };
    await expect(admitWorkspace('ws-1', 'not-found')).resolves.toBeUndefined();
    expect(replace).not.toHaveBeenCalled();
    expect(onRefused).not.toHaveBeenCalled();
  });
});

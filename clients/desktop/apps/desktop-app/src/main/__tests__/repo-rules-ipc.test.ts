import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerRepoRulesHandlers } from '../ipc/repo-rules';

const handlers = new Map<
  string,
  (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>,
  ): void => {
    handlers.set(channel, handler);
  },
}));
const scan = jest.fn(() => Promise.resolve({ proposals: [] }));
const apply = jest.fn(() => Promise.resolve({ enabled: false }));
const status = jest.fn(() => Promise.resolve({ enabled: false }));
const preview = jest.fn(() => ({ body: 'snapshot' }));
const resolveCheckouts = jest.fn(() => Promise.resolve([]));
jest.mock('../repo-rules/host', () => ({
  repoRulesService: {
    scan: (...args: unknown[]): ReturnType<typeof scan> => scan(...args),
    apply: (...args: unknown[]): ReturnType<typeof apply> => apply(...args),
    status: (...args: unknown[]): ReturnType<typeof status> => status(...args),
    preview: (...args: unknown[]): ReturnType<typeof preview> =>
      preview(...args),
  },
  resolveRepoRuleCheckouts: (
    ...args: unknown[]
  ): ReturnType<typeof resolveCheckouts> => resolveCheckouts(...args),
}));

let query: jest.Mock<
  Promise<{ kind?: string; workspaceId?: string }>,
  [string]
>;
let caller: CanopyCallerDescriptor;
const event = {} as IpcMainInvokeEvent;
const scanId = '12345678-1234-4234-8234-123456789abc';
beforeEach(() => {
  jest.clearAllMocks();
  handlers.clear();
  caller = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'window-1',
    authorityId: 'local',
    interfaceKind: 'desktop',
    grants: [],
  };
  query = jest.fn((name: string) =>
    Promise.resolve(
      name === 'core.workspace.get'
        ? { kind: 'git' }
        : { workspaceId: 'workspace-1' },
    ),
  );
  registerRepoRulesHandlers(
    { query } as unknown as DesktopCanopyDispatcher,
    () => caller,
  );
});
async function invoke(channel: string, input: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error('Missing handler');
  return handler(event, input);
}
it('authorizes workspace/worktree through the existing dispatcher before scanning', async () => {
  await invoke(IPC_CHANNELS.repoRulesScan, {
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
  });
  expect(query.mock.calls.map((c) => c[0])).toEqual([
    'core.workspace.get',
    'core.worktree.get',
  ]);
  expect(scan).toHaveBeenCalledWith('local-desktop-user:window-1', {
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
  });
});
it('rejects caller-supplied paths, unsafe IDs, cross-workspace worktrees and untrusted callers', async () => {
  await expect(
    invoke(IPC_CHANNELS.repoRulesScan, {
      workspaceId: 'workspace-1',
      root: '/tmp',
    }),
  ).rejects.toThrow();
  await expect(
    invoke(IPC_CHANNELS.repoRulesScan, { workspaceId: '../bad' }),
  ).rejects.toThrow();
  query.mockResolvedValue({ kind: 'git', workspaceId: 'other' });
  await expect(
    invoke(IPC_CHANNELS.repoRulesScan, {
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    }),
  ).rejects.toThrow('belong');
  caller.principalId = 'remote-device:other';
  await expect(
    invoke(IPC_CHANNELS.repoRulesScan, { workspaceId: 'workspace-1' }),
  ).rejects.toThrow('local');
  expect(scan).not.toHaveBeenCalled();
});
it('queries policy and disables without resolving repositories or scanning', async () => {
  await invoke(IPC_CHANNELS.repoRulesStatus, { workspaceId: 'workspace-1' });
  await invoke(IPC_CHANNELS.repoRulesApply, {
    workspaceId: 'workspace-1',
    enabled: false,
  });
  expect(status).toHaveBeenCalledWith('workspace-1');
  expect(apply).toHaveBeenCalledWith('local-desktop-user:window-1', {
    workspaceId: 'workspace-1',
    enabled: false,
  });
  expect(resolveCheckouts).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
});
it('binds preview lookup to the authorized caller and request', async () => {
  await invoke(IPC_CHANNELS.repoRulesPreview, {
    workspaceId: 'workspace-1',
    scanId,
    ruleId: 'r:.cursorrules',
  });
  expect(preview).toHaveBeenCalledWith('local-desktop-user:window-1', {
    workspaceId: 'workspace-1',
    scanId,
    ruleId: 'r:.cursorrules',
  });
});

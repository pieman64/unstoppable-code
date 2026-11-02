import type { IpcMainInvokeEvent } from 'electron';
import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { RepoRulesPolicy } from '@canopy/core-runtime/node/workspace/repo-rules';
import { createCoreWorkspaceRepoRulesHandlers } from '@canopy/core-runtime/node/workspace/workspace-repo-rules';
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
const scan = jest.fn<Promise<{ proposals: never[] }>, [unknown, unknown]>(() =>
  Promise.resolve({ proposals: [] }),
);
const apply = jest.fn<Promise<{ enabled: boolean }>, [unknown, unknown]>(() =>
  Promise.resolve({ enabled: false }),
);
const status = jest.fn<Promise<{ enabled: boolean }>, [unknown]>(() =>
  Promise.resolve({ enabled: false }),
);
const preview = jest.fn<{ body: string }, [unknown, unknown]>(() => ({
  body: 'snapshot',
}));
const resolveCheckouts = jest.fn<Promise<never[]>, [unknown]>(() =>
  Promise.resolve([]),
);
jest.mock('../repo-rules/host', () => ({
  repoRulesService: {
    scan: (session: unknown, request: unknown): ReturnType<typeof scan> =>
      scan(session, request),
    apply: (session: unknown, request: unknown): ReturnType<typeof apply> =>
      apply(session, request),
    status: (workspaceId: unknown): ReturnType<typeof status> =>
      status(workspaceId),
    preview: (session: unknown, request: unknown): ReturnType<typeof preview> =>
      preview(session, request),
  },
  resolveRepoRuleCheckouts: (
    request: unknown,
  ): ReturnType<typeof resolveCheckouts> => resolveCheckouts(request),
}));

const repoRules = createCoreWorkspaceRepoRulesHandlers({
  load: () =>
    Promise.resolve({
      policy: { scan, apply, status, preview } as unknown as RepoRulesPolicy,
    }),
});
type Call = [string, unknown, { caller: CanopyCallerDescriptor }];
// Stands in for the dispatcher: checks each call's grants and runs the core
// repo-rules handlers in process.
function dispatch(
  definitions: Record<
    string,
    {
      requiredGrants: readonly CanopyCallerDescriptor['grants'][number][];
    }
  >,
  handlers: Record<string, (params: never, context: never) => unknown>,
): jest.Mock<Promise<unknown>, Call> {
  return jest.fn((name: string, params: unknown, options) => {
    const required = definitions[name]?.requiredGrants ?? [];
    if (required.some((grant) => !options.caller.grants.includes(grant)))
      return Promise.reject(new Error(`${name} lacks a grant`));
    const handler = handlers[name];
    if (handler)
      return Promise.resolve(
        Reflect.apply(handler, undefined, [
          params,
          { caller: options.caller, requestId: 'r', metadata: {} },
        ]),
      );
    return Promise.resolve(
      name === 'core.workspace.get'
        ? { kind: 'git' }
        : { workspaceId: 'workspace-1' },
    );
  });
}
let query: jest.Mock<Promise<unknown>, Call>;
let instruction: jest.Mock<Promise<unknown>, Call>;
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
  query = dispatch(CANOPY_QUERY_DEFINITIONS, repoRules.queries);
  instruction = dispatch(
    CANOPY_INSTRUCTION_DEFINITIONS,
    repoRules.instructions,
  );
  registerRepoRulesHandlers(
    { query, instruction } as unknown as DesktopCanopyDispatcher,
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
  expect(query.mock.calls.map((c) => [c[0], c[2].caller.grants])).toEqual([
    ['core.workspace.get', ['core.workspace.read']],
    ['core.worktree.get', ['core.worktree.read']],
    ['core.workspace.repoRules.scan', ['core.workspace.read']],
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
  query.mockResolvedValueOnce({ kind: 'git' });
  query.mockResolvedValueOnce({ workspaceId: 'other' });
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
  expect(instruction.mock.calls.map((c) => [c[0], c[2].caller.grants])).toEqual(
    [['core.workspace.repoRules.apply', ['core.workspace.write']]],
  );
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

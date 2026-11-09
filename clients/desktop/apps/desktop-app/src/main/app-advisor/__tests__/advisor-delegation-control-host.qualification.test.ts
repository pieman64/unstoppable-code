jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockInstructions: Array<{
  name: string;
  params: unknown;
  options: unknown;
}> = [];
const mockSubagentRunChecks: string[] = [];
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    instruction: (name: string, params: unknown, options: unknown): object => {
      mockInstructions.push({ name, params, options });
      return Promise.resolve({ outcome: 'requested' });
    },
    subagentRuns: {
      findLive: (delegationId: string, runGeneration: number): object | null =>
        delegationId === 'del-1' && runGeneration === 2
          ? { operationId: 'op-subagent' }
          : null,
      isSubagentRun: (operationId: string): Promise<boolean> => {
        mockSubagentRunChecks.push(operationId);
        return Promise.resolve(operationId === 'op-subagent');
      },
    },
  }),
}));

const mockService = {
  inspect: jest.fn(),
  stop: jest.fn(),
  stopAll: jest.fn(),
};
jest.mock('../../agents/delegation/service', () => ({
  inspectManagedDelegationForUser: (...args: unknown[]): unknown =>
    mockService.inspect(...args),
  stopManagedDelegationForUser: (...args: unknown[]): unknown =>
    mockService.stop(...args),
  stopAllManagedDelegationsForUser: (...args: unknown[]): unknown =>
    mockService.stopAll(...args),
}));

import { mainAdvisorDelegationControlHost } from '../advisor-delegation-control-host';

const TARGET = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };

beforeEach(() => {
  mockInstructions.length = 0;
  mockSubagentRunChecks.length = 0;
  mockService.inspect.mockReset().mockResolvedValue({ ok: true, value: null });
  mockService.stop.mockReset().mockResolvedValue({ ok: true, value: {} });
  mockService.stopAll.mockReset().mockResolvedValue({
    ok: true,
    value: { stopped: 0, delegationIds: [] },
  });
});

describe('App Advisor delegation control host (CAN-6000)', () => {
  const host = (): ReturnType<typeof mainAdvisorDelegationControlHost> =>
    mainAdvisorDelegationControlHost({ chatId: 'advisor-chat' });

  it('sends core.operation.cancel as the advisor chat with only core.operation.cancel', async () => {
    await host().cancelOperation('op-subagent');

    expect(mockInstructions).toEqual([
      {
        name: 'core.operation.cancel',
        params: {
          operationId: 'op-subagent',
          reason: 'Stopped by App Advisor',
        },
        options: {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-action:advisor-chat',
            authorityId: 'local-desktop',
            interfaceKind: 'mcp',
            grants: ['core.operation.cancel'],
          },
        },
      },
    ]);
  });

  it('resolves the live core.agent.subagent.run and asks the ledger for its kind', async () => {
    expect(host().findLiveRun('del-1', 2)).toBe('op-subagent');
    expect(host().findLiveRun('del-1', 1)).toBeNull();
    await expect(host().isSubagentRun('op-pipeline')).resolves.toBe(false);
    expect(mockSubagentRunChecks).toEqual(['op-pipeline']);
  });

  it("reads and stops through the chat's delegation service", async () => {
    const stopRoot = jest.fn();
    await host().inspect(TARGET, 'del-1');
    await host().stopWithoutRun(TARGET, 'del-1');
    await host().stopAll(TARGET, stopRoot);

    expect(mockService.inspect).toHaveBeenCalledWith(TARGET, 'del-1');
    expect(mockService.stop).toHaveBeenCalledWith(TARGET, 'del-1');
    expect(mockService.stopAll).toHaveBeenCalledWith(TARGET, { stopRoot });
    expect(mockInstructions).toEqual([]);
  });
});

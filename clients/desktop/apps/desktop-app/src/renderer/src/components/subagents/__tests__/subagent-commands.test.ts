/** @jest-environment jsdom */

/** Result mapping for the desktop subagent viewer's IPC commands. */
import type { ManagedDelegationWorktreeSummary } from '@canopy/desktop-shared/types';
import {
  interruptNativeSubagent,
  mapSubagentWorktreeSummary,
  messageManagedSubagent,
  readSubagentWorktreeSummary,
  stopWorkflowRun,
  stopSubagent,
  SUBAGENT_COMMAND_UNSUPPORTED_ERROR,
} from '../subagent-commands';
import { subagentCapabilitiesForKind } from '@canopy/ui-app/subagents';
import { subagentViewerCapabilitiesFrom } from '../subagent-capabilities';
import { createDesktopCapabilities } from '@/client/ipc-canopy-client';

const SCOPE = { projectId: 'project-1', worktreeId: 'worktree-1' };

const managedDelegation = {
  stop: jest.fn(),
  message: jest.fn(),
  worktreeSummary: jest.fn(),
};
const nativeSubagents = { interrupt: jest.fn() };
const activity = { stopBgProcess: jest.fn() };

const SUMMARY: ManagedDelegationWorktreeSummary = {
  delegationId: 'delegate-1',
  checkout: 'retained',
  startingRevision: 'abc1234',
  startingSubject: 'Add parser',
  filesChanged: 2,
  additions: 10,
  deletions: 3,
  commitsAhead: 1,
  untrackedFiles: 1,
  applyState: 'not_applied',
  topFiles: [
    { path: 'src/a.ts', additions: 8, deletions: 1, status: 'modified' },
    { path: 'src/b.ts', additions: 2, deletions: 2, status: 'added' },
  ],
  truncated: false,
};

beforeEach(() => {
  jest.resetAllMocks();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { activity, managedDelegation, nativeSubagents },
  });
});

describe('stopWorkflowRun', () => {
  it('stops the provider task for the root chat', async () => {
    activity.stopBgProcess.mockResolvedValue('stopped');

    await expect(
      stopWorkflowRun(SCOPE, 'root-chat', { taskId: 'task-1' }),
    ).resolves.toEqual({ ok: true });
    expect(activity.stopBgProcess).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'root-chat',
      taskId: 'task-1',
    });
  });

  it('refuses to stop a run without a provider task id', async () => {
    await expect(stopWorkflowRun(SCOPE, 'root-chat', {})).resolves.toEqual({
      ok: false,
      error: 'This workflow run cannot be stopped.',
    });
    expect(activity.stopBgProcess).not.toHaveBeenCalled();
  });

  it.each(['already-finished', 'session-ended'] as const)(
    'reports %s as a run that is no longer running',
    async (outcome) => {
      activity.stopBgProcess.mockResolvedValue(outcome);

      await expect(
        stopWorkflowRun(SCOPE, 'root-chat', { taskId: 'task-1' }),
      ).resolves.toEqual({
        ok: false,
        error: 'This workflow run is no longer running.',
      });
    },
  );

  it('maps rejected IPC calls to a readable error', async () => {
    activity.stopBgProcess.mockRejectedValue(
      new Error(
        "Error invoking remote method 'activity:stop': Error: IPC down",
      ),
    );

    await expect(
      stopWorkflowRun(SCOPE, 'root-chat', { taskId: 'task-1' }),
    ).resolves.toEqual({ ok: false, error: 'IPC down' });
  });
});

describe('stopSubagent', () => {
  it('stops a managed delegate in the root chat', async () => {
    managedDelegation.stop.mockResolvedValue({ ok: true });
    await expect(
      stopSubagent(SCOPE, 'root-chat', { id: 'delegate-1', kind: 'managed' }),
    ).resolves.toEqual({ ok: true });
    expect(managedDelegation.stop).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'root-chat',
      delegationId: 'delegate-1',
    });
  });

  it('maps a refusal and a rejected IPC call to readable errors', async () => {
    managedDelegation.stop.mockResolvedValueOnce({
      ok: false,
      error: 'Already finished.',
    });
    await expect(
      stopSubagent(SCOPE, 'root-chat', { id: 'delegate-1', kind: 'managed' }),
    ).resolves.toEqual({ ok: false, error: 'Already finished.' });
    managedDelegation.stop.mockRejectedValueOnce(new Error('IPC down'));
    const rejected = await stopSubagent(SCOPE, 'root-chat', {
      id: 'delegate-1',
      kind: 'managed',
    });
    expect(rejected.ok).toBe(false);
  });

  it('never sends a native subagent through the managed stop', async () => {
    await expect(
      stopSubagent(SCOPE, 'root-chat', { id: 'tool-1', kind: 'claude-native' }),
    ).resolves.toEqual({
      ok: false,
      error: SUBAGENT_COMMAND_UNSUPPORTED_ERROR,
    });
    expect(managedDelegation.stop).not.toHaveBeenCalled();
  });
});

describe('messageManagedSubagent', () => {
  it('forwards the operation and its operation id', async () => {
    managedDelegation.message.mockResolvedValue({ ok: true, snapshot: {} });
    await expect(
      messageManagedSubagent(SCOPE, 'root-chat', 'delegate-1', {
        operation: 'steer',
        message: 'Focus on tests',
        operationId: 'op-1',
      }),
    ).resolves.toEqual({ ok: true });
    expect(managedDelegation.message).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'root-chat',
      delegationId: 'delegate-1',
      operation: 'steer',
      message: 'Focus on tests',
      operationId: 'op-1',
    });
  });

  it('omits the message for an interrupt and keeps refusal codes', async () => {
    managedDelegation.message.mockResolvedValue({
      ok: false,
      code: 'busy',
      error: 'Busy.',
    });
    await expect(
      messageManagedSubagent(SCOPE, 'root-chat', 'delegate-1', {
        operation: 'interrupt',
        operationId: 'op-2',
      }),
    ).resolves.toEqual({ ok: false, code: 'busy', error: 'Busy.' });
    expect(managedDelegation.message).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'root-chat',
      delegationId: 'delegate-1',
      operation: 'interrupt',
      operationId: 'op-2',
    });
  });

  it('maps a rejected IPC call to a failed result', async () => {
    managedDelegation.message.mockRejectedValue(new Error('IPC down'));
    const result = await messageManagedSubagent(SCOPE, 'root', 'd', {
      operation: 'follow_up',
      message: 'Hi',
      operationId: 'op-3',
    });
    expect(result).toMatchObject({ ok: false, code: 'failed' });
  });
});

describe('interruptNativeSubagent', () => {
  it('interrupts a Claude Task agent by its tool use id', async () => {
    nativeSubagents.interrupt.mockResolvedValue({ ok: true });
    await expect(
      interruptNativeSubagent(SCOPE, 'root-chat', {
        id: 'toolu_1',
        kind: 'claude-native',
      }),
    ).resolves.toEqual({ ok: true });
    expect(nativeSubagents.interrupt).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'root-chat',
      subagentKind: 'claude-native',
      subagentId: 'toolu_1',
    });
  });

  it('keeps the refusal code', async () => {
    nativeSubagents.interrupt.mockResolvedValue({
      ok: false,
      code: 'not_running',
      error: 'It already finished.',
    });
    await expect(
      interruptNativeSubagent(SCOPE, 'root-chat', {
        id: 'toolu_1',
        kind: 'claude-native',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'not_running',
      error: 'It already finished.',
    });
  });

  it('refuses a Codex subagent without a round trip', async () => {
    const result = await interruptNativeSubagent(SCOPE, 'root-chat', {
      id: 'thread-1',
      kind: 'codex-native',
    });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    expect(nativeSubagents.interrupt).not.toHaveBeenCalled();
  });
});

describe('worktree summary', () => {
  it('maps the IPC summary onto the shared display type', () => {
    expect(mapSubagentWorktreeSummary(SUMMARY)).toEqual({
      checkout: 'retained',
      startingRevision: 'abc1234',
      startingSubject: 'Add parser',
      filesChanged: 2,
      additions: 10,
      deletions: 3,
      commitsAhead: 1,
      untrackedFiles: 1,
      applyState: 'not_applied',
      topFiles: SUMMARY.topFiles,
      truncated: false,
    });
  });

  it('reads with the recorded starting revision and maps failures', async () => {
    managedDelegation.worktreeSummary.mockResolvedValueOnce({
      ok: true,
      summary: SUMMARY,
    });
    const read = await readSubagentWorktreeSummary(
      SCOPE,
      'delegate-1',
      'abc1234',
    );
    expect(read.ok).toBe(true);
    expect(managedDelegation.worktreeSummary).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      delegationId: 'delegate-1',
      revision: 'abc1234',
    });
    managedDelegation.worktreeSummary.mockResolvedValueOnce({
      ok: false,
      error: 'Checkout missing.',
    });
    await expect(
      readSubagentWorktreeSummary(SCOPE, 'delegate-1', 'abc1234'),
    ).resolves.toEqual({ ok: false, error: 'Checkout missing.' });
  });
});

describe('subagent viewer capabilities', () => {
  it('maps the desktop capability flags onto the viewer', () => {
    expect(
      subagentViewerCapabilitiesFrom(createDesktopCapabilities('darwin')),
    ).toEqual({
      stop: true,
      messaging: true,
      worktreeDetails: true,
      nativeInterrupt: true,
      openWorkflow: true,
      stopWorkflow: true,
    });
    expect(
      subagentViewerCapabilitiesFrom({
        ...createDesktopCapabilities('darwin'),
        delegationStop: undefined,
        nativeSubagentInterrupt: false,
      }),
    ).toMatchObject({ stop: false, nativeInterrupt: false });
  });

  it('offers native interrupt only for a Claude Task agent', () => {
    const capabilities = subagentViewerCapabilitiesFrom(
      createDesktopCapabilities('darwin'),
    );
    expect(
      subagentCapabilitiesForKind(capabilities, 'claude-native')
        .nativeInterrupt,
    ).toBe(true);
    expect(
      subagentCapabilitiesForKind(capabilities, 'codex-native').nativeInterrupt,
    ).toBe(false);
    expect(
      subagentCapabilitiesForKind(capabilities, 'managed').nativeInterrupt,
    ).toBe(true);
  });
});

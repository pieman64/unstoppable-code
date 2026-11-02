import type {
  AppDiagnosticRecord,
  SessionDiagnosticRecord,
} from '../observability/service';

const recordSessionDiagnosticMock = jest.fn<void, [SessionDiagnosticRecord]>();
const recordAppDiagnosticMock = jest.fn<void, [AppDiagnosticRecord]>();
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    recordSessionDiagnostic: (record: SessionDiagnosticRecord): void =>
      recordSessionDiagnosticMock(record),
    recordAppDiagnostic: (record: AppDiagnosticRecord): void =>
      recordAppDiagnosticMock(record),
  }),
}));

import {
  recordHostedClaudeProcessDiagnostic,
  recordReapedClaudeProcessDiagnostic,
} from '../agents/claude-process-diagnostics';

describe('Claude process diagnostics (CAN-4835)', () => {
  beforeEach(() => {
    recordSessionDiagnosticMock.mockReset();
    recordAppDiagnosticMock.mockReset();
  });

  it("records a delegated run's CLI under its parent chat", () => {
    recordHostedClaudeProcessDiagnostic(
      {
        sessionKey: 'project/worktree/parent',
        delegationId: 'delegation-1',
        providerType: 'claude',
      },
      {
        kind: 'claude_process_exited',
        pid: 4242,
        exitCode: null,
        signal: 'SIGKILL',
        uptimeMs: 10,
      },
    );

    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'claude_process_exited',
        sessionKey: 'project/worktree/parent',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'parent',
        delegationId: 'delegation-1',
        providerType: 'claude',
        pid: 4242,
        exitCode: null,
        signal: 'SIGKILL',
        uptimeMs: 10,
      }),
    );
    expect(
      recordSessionDiagnosticMock.mock.calls[0]?.[0].sessionInstanceId,
    ).toBeUndefined();
  });

  it('keeps the PID when the session key does not parse', () => {
    recordHostedClaudeProcessDiagnostic(
      {
        sessionKey: 'not-a-chat-key',
        sessionInstanceId: 'instance-1',
        providerType: 'claude',
      },
      { kind: 'claude_process_started', pid: 4242 },
    );

    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'claude_process_started',
        sessionKey: 'not-a-chat-key',
        projectId: '',
        sessionInstanceId: 'instance-1',
        pid: 4242,
      }),
    );
  });

  it("records a reaped chat CLI as its chat's session diagnostic", () => {
    recordReapedClaudeProcessDiagnostic({
      pid: 4242,
      startedAtMs: Date.now() - 1_000,
      executable: '/bin/claude',
      sessionKey: 'project/worktree/chat',
      sessionInstanceId: 'instance-1',
    });

    expect(recordAppDiagnosticMock).not.toHaveBeenCalled();
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'claude_process_untracked',
        claudeProcessUntrackedReason: 'previous_run',
        chatId: 'chat',
        sessionInstanceId: 'instance-1',
        pid: 4242,
      }),
    );
  });

  it('records a reaped CLI no chat owned as a PID-only app diagnostic', () => {
    recordReapedClaudeProcessDiagnostic({
      pid: 5151,
      startedAtMs: Date.now() - 1_000,
      executable: '/bin/claude',
    });

    expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'claude_process_untracked',
        reason: 'previous_run',
        claudeProcessId: 5151,
      }),
    );
    expect(
      Object.keys(recordAppDiagnosticMock.mock.calls[0]?.[0] ?? {}).sort(),
    ).toEqual([
      'claudeProcessId',
      'kind',
      'processUptimeMs',
      'reason',
      'timestamp',
      'version',
    ]);
  });
});

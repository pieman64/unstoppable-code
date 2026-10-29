import type { AppDiagnosticRecord } from '../observability/service';

const mockRecordDiagnostic = jest.fn<void, [AppDiagnosticRecord]>();
const mockInfo = jest.fn<void, [string, unknown]>();
const mockWarn = jest.fn<void, [string, unknown]>();
jest.mock('../observability', (): object => ({
  getObservabilityService: (): object => ({
    recordAppDiagnostic: (event: AppDiagnosticRecord): void =>
      mockRecordDiagnostic(event),
  }),
}));
jest.mock('../lib/main-process-logging', (): object => ({
  logMainProcessInfo: (message: string, context: unknown): void =>
    mockInfo(message, context),
  logMainProcessWarn: (message: string, context: unknown): void =>
    mockWarn(message, context),
}));

import { reportActivityMove } from '../lib/org-project-activity-move-report';

// CAN-3601: the answer to a move of uploaded activity used to be discarded,
// so a move the server refused on every launch left no trace.
describe('reportActivityMove', (): void => {
  const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  beforeEach((): void => {
    jest.clearAllMocks();
  });

  it("logs the server's answer, with the transfer and its counts", (): void => {
    const counts = {
      worktrees: 1,
      turns: 3,
      plans: 1,
      pullRequests: 1,
      skippedPullRequests: 0,
      pipelineRuns: 1,
      rekeyedBodies: 0,
    };
    reportActivityMove({
      projectId,
      result: 'answered',
      outcome: 'moved',
      transferId: 'transfer-1',
      counts,
    });
    expect(mockInfo.mock.calls).toEqual([
      [
        'Activity move to the organization answered',
        { projectId, outcome: 'moved', transferId: 'transfer-1', counts },
      ],
    ]);
    expect(mockRecordDiagnostic).not.toHaveBeenCalled();
  });

  it('records a refusal as an app diagnostic with the server code and no ids', (): void => {
    reportActivityMove({
      projectId,
      result: 'failed',
      status: 409,
      serverCode: 'not_personal',
      error: 'HTTP 409: Only Personal activity can move',
    });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockRecordDiagnostic).toHaveBeenCalledTimes(1);
    const [event] = mockRecordDiagnostic.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      version: 1,
      kind: 'org_project_activity_move_failed',
      reason: 'not_personal',
      error: 'HTTP 409: Only Personal activity can move',
    });
    // No workspace or project ids in app diagnostics.
    expect(Object.keys(event ?? {}).sort()).toEqual([
      'error',
      'kind',
      'reason',
      'timestamp',
      'version',
    ]);
  });

  it('names an HTTP status or the network when the server sent no code', (): void => {
    reportActivityMove({
      projectId,
      result: 'failed',
      status: 503,
      serverCode: null,
      error: 'HTTP 503',
    });
    reportActivityMove({
      projectId,
      result: 'failed',
      status: null,
      serverCode: null,
      error: 'offline',
    });
    expect(
      mockRecordDiagnostic.mock.calls.map(([event]) => event.reason),
    ).toEqual(['http_503', 'network']);
  });
});

import type { SessionDiagnosticRecord } from '../observability/service';
import {
  recordCodeGraphBuildDiagnostic,
  resetCodeGraphBuildDiagnosticsForTests,
  setCodeGraphBuildDiagnosticRecorderForTests,
} from '../lib/code-graph-build-diagnostics';

describe('local Code Graph build diagnostic safety', () => {
  afterEach(() => {
    resetCodeGraphBuildDiagnosticsForTests();
  });

  it('drops unsafe attempt ids and bounds duration fields in the local record', () => {
    const records: SessionDiagnosticRecord[] = [];
    setCodeGraphBuildDiagnosticRecorderForTests((record) =>
      records.push(record),
    );

    recordCodeGraphBuildDiagnostic({
      projectId: 'project-safe',
      worktreeId: 'worktree-safe',
      detail: {
        scope: 'worktree',
        trigger: 'refresh',
        outcome: 'deferred',
        failureStage: 'preflight',
        failureReason: 'busy',
        attemptId: 'private/path/id',
        queueWaitMs: Number.MAX_SAFE_INTEGER,
        totalMs: 4,
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'code_graph_build',
      sessionKey: 'project-safe/worktree-safe/',
      projectId: 'project-safe',
      worktreeId: 'worktree-safe',
      codeGraphBuild: {
        outcome: 'deferred',
        failureReason: 'busy',
        queueWaitMs: 86_400_000,
      },
    });
    expect(records[0]?.codeGraphBuild).not.toHaveProperty('attemptId');
    expect(JSON.stringify(records)).not.toContain('private/path/id');
  });
});

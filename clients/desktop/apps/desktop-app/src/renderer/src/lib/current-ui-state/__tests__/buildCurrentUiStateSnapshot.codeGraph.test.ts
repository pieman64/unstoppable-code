/** @jest-environment jsdom */
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

const PANEL = {
  scope: 'worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
  phase: 'loaded',
  state: 'ready',
  enabled: true,
  building: false,
  repositoryCount: 2,
  loadErrorVisible: false,
  buildErrorVisible: false,
};

function project(
  fields: Record<string, unknown>,
): ReturnType<typeof buildCurrentUiStateSnapshot>['codeGraphPanel'] {
  return buildCurrentUiStateSnapshot({
    'codeGraph.detailPanel': { ...PANEL, ...fields },
  }).codeGraphPanel;
}

describe('Code Graph App Advisor readiness projection', () => {
  it.each([
    ['snapshotState', 'missing'],
    ['snapshotState', 'summary-pending'],
    ['snapshotState', 'readable'],
    ['snapshotState', 'read-error'],
    ['buildState', 'idle'],
    ['buildState', 'queued'],
    ['buildState', 'running'],
    ['readFailure', 'queue-timeout'],
    ['readFailure', 'execution-timeout'],
    ['readFailure', 'busy'],
    ['readFailure', 'worker-exit'],
    ['readFailure', 'canceled'],
    ['readFailure', 'invalid-response'],
    ['readFailure', 'database-error'],
  ])('preserves %s=%s and every legacy field', (key, value) => {
    expect(project({ [key]: value })).toEqual({ ...PANEL, [key]: value });
  });

  it.each([
    undefined,
    null,
    false,
    0,
    {},
    [],
    'ready',
    '/private/workspace/graph.db',
    'SQLITE_BUSY: secret database path',
  ])('drops invalid readiness values: %p', (value) => {
    expect(
      project({
        snapshotState: value,
        buildState: value,
        readFailure: value,
      }),
    ).toEqual(PANEL);
  });

  it('retains independent readability and generation without exposing payloads', () => {
    expect(
      project({
        snapshotState: 'readable',
        buildState: 'running',
        readFailure: '/private/workspace/graph.db',
        totals: { fileCount: 23, symbolCount: 45 },
        message: 'SQLITE_BUSY: /private/workspace/graph.db',
        repositories: [{ name: 'private-repository', gitHead: 'secret-head' }],
        shadowPath: '/private/workspace/shadow',
      }),
    ).toEqual({ ...PANEL, snapshotState: 'readable', buildState: 'running' });
  });

  it('does not invent readiness for an older reporter', () => {
    expect(project({})).toEqual(PANEL);
    expect(buildCurrentUiStateSnapshot({}).codeGraphPanel).toBeUndefined();
  });
});

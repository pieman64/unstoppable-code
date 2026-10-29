import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';
import { workspaceReadinessIssueKey } from '../workspaceReadinessIssueKey';

// Pins the derivation directly: the consuming component suites only observe
// behavior THROUGH the key (disabled states, row identity), so a changed
// derivation can pass them while breaking cross-surface stability.
describe('workspaceReadinessIssueKey', () => {
  function issue(
    overrides: Partial<WorkspaceReadinessIssue>,
  ): WorkspaceReadinessIssue {
    return {
      code: 'configure-hooks',
      title: 'Add repository hooks',
      message: 'No effective hooks.',
      repoName: 'app',
      fixPrompt: 'Configure hooks.',
      ...overrides,
    };
  }

  it('gives sibling recovery checkouts distinct stable keys and derived entry ids', () => {
    const recoveries = ['alpha', 'beta'].map((branchName) =>
      issue({
        code: 'recovery-required',
        fixPrompt: null,
        recovery: {
          workspaceId: 'ws-1',
          phase: 'orphan-checkout',
          repositoryPath: '/repos/app',
          checkoutPath: `/checkouts/${branchName}`,
          branchName,
        },
      }),
    );
    const keys = recoveries.map(workspaceReadinessIssueKey);
    expect(new Set(keys).size).toBe(2);
    expect(
      new Set(keys.map((key) => `advanced:readiness:ws-1:${key}`)).size,
    ).toBe(2);
    expect(
      recoveries.map((item) => workspaceReadinessIssueKey({ ...item })),
    ).toEqual(keys);
  });

  it('prefers the child-repo id when present', () => {
    expect(workspaceReadinessIssueKey(issue({ repoId: 'repo-1' }))).toBe(
      'repo-1:configure-hooks',
    );
  });

  it('falls back to the repo name for single-repo issues', () => {
    expect(workspaceReadinessIssueKey(issue({}))).toBe('app:configure-hooks');
  });

  it('distinguishes issues by code within one repo', () => {
    expect(
      workspaceReadinessIssueKey(issue({ code: 'configure-scripts' })),
    ).not.toBe(workspaceReadinessIssueKey(issue({})));
  });
});

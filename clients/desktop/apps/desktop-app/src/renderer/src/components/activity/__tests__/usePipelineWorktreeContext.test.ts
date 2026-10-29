import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import { ensureWorkspaceRootRepoChoice } from '../usePipelineWorktreeContext';

describe('ensureWorkspaceRootRepoChoice', () => {
  it('prepends the project root for local-only multi-repo projects', () => {
    // Temporary and persistent local-only workspaces have the same IPC shape:
    // child repos are returned while the non-Git workspace root is omitted.
    const choices = [
      { repoId: 'app', repoName: 'App' },
      { repoId: 'api', repoName: 'API' },
    ];

    expect(ensureWorkspaceRootRepoChoice(choices)).toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: WORKSPACE_ROOT_REPO_NAME,
      },
      ...choices,
    ]);
  });

  it('falls back to the project root when repo entries are empty', () => {
    expect(ensureWorkspaceRootRepoChoice([])).toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: WORKSPACE_ROOT_REPO_NAME,
      },
    ]);
  });

  it('does not duplicate an existing workspace-root choice', () => {
    const choices = [
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: WORKSPACE_ROOT_REPO_NAME,
      },
      { repoId: 'app', repoName: 'App' },
    ];

    expect(ensureWorkspaceRootRepoChoice(choices)).toBe(choices);
  });
});

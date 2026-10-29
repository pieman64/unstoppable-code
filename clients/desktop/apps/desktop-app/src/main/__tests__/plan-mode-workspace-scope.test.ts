import type { WorkspaceRepoData } from '@canopy/desktop-shared/types';
import {
  buildMultiRepoPlanScopePrompt,
  buildPlanModeWorkspaceScopePrompt,
} from '../lib/plan-mode-workspace-scope';

const mockGetWorkspaceType = jest.fn();
const mockReadEffectiveWorkspaceConfig = jest.fn();

jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: (workspaceId: string): unknown =>
    mockGetWorkspaceType(workspaceId),
}));

jest.mock('../lib/workspace-source', () => ({
  readEffectiveWorkspaceConfig: (workspaceId: string): unknown =>
    mockReadEffectiveWorkspaceConfig(workspaceId),
}));

describe('buildMultiRepoPlanScopePrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires proposed plans to declare multi-repo scope', () => {
    const repos: WorkspaceRepoData[] = [
      { id: 'api', name: 'API', repoPath: '/workspace/repos/api' },
      { id: 'web', name: 'Web', repoPath: '/workspace/repos/web' },
    ];

    const prompt = buildMultiRepoPlanScopePrompt({
      repos,
      hasWorkspaceRootRepo: true,
      selectedRepoId: 'api',
    });

    expect(prompt).toContain('Multi-repo planning scope:');
    expect(prompt).toContain('Current working scope: child repo API (api).');
    expect(prompt).toContain('- API (api)');
    expect(prompt).toContain('- Web (web)');
    expect(prompt).toContain('"Repository Scope" section');
    expect(prompt).toContain('Which child repos are in scope, by name and id');
    expect(prompt).toContain(
      'Whether the top-level project itself is in scope',
    );
    expect(prompt).toContain(
      'which child repos are out of scope by name and id',
    );
    expect(prompt).toContain('all child repos are out of scope');
  });

  it('returns undefined when project config cannot be loaded', async () => {
    mockGetWorkspaceType.mockReturnValue('multi-repo');
    mockReadEffectiveWorkspaceConfig.mockRejectedValue(
      new Error('project read failed'),
    );

    await expect(
      buildPlanModeWorkspaceScopePrompt('workspace', 'api'),
    ).resolves.toBeUndefined();
  });
});

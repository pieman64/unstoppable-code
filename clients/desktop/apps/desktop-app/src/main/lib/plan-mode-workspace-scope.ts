import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import { getWorkspaceType } from './workspace-registry';
import {
  readEffectiveWorkspaceConfig,
  type EffectiveWorkspaceConfig,
} from './workspace-source';

export interface MultiRepoPlanScopePromptOptions {
  repos: WorkspaceRepoData[];
  hasWorkspaceRootRepo: boolean;
  selectedRepoId?: string;
}

function formatRepoLabel(repo: WorkspaceRepoData): string {
  return `${repo.name} (${repo.id})`;
}

function describeSelectedScope(
  options: MultiRepoPlanScopePromptOptions,
): string {
  const selectedRepoId = options.selectedRepoId ?? WORKSPACE_ROOT_REPO_ID;
  if (selectedRepoId === WORKSPACE_ROOT_REPO_ID) {
    return options.hasWorkspaceRootRepo
      ? `${WORKSPACE_ROOT_REPO_NAME} (${WORKSPACE_ROOT_REPO_ID})`
      : 'top-level project root';
  }

  const selectedRepo = options.repos.find(
    (repo): boolean => repo.id === selectedRepoId,
  );
  if (selectedRepo) {
    return `child repo ${formatRepoLabel(selectedRepo)}`;
  }

  return `child repo id ${selectedRepoId}`;
}

export function buildMultiRepoPlanScopePrompt(
  options: MultiRepoPlanScopePromptOptions,
): string {
  const repoLines =
    options.repos.length > 0
      ? options.repos
          .map((repo): string => `- ${formatRepoLabel(repo)}`)
          .join('\n')
      : '- No child repos are currently configured.';
  const rootDescription = options.hasWorkspaceRootRepo
    ? `The top-level project is also a source-backed repository: ${WORKSPACE_ROOT_REPO_NAME} (${WORKSPACE_ROOT_REPO_ID}).`
    : 'The top-level project root is available as a working directory, but this project does not have a source-backed top-level repository.';

  return [
    'Multi-repo planning scope:',
    rootDescription,
    `Current working scope: ${describeSelectedScope(options)}.`,
    'Configured child repos:',
    repoLines,
    'For any proposed plan in this multi-repo project, include a "Repository Scope" section that clearly states:',
    '- Which child repos are in scope, by name and id, or that no child repos are in scope.',
    '- Whether the top-level project itself is in scope.',
    '- If the top-level project itself is in scope, which child repos are out of scope by name and id, or that all child repos are out of scope when no child repo work is included. If no child repos are out of scope, state that explicitly.',
  ].join('\n');
}

export async function buildPlanModeWorkspaceScopePrompt(
  projectId: string,
  selectedRepoId?: string,
): Promise<string | undefined> {
  if (getWorkspaceType(projectId) !== 'multi-repo') {
    return undefined;
  }

  const config = await readEffectiveWorkspaceConfig(projectId).catch(
    (): undefined => undefined,
  );
  if (!config) {
    return undefined;
  }

  const scopeConfig: Pick<
    EffectiveWorkspaceConfig,
    'repos' | 'sourceRepoPath'
  > = {
    repos: config.repos,
    sourceRepoPath: config.sourceRepoPath,
  };
  return buildMultiRepoPlanScopePrompt({
    repos: scopeConfig.repos,
    hasWorkspaceRootRepo: Boolean(scopeConfig.sourceRepoPath),
    selectedRepoId,
  });
}

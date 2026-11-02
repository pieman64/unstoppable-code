import type { WorkspaceRepoData } from '@canopy/desktop-shared/types';
import { readWorkspaceConfig } from './workspace-persistence';

export async function readWorkspaceRepoOrThrow(args: {
  workspaceId: string;
  repoId: string;
  notFoundMessage: string;
}): Promise<WorkspaceRepoData> {
  const config = await readWorkspaceConfig(args.workspaceId);
  const repo = config.repos.find((candidate) => candidate.id === args.repoId);
  if (!repo) {
    throw new Error(args.notFoundMessage);
  }
  return repo;
}

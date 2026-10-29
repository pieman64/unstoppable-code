import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  isGitHubPreviewTarget,
  isGitHubReferenceOrigin,
  isLinearIssuePreviewRequest,
  type GitHubOriginRepository,
  type GitHubPreviewResult,
  type GitHubPreviewScope,
  type LinearIssuePreviewResult,
  type LinearPreviewScope,
  type LinearTeamKeysResult,
} from '@canopy/protocol/reference-previews';
import { createGitHubReferencePreviewReader } from '../lib/github-reference-preview';
import { createLinearReferencePreviewReader } from '../lib/linear-reference-preview';
import { registerIpcHandler } from './register';

/** Read-only previews for transcript references; credentials stay in main. */
export function registerReferencePreviewHandlers(): void {
  const linear = createLinearReferencePreviewReader();
  const github = createGitHubReferencePreviewReader();

  registerIpcHandler<[], LinearPreviewScope>(
    IPC_CHANNELS.referencePreviewLinearScope,
    () => linear.readScope(),
  );

  registerIpcHandler<[], LinearTeamKeysResult>(
    IPC_CHANNELS.referencePreviewLinearTeams,
    () => linear.readTeamKeys(),
  );

  registerIpcHandler<[unknown], LinearIssuePreviewResult>(
    IPC_CHANNELS.referencePreviewLinearIssue,
    async (_event, request) => {
      if (!isLinearIssuePreviewRequest(request)) {
        throw new Error('Invalid Linear issue preview request.');
      }
      return linear.readIssue({
        identifier: request.identifier,
        ...(request.workspaceSlug !== undefined
          ? { workspaceSlug: request.workspaceSlug }
          : {}),
      });
    },
  );

  registerIpcHandler<[], GitHubPreviewScope>(
    IPC_CHANNELS.referencePreviewGitHubScope,
    () => github.readScope(),
  );

  registerIpcHandler<[unknown], GitHubOriginRepository>(
    IPC_CHANNELS.referencePreviewGitHubOrigin,
    async (_event, origin) => {
      if (!isGitHubReferenceOrigin(origin)) {
        throw new Error('Invalid GitHub reference origin.');
      }
      return github.readOrigin(
        origin.kind === 'worktree'
          ? {
              kind: 'worktree',
              projectId: origin.projectId,
              worktreeId: origin.worktreeId,
            }
          : { kind: 'cowork' },
      );
    },
  );

  registerIpcHandler<[unknown], GitHubPreviewResult>(
    IPC_CHANNELS.referencePreviewGitHub,
    async (_event, target) => {
      if (!isGitHubPreviewTarget(target)) {
        throw new Error('Invalid GitHub preview request.');
      }
      return github.read(
        target.kind === 'item'
          ? {
              kind: 'item',
              owner: target.owner,
              repository: target.repository,
              number: target.number,
            }
          : {
              kind: 'repository',
              owner: target.owner,
              repository: target.repository,
            },
      );
    },
  );
}

import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  IPC_CHANNELS,
  type DetectedPlanEntry,
  type DetectedPlanUpdateRequest,
  type DetectedPlansListRequest,
  type DetectedPlansScanRequest,
  type DetectedPlansScanResponse,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { resolveWorktreePlanDetectionRules } from '../lib/plan-detection-config';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { getWorkspaceWorktreeDir } from '../lib/paths';
import { matchCandidatePaths } from '../lib/detected-plan-matcher';
import {
  appendDetectedPlans,
  readDetectedPlans,
  updateDetectedPlan,
} from '../lib/detected-plan-persistence';
import { validateId } from '../lib/validation';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { sendToWindow } from '../lib/window-send';
import { registerIpcHandler } from './register';

export async function scanDetectedPlans(
  request: DetectedPlansScanRequest,
): Promise<DetectedPlansScanResponse> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.chatId, 'chatId');
  const rules = await resolveWorktreePlanDetectionRules(
    request.projectId,
    request.worktreeId,
  );
  const existing = await readDetectedPlans(
    request.projectId,
    request.worktreeId,
  );
  if (rules.includes.length === 0) {
    return { entries: existing, newlyDetected: [] };
  }
  const worktreePath = getWorkspaceWorktreeDir(
    request.projectId,
    request.worktreeId,
  );
  const repoEntries = await listWorkspaceWorktreeRepoEntries(
    request.projectId,
    worktreePath,
  ).catch(() => []);
  const repos =
    repoEntries.length > 0
      ? repoEntries.map((repo) => ({
          repoId: repo.repoId,
          repoPath: repo.repoPath,
        }))
      : [{ repoId: WORKSPACE_ROOT_REPO_ID, repoPath: worktreePath }];
  const matches = matchCandidatePaths({
    candidatePaths: request.candidatePaths,
    repos,
    rules,
  });
  const existingKeys = new Set(
    existing.map((entry) => `${entry.sourceRepoId}::${entry.sourceFilePath}`),
  );
  const now = new Date().toISOString();
  const fresh: DetectedPlanEntry[] = matches
    .filter(
      (match) =>
        !existingKeys.has(`${match.sourceRepoId}::${match.sourceFilePath}`),
    )
    .map((match) => ({
      id: randomUUID(),
      sourceRepoId: match.sourceRepoId,
      sourceFilePath: match.sourceFilePath,
      status: 'detected',
      bannerSeen: false,
      detectedInChatId: request.chatId,
      detectedAt: now,
    }));
  const entries =
    fresh.length > 0
      ? await appendDetectedPlans(request.projectId, request.worktreeId, fresh)
      : existing;
  return { entries, newlyDetected: fresh };
}

export function registerDetectedPlansHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  registerIpcHandler<[DetectedPlansScanRequest], DetectedPlansScanResponse>(
    IPC_CHANNELS.detectedPlansScan,
    async (_event, request) => {
      const response = await scanDetectedPlans(request);
      if (response.newlyDetected.length > 0) {
        sendToWindow(getWindow(), IPC_CHANNELS.detectedPlansUpdated, {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          entries: response.entries,
        });
      }
      return response;
    },
  );

  registerIpcHandler<[DetectedPlansListRequest], DetectedPlanEntry[]>(
    IPC_CHANNELS.detectedPlansList,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      // Cowork workspaces have no detected-plan storage (worktree-only
      // feature); empty list instead of the resolve-worktree throw.
      if (isCoworkWorkspace(request.projectId)) {
        return [];
      }
      return readDetectedPlans(request.projectId, request.worktreeId);
    },
  );

  registerIpcHandler<[DetectedPlanUpdateRequest], DetectedPlanEntry[]>(
    IPC_CHANNELS.detectedPlansUpdate,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.entryId, 'entryId');
      if (request.importedPlanId !== undefined) {
        validateId(request.importedPlanId, 'importedPlanId');
      }
      const entries = await updateDetectedPlan(
        request.projectId,
        request.worktreeId,
        request.entryId,
        {
          ...(request.status ? { status: request.status } : {}),
          ...(request.bannerSeen !== undefined
            ? { bannerSeen: request.bannerSeen }
            : {}),
          ...(request.importedPlanId
            ? { importedPlanId: request.importedPlanId }
            : {}),
        },
      );
      sendToWindow(getWindow(), IPC_CHANNELS.detectedPlansUpdated, {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        entries,
      });
      return entries;
    },
  );
}

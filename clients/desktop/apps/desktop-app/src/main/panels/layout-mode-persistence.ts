import {
  APP_ADVISOR_PROJECT_ID,
  type WorkspaceLayoutMode,
} from '@canopy/desktop-shared/types';
import {
  initializePanelLayoutModeFile,
  readPanelLayoutModeFile,
  savePanelLayoutModeFile,
  type PanelLayoutModeFileTarget,
} from '@canopy/desktop-shared/node/lib/panel-layout-mode';
import { getWorktreePanelLayoutModeFilePath } from '../lib/paths';

function target(
  projectId: string,
  worktreeId: string,
): PanelLayoutModeFileTarget {
  return {
    workspaceId: projectId,
    worktreeId,
    filePath: getWorktreePanelLayoutModeFilePath(projectId, worktreeId),
  };
}

export class PanelLayoutModePersistenceStore {
  public load(
    projectId: string,
    worktreeId: string,
  ): Promise<WorkspaceLayoutMode | null> {
    if (projectId === APP_ADVISOR_PROJECT_ID) return Promise.resolve(null);
    return readPanelLayoutModeFile(target(projectId, worktreeId));
  }

  public initialize(
    projectId: string,
    worktreeId: string,
    mode: WorkspaceLayoutMode,
  ): Promise<WorkspaceLayoutMode> {
    if (projectId === APP_ADVISOR_PROJECT_ID) {
      return Promise.resolve('advanced');
    }
    return initializePanelLayoutModeFile(target(projectId, worktreeId), mode);
  }

  public save(
    projectId: string,
    worktreeId: string,
    mode: WorkspaceLayoutMode,
  ): Promise<void> {
    if (projectId === APP_ADVISOR_PROJECT_ID) return Promise.resolve();
    return savePanelLayoutModeFile(target(projectId, worktreeId), mode);
  }
}

export const panelLayoutModePersistenceStore =
  new PanelLayoutModePersistenceStore();

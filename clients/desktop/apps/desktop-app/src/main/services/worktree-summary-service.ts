import type { BrowserWindow } from 'electron';
import { validateId } from '../lib/validation';
import { triggerManualRefresh } from '../lib/worktree-summary-scheduler';

export function refreshWorktreeSummary(
  projectId: string,
  worktreeId: string,
  getWindow: () => BrowserWindow | null,
): void {
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  triggerManualRefresh(projectId, worktreeId, getWindow);
}

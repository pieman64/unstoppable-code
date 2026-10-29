import {
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorAction,
  type AppAdvisorBrowserAction,
  type AppAdvisorRendererToolRequest,
} from '../types';

export function isAppAdvisorBrowserAction(
  action: AppAdvisorAction,
): action is AppAdvisorBrowserAction {
  return action.type.startsWith('browser.');
}

/**
 * A window this computer shows for a controlled computer. Each surface has
 * its own bridge on the controlled computer, so replies, per-page
 * subscriptions and addressed pushes reach exactly that window.
 */
export const REMOTE_SURFACES = ['main', 'app-advisor'] as const;

export type RemoteSurface = (typeof REMOTE_SURFACES)[number];

export function isRemoteSurface(value: unknown): value is RemoteSurface {
  return REMOTE_SURFACES.some((surface) => surface === value);
}

/**
 * Whether a renderer tool request runs in App Advisor's own window: its
 * questions, its files, and browser actions without a worktree. Everything
 * else runs in the main window.
 */
export function targetsAppAdvisorSurface(
  request: AppAdvisorRendererToolRequest,
): boolean {
  return (
    request.kind === 'ask_user_question' ||
    (request.kind === 'dispatch_action' &&
      isAppAdvisorBrowserAction(request.action) &&
      !request.action.projectId &&
      !request.action.worktreeId) ||
    (request.kind === 'show_files' &&
      request.payload.target.projectId === APP_ADVISOR_PROJECT_ID)
  );
}

export function rendererToolRequestSurface(
  request: AppAdvisorRendererToolRequest,
): RemoteSurface {
  return targetsAppAdvisorSurface(request) ? 'app-advisor' : 'main';
}

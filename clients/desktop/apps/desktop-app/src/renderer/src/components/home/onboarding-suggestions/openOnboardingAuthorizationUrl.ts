import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { discardOpenedBrowser } from '@/lib/panels/browser-panel-sync';
import { useBrowserStore } from '@/stores/browserStore';

export interface OnboardingChatBrowserTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * Open one provider authorization page beside the new-task chat that owns it.
 * The tab appears at once; the result waits for its session so a failed open
 * removes the tab and reports `false` (the caller then falls back).
 */
export async function openOnboardingAuthorizationUrl(
  target: OnboardingChatBrowserTarget,
  url: string,
): Promise<boolean> {
  const opened = useBrowserStore
    .getState()
    .openBrowser(target.projectId, target.worktreeId, { url });
  if (opened === null) {
    return false;
  }
  let activated = false;
  try {
    activated = await requestBrowserPanel(
      target.projectId,
      target.worktreeId,
      opened.browserId,
      target.chatId,
      { focus: true },
    );
  } catch {
    // Treated as a declined placement below.
  }
  if (activated && (await opened.ready) !== null) {
    return true;
  }
  await discardOpenedBrowser(
    target.projectId,
    target.worktreeId,
    opened.browserId,
  );
  return false;
}

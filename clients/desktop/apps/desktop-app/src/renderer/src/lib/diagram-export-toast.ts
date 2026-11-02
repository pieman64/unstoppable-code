import type { MermaidExportToast } from '@canopy/ui-shared/components';
import { useGitHubStore, type ToastMeta } from '@/stores/githubStore';

/**
 * Posts a diagram export toast. It answers a click on the diagram, so like a
 * share toast it shows even with in-app notifications off (`forceInApp`) and
 * never raises an OS banner (`suppressOsNotification`).
 */
export function postDiagramExportToast(toast: MermaidExportToast): void {
  const meta: ToastMeta = {
    forceInApp: true,
    suppressOsNotification: true,
    ...(toast.blockMessageFromReplay === true
      ? { blockMessageFromReplay: true }
      : {}),
    ...(toast.action !== undefined
      ? { action: { label: toast.action.label, onClick: toast.action.run } }
      : {}),
  };
  useGitHubStore
    .getState()
    .addToast(toast.message, toast.tone, undefined, meta);
}

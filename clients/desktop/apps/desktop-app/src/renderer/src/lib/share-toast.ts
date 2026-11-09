import type { ShareToast } from '@canopy/ui-app/sharing';
import { useGitHubStore } from '@/stores/githubStore';
import type { ToastMeta } from '@/stores/toastStore';

/**
 * Posts a share toast. A share dialog closes on success, so this toast is the
 * only confirmation: it shows even with in-app notifications off
 * (`forceInApp`) and never raises an OS banner (`suppressOsNotification`).
 * A toast that carries a link stays for a minute so there is time to copy it.
 */
export function postShareToast(toast: ShareToast): void {
  const meta: ToastMeta = {
    forceInApp: true,
    suppressOsNotification: true,
    ...(toast.blockMessageFromReplay === true
      ? { blockMessageFromReplay: true }
      : {}),
    ...(toast.link !== undefined
      ? { link: { url: toast.link, signedIn: true }, persistent: true }
      : {}),
  };
  useGitHubStore
    .getState()
    .addToast(toast.message, toast.tone, undefined, meta);
}

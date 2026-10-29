import { create } from 'zustand';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { invalidateSharedAiCreditsRead } from '@/lib/openBillingPage';

/**
 * Per-surface personalization for the shared cloud connect gate (CAN-936, WS3).
 * Every contextual sign-in prompt (Remote Control, AI Credits purchase, upgrade
 * nudge) routes through the same `CloudSyncModal` via this context so no surface
 * reimplements OAuth.
 */
export interface CloudConnectGateContext {
  title?: string;
  /**
   * Subheading under the modal title. `null` renders NO subheading, which is
   * distinct from omitting the key (that falls back to the modal's generic
   * default). Guest entry points use `null`: the panel's lead line plus its
   * benefit rows already carry the pitch.
   */
  subtitle?: string | null;
  description?: string;
  /**
   * Body of the success toast fired when the user connects. Signing in closes
   * the gate immediately, so this per-surface copy is the confirmation — there
   * is no in-modal success screen for it to live in.
   */
  toastMessage?: string;
  /** The request originated from a confirmed guest account. */
  guestBenefits?: boolean;
}

interface PendingConnect {
  context: CloudConnectGateContext;
  proceed: () => void;
}

interface CloudConnectGateState {
  /**
   * The in-flight connect request, or `null` when no modal is open. Holds a
   * transient callback — never persisted.
   */
  pending: PendingConnect | null;
  /**
   * Trigger the shared sign-in surface. If a real (non-guest) account is already
   * connected, `proceed` runs immediately with no modal. Otherwise the shared
   * `CloudSyncModal` opens; the mounted `CloudConnectGate` auto-resumes `proceed`
   * once the user connects (or upgrades from guest).
   */
  requestConnect: (
    context: CloudConnectGateContext,
    proceed: () => void,
  ) => void;
  /**
   * Clear the pending request (called by the gate on modal close).
   *
   * Also opens a new AI-credits availability episode. The gate closing is the
   * moment the account may have just changed, and this is the one chokepoint
   * every close passes through — putting the invalidation in the mounted
   * component instead would make the guarantee depend on which surface happened
   * to close the modal.
   */
  resolve: () => void;
}

/**
 * A guest credential is technically "connected" (it has a device key), but for
 * the WS3 contextual prompts a guest still needs to sign in / upgrade before the
 * gated action can run. So the gate treats guest as not-yet-connected.
 */
function isConnectedNonGuest(
  account: CanopyCloudAccountPublicState | null | undefined,
): boolean {
  return isCanopyCloudConnected(account) && !isGuestAccount(account);
}

/**
 * App-wide singleton backing the shared cloud connect gate. A single
 * `CloudConnectGate` mounted once in `App.tsx` reads `pending` and renders the
 * shared modal, so contextual prompts never stack their own sign-in modals.
 */
export const useCloudConnectGateStore = create<CloudConnectGateState>(
  (set) => ({
    pending: null,
    requestConnect: (context, proceed): void => {
      void (async (): Promise<void> => {
        let account: CanopyCloudAccountPublicState | null | undefined;
        try {
          account = await window.api.loadCanopyCloudAccount();
        } catch {
          // Fall through to the connect prompt on load failure. Only the
          // account load is guarded — a throw from `proceed()` must surface,
          // not be swallowed and mistaken for a load failure that opens the
          // modal.
          set({
            pending: {
              context: { ...context, guestBenefits: false },
              proceed,
            },
          });
          return;
        }
        if (isConnectedNonGuest(account)) {
          proceed();
          return;
        }
        set({
          pending: {
            // The fresh account read is authoritative in both directions. A
            // caller may have rendered from a stale guest snapshot, so only
            // upgrading `false` to `true` would preserve guest-only copy and
            // merge warnings after that guest credential has disappeared.
            context: {
              ...context,
              guestBenefits: isGuestAccount(account),
            },
            proceed,
          },
        });
      })();
    },
    resolve: (): void => {
      // BEFORE the state change, so every surface woken by `pending -> null`
      // reads in the new episode rather than inheriting the pre-sign-in answer.
      invalidateSharedAiCreditsRead();
      set({ pending: null });
    },
  }),
);

export { isConnectedNonGuest };

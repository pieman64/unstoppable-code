import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DialogModal } from '@/components/shared/DialogModal';
import { CopyButton } from '@/components/shared/CopyButton';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useSubscriptionStatus } from '@/hooks/useSubscriptionStatus';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { RemoteControlUpgradeCta } from '@/components/portal/RemoteControlUpgradeCta';
import {
  resolveBillingManageableOrgs,
  resolveManageableLapsedOrg,
} from '@/components/portal/manageable-lapsed-org';
import { RemoteControlGuestCta } from '@/components/portal/RemoteControlGuestCta';
import { RemoteControlMobileAppsCta } from '@/components/portal/RemoteControlMobileAppsCta';
import { RemoteControlPairingQr } from '@/components/portal/RemoteControlPairingQr';
import { useQrCodeDataUrl } from '@/hooks/useQrCodeDataUrl';
import type {
  CanopyCloudAccountPublicState,
  CanopyPortalState,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { lapsedOrgNames as lapsedOrgNamesFrom } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { organizationBillingPath } from '@canopy/protocol/billing';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { buildRemoteControlPairingUrl } from '@canopy/protocol/portal/pairing-link';
import { GUEST_WORK_PRESERVED } from '@/lib/guest-cta-copy';
import { brandText, getBrandMobileApps } from '@/lib/brand';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { useSettingsLocationLabel } from '@/lib/navigation/settings-destinations';

const PORTAL_NAME = REMOTE_CONTROL_LABEL;
const CLOUD_NAME = `${brandText.appName} Cloud`;
const TITLE = PORTAL_NAME;
const SUBTITLE = `Steer the agents running on this ${brandText.appName} app from any browser. Pair securely with ${CLOUD_NAME} to control the sessions on this machine from anywhere.`;
/**
 * Same sentence, naming the phone app as a second way in.
 *
 * This is how the mobile story survives {@link RemoteControlMobileAppsCta}
 * being hidden from signed-out and guest visitors: prose costs nothing next to
 * the modal's primary CTA, while a pair of store badges under that CTA competes
 * with it. Brand-gated on a declared listing, so a brand with no mobile app
 * never names one.
 */
const SUBTITLE_WITH_MOBILE = `Steer the agents running on this ${brandText.appName} app from any browser, or from the ${brandText.appName} mobile app. Pair securely with ${CLOUD_NAME} to control the sessions on this machine from anywhere.`;

/** Where the cloud account lives depends on the Settings rail. */
function noAccountMessage(accountLocation: string): string {
  return `Connect ${CLOUD_NAME} in ${accountLocation} before enabling ${REMOTE_CONTROL_LABEL.toLowerCase()}.`;
}
const DISABLED_HELPER = `A QR code will appear. Scan it with your phone, or enter its 6-digit code in ${CLOUD_NAME}.`;
const PENDING_STATUS_LABEL = 'Waiting for code';
/** Shown only when no QR code is available; the QR code carries its own line. */
const PENDING_HELPER = `Enter this code in ${CLOUD_NAME}.`;
const MANUAL_FALLBACK_LABEL = `Or enter this code in ${CLOUD_NAME}:`;
const EXPIRED_RETRY_HELPER = `Enable ${REMOTE_CONTROL_LABEL} to get a new QR code.`;
const CONNECTED_STATUS_LABEL = 'Connected';
const RECONNECTING_STATUS_LABEL = 'Reconnecting';
const RECONNECTING_HELPER = `${CLOUD_NAME} will keep the session open while this app reconnects.`;
const ERROR_STATUS_LABEL = 'Connection failed';
const STARTING_STATUS_LABEL = 'Starting…';
const STOPPING_STATUS_LABEL = 'Stopping…';
const DISCONNECTED_STATUS_LABEL = 'Disconnected';
const DISCONNECTED_HELPER = `The session ended. Reconnect to start a new session — a fresh pairing code will appear if ${CLOUD_NAME} needs to pair again.`;

const SIGN_IN_BUTTON = `Sign in to enable ${REMOTE_CONTROL_LABEL}`;
/**
 * Title and supporting line for the sign-in gate a guest opens from the pairing
 * CTA. Deliberately NOT `SIGN_IN_BUTTON`, even though they render the same
 * string today: that constant labels the no-account state's button, and reusing
 * it would let an edit to that button silently retitle this dialog.
 *
 * The description closes on {@link GUEST_WORK_PRESERVED}, the same clause the
 * pairing card ends with, so the dialog continues the sentence the guest just
 * read instead of restarting on a different subject. Shared rather than
 * duplicated because a second hand-maintained copy of that clause is exactly
 * the drift `guest-cta-copy.ts` exists to prevent.
 */
const GUEST_GATE_TITLE = `Sign in to enable ${REMOTE_CONTROL_LABEL}`;
const GUEST_GATE_DESCRIPTION = `An account is what pairs this device with ${REMOTE_CONTROL_LABEL}. ${GUEST_WORK_PRESERVED}`;
/**
 * Confirmation for the same flow. Overridden alongside the title so the guest
 * is not told about a different feature than the one they just signed in for.
 */
const GUEST_GATE_TOAST = `You're all set. Your guest work is synced and ${REMOTE_CONTROL_LABEL} is ready to enable.`;
const ENABLE_BUTTON = `Enable ${REMOTE_CONTROL_LABEL}`;
const DISABLE_BUTTON = `Disable ${REMOTE_CONTROL_LABEL}`;
const REGENERATE_BUTTON = 'Regenerate code';
const PAIR_ANOTHER_DEVICE_BUTTON = 'Pair another device';
const CANCEL_PAIRING_CODE_BUTTON = 'Cancel pairing code';
const PAIR_ANOTHER_DEVICE_HELPER =
  'Enter this code on the other device. Devices already connected stay connected.';
const PAIR_ANOTHER_DEVICE_QR_HELPER =
  'Scan the QR code or enter the code on the other device. Devices already connected stay connected.';
const TRY_AGAIN_BUTTON = 'Try again';
const RECONNECT_BUTTON = 'Reconnect';
const OPEN_SETTINGS_BUTTON = 'Open settings';
const VIEW_PORTAL_BUTTON = 'View web portal';
const CLOSE_BUTTON = 'Close';
const ACCOUNT_LOADING_LABEL = `Checking ${CLOUD_NAME} account…`;

interface CanopyPortalModalProps {
  onClose: () => void;
  /**
   * Invoked when the user clicks "Open Settings" — the host opens the
   * settings overlay to the Accounts tab where the Cloud API key
   * is configured.
   */
  onOpenAccountSettings: () => void;
  /**
   * Invoked when the user clicks "Sign in to enable Remote Control" from the
   * no-account state (CAN-936, WS3). The host routes this through the shared
   * cloud connect gate so the user signs in inline and lands back on this modal,
   * which advances to the Enable state on `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT`.
   * The modal stays dumb — no OAuth logic inside it.
   */
  onRequestSignIn: () => void;
}

function PairingCodeDisplay({ code }: { code: string | null }): JSX.Element {
  if (!code) {
    return (
      <span className="font-mono text-3xl font-semibold fg-secondary">
        — — — — — —
      </span>
    );
  }
  // Render the two halves as adjacent spans with a CSS gap so the visible
  // separation does not insert a whitespace character into the DOM —
  // copy/paste (via select-all or the explicit copy button) yields the
  // raw 6-digit code with no spaces.
  return (
    <span
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} font-mono text-3xl font-semibold fg-primary select-all`}
      data-testid="canopy-portal-pairing-code-value"
    >
      <span>{code.slice(0, 3)}</span>
      <span className="ml-4">{code.slice(3)}</span>
    </span>
  );
}

export function CanopyPortalModal({
  onClose,
  onOpenAccountSettings,
  onRequestSignIn,
}: CanopyPortalModalProps): JSX.Element {
  const portal = useCanopyPortalStore((s) => s.state);
  const accountLocation = useSettingsLocationLabel('account');

  const [cloudAccount, setCloudAccount] =
    useState<CanopyCloudAccountPublicState | null>(null);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [busy, setBusy] = useState<
    'idle' | 'starting' | 'stopping' | 'regenerating'
  >('idle');
  const [actionError, setActionError] = useState<string | null>(null);

  // Load the configured Canopy Cloud account on mount and after Settings changes.
  useEffect(() => {
    let cancelled = false;
    const reload = (): void => {
      setCloudLoading(true);
      window.api
        .loadCanopyCloudAccount()
        .then((next) => {
          if (cancelled) return;
          setCloudAccount(next);
        })
        .catch(() => {
          if (cancelled) return;
          setCloudAccount(null);
        })
        .finally(() => {
          if (!cancelled) setCloudLoading(false);
        });
    };

    reload();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    return (): void => {
      cancelled = true;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    };
  }, []);

  const cloudReady = isCanopyCloudConnected(cloudAccount);

  // Remote Control is a paid perk (Pro + Business). The authoritative "can I use
  // Remote Control" signal is the account `portal-v1` capability, minted
  // server-side and fail-open under billing-off — NOT the `remote_control`
  // entitlement bit (the billing-off entitlements mirror never emits it, so a
  // raw entitlement check would wrongly block everyone). When billing is on and
  // a signed-in user's plan does not include Remote Control, surface an upgrade
  // CTA instead of Enable. `subscription.visible` is only ever true under
  // billing-on for a real signed-in account, so billing-off ⇒ no CTA (fail open).
  const subscription = useSubscriptionStatus();
  const hasPortalCapability =
    cloudAccount?.capabilities.includes('portal-v1') ?? false;
  // A device-scoped guest resolves as a real cloud account (has an API key), so
  // `cloudReady` is true and the modal would otherwise offer a dead-end Enable
  // button the server rejects — the guest has no way to sign in and finish
  // pairing. Detect the guest credential and surface a create-account CTA that
  // routes through the shared free-trial gate instead (the same CloudSyncModal
  // the bottom-left "Start free trial" CTA opens). `subscription.visible` is
  // never true for a guest (not signed in), so this is mutually exclusive with
  // the upgrade CTA below.
  const isGuest = isGuestAccount(cloudAccount);
  // Which of the user's orgs have no active plan (CAN-2311). Read straight off
  // the already-loaded account snapshot — no extra IPC — and passed to the CTA
  // as CONTEXT only, never as a cause. The snapshot carries current capabilities
  // and per-org `teamsEntitled`; it does not say which org (if any) was the
  // source of this user's Remote Control coverage, or whether they ever had it.
  // A personal-free-plan user, or a member of a healthy org on a plan without
  // `remote_control`, can belong to a lapsed org and have lost nothing — so the
  // CTA names the lapsed org without asserting that the lapse paused Remote
  // Control. Per-org by construction: a healthy org that still grants the
  // capability keeps it, and that user never reaches this CTA at all.
  const lapsedOrgNames = useMemo(() => {
    const states = cloudAccount?.orgBillingStates ?? [];
    return lapsedOrgNamesFrom(
      states,
      states.map((state) => state.organizationId),
    );
  }, [cloudAccount]);
  // Whether the reader can actually fix the lapse the copy above names, which
  // is what decides the paywall's action (CAN-2590): someone who can buy for the
  // named org is sent to that org's billing page, everyone else is told to ask
  // and keeps their own upgrade route. Matched here rather than inside the CTA
  // because `lapsedOrgNames` carries names only — widening that prop to carry
  // ids just to re-derive this downstream would be the worse trade.
  const billingPresentation = subscription.status?.billingPresentation ?? null;
  // Every org the reader manages is checked for the lapse, and the selected
  // navigation context settles it when more than one has lapsed, so the org
  // the button opens is never a guess (CAN-3465). Both are stable store
  // references.
  const workspaceContext = useWorkspaceContextStore(
    (store) => store.state.context,
  );
  const contextOrganizations = useWorkspaceContextStore(
    (store) => store.state.organizations,
  );
  const administeredLapsedOrg = useMemo(
    () =>
      resolveManageableLapsedOrg(
        cloudAccount?.orgBillingStates,
        resolveBillingManageableOrgs(
          contextOrganizations,
          subscription.billingManageableOrg,
        ),
        workspaceContext.kind === 'organization'
          ? workspaceContext.organizationId
          : null,
      ),
    [
      cloudAccount,
      contextOrganizations,
      subscription.billingManageableOrg,
      workspaceContext,
    ],
  );
  // ...but "administers" is not "can buy for". `billingManageableOrg` is
  // `canEditOrg`, which admits ADMIN as well as OWNER, while every billing CTA
  // on the destination page is OWNER-gated — `subscribe/page.tsx` filters to
  // OWNER for exactly this reason and says so: "routing an ADMIN there is a
  // guaranteed dead end: no upgrade affordance, no explanation, nothing they can
  // do about it."
  //
  // `billingPresentation.action` is the one signal on the wire that separates
  // them, and `view` is emitted precisely for a non-owner ADMIN. So when the
  // presentation describes THIS org and says `view`, the reader is provably
  // someone who cannot buy here: drop them to the everyone-else branch, where
  // they keep the personal upgrade route they had before this feature existed
  // and the copy names the person who can act. Sending them to a read-only page
  // with a purchase label would be the same false promise as naming a tier the
  // page cannot sell, one layer further out.
  //
  // Deliberately narrow: `view` PROVES they cannot buy, so this never guesses.
  // An ADMIN whose presentation describes some other entity is not provable
  // either way and keeps the org destination, which is at worst a page that
  // shows them their org's real billing state.
  const lapsedOrgIsReadOnlyForReader =
    administeredLapsedOrg !== null &&
    billingPresentation !== null &&
    billingPresentation.owner.type === 'organization' &&
    billingPresentation.owner.id === administeredLapsedOrg.id &&
    billingPresentation.action === 'view';
  const manageableLapsedOrg = lapsedOrgIsReadOnlyForReader
    ? null
    : administeredLapsedOrg;
  // The plan an owner/admin is being sent to buy — named ONLY when
  // `billingPresentation` actually describes the lapsed org this copy names.
  //
  // `billingPresentation` is a wallet-wide winner: the server ranks the caller's
  // own subscription/trial against every org they administer and returns the
  // priciest, paired with its exact `owner`. It carries no promise of being the
  // org the paywall is talking about, and the protocol doc is explicit that it
  // is "Display and navigation only; never use this field for capability or
  // authorization" (`packages/protocol/src/billing/index.ts`). Pairing its
  // `plan` with a DIFFERENT entity's id splits those two halves apart and
  // produces a claim that is simply false: a personal-trial user who administers
  // a lapsed org gets `owner: { type: 'user' }` with the personal entry tier, and
  // the panel would then read "This feature requires Pro" over a `Get Pro` button
  // deep-linking to that ORG's billing page — which only sells the entry ORG tier
  // and silently ignores a personal `?plan=` key it cannot fulfil. The reader is
  // promised a plan the destination cannot sell, which is a worse mis-statement
  // than the jargon CAN-2590 set out to remove.
  //
  // So the plan is named only when the presentation's owner IS this org AND its
  // `action` says this reader can actually buy it. Both halves are required, and
  // each rules out a different false statement:
  //
  //   - `owner` mismatch → the plan belongs to some other entity (see above).
  //   - `action !== 'subscribe'` → the plan is not on offer to THIS reader.
  //     The server sets `manage` for an owner whose org already holds a live
  //     paid subscription, and `view` for a non-owner ADMIN, who reaches this
  //     branch (`billingManageableOrg` is OWNER+ADMIN via `canEditOrg`) but
  //     lands on a read-only billing page. Naming a plan for `manage` would tell
  //     an owner to buy the tier they are already paying for; naming one for
  //     `view` would put a purchase label on a page that sells them nothing.
  //
  // This mirrors `useSubscriptionStatus`'s own `billingAction`, which already
  // requires `action === 'subscribe'` before it will name a plan or attach a
  // `?plan=` intent — the two derivations now agree instead of one quietly
  // dropping the guard.
  //
  // Anything short of both conditions falls back to the plan-agnostic copy and
  // the generic button, which is the fallback this ticket's own plan prescribed
  // for a winner that names a tier the reader cannot buy here.
  // `billingPresentation` is also optional on the wire, so null is a real state
  // the CTA renders around, never `Get undefined`.
  //
  // REACHABILITY, stated plainly so the next maintainer does not mistake the
  // E2E mock override for evidence: against today's server the named-plan
  // branch is effectively unreachable, and the plan-agnostic fallback IS the
  // production path. An org must be `billingActive` to become a presentation
  // candidate at all (`entitlements.ts`), `action: 'subscribe'` narrows that to
  // an OWNER on a trialing org, and the org trial plan is the entry org tier,
  // which grants `teams` — so such an org is not lapsed. The capture spec
  // reaches the branch only by overriding `billingPresentation` in the mock.
  //
  // The guard is kept rather than deleted because it is the correct rule, not
  // an optimization: it states the two facts that must hold before this panel
  // may name a tier, and it lights up honestly if the server ever starts
  // offering a lapsed org a plan (e.g. a paid org on a tier that does not grant
  // `teams` — the legacy tiers carry no capabilities at all). Deleting it would
  // leave the next person to re-derive the rule from scratch, which is how the
  // crossed pairing got here in the first place.
  const upgradePlan =
    billingPresentation !== null &&
    billingPresentation.owner.type === 'organization' &&
    manageableLapsedOrg !== null &&
    billingPresentation.owner.id === manageableLapsedOrg.id &&
    billingPresentation.action === 'subscribe'
      ? billingPresentation.plan
      : null;
  // On the owner/admin branch the button deep-links into the lapsed org's own
  // billing page, since that org's plan is exactly what they are being asked to
  // renew. It carries a `?plan=` intent only when `upgradePlan` survived the
  // owner check above, because the org billing page honours the intent only for
  // a plan it can actually sell this org; an unmatched key is inert and would
  // make the button's promise and its destination disagree. Everyone else keeps
  // the hook's resolved billing action, which is that reader's own upgrade path.
  const { openBillingPath, openBillingAction, openUpgradePage } = subscription;
  const openUpgrade = useCallback((): void => {
    // The provably-read-only ADMIN gets an EXPLICIT personal destination, not
    // `openBillingAction()`. That looks like the obvious fallback and is a trap:
    // for this exact presentation shape (`owner.type === 'organization'` with
    // `action: 'view'`) the hook resolves `billingAction.path` back to
    // `organizationBillingPath(owner.id)` — byte-identical to the org page the
    // diversion exists to keep them off. Deferring to it would leave the copy
    // promising "or upgrade your own plan" over a button that lands on a page
    // selling them nothing, which is the CAN-2590 defect one layer out.
    //
    // `/pricing` (via `openUpgradePage`) is the catalog every reader can act on
    // regardless of role, so the promise and the destination agree.
    if (lapsedOrgIsReadOnlyForReader) {
      openUpgradePage();
      return;
    }
    if (manageableLapsedOrg) {
      openBillingPath(
        organizationBillingPath(manageableLapsedOrg.id, {
          ...(upgradePlan ? { plan: upgradePlan.key } : {}),
        }),
      );
      return;
    }
    openBillingAction();
  }, [
    lapsedOrgIsReadOnlyForReader,
    manageableLapsedOrg,
    upgradePlan,
    openBillingPath,
    openBillingAction,
    openUpgradePage,
  ]);
  const showGuestCta = cloudReady && portal.status === 'disabled' && isGuest;
  // Free app access grants `remote_control` to every signed-in account, so
  // there is no plan to sell. `subscription.visible` is already false then;
  // the explicit check keeps the paywall closed even if a stale account
  // snapshot still lacks `portal-v1` or names a lapsed org.
  const showUpgradeCta =
    cloudReady &&
    portal.status === 'disabled' &&
    !hasPortalCapability &&
    !isGuest &&
    !subscription.freeAccess &&
    subscription.visible;

  // Resolve the Canopy Cloud base URL this build talks to (a localhost origin
  // in dev, staging for internal builds, production for releases), so the link
  // always targets the environment the session is paired with. Stays null when
  // the base URL is not configured — the View Web Portal button is hidden
  // rather than pointing at a dead origin.
  const [cloudBaseUrl, setCloudBaseUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.api
      .getCanopyCloudBaseUrl()
      .then((base) => {
        if (cancelled || !base) return;
        setCloudBaseUrl(base.replace(/\/+$/, ''));
      })
      .catch(() => {
        // Leave null; the View Web Portal button stays hidden.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // CAN-2938: the QR code opens the web pairing page with the code in the URL
  // fragment. Derived from the current code, so it changes whenever the code
  // is regenerated or re-armed and disappears when the code is cleared.
  const pairingUrl =
    cloudBaseUrl !== null && portal.pairingCode !== null
      ? buildRemoteControlPairingUrl(cloudBaseUrl, portal.pairingCode)
      : null;
  const pairingQrSrc = useQrCodeDataUrl(pairingUrl);
  const pairingQrVisible =
    pairingQrSrc !== null &&
    (portal.status === 'pending_auth' || portal.status === 'active');

  // While pairing, deep-link to the code-entry dialog: `/portal` permanently
  // redirects to `/chat`, where the pairing form only opens on an explicit
  // Connect-a-device click — `?pair=1` opens it on arrival (CAN-2357).
  const portalPath =
    portal.status === 'pending_auth' ? '/chat?pair=1' : '/portal';

  const openPortal = useCallback(() => {
    // Hand the user off to the remote-control surface already signed in. The
    // main process exchanges the desktop cloud credential for a one-time
    // code; if that is unavailable (flag off, no token, offline, mint failure,
    // or an older build without the handler) we fall back to the plain,
    // unauthenticated portal URL so the button still works.
    const openUnauthenticated = (): void => {
      if (!cloudBaseUrl) return;
      void window.api.browser.openExternal({
        url: `${cloudBaseUrl}${portalPath}`,
      });
    };
    try {
      void window.api
        .openAuthenticatedPortalPage(portalPath)
        .catch(openUnauthenticated);
    } catch {
      openUnauthenticated();
    }
  }, [cloudBaseUrl, portalPath]);

  const enable = useCallback(async () => {
    if (!cloudReady) return;
    setActionError(null);
    setBusy('starting');
    try {
      await window.api.canopyPortal.start();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `Failed to enable ${REMOTE_CONTROL_LABEL.toLowerCase()}.`;
      setActionError(message);
    } finally {
      setBusy('idle');
    }
  }, [cloudReady]);

  const disable = useCallback(async () => {
    setActionError(null);
    setBusy('stopping');
    try {
      await window.api.canopyPortal.stop();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `Failed to disable ${REMOTE_CONTROL_LABEL.toLowerCase()}.`;
      setActionError(message);
    } finally {
      setBusy('idle');
    }
  }, []);

  const regenerate = useCallback(async () => {
    if (!cloudReady) return;
    setActionError(null);
    setBusy('regenerating');
    try {
      // Regeneration is modelled as stop+start; the main process will end
      // the prior pending session with reason `replaced` and create a new
      // one. We treat any failure during stop as fatal so the user sees a
      // clear error rather than a half-rotated state.
      await window.api.canopyPortal.stop();
      await window.api.canopyPortal.start();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to regenerate code.';
      setActionError(message);
    } finally {
      setBusy('idle');
    }
  }, [cloudReady]);

  const pairAnotherDevice = useCallback(async () => {
    if (!cloudReady) return;
    setActionError(null);
    setBusy('regenerating');
    try {
      // CAN-2981: re-arm a code on the live session. Connected devices are
      // untouched; the main process keeps the session and its activation.
      await window.api.canopyPortal.regeneratePairingCode();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate a code.';
      setActionError(message);
    } finally {
      setBusy('idle');
    }
  }, [cloudReady]);

  const cancelPairingCode = useCallback(async () => {
    setActionError(null);
    setBusy('regenerating');
    try {
      // CAN-2981: drop the armed code; nothing already connected changes.
      await window.api.canopyPortal.cancelPairingCode();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to cancel the code.';
      setActionError(message);
    } finally {
      setBusy('idle');
    }
  }, []);

  const isBusy = busy !== 'idle';
  // Expose the inline sign-in affordance (shown in the no-account state) so the
  // App Advisor knows the user can sign in from here (CAN-936, WS3).
  const signInAffordanceVisible = !cloudLoading && !cloudReady;
  // Shown while pairing too (CAN-2357): the portal is where the user must
  // enter the code, so the CTA has to be reachable before the session
  // connects, not only after.
  const viewPortalVisible =
    (portal.status === 'pending_auth' ||
      portal.status === 'active' ||
      portal.status === 'reconnecting') &&
    cloudBaseUrl !== null;
  useCurrentUiStateReporter('canopyPortal.modal', {
    open: true,
    busy,
    errorVisible: Boolean(actionError),
    signInAffordanceVisible,
    viewPortalVisible,
    upgradeCtaVisible: showUpgradeCta,
    guestCtaVisible: showGuestCta,
    pairingQrVisible,
  });

  const statusInfo = useMemo(() => {
    return derivePresentation(portal, { pairingQrVisible });
  }, [portal, pairingQrVisible]);

  return (
    <DialogModal
      onClose={isBusy ? (): void => {} : onClose}
      title={TITLE}
      subtitle={getBrandMobileApps() ? SUBTITLE_WITH_MOBILE : SUBTITLE}
      maxWidth="md"
      closeOnBackdrop={!isBusy}
      dataTestId="canopy-portal-modal"
    >
      <div className="px-5 py-4 space-y-4">
        {cloudLoading && (
          <p className="text-s fg-secondary">{ACCOUNT_LOADING_LABEL}</p>
        )}

        {!cloudLoading && !cloudReady && (
          <div className="space-y-3" data-testid="canopy-portal-no-account">
            <p className="text-s fg-secondary">
              {noAccountMessage(accountLocation)}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onRequestSignIn}
                data-testid="canopy-portal-sign-in"
                className="rounded-lg bg-accent px-3 py-1.5 text-s font-semibold fg-emphasis hover:bg-accent/90 transition-colors focus-ring"
              >
                {SIGN_IN_BUTTON}
              </button>
              <button
                type="button"
                onClick={onOpenAccountSettings}
                data-testid="canopy-portal-open-settings"
                className="text-s font-medium fg-secondary underline-offset-2 hover:fg-primary hover:underline transition-colors focus-ring"
              >
                {OPEN_SETTINGS_BUTTON}
              </button>
            </div>
          </div>
        )}

        {!cloudLoading && cloudReady && portal.status === 'disabled' && (
          <div className="space-y-3" data-testid="canopy-portal-disabled">
            {showGuestCta ? (
              <RemoteControlGuestCta
                freeAccess={subscription.freeAccess}
                // Keep the gate on the subject of the button that opened it.
                // `startFreeTrial`'s default title names a specific offer, and
                // a guest who clicked to unlock pairing would otherwise get a
                // dialog headed by an unrelated product — a non sequitur, not
                // an upsell. Same reason `GuestUpgradeNudge` passes its own.
                onCreateAccount={(): void =>
                  subscription.startFreeTrial({
                    title: GUEST_GATE_TITLE,
                    description: GUEST_GATE_DESCRIPTION,
                    toastMessage: GUEST_GATE_TOAST,
                  })
                }
              />
            ) : showUpgradeCta ? (
              <RemoteControlUpgradeCta
                onUpgrade={openUpgrade}
                lapsedOrgNames={lapsedOrgNames}
                manageableLapsedOrg={manageableLapsedOrg}
                planDisplayName={upgradePlan?.displayName ?? null}
              />
            ) : portal.error ? (
              // CAN-2938: the pending code (and its QR code) lapsed unscanned.
              // Enable below mints a fresh one.
              <div data-testid="canopy-portal-pairing-expired">
                <StatusRow
                  label={portal.error}
                  tone="warning"
                  helper={EXPIRED_RETRY_HELPER}
                />
              </div>
            ) : (
              <p className="text-s fg-secondary">{DISABLED_HELPER}</p>
            )}
          </div>
        )}

        {(portal.status === 'pending_auth' ||
          portal.status === 'active' ||
          portal.status === 'reconnecting' ||
          portal.status === 'starting' ||
          portal.status === 'stopping') && (
          <div
            className="space-y-4"
            data-testid={`canopy-portal-${portal.status.replace(/_/g, '-')}`}
          >
            <StatusRow
              label={statusInfo.label}
              tone={statusInfo.tone}
              helper={statusInfo.helper}
              action={
                viewPortalVisible ? (
                  <button
                    type="button"
                    onClick={openPortal}
                    className="rounded-lg bg-accent px-3 py-1.5 text-s font-semibold fg-emphasis hover:bg-accent/90 transition-colors focus-ring"
                    data-testid="canopy-portal-view-web-portal"
                  >
                    {VIEW_PORTAL_BUTTON}
                  </button>
                ) : undefined
              }
            />
            {(portal.status === 'pending_auth' ||
              (portal.status === 'active' && portal.pairingCode !== null)) && (
              <div
                className="rounded-2xl border bg-base p-5 text-center"
                data-testid="canopy-portal-pairing-code"
              >
                {pairingQrVisible && pairingQrSrc !== null && (
                  <div className="mb-4 space-y-4">
                    <RemoteControlPairingQr
                      qrSrc={pairingQrSrc}
                      machineName={portal.machineName}
                    />
                    <p
                      className="text-xs fg-secondary"
                      data-testid="canopy-portal-pairing-manual-fallback"
                    >
                      {MANUAL_FALLBACK_LABEL}
                    </p>
                  </div>
                )}
                <div className="flex items-center justify-center gap-3">
                  <PairingCodeDisplay code={portal.pairingCode} />
                  {portal.pairingCode && (
                    <CopyButton
                      value={portal.pairingCode}
                      ariaLabel="Copy pairing code"
                      title="Copy pairing code"
                      size="lg"
                      dataTestId="canopy-portal-copy-code"
                    />
                  )}
                </div>
                <p className="mt-2 text-xs fg-secondary">
                  {portal.pairingCodeExpiresAt
                    ? `Expires at ${new Date(portal.pairingCodeExpiresAt).toLocaleTimeString()}.`
                    : 'Code expires automatically after 10 minutes.'}
                </p>
                {portal.status === 'active' && (
                  <p
                    className="mt-1 text-xs fg-secondary"
                    data-testid="canopy-portal-pair-another-device-helper"
                  >
                    {pairingQrVisible
                      ? PAIR_ANOTHER_DEVICE_QR_HELPER
                      : PAIR_ANOTHER_DEVICE_HELPER}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {portal.status === 'inactive' && (
          <div className="space-y-3" data-testid="canopy-portal-inactive">
            <StatusRow
              label={DISCONNECTED_STATUS_LABEL}
              tone="error"
              helper={portal.error ?? DISCONNECTED_HELPER}
            />
            {portal.error && (
              <p className="text-xs fg-secondary">{DISCONNECTED_HELPER}</p>
            )}
          </div>
        )}

        {portal.status === 'error' && (
          <div className="space-y-3" data-testid="canopy-portal-error">
            <StatusRow
              label={ERROR_STATUS_LABEL}
              tone="error"
              helper={portal.error ?? undefined}
            />
          </div>
        )}

        {actionError && (
          <p
            className="text-s fg-destructive"
            role="alert"
            data-testid="canopy-portal-action-error"
          >
            {actionError}
          </p>
        )}

        {/* Deliberate download surface, appended unconditionally as the last
            child of the body so it covers every modal state at once. It sits
            below the pairing code and above the footer, so it never competes
            with Enable/Reconnect/Try Again. */}
        <RemoteControlMobileAppsCta />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={isBusy}
          className="rounded-lg border bg-base px-3 py-1.5 text-s font-medium fg-secondary hover:fg-primary hover:bg-secondary transition-colors focus-ring disabled:opacity-50"
          data-testid="canopy-portal-close"
        >
          {CLOSE_BUTTON}
        </button>

        {portal.status === 'disabled' &&
          cloudReady &&
          !showUpgradeCta &&
          !showGuestCta && (
            <button
              type="button"
              onClick={() => void enable()}
              disabled={isBusy}
              className="rounded-lg bg-accent px-3 py-1.5 text-s font-semibold fg-emphasis hover:bg-accent/90 transition-colors focus-ring disabled:opacity-50"
              data-testid="canopy-portal-enable"
            >
              {busy === 'starting' ? 'Enabling…' : ENABLE_BUTTON}
            </button>
          )}

        {portal.status === 'pending_auth' && (
          <>
            <button
              type="button"
              onClick={() => void regenerate()}
              disabled={isBusy}
              className="rounded-lg border bg-base px-3 py-1.5 text-s font-medium fg-primary hover:bg-secondary transition-colors focus-ring disabled:opacity-50"
              data-testid="canopy-portal-regenerate"
            >
              {busy === 'regenerating' ? 'Regenerating…' : REGENERATE_BUTTON}
            </button>
            <button
              type="button"
              onClick={() => void disable()}
              disabled={isBusy}
              className="whitespace-nowrap rounded-lg border bg-base px-3 py-1.5 text-s font-medium fg-primary hover:bg-secondary transition-colors focus-ring disabled:opacity-50"
              data-testid="canopy-portal-disable"
            >
              {busy === 'stopping' ? 'Disabling…' : DISABLE_BUTTON}
            </button>
          </>
        )}

        {(portal.status === 'active' || portal.status === 'reconnecting') && (
          <>
            {portal.status === 'active' && portal.pairingCode !== null && (
              <button
                type="button"
                onClick={() => void cancelPairingCode()}
                disabled={isBusy}
                className="whitespace-nowrap rounded-lg border bg-base px-3 py-1.5 text-s font-medium fg-primary hover:bg-secondary transition-colors focus-ring disabled:opacity-50"
                data-testid="canopy-portal-cancel-pairing-code"
              >
                {busy === 'regenerating'
                  ? 'Cancelling…'
                  : CANCEL_PAIRING_CODE_BUTTON}
              </button>
            )}
            {portal.status === 'active' && portal.pairingCode === null && (
              <button
                type="button"
                onClick={() => void pairAnotherDevice()}
                disabled={isBusy}
                className="whitespace-nowrap rounded-lg border bg-base px-3 py-1.5 text-s font-medium fg-primary hover:bg-secondary transition-colors focus-ring disabled:opacity-50"
                data-testid="canopy-portal-pair-another-device"
              >
                {busy === 'regenerating'
                  ? 'Generating code…'
                  : PAIR_ANOTHER_DEVICE_BUTTON}
              </button>
            )}
            <button
              type="button"
              onClick={() => void disable()}
              disabled={isBusy}
              className="whitespace-nowrap rounded-lg border bg-base px-3 py-1.5 text-s font-medium fg-primary hover:bg-secondary transition-colors focus-ring disabled:opacity-50"
              data-testid="canopy-portal-disable"
            >
              {busy === 'stopping' ? 'Disabling…' : DISABLE_BUTTON}
            </button>
          </>
        )}

        {portal.status === 'inactive' && (
          <button
            type="button"
            onClick={() => void enable()}
            disabled={isBusy || !cloudReady}
            className="rounded-lg bg-accent px-3 py-1.5 text-s font-semibold fg-emphasis hover:bg-accent/90 transition-colors focus-ring disabled:opacity-50"
            data-testid="canopy-portal-reconnect"
          >
            {busy === 'starting' ? 'Reconnecting…' : RECONNECT_BUTTON}
          </button>
        )}

        {portal.status === 'error' && (
          <button
            type="button"
            onClick={() => void enable()}
            disabled={isBusy || !cloudReady}
            className="rounded-lg bg-accent px-3 py-1.5 text-s font-semibold fg-emphasis hover:bg-accent/90 transition-colors focus-ring disabled:opacity-50"
            data-testid="canopy-portal-try-again"
          >
            {busy === 'starting' ? 'Retrying…' : TRY_AGAIN_BUTTON}
          </button>
        )}
      </div>
    </DialogModal>
  );
}

interface PortalPresentation {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
  helper?: string;
}

function derivePresentation(
  state: CanopyPortalState,
  { pairingQrVisible }: { pairingQrVisible: boolean },
): PortalPresentation {
  switch (state.status) {
    case 'starting':
      return { label: STARTING_STATUS_LABEL, tone: 'neutral' };
    case 'pending_auth':
      return {
        label: PENDING_STATUS_LABEL,
        tone: 'warning',
        // One home per fact: with a QR code on screen, its instruction and
        // the manual-fallback line already say what to do.
        helper: pairingQrVisible ? undefined : PENDING_HELPER,
      };
    case 'active':
      return {
        label: CONNECTED_STATUS_LABEL,
        tone: 'success',
        // Sentence-start copy, so the lowercase "this computer" stand-in
        // from `pairingMachineLabel` is not used here: a blank or
        // whitespace-only name takes the neutral branch.
        helper: state.machineName?.trim()
          ? `${state.machineName.trim()} is connected.`
          : 'This computer is connected.',
      };
    case 'reconnecting':
      return {
        label: RECONNECTING_STATUS_LABEL,
        tone: 'warning',
        helper: RECONNECTING_HELPER,
      };
    case 'stopping':
      return { label: STOPPING_STATUS_LABEL, tone: 'neutral' };
    case 'inactive':
      return {
        label: DISCONNECTED_STATUS_LABEL,
        tone: 'error',
        helper: state.error ?? DISCONNECTED_HELPER,
      };
    case 'error':
      return {
        label: ERROR_STATUS_LABEL,
        tone: 'error',
        helper: state.error ?? undefined,
      };
    case 'disabled':
    default:
      return { label: '', tone: 'neutral' };
  }
}

function StatusRow({
  label,
  tone,
  helper,
  action,
}: {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
  helper?: string;
  action?: JSX.Element;
}): JSX.Element {
  const dotClass =
    tone === 'success'
      ? 'bg-success'
      : tone === 'warning'
        ? 'bg-warning'
        : tone === 'error'
          ? 'bg-destructive'
          : 'bg-fg-secondary';
  return (
    <div className="space-y-1" data-testid="canopy-portal-status-row">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${dotClass}`}
        />
        <span className="text-s font-medium fg-primary">{label}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {helper && <p className="text-xs fg-secondary">{helper}</p>}
    </div>
  );
}

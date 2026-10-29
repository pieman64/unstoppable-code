import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ShareResourceDialog,
  type CapabilityPackageRepairBinding,
  type CapabilityPackageSharePort,
  type ShareResourceAccount,
  type ShareResourceCopy,
  type ShareResourceDialogProps,
  type ShareTargetSummary,
  toShareTarget,
} from '@canopy/ui-app/sharing';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { isGuestAccount } from '@/hooks/useIsGuestCredential';
import { useSubscriptionStatus } from '@/hooks/useSubscriptionStatus';
import { brandText } from '@/lib/brand';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import {
  announceCanopyCloudAccountChanged,
  refreshAndAnnounceCanopyCloudAccount,
  refreshCanopyCloudAccountData,
} from '@/lib/canopyCloudAccountChange';
import { openSettingsPathOrWebReported } from '@/lib/navigation/settings-destinations';
import { openOrganizationBillingPage } from '@/lib/organizationPlan';
import { desktopOrganizationAccess } from '@/lib/sharing/organization-access';
import { copyTextToClipboard } from '@/lib/clipboard';
import { GUEST_WORK_PRESERVED } from '@/lib/guest-cta-copy';
import { loadSharedOrganizations, loadSharedTeams } from '@/lib/share-targets';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import { postShareToast } from '@/lib/share-toast';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { desktopPersonalOrganizationUpgradePort } from '@/lib/personal-organization-upgrade-port';

/**
 * The desktop binding of {@link ShareResourceDialog}. Every desktop share
 * modal renders this rather than the dialog directly, so the window-level
 * pieces are bound once: the cloud account (with the guest kind) and its
 * change event, organization/team membership, the team/organization loaders,
 * clipboard, the connect gate, organization setup (inside Settings, or on
 * the web through the authenticated portal bridge), the shared-resource
 * error copy, and package progress from main.
 *
 * Resource modals supply only the noun, offered audiences, capability,
 * package port, `share()`, `existingShare` and their own notes/options.
 */

const CLOUD_ACCOUNT_NAME = `${brandText.appName} Cloud`;

/**
 * Title of the sign-in gate a guest opens from the share dialog. With free
 * access there is no trial to start, so the title names the step instead.
 */
function desktopShareGuestGateTitle(freeAccess: boolean): string {
  return freeAccess ? 'Sign in to share' : 'Start your free trial';
}

/** Desktop account copy: names the brand's cloud account. */
export function desktopShareCopy(noun: string): Partial<ShareResourceCopy> {
  return {
    accountLoading: `Checking ${CLOUD_ACCOUNT_NAME} account…`,
    emptyState: `No ${CLOUD_ACCOUNT_NAME} account configured.`,
    emptyAction: 'Open account settings',
    guestState: `Create a free account to share ${noun}s. ${GUEST_WORK_PRESERVED}`,
    missingCapability: `This ${CLOUD_ACCOUNT_NAME} account does not support shared ${noun}s.`,
    upgradeHint: `This ${CLOUD_ACCOUNT_NAME} account must be upgraded before team or organization sharing is available.`,
  };
}

type DesktopShareAccount = ShareResourceAccount & {
  readonly contextOrganizations: readonly ShareTargetSummary[];
};

function toDesktopShareAccount(
  account: CanopyCloudAccountPublicState,
): DesktopShareAccount {
  const organizationAccess = desktopOrganizationAccess(account);
  return {
    connected: isCanopyCloudConnected(account),
    capabilities: account.capabilities,
    ...(account.personalOrganizationId
      ? { personalOrganizationId: account.personalOrganizationId }
      : {}),
    ...(account.account ? { id: account.account.id } : {}),
    ...(isGuestAccount(account) ? { kind: 'guest' as const } : {}),
    // Membership comes from the stored account, which the startup reprobe
    // refreshes. A stale entry can briefly read as no organization; the org
    // setup button's focus refresh re-probes it. A state that omits the field
    // entirely leaves Team and Organization available.
    ...(account.organizations !== undefined
      ? { hasOrganization: account.organizations.length > 0 }
      : {}),
    ...(account.teams !== undefined
      ? { hasTeam: account.teams.length > 0 }
      : {}),
    ...(organizationAccess !== undefined ? { organizationAccess } : {}),
    contextOrganizations: (account.organizations ?? []).map((organization) => ({
      id: organization.id,
      name: organization.name,
    })),
  };
}

async function loadDesktopShareAccount(): Promise<DesktopShareAccount | null> {
  const account = await window.api.loadCanopyCloudAccount();
  return account ? toDesktopShareAccount(account) : null;
}

/**
 * Re-probes the account so access facts are current. Rejects when the probe
 * failed, which the dialog reports as information, never as a denial.
 */
async function refreshDesktopShareAccount(): Promise<DesktopShareAccount | null> {
  const outcome = await refreshCanopyCloudAccountData();
  if (outcome.status !== 'refreshed') {
    throw new Error('The account could not be refreshed.');
  }
  announceCanopyCloudAccountChanged(outcome.reason);
  return toDesktopShareAccount(outcome.account);
}

/** The Organizations list, which creates an organization or accepts an invitation. */
const ORGANIZATION_SETUP_PORTAL_PATH = '/organization';

function subscribeDesktopAccountChanged(listener: () => void): () => void {
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, listener);
  return (): void => {
    window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, listener);
  };
}

// The dialog's ports take the query as a string; the shared desktop loaders
// take `undefined` for an empty one. Module-level so the references stay
// stable and the dialog's search hook does not reload on every render.
async function listDesktopShareTeams(
  query: string,
): Promise<readonly ShareTargetSummary[]> {
  const teams = await loadSharedTeams(query || undefined);
  return teams.map(toShareTarget);
}

async function listDesktopShareOrganizations(
  query: string,
): Promise<readonly ShareTargetSummary[]> {
  const organizations = await loadSharedOrganizations(query || undefined);
  return organizations.map(toShareTarget);
}

/** Package progress from main, emitted for every packaged subject. */
export function subscribeDesktopPackageProgress(
  listener: Parameters<
    NonNullable<CapabilityPackageSharePort['subscribeProgress']>
  >[0],
): () => void {
  const subscribe = window.pipelines.onPackageProgress?.bind(window.pipelines);
  return subscribe ? subscribe(listener) : (): void => {};
}

export interface DesktopShareCapabilityPackage {
  readonly mode?: 'package' | 'reference';
  readonly port: CapabilityPackageSharePort | null;
  readonly bindingLabelFor?: (binding: {
    jobId: string;
    stepId: string;
  }) => string | null;
  /** Offers Fix it with AI beside blocking problems; absent when unsupported. */
  readonly repair?: CapabilityPackageRepairBinding;
  /** `host` moves an unblocked review into the host's `extraOptions`. */
  readonly placement?: 'inline' | 'host';
}

export type DesktopShareResourceDialogProps = Omit<
  ShareResourceDialogProps,
  | 'loadAccount'
  | 'refreshAccount'
  | 'onChooseOrganizationPlan'
  | 'subscribeAccountChanged'
  | 'listTeams'
  | 'listOrganizations'
  | 'context'
  | 'contextOrganizations'
  | 'copyText'
  | 'notify'
  | 'onConnect'
  | 'onSetUpOrganization'
  | 'capabilityPackage'
> & {
  readonly capabilityPackage?: DesktopShareCapabilityPackage;
};

export function DesktopShareResourceDialog({
  resourceNoun,
  copy,
  capabilityPackage,
  resolveErrorMessage = resolveSharedResourceErrorMessage,
  ...props
}: DesktopShareResourceDialogProps): JSX.Element {
  const context = useSidebarScopingContext();
  // Server-reported free access. A guest's own entitlements carry it too, so
  // the guest prompt can say "Sign in" rather than offer a trial.
  const { freeAccess } = useSubscriptionStatus();
  const [contextOrganizations, setContextOrganizations] = useState<
    readonly ShareTargetSummary[]
  >([]);
  const [upgradeAccount, setUpgradeAccount] =
    useState<ShareResourceAccount | null>(null);
  const loadAccount =
    useCallback(async (): Promise<ShareResourceAccount | null> => {
      const account = await loadDesktopShareAccount();
      setContextOrganizations(account?.contextOrganizations ?? []);
      setUpgradeAccount(account);
      return account;
    }, []);
  const refreshAccount =
    useCallback(async (): Promise<ShareResourceAccount | null> => {
      const account = await refreshDesktopShareAccount();
      setContextOrganizations(account?.contextOrganizations ?? []);
      setUpgradeAccount(account);
      return account;
    }, []);
  const requestConnect = useCloudConnectGateStore((s) => s.requestConnect);
  const handleConnect = useCallback((): void => {
    requestConnect(
      {
        title: desktopShareGuestGateTitle(freeAccess),
        subtitle: `Sign in to ${CLOUD_ACCOUNT_NAME} to share ${resourceNoun}s and unlock more.`,
        toastMessage: `You're all set. You can now share this ${resourceNoun}.`,
        guestBenefits: true,
      },
      // Connecting fires CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, which reloads
      // the account (and its capabilities) in the dialog.
      () => {},
    );
  }, [freeAccess, requestConnect, resourceNoun]);

  // Organization setup opened on the web finishes there. Once the page has
  // been opened, every return to the window re-probes the account, so a new
  // organization or team shows up even if the author came back before
  // finishing setup. The listener lives until the dialog closes.
  // Choosing a plan on the web re-probes the same way. Either one opened
  // inside Settings closes the dialog instead, since Settings covers it.
  const stopSetupRefresh = useRef<(() => void) | null>(null);
  useEffect(() => (): void => stopSetupRefresh.current?.(), []);
  const refreshOnEveryReturn = useCallback((): void => {
    if (stopSetupRefresh.current !== null) return;
    const refreshOnReturn = (): void => {
      void refreshAndAnnounceCanopyCloudAccount();
    };
    window.addEventListener('focus', refreshOnReturn);
    stopSetupRefresh.current = (): void => {
      window.removeEventListener('focus', refreshOnReturn);
      stopSetupRefresh.current = null;
    };
  }, []);
  const { onClose } = props;
  const handleSetUpOrganization = useCallback(async (): Promise<boolean> => {
    const opened = await openSettingsPathOrWebReported(
      ORGANIZATION_SETUP_PORTAL_PATH,
    );
    if (opened === 'settings') onClose();
    if (opened === 'web') refreshOnEveryReturn();
    return opened !== 'failed';
  }, [onClose, refreshOnEveryReturn]);
  const handleChooseOrganizationPlan = useCallback(
    (organizationId: string): void => {
      if (openOrganizationBillingPage(organizationId) === 'settings') {
        onClose();
        return;
      }
      refreshOnEveryReturn();
    },
    [onClose, refreshOnEveryReturn],
  );

  const hostPort = capabilityPackage?.port ?? null;
  const port = useMemo((): CapabilityPackageSharePort | null => {
    if (hostPort === null) return null;
    if (hostPort.subscribeProgress) return hostPort;
    return { ...hostPort, subscribeProgress: subscribeDesktopPackageProgress };
  }, [hostPort]);

  const mergedCopy = useMemo(
    (): Partial<ShareResourceCopy> => ({
      ...desktopShareCopy(resourceNoun),
      ...copy,
    }),
    [copy, resourceNoun],
  );

  return (
    <ShareResourceDialog
      {...props}
      resourceNoun={resourceNoun}
      copy={mergedCopy}
      freeAccess={freeAccess}
      context={context}
      contextOrganizations={contextOrganizations}
      {...(capabilityPackage
        ? {
            capabilityPackage: {
              port,
              ...(capabilityPackage.mode
                ? { mode: capabilityPackage.mode }
                : {}),
              ...(capabilityPackage.bindingLabelFor
                ? { bindingLabelFor: capabilityPackage.bindingLabelFor }
                : {}),
              ...(capabilityPackage.repair
                ? { repair: capabilityPackage.repair }
                : {}),
              ...(capabilityPackage.placement
                ? { placement: capabilityPackage.placement }
                : {}),
            },
          }
        : {})}
      loadAccount={loadAccount}
      refreshAccount={refreshAccount}
      onChooseOrganizationPlan={handleChooseOrganizationPlan}
      personalOrganizationUpgradePort={
        upgradeAccount?.id &&
        upgradeAccount.personalOrganizationId &&
        upgradeAccount.kind !== 'guest'
          ? desktopPersonalOrganizationUpgradePort(
              upgradeAccount.id,
              true,
              true,
            )
          : undefined
      }
      subscribeAccountChanged={subscribeDesktopAccountChanged}
      listTeams={listDesktopShareTeams}
      listOrganizations={listDesktopShareOrganizations}
      copyText={copyTextToClipboard}
      notify={postShareToast}
      resolveErrorMessage={resolveErrorMessage}
      onConnect={handleConnect}
      onSetUpOrganization={handleSetUpOrganization}
    />
  );
}

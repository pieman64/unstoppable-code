/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import type { ForeignActivityProjection } from '@canopy/protocol/foreign-activity';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import type {
  AiCreditsRoutingMode,
  CanopyApi,
  CanopyCloudAccountPublicState,
  CanopyCloudAiCreditsState,
  NativeAiCreditsAvailability,
  CanopyCloudEntitlementsState,
  TelemetrySyncStatus,
  UpdateState,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { organizationBillingPath } from '@canopy/protocol/billing';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useAccountProxyStore } from '@/stores/accountProxyStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { GUEST_SIGN_IN_CTA_LABEL } from '@/lib/guest-cta-copy';
import { invalidateAiCreditsUsageCache } from '@/hooks/useAiCreditsUsage';
import { accessibleLabel } from '@/test-utils/dom';
import {
  defaultRemoteControlState,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { brandText } from '@/lib/brand';
import type { CanopyPortalState } from '@canopy/desktop-shared/types';
import {
  SidebarAccountMenu,
  type SidebarAccountMenuProps,
} from '../SidebarAccountMenu';

let mockHostedSettingsClient: unknown = null;
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient: (): unknown => mockHostedSettingsClient,
}));

let mockForeignProjection: ForeignActivityProjection = {
  epoch: '',
  sequence: 0,
  groups: [],
};
jest.mock('@/hooks/useForeignActivityProjection', () => ({
  useForeignActivityProjection: (): ForeignActivityProjection =>
    mockForeignProjection,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;

  interface Window {
    api: CanopyApi;
  }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (typeof globalThis.structuredClone === 'undefined') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: (value: unknown): unknown => JSON.parse(JSON.stringify(value)),
  });
}

// Replace the heavy confirm modal (DialogModal + portal) with a light stand-in
// that surfaces the confirm callback, the inline error, and the confirm tone
// via stable testids/attributes.
jest.mock('../../shared/DeleteConfirmModal', () => ({
  DeleteConfirmModal: (props: {
    onConfirm: () => void;
    onCancel: () => void;
    pending?: boolean;
    error?: string | null;
    confirmTone?: string;
  }): JSX.Element => (
    <div
      data-testid="mock-sign-out-modal"
      data-confirm-tone={props.confirmTone ?? ''}
    >
      {props.error ? (
        <span data-testid="mock-sign-out-error">{props.error}</span>
      ) : null}
      <button
        type="button"
        data-testid="mock-sign-out-confirm"
        onClick={() => props.onConfirm()}
      >
        confirm
      </button>
    </div>
  ),
}));

jest.mock('../DesktopCreateTeamDialog', () => ({
  DesktopCreateTeamDialog: ({
    personalOrganizationId,
  }: {
    personalOrganizationId: string;
  }): JSX.Element => (
    <div
      data-testid="mock-create-team-dialog"
      data-personal-organization-id={personalOrganizationId}
    />
  ),
  DesktopInviteTeamDialog: ({
    organizationId,
  }: {
    organizationId: string;
  }): JSX.Element => (
    <div
      data-testid="mock-invite-team-dialog"
      data-organization-id={organizationId}
    />
  ),
}));

jest.mock('../../feedback/FeedbackModal', () => ({
  FeedbackModal: (): JSX.Element => <div data-testid="mock-feedback-modal" />,
}));

// The banner stack mounts the update prompt, whose hook needs the
// `window.api.update` bridge this suite does not install. Drive it directly;
// defaults to idle (prompt hidden).
const mockMenuRender = jest.fn();
let mockUpdateState: UpdateState = { phase: 'idle' };

jest.mock('@/hooks/useUpdateState', () => ({
  useUpdateState: (): {
    appVersion: string | null;
    dependencyVersions: null;
    state: UpdateState;
    refresh: () => Promise<void>;
  } => {
    mockMenuRender();
    return {
      appVersion: '0.26.8',
      dependencyVersions: null,
      state: mockUpdateState,
      refresh: (): Promise<void> => Promise.resolve(),
    };
  },
}));

function makeAccount(
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: false,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    account: undefined,
    storageAvailable: true,
    ...overrides,
  };
}

const signedInAccount = makeAccount({
  hasApiKey: true,
  account: {
    id: 'acct_1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    role: 'DEVELOPER',
  },
});

const UNRESOLVED_ENTITLEMENTS: CanopyCloudEntitlementsState = {
  resolved: false,
  canDisableSharing: false,
  canRemoteControl: false,
  source: 'none',
  plan: null,
  trial: null,
  billingManageableOrg: null,
  displayPlan: null,
  billingPresentation: null,
};

let startOAuthLogin: jest.Mock;
let workspaceContextSet: jest.Mock;
let disconnectAccount: jest.Mock;
let openExternal: jest.Mock;
let openAuthenticatedPortalPage: jest.Mock;

function installWindowApi(
  overrides: {
    account?: CanopyCloudAccountPublicState;
    accountPromise?: Promise<CanopyCloudAccountPublicState>;
    accountQueue?: Array<
      CanopyCloudAccountPublicState | Promise<CanopyCloudAccountPublicState>
    >;
    entitlements?: CanopyCloudEntitlementsState;
    entitlementsPromise?: Promise<CanopyCloudEntitlementsState>;
    entitlementsQueue?: Array<
      CanopyCloudEntitlementsState | Promise<CanopyCloudEntitlementsState>
    >;
    baseUrl?: string | null;
    aiCredits?: CanopyCloudAiCreditsState;
    nativeAvailability?: NativeAiCreditsAvailability;
    telemetrySyncStatus?: TelemetrySyncStatus;
    aiCreditsRoutingMode?: AiCreditsRoutingMode;
  } = {},
): void {
  // Copy before shifting so fixtures remain immutable. Once a queue drains, the
  // existing single-value override remains the source-compatible fallback.
  const accountQueue = [...(overrides.accountQueue ?? [])];
  const entitlementsQueue = [...(overrides.entitlementsQueue ?? [])];
  startOAuthLogin = jest.fn().mockResolvedValue({
    status: {
      authenticated: true,
      account: { id: 'acct_1' },
      missingCapabilities: [],
      error: null,
    },
    account: makeAccount(),
  });
  disconnectAccount = jest.fn().mockResolvedValue(makeAccount());
  workspaceContextSet = jest
    .fn()
    .mockImplementation((request: { context: unknown }) =>
      Promise.resolve({
        context: request.context,
        revision: 2,
        organizations: useWorkspaceContextStore.getState().state.organizations,
      }),
    );
  openExternal = jest.fn().mockResolvedValue(undefined);
  openAuthenticatedPortalPage = jest.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: jest.fn().mockImplementation(() => {
        return Promise.resolve(
          accountQueue.shift() ??
            overrides.accountPromise ??
            overrides.account ??
            makeAccount(),
        );
      }),
      startCanopyCloudOAuthLogin: startOAuthLogin,
      disconnectCanopyCloudAccount: disconnectAccount,
      // The subscription-status hook (plan subtitle + menu header/CTA) reads these.
      loadCanopyCloudEntitlements: jest.fn().mockImplementation(() => {
        return Promise.resolve(
          entitlementsQueue.shift() ??
            overrides.entitlementsPromise ??
            overrides.entitlements ??
            UNRESOLVED_ENTITLEMENTS,
        );
      }),
      getCanopyCloudBaseUrl: jest
        .fn()
        .mockResolvedValue(
          overrides.baseUrl === undefined ? null : overrides.baseUrl,
        ),
      openAuthenticatedPortalPage: openAuthenticatedPortalPage,
      browser: { openExternal: openExternal },
      ...(overrides.aiCredits
        ? {
            loadCanopyCloudAiCredits: jest
              .fn()
              .mockResolvedValue(overrides.aiCredits),
          }
        : {}),
      ...(overrides.aiCreditsRoutingMode
        ? {
            loadPreferences: jest.fn().mockResolvedValue({
              aiCreditsRoutingMode: overrides.aiCreditsRoutingMode,
            }),
          }
        : {}),
      ...(overrides.nativeAvailability
        ? {
            loadNativeAiCreditsAvailability: jest
              .fn()
              .mockResolvedValue(overrides.nativeAvailability),
          }
        : {}),
      foreignActivity: {
        get: jest
          .fn()
          .mockResolvedValue({ epoch: '', sequence: 0, groups: [] }),
        onChanged: jest.fn((): (() => void) => (): void => {}),
        stop: jest.fn().mockResolvedValue(undefined),
      },
      workspaceContext: {
        get: jest
          .fn()
          .mockResolvedValue(useWorkspaceContextStore.getState().state),
        set: workspaceContextSet,
        onChanged: jest.fn((): (() => void) => (): void => {}),
      },
      telemetrySync: {
        getStatus: jest
          .fn()
          .mockResolvedValue(
            overrides.telemetrySyncStatus ?? makeTelemetrySyncStatus(),
          ),
        onStatusEvent: jest.fn(
          (callback: (status: TelemetrySyncStatus) => void): (() => void) => {
            telemetrySyncStatusListener = callback;
            return (): void => {
              telemetrySyncStatusListener = null;
            };
          },
        ),
        recordActivity: jest.fn(),
      },
    },
  });
}

let telemetrySyncStatusListener:
  | ((status: TelemetrySyncStatus) => void)
  | null = null;

function makeTelemetrySyncStatus(
  overrides: Partial<TelemetrySyncStatus> = {},
): TelemetrySyncStatus {
  return {
    isSyncing: false,
    pendingCount: 0,
    sharingActive: true,
    lastSyncedAt: null,
    lastErrorAt: null,
    lastError: null,
    pausedReason: null,
    ...overrides,
  };
}

const ORG_A = '11111111-1111-4111-8111-111111111111';

// Organization projects default on when LaunchDarkly is not configured; the
// menu baseline keeps them off so only the context-switcher tests opt in.
function baselineFeatureFlagSnapshot(): ReturnType<
  typeof getDefaultFeatureFlagSnapshot
> {
  const snapshot = getDefaultFeatureFlagSnapshot();
  snapshot.values['canopy-shared-org-projects-enabled'] = false;
  // On without LaunchDarkly; the menu-shape tests pin it off, and the
  // External agents describe turns it on.
  snapshot.values[CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu.key] =
    false;
  return snapshot;
}

function setOrgProjectsFlag(enabled: boolean): void {
  const snapshot = baselineFeatureFlagSnapshot();
  snapshot.values['canopy-shared-org-projects-enabled'] = enabled;
  useFeatureFlagsStore.setState({ snapshot });
}

function seedWorkspaceContext(
  organizations: Array<{ id: string; name: string }>,
  context: WorkspaceContext = { kind: 'personal' },
): void {
  useWorkspaceContextStore.setState({
    state: {
      context,
      revision: 1,
      organizations: organizations.map((organization) => ({
        ...organization,
        role: 'MEMBER' as const,
      })),
    },
    hydrated: true,
  });
}

const DAY_MS = 86_400_000;

function setBillingFlag(enabled: boolean): void {
  const snapshot = baselineFeatureFlagSnapshot();
  snapshot.values['canopy-billing-enabled'] = enabled;
  useFeatureFlagsStore.setState({ snapshot });
}

function setExternalAgentsMenuFlag(enabled: boolean): void {
  const snapshot = baselineFeatureFlagSnapshot();
  snapshot.values[CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu.key] =
    enabled;
  useFeatureFlagsStore.setState({ snapshot });
}

function resolvedEntitlements(
  overrides: Partial<CanopyCloudEntitlementsState> = {},
): CanopyCloudEntitlementsState {
  return {
    resolved: true,
    canDisableSharing: true,
    canRemoteControl: false,
    source: 'trial',
    plan: { key: 'business', displayName: 'Business' },
    trial: {
      active: true,
      endsAt: new Date(Date.now() + DAY_MS * 12).toISOString(),
    },
    billingManageableOrg: null,
    displayPlan: null,
    billingPresentation: null,
    ...overrides,
  };
}

const BASE_PROPS: SidebarAccountMenuProps = {
  activePage: 'home',
  onNavigate: jest.fn(),
  onSettingsClick: jest.fn(),
  settingsOpen: false,
  canopyPortalEnabled: true,
  onCanopyPortalClick: jest.fn(),
};

// The portal store is module-global; App.tsx hydrates it in the app, and the
// menu only reads it. Every test starts from the off state and the untouched
// store is restored afterwards for later suites in this worker.
const INITIAL_PORTAL_STORE = useCanopyPortalStore.getState();

function offPortalState(): CanopyPortalState {
  return {
    status: 'disabled',
    connectionStatus: 'inactive',
    sessionId: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    machineName: null,
    activatedAt: null,
    lastSeenAt: null,
    lastErrorAt: null,
    error: null,
  };
}

// Field values shared with the CAN-3659 Electron spec's PORTAL_STATES.
const PORTAL_ACTIVE: Partial<CanopyPortalState> = {
  status: 'active',
  connectionStatus: 'active',
  sessionId: 'portal-session-can-3659',
  machineName: 'Test Mac',
  activatedAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-01T10:05:00.000Z',
};
const PORTAL_RECONNECTING: Partial<CanopyPortalState> = {
  ...PORTAL_ACTIVE,
  status: 'reconnecting',
  connectionStatus: 'reconnecting',
};
const PORTAL_DISCONNECTED: Partial<CanopyPortalState> = {
  ...PORTAL_ACTIVE,
  status: 'error',
  connectionStatus: 'ended',
  lastErrorAt: '2026-10-01T10:06:00.000Z',
  error: 'Connection lost',
};

function seedPortal(partial: Partial<CanopyPortalState>): void {
  useCanopyPortalStore.setState({
    hydrated: true,
    state: { ...offPortalState(), ...partial },
  });
}

beforeEach(() => {
  seedPortal({});
  const { snapshot } = useFeatureFlagsStore.getState();
  useFeatureFlagsStore.setState({
    snapshot: {
      ...snapshot,
      values: {
        ...snapshot.values,
        [CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu.key]: false,
      },
    },
  });
});

afterEach(() => {
  useCanopyPortalStore.setState(INITIAL_PORTAL_STORE, true);
});

async function renderMenu(
  props: Partial<SidebarAccountMenuProps> = {},
  apiOverrides: Parameters<typeof installWindowApi>[0] = {},
): Promise<{ container: HTMLElement; root: Root; unmount: () => void }> {
  installWindowApi(apiOverrides);
  const container = document.createElement('div');
  const statusHost = document.createElement('div');
  statusHost.id = 'app-bottom-status-host';
  statusHost.dataset.testid = 'app-bottom-status';
  document.body.appendChild(statusHost);
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <CanopyClientProvider client={createFakeClient().client}>
        <SidebarAccountMenu {...BASE_PROPS} {...props} />
      </CanopyClientProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    // Sidebar menus render in a body portal so they cannot be clipped by the
    // sidebar's overflow boundary. Query the shared document surface to cover
    // both the component mount and its portaled overlays.
    container: document.body,
    root,
    unmount: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
      statusHost.remove();
    },
  };
}

function openMenu(container: HTMLElement): void {
  act(() => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="sidebar-account-row"]')
      ?.click();
  });
}

/** The open account menu's rows and dividers in order, by test id. */
function menuShape(container: HTMLElement): string[] {
  const menu = container.querySelector('[data-testid="sidebar-account-menu"]');
  return Array.from(
    menu?.querySelectorAll<HTMLElement>(
      '[data-testid="sidebar-account-menu-header-identity"], [data-testid="sidebar-account-menu-subscription-header"], [role="menuitem"], [role="separator"], [data-testid="sidebar-account-menu-sync-paused"]',
    ) ?? [],
  ).map((element) =>
    element.getAttribute('role') === 'separator'
      ? '---'
      : (element.getAttribute('data-testid') ?? '?'),
  );
}

/**
 * Fire the ambient account-changed broadcast and drain the resulting IPC
 * chains. This is the event every focus / visibility re-probe dispatches, so it
 * is the background-refresh path — not a user action.
 */
async function dispatchAccountChanged(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function clickTestId(root: ParentNode, testId: string): void {
  act(() => {
    root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
  });
}

describe('SidebarAccountMenu', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

  beforeEach(() => {
    // Reset the billing flag to its default (on when LaunchDarkly is not
    // configured) before each test; individual tests override as needed.
    setBillingFlag(true);
    useObservabilityStore.setState({
      usage: { updatedAt: new Date(0).toISOString(), providers: [] },
    });
    // Clear any pending cloud-connect request the guest-CTA tests leave behind.
    useCloudConnectGateStore.setState({ pending: null });
    mockForeignProjection = { epoch: '', sequence: 0, groups: [] };
    mockUpdateState = { phase: 'idle' };
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('keeps other-context updates and the context switcher off the personal account row (CAN-4053)', async (): Promise<void> => {
    setOrgProjectsFlag(true);
    seedWorkspaceContext([
      { id: ORG_A, name: 'Org A' },
      { id: 'org-222222', name: 'Org B' },
    ]);
    mockForeignProjection = {
      epoch: 'epoch',
      sequence: 1,
      groups: [
        {
          context: { kind: 'organization', organizationId: ORG_A },
          workspaces: [
            {
              workspaceId: 'workspace',
              name: 'Workspace',
              running: 1,
              unread: 0,
              interrupted: false,
              stopTargets: [],
              latestTarget: {
                source: 'chat',
                operationId: 'turn',
                workspaceId: 'workspace',
                worktreeId: 'worktree',
                resultToken: null,
              },
            },
          ],
        },
      ],
    };
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      // The switcher at the top of the sidebar carries the updates dot; the
      // avatar keeps its dot for usage warnings only.
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-attention-dot"]',
        ),
      ).toBeNull();
      expect(
        accessibleLabel(
          container.querySelector('[data-testid="sidebar-account-row"]'),
        ),
      ).not.toContain('updates in');
      expect(
        container.querySelector('[data-testid="sidebar-context-row"]'),
      ).toBeNull();
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-context-option-personal"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
      mockForeignProjection = { epoch: '', sequence: 0, groups: [] };
      setOrgProjectsFlag(false);
      seedWorkspaceContext([]);
    }
  });

  it('puts computers in the account menu locally and the picker above the row remotely (CAN-4268)', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      expect(
        container.querySelector('[data-testid="sidebar-machine-picker"]'),
      ).toBeNull();

      const ready = {
        ...defaultRemoteControlState(),
        available: true,
        signedIn: true,
        thisDevice: {
          deviceId: 'dev-local',
          name: 'Work laptop',
          platform: 'darwin' as const,
        },
      };
      // This computer's own window looks as it does with remote access off.
      act(() => {
        useRemoteControlStore.setState({
          hydrated: true,
          context: { mode: 'local' },
          state: ready,
        });
      });
      expect(
        container.querySelector('[data-testid="sidebar-machine-picker"]'),
      ).toBeNull();
      // Its computers live in the account menu, just above Sign out, and the
      // menu has no nested computer picker.
      openMenu(container);
      const computers = container.querySelector(
        '[data-testid="sidebar-account-menu-computers"]',
      );
      expect(computers?.textContent).toContain('Work laptop');
      const signOut = container.querySelector(
        '[data-testid="sidebar-account-menu-item-sign-in-out"]',
      );
      expect(
        computers && signOut
          ? computers.compareDocumentPosition(signOut) &
              Node.DOCUMENT_POSITION_FOLLOWING
          : 0,
      ).toBeTruthy();
      expect(
        container
          .querySelector('[data-testid="sidebar-account-menu"]')
          ?.querySelector('[data-testid="sidebar-machine-picker"]'),
      ).toBeNull();
      openMenu(container);

      act(() => {
        useRemoteControlStore.setState({
          context: {
            mode: 'remote',
            deviceId: 'dev-studio',
            name: 'Studio desktop',
            platform: 'linux',
          },
        });
      });
      const footer = container.querySelector(
        '[data-testid="sidebar-account-footer"]',
      );
      const picker = footer?.querySelector(
        '[data-testid="sidebar-machine-picker"]',
      );
      const row = footer?.querySelector('[data-testid="sidebar-account-row"]');
      expect(picker?.textContent).toContain('Studio desktop');
      expect(
        picker && row
          ? picker.compareDocumentPosition(row) &
              Node.DOCUMENT_POSITION_FOLLOWING
          : 0,
      ).toBeTruthy();
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-computers"]',
        ),
      ).toBeNull();
      openMenu(container);
    } finally {
      act(() => {
        useRemoteControlStore.setState({
          hydrated: false,
          context: { mode: 'local' },
          state: defaultRemoteControlState(),
        });
      });
      unmount();
    }
  });

  it('renders row-sized Send feedback and Settings actions', async () => {
    const onSettingsClick = jest.fn();
    const onNavigate = jest.fn();
    const { container, unmount } = await renderMenu(
      { onNavigate, onSettingsClick },
      { account: signedInAccount },
    );
    try {
      const settingsAction = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-action-settings"]',
      );
      const feedbackAction = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-action-feedback"]',
      );
      expect(feedbackAction).not.toBeNull();
      expect(settingsAction).not.toBeNull();
      for (const action of [feedbackAction, settingsAction]) {
        expect(action?.className).toContain('inline-flex');
        expect(action?.className).toContain('h-8');
        expect(action?.className).toContain('w-8');
        expect(action?.className).toContain('rounded-row');
        expect(action?.className).toContain('hover:bg-subtle');
        expect(action?.className).not.toContain(
          'group-hover/sidebar-item:inline-flex',
        );
        // The secondary tone lives on the control; the glyph inherits it and
        // keeps it under the pointer while only the surface responds.
        expect(action?.className).toContain('fg-secondary');
        expect(action?.className).not.toContain('hover:fg-primary');
        const icon = action?.querySelector('svg');
        expect(icon).not.toBeNull();
        expect(icon?.getAttribute('width')).toBe('14px');
        expect(icon?.getAttribute('height')).toBe('14px');
        expect(icon?.getAttribute('class')).toBeNull();
      }
      expect(
        feedbackAction?.querySelector('[data-app-icon="true"]'),
      ).not.toBeNull();
      // CAN-2678: a raised hand, not a bug. A bug glyph framed the channel as
      // "report a defect" and quietly told users that ideas, questions, and
      // "this felt confusing" did not belong here.
      expect(
        feedbackAction?.querySelector('svg[data-glyph="hand"]'),
      ).not.toBeNull();
      expect(feedbackAction?.querySelector('svg[data-glyph="bug"]')).toBeNull();
      expect(
        settingsAction?.querySelector('[data-app-icon="true"]'),
      ).not.toBeNull();
      expect(feedbackAction?.getAttribute('aria-label')).toBe('Send feedback');
      expect(feedbackAction?.getAttribute('aria-haspopup')).toBe('dialog');
      expect(feedbackAction?.getAttribute('aria-expanded')).toBe('false');
      expect(
        settingsAction?.closest('[data-testid="sidebar-account-list-item"]'),
      ).toBeNull();
      expect(
        feedbackAction?.closest('[data-testid="sidebar-account-list-item"]'),
      ).toBeNull();
      const accountItem = container.querySelector(
        '[data-testid="sidebar-account-list-item"]',
      );
      // The signed-in row shows only the name, so it stays one line tall.
      expect(accountItem?.className).toMatch(/(^|\s)h-8(\s|$)/);
      expect(accountItem?.parentElement?.className).toContain('gap-0');

      clickTestId(container, 'sidebar-account-action-settings');
      expect(onSettingsClick).toHaveBeenCalledTimes(1);

      clickTestId(container, 'sidebar-account-action-feedback');
      expect(
        container.querySelector('[data-testid="mock-feedback-modal"]'),
      ).not.toBeNull();
      expect(feedbackAction?.getAttribute('aria-expanded')).toBe('true');

      openMenu(container);
      // Settings and Send feedback live on the rail only (CAN-4055).
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-item-settings"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-item-feedback"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-item-usage"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-item-sign-in-out"]',
        ),
      ).not.toBeNull();
      // Items that moved into the sidebar nav / Privacy stay gone.
      for (const removed of ['audit', 'workers', 'cloud-sync']) {
        expect(
          container.querySelector(
            `[data-testid="sidebar-account-menu-item-${removed}"]`,
          ),
        ).toBeNull();
      }
      clickTestId(container, 'sidebar-account-menu-item-usage');
      expect(onNavigate).toHaveBeenCalledWith('usage');
    } finally {
      unmount();
    }
  });

  it('portals the menu outside the sidebar clipping boundary', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      const accountRow = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-row"]',
      );
      const sidebarMount = accountRow?.closest(
        '[data-testid="sidebar-account-footer"]',
      )?.parentElement;

      openMenu(container);

      const menu = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-menu"]',
      );
      expect(menu).not.toBeNull();
      expect(sidebarMount?.contains(menu ?? null)).toBe(false);
      expect(menu?.style.position).toBe('fixed');
    } finally {
      unmount();
    }
  });

  it('uses the shared action-menu geometry and restores focus for the signed-out menu', async () => {
    setBillingFlag(false);
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount() },
    );
    try {
      const trigger = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-row"]',
      );
      trigger?.focus();
      openMenu(container);

      const menu = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-menu"]',
      );
      expect(menu?.className).toContain('rounded-lg');
      expect(menu?.className).toContain('bg-quaternary');
      expect(menu?.className).toContain('p-1');
      expect(menu?.className).toContain('shadow-xl');
      expect(menu?.dataset.placement).toMatch(/^top-/);

      const items = Array.from(
        menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
      );
      expect(items.map((item) => item.textContent?.trim())).toEqual([
        'Usage',
        'Remote Control',
        'Sign in',
      ]);
      for (const item of items) {
        expect(item.className).toContain('h-8');
        expect(item.className).toContain('rounded-md');
        // The quiet action-menu rows, like the worktree menu's.
        expect(item.className).toContain('text-xs');
      }
      expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(1);

      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(
        container.querySelector('[data-testid="sidebar-account-menu"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      unmount();
    }
  });

  it('lists the person, Usage, Remote Control, then Sign out, with no Settings or Feedback rows (CAN-4055)', async () => {
    setBillingFlag(false);
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      openMenu(container);
      expect(menuShape(container)).toEqual([
        'sidebar-account-menu-header-identity',
        '---',
        'sidebar-account-menu-item-usage',
        'sidebar-account-menu-item-remote-control',
        '---',
        'sidebar-account-menu-item-sign-in-out',
      ]);
      const header = container.querySelector(
        '[data-testid="sidebar-account-menu-header-identity"]',
      );
      expect(header?.textContent).toContain('Ada Lovelace');
      expect(header?.textContent).toContain('ada@example.com');
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-item-sign-in-out"]',
        )?.textContent,
      ).toBe('Sign out');
      // Every action row leads with an icon; Sign out stays plain, not red.
      for (const row of Array.from(
        container.querySelectorAll(
          '[data-testid="sidebar-account-menu"] [role="menuitem"]',
        ),
      )) {
        expect(row.querySelector('svg')).not.toBeNull();
      }
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-item-sign-in-out"]',
        )?.className,
      ).not.toContain('fg-destructive');
      // The rail keeps both actions and the onboarding anchor.
      expect(
        container
          .querySelector('[data-testid="sidebar-account-action-settings"]')
          ?.getAttribute('data-onboarding-anchor'),
      ).toBe('sidebar-settings');
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-action-feedback"]',
        ),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it.each([
    ['Personal', { kind: 'personal' } as WorkspaceContext],
    [
      'an organization',
      { kind: 'organization', organizationId: ORG_A } as WorkspaceContext,
    ],
  ])(
    'keeps organization actions on the switcher, not the personal menu, in %s (CAN-4054)',
    async (_label, context) => {
      setOrgProjectsFlag(true);
      useWorkspaceContextStore.setState({
        state: {
          context,
          revision: 1,
          organizations: [{ id: ORG_A, name: 'Acme', role: 'OWNER' }],
        },
        hydrated: true,
      });
      const { container, unmount } = await renderMenu(
        {},
        {
          account: makeAccount({
            ...signedInAccount,
            personalOrganizationId: '44444444-4444-4444-8444-444444444444',
          }),
        },
      );
      try {
        openMenu(container);
        for (const testId of [
          'account-personal-activity-row',
          'account-create-team-row',
          'account-invite-team-row',
          'sidebar-context-organization-settings',
          'sidebar-context-menu-item-ai-credits',
        ]) {
          expect(
            container.querySelector(`[data-testid="${testId}"]`),
          ).toBeNull();
        }
        // The row and the header name the person in every context.
        expect(
          container.querySelector('[data-testid="sidebar-account-identity"]')
            ?.textContent,
        ).toBe('Ada Lovelace');
      } finally {
        unmount();
        setOrgProjectsFlag(false);
        seedWorkspaceContext([]);
      }
    },
  );

  describe('External agents menu row', () => {
    const accountWithPersonalOrganization = makeAccount({
      ...signedInAccount,
      personalOrganizationId: '44444444-4444-4444-8444-444444444444',
    });

    afterEach(() => {
      setExternalAgentsMenuFlag(false);
    });

    it('shows after Usage for a signed-in account when the flag is enabled', async () => {
      setExternalAgentsMenuFlag(true);
      const { container, unmount } = await renderMenu(
        {},
        { account: accountWithPersonalOrganization },
      );
      try {
        openMenu(container);
        const usage = container.querySelector(
          '[data-testid="sidebar-account-menu-item-usage"]',
        );
        const externalAgents = container.querySelector(
          '[data-testid="account-external-agents-row"]',
        );
        expect(externalAgents?.textContent).toBe('External agents (MCP)');
        if (usage === null || externalAgents === null) {
          throw new Error('Expected Usage and External agents menu rows.');
        }
        const rows = Array.from(usage.parentElement?.children ?? []);
        expect(rows.indexOf(externalAgents)).toBeGreaterThan(
          rows.indexOf(usage),
        );
      } finally {
        unmount();
      }
    });

    it('opens the authenticated Portal page and closes the menu', async () => {
      setExternalAgentsMenuFlag(true);
      const { container, unmount } = await renderMenu(
        {},
        { account: accountWithPersonalOrganization },
      );
      try {
        openMenu(container);
        clickTestId(container, 'account-external-agents-row');
        expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
          '/account/external-agents',
        );
        expect(
          container.querySelector('[data-testid="sidebar-account-menu"]'),
        ).toBeNull();
      } finally {
        unmount();
      }
    });

    it('hides when the flag is off', async () => {
      setExternalAgentsMenuFlag(false);
      const { container, unmount } = await renderMenu(
        {},
        { account: accountWithPersonalOrganization },
      );
      try {
        openMenu(container);
        expect(
          container.querySelector(
            '[data-testid="account-external-agents-row"]',
          ),
        ).toBeNull();
      } finally {
        unmount();
      }
    });

    it('hides from a guest account even when the flag is enabled', async () => {
      setExternalAgentsMenuFlag(true);
      const guestAccount = makeAccount({
        hasApiKey: true,
        credentialSource: 'guest',
        account: {
          id: 'guest_1',
          name: 'Guest',
          email: 'guest+abc@example.com',
          role: 'DEVELOPER',
        },
      });
      const { container, unmount } = await renderMenu(
        {},
        { account: guestAccount },
      );
      try {
        openMenu(container);
        expect(
          container.querySelector(
            '[data-testid="account-external-agents-row"]',
          ),
        ).toBeNull();
      } finally {
        unmount();
      }
    });
  });

  it('uses the compact filter-dot geometry for usage alerts', async () => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: new Date(0).toISOString(),
        providers: [
          {
            provider: 'claude',
            authState: 'authenticated',
            hasRemainingLimits: true,
            rateLimits: [{ primary: { usedPercent: 85 } }],
          },
        ],
      },
    });
    const { container, unmount } = await renderMenu(
      {},
      {
        account: makeAccount({
          hasApiKey: true,
          account: {
            id: 'acct_attention',
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            role: 'DEVELOPER',
            image: 'https://example.com/avatar.png',
          },
        }),
      },
    );
    try {
      const identity = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-identity"]',
      );
      const avatar = container.querySelector<HTMLImageElement>(
        '[data-testid="sidebar-account-avatar"]',
      );
      const rowDot = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-attention-dot"]',
      );
      expect(identity?.className).not.toContain('fg-warning');
      expect(identity?.className).not.toContain('fg-destructive-strong');
      expect(avatar?.className).toContain(
        'sidebar-account-avatar-attention-mask',
      );
      expect(rowDot?.className).toContain('bg-warning');
      expect(rowDot?.className).not.toContain('ring-sidebar');
      expect(
        accessibleLabel(
          container.querySelector('[data-testid="sidebar-account-row"]'),
        ),
      ).toContain('usage is nearing its limit');

      openMenu(container);
      const dot = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-usage-alert-dot"]',
      );
      const frame = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-usage-alert-frame"]',
      );
      expect(frame?.className).toContain(
        'ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center',
      );
      expect(dot?.className).toContain('h-1.5 w-1.5 rounded-full');
      expect(dot?.className).toContain('bg-warning');
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-item-usage"]',
        )?.className,
      ).not.toContain('fg-warning');
      expect(
        frame?.closest('[data-testid="sidebar-account-menu-item-usage"]'),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('inks the Usage row red, not primary, once a limit is reached', async () => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: new Date(0).toISOString(),
        providers: [
          {
            provider: 'claude',
            authState: 'authenticated',
            hasRemainingLimits: true,
            rateLimits: [{ primary: { usedPercent: 99 } }],
          },
        ],
      },
    });
    const { container, unmount } = await renderMenu(
      {},
      {
        account: makeAccount({
          hasApiKey: true,
          account: {
            id: 'acct_critical',
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            role: 'DEVELOPER',
            image: null,
          },
        }),
      },
    );
    try {
      expect(
        container.querySelector<HTMLElement>(
          '[data-testid="sidebar-account-identity"]',
        )?.className,
      ).not.toContain('fg-destructive');

      openMenu(container);
      const usageTokens = (
        container.querySelector<HTMLElement>(
          '[data-testid="sidebar-account-menu-item-usage"]',
        )?.className ?? ''
      ).split(/\s+/);
      // The row's own `fg-primary` sorts after `fg-destructive` in the
      // stylesheet, so the alert ink has to replace it rather than ride
      // alongside it.
      expect(usageTokens).not.toContain('fg-destructive');
      expect(usageTokens).toContain('fg-primary');
      expect(
        container.querySelector<HTMLElement>(
          '[data-testid="sidebar-account-usage-alert-dot"]',
        )?.className,
      ).toContain('bg-destructive');
    } finally {
      unmount();
    }
  });

  it('follows the AI Credits mode before judging the account proxy pool', async () => {
    // A healthy native plan, and a proxy whose only Claude account is off.
    useObservabilityStore.setState({
      usage: {
        updatedAt: new Date(0).toISOString(),
        providers: [
          {
            provider: 'claude',
            authState: 'authenticated',
            hasRemainingLimits: true,
            rateLimits: [{ primary: { usedPercent: 10 } }],
          },
        ],
      },
    });
    useAccountProxyStore.setState({
      status: {
        available: true,
        connection: {
          id: 'c1',
          kind: 'server',
          url: 'https://proxy.example.com',
        },
        state: 'connected',
        error: null,
        version: '8.0.28',
        accounts: [
          {
            authIndex: 'a1f3c2d4a1f3c2d4',
            provider: 'claude',
            label: 'sam@example.com',
            source: 'sign-in',
            fileName: 'claude-sam.json',
            planType: 'max',
            status: 'disabled',
            statusMessage: null,
            availableAt: null,
            limits: [],
          },
        ],
        routing: null,
        keepChatOnOneAccount: true,
        routeClaude: true,
        routeCodex: false,
        refreshedAt: 1,
        local: {
          phase: 'not-installed',
          version: '8.0.28',
          install: null,
          port: null,
          startWithApp: true,
          message: null,
        },
        signIn: null,
      },
    });
    const identityClass = async (
      aiCreditsRoutingMode: AiCreditsRoutingMode,
    ): Promise<string> => {
      invalidateAiCreditsUsageCache();
      const { container, unmount } = await renderMenu(
        {},
        {
          account: makeAccount({
            hasApiKey: true,
            account: {
              id: 'acct_proxy',
              name: 'Ada Lovelace',
              email: 'ada@example.com',
              role: 'DEVELOPER',
              image: null,
            },
          }),
          aiCredits: {
            connected: true,
            email: 'ada@example.com',
            subscription: null,
            balance: {
              email: 'ada@example.com',
              credits: 500,
              eligible: true,
            },
            noUdAccount: false,
            error: null,
          },
          aiCreditsRoutingMode,
        },
      );
      try {
        await act(async () => {
          for (let i = 0; i < 10; i += 1) await Promise.resolve();
        });
        return (
          container.querySelector<HTMLElement>(
            '[data-testid="sidebar-account-identity"]',
          )?.className ?? ''
        );
      } finally {
        unmount();
      }
    };
    try {
      // Main skips the proxy while AI Credits route every session.
      expect(await identityClass('on')).not.toContain('fg-destructive');
      // `on-quota` keeps Claude on the proxy, whose pool cannot serve.
      expect(await identityClass('on-quota')).not.toContain('fg-destructive');
    } finally {
      useAccountProxyStore.setState({ status: null });
      invalidateAiCreditsUsageCache();
    }
  });

  it('removes a cached Cursor usage warning when the rollout turns off', async () => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: new Date().toISOString(),
        providers: [
          {
            provider: 'cursor',
            authState: 'authenticated',
            hasRemainingLimits: true,
            rateLimits: [{ primary: { usedPercent: 85 } }],
          },
        ],
      },
    });
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-usage-alert-dot"]',
        ),
      ).not.toBeNull();
      act(() => {
        const snapshot = baselineFeatureFlagSnapshot();
        useFeatureFlagsStore.setState({
          snapshot: {
            ...snapshot,
            values: {
              ...snapshot.values,
              'canopy-desktop-cursor-harness': false,
            },
          },
        });
      });
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-usage-alert-dot"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('closes the portaled account menu when Settings opens', async () => {
    const { container, root, unmount } = await renderMenu();
    try {
      openMenu(container);
      expect(
        container.querySelector('[data-testid="sidebar-account-menu"]'),
      ).not.toBeNull();

      await act(async () => {
        root.render(<SidebarAccountMenu {...BASE_PROPS} settingsOpen />);
        await Promise.resolve();
      });

      expect(
        container.querySelector('[data-testid="sidebar-account-menu"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('starts OAuth from the account menu when not signed in', async () => {
    setBillingFlag(false);
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount() },
    );
    try {
      openMenu(container);
      await act(async () => {
        clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
        await Promise.resolve();
      });
      expect(startOAuthLogin).toHaveBeenCalledTimes(1);
      expect(disconnectAccount).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('starts OAuth from the account menu for a guest', async () => {
    setBillingFlag(false);
    const guestAccount = makeAccount({
      hasApiKey: true,
      credentialSource: 'guest',
      account: {
        id: 'guest_1',
        name: 'Guest',
        email: 'guest+abc123@example.com',
        role: 'DEVELOPER',
      },
    });
    const { container, unmount } = await renderMenu(
      {},
      { account: guestAccount },
    );
    try {
      // A guest carries account metadata but must be offered the OAuth upgrade,
      // never the sign-out/disconnect that destroys their device token.
      openMenu(container);
      await act(async () => {
        clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
        await Promise.resolve();
      });
      expect(startOAuthLogin).toHaveBeenCalledTimes(1);
      expect(disconnectAccount).not.toHaveBeenCalled();
      // No sign-out confirm modal should open for a guest.
      expect(
        container.querySelector('[data-testid="mock-sign-out-modal"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('treats authMode "guest" as a guest even when credentialSource is not guest', async () => {
    // Legacy/normalized entries can carry `authMode: 'guest'` while
    // `credentialSource` is normalized to a non-guest value. The menu must still
    // classify this as a guest and offer OAuth upgrade, never sign-out.
    setBillingFlag(false);
    const legacyGuestAccount = makeAccount({
      hasApiKey: true,
      authMode: 'guest',
      credentialSource: 'manual',
      account: {
        id: 'guest_legacy_1',
        name: 'Guest',
        email: 'guest+legacy@example.com',
        role: 'DEVELOPER',
      },
    });
    const { container, unmount } = await renderMenu(
      {},
      { account: legacyGuestAccount },
    );
    try {
      openMenu(container);
      await act(async () => {
        clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
        await Promise.resolve();
      });
      expect(startOAuthLogin).toHaveBeenCalledTimes(1);
      expect(disconnectAccount).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="mock-sign-out-modal"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('announces success only when OAuth resolves authenticated', async () => {
    setBillingFlag(false);
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount() },
    );
    const onChanged = jest.fn();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, onChanged);
    try {
      openMenu(container);
      await act(async () => {
        clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
        await Promise.resolve();
      });
      expect(startOAuthLogin).toHaveBeenCalledTimes(1);
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, onChanged);
      unmount();
    }
  });

  it('does not announce success when OAuth resolves unauthenticated (cancelled)', async () => {
    setBillingFlag(false);
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount() },
    );
    startOAuthLogin.mockResolvedValueOnce({
      status: { authenticated: false, missingCapabilities: [], error: null },
      account: makeAccount(),
    });
    const onChanged = jest.fn();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, onChanged);
    try {
      openMenu(container);
      await act(async () => {
        clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
        await Promise.resolve();
      });
      expect(startOAuthLogin).toHaveBeenCalledTimes(1);
      // A cancelled/failed sign-in must NOT broadcast an account change; the
      // row remains available so the user can retry.
      expect(onChanged).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="sidebar-account-row"]'),
      ).not.toBeNull();
    } finally {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, onChanged);
      unmount();
    }
  });

  it('surfaces an OAuth launch failure instead of appearing inert', async () => {
    setBillingFlag(false);
    const originalAddToast = useGitHubStore.getState().addToast;
    const addToast = jest.fn();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    useGitHubStore.setState({ addToast });
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount() },
    );
    startOAuthLogin.mockRejectedValueOnce(
      new Error('Cloud base URL is not configured.'),
    );
    try {
      openMenu(container);
      await act(async () => {
        clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(addToast).toHaveBeenCalledWith(
        'Unable to start sign-in. Check Cloud configuration.',
        'error',
      );
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-account-row"]',
        )?.disabled,
      ).toBe(false);
    } finally {
      unmount();
      useGitHubStore.setState({ addToast: originalAddToast });
      consoleError.mockRestore();
    }
  });

  it('does not start a second OAuth login while one is in flight', async () => {
    setBillingFlag(false);
    let resolveLogin: (() => void) | undefined;
    const pendingLogin = new Promise<
      Awaited<ReturnType<CanopyApi['startCanopyCloudOAuthLogin']>>
    >((resolve) => {
      resolveLogin = (): void =>
        resolve({
          status: {
            authenticated: true,
            account: { id: 'acct_1' },
            missingCapabilities: [],
            error: null,
          },
          account: makeAccount(),
        });
    });
    startOAuthLogin.mockImplementationOnce(() => pendingLogin);
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount() },
    );
    try {
      openMenu(container);
      const clickSignIn = (): void =>
        clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
      // Rapid double-click while the first OAuth call is still pending.
      await act(async () => {
        clickSignIn();
        clickSignIn();
        await Promise.resolve();
      });
      expect(startOAuthLogin).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveLogin?.();
        await Promise.resolve();
      });
    } finally {
      unmount();
    }
  });

  it('labels the sign-in/out item "Sign out" and confirms before disconnecting', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      openMenu(container);
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-menu-item-sign-in-out"]',
      );
      expect(button?.textContent).toContain('Sign out');

      // Clicking Sign out opens the confirm modal but does NOT disconnect yet.
      clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
      expect(disconnectAccount).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="mock-sign-out-confirm"]'),
      ).not.toBeNull();

      // Confirming disconnects.
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="mock-sign-out-confirm"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(disconnectAccount).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });

  it('uses a non-destructive confirm tone for sign out', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      openMenu(container);
      clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
      const modal = container.querySelector<HTMLElement>(
        '[data-testid="mock-sign-out-modal"]',
      );
      expect(modal?.getAttribute('data-confirm-tone')).toBe('primary');
    } finally {
      unmount();
    }
  });

  it('surfaces an error and keeps the modal open when sign-out fails', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    disconnectAccount.mockRejectedValueOnce(new Error('network down'));
    try {
      openMenu(container);
      clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="mock-sign-out-confirm"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(disconnectAccount).toHaveBeenCalledTimes(1);
      // Failure is surfaced inline and the confirm modal stays open for retry.
      expect(
        container.querySelector('[data-testid="mock-sign-out-error"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="mock-sign-out-modal"]'),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('shows the signed-out status with the account icon', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount({ hasApiKey: false }) },
    );
    try {
      const accountRow = container.querySelector(
        '[data-testid="sidebar-account-row"]',
      );
      expect(accountRow?.getAttribute('aria-label')).toBe('Sign in');
      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toBe('Sign in');
      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-account-icon"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-account-icon"]')
          ?.parentElement?.className,
      ).toContain('fg-secondary');
      // Signed out, the identity carries no usage-alert tone and inherits the
      // row's primary ink.
      const identity = container.querySelector(
        '[data-testid="sidebar-account-identity"]',
      );
      expect(identity?.className).not.toContain('fg-warning');
      expect(identity?.className).not.toContain('fg-destructive');
      expect(
        identity?.closest('[data-testid="sidebar-account-list-item"]')
          ?.className,
      ).toContain('fg-primary');
      expect(
        container.querySelector('[data-testid="sidebar-account-initials"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('renders a safe profile image in the bottom-left account row', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: makeAccount({
          hasApiKey: true,
          account: {
            id: 'acct_1',
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            role: 'DEVELOPER',
            image: 'https://example.com/avatar.png',
          },
        }),
      },
    );
    try {
      const avatar = container.querySelector<HTMLImageElement>(
        '[data-testid="sidebar-account-avatar"]',
      );
      expect(avatar?.getAttribute('src')).toBe(
        'https://example.com/avatar.png',
      );
      expect(avatar?.getAttribute('alt')).toBe('Ada Lovelace');
      expect(avatar?.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(avatar?.className).toContain('h-4 w-4 rounded-full object-cover');
      expect(
        container.querySelector('[data-testid="sidebar-account-initials"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('derives a compact initial for a single-word guest name', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: makeAccount({
          hasApiKey: true,
          credentialSource: 'guest',
          account: {
            id: 'guest_1',
            name: 'Guest',
            email: 'guest+abc@example.com',
            role: 'DEVELOPER',
          },
        }),
      },
    );
    try {
      const initials = container.querySelector(
        '[data-testid="sidebar-account-initials"]',
      );
      expect(initials?.textContent).toBe('G');
    } finally {
      unmount();
    }
  });

  it('falls back to initials for a non-http(s) profile image URL', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: makeAccount({
          hasApiKey: true,
          account: {
            id: 'acct_1',
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            role: 'DEVELOPER',
            image: 'javascript:alert(1)',
          },
        }),
      },
    );
    try {
      expect(
        container.querySelector<HTMLImageElement>(
          '[data-testid="sidebar-account-avatar"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-account-initials"]')
          ?.textContent,
      ).toBe('A');
    } finally {
      unmount();
    }
  });

  it('falls back to initials when the profile image fails to load', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: makeAccount({
          hasApiKey: true,
          account: {
            id: 'acct_1',
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            role: 'DEVELOPER',
            image: 'https://example.com/broken.png',
          },
        }),
      },
    );
    try {
      const avatar = container.querySelector<HTMLImageElement>(
        '[data-testid="sidebar-account-avatar"]',
      );
      expect(avatar).not.toBeNull();
      act(() => {
        avatar?.dispatchEvent(new Event('error'));
      });
      expect(
        container.querySelector('[data-testid="sidebar-account-avatar"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-account-initials"]')
          ?.textContent,
      ).toBe('A');
    } finally {
      unmount();
    }
  });

  it('renders only the account name, without the email, while Remote Control is off', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount, entitlements: resolvedEntitlements() },
    );
    try {
      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toBe('Ada Lovelace');
      // The email lives in the menu header, not on the row.
      expect(
        container.querySelector('[data-testid="sidebar-account-list-item"]')
          ?.textContent,
      ).not.toContain('ada@example.com');
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-remote-control-subtitle"]',
        ),
      ).toBeNull();
      // The plan moved off the row into the menu header (CAN-3659).
      expect(
        container.querySelector(
          '[data-testid="sidebar-subscription-plan-subtitle"]',
        ),
      ).toBeNull();
      // One line, so the row keeps the single-line height and the name
      // centers with the avatar and the rail icons.
      expect(
        container.querySelector('[data-testid="sidebar-account-list-item"]')
          ?.className,
      ).toMatch(/(^|\s)h-8(\s|$)/);
      expect(
        accessibleLabel(
          container.querySelector('[data-testid="sidebar-account-row"]'),
        ),
      ).toBe('Ada Lovelace');
      expect(container.textContent).not.toContain('Not signed in');
      expect(
        container.querySelector('[data-testid="sidebar-account-row"]')
          ?.className,
      ).toContain('h-full');
    } finally {
      unmount();
    }
  });

  it('holds the menu plan header across a background refresh of a resolved plan', async () => {
    // The second entitlements read stays pending for the whole assertion, so
    // this is precisely the in-flight window the reporter saw flicker.
    let resolveSecondRead:
      | ((value: CanopyCloudEntitlementsState) => void)
      | undefined;
    const secondRead = new Promise<CanopyCloudEntitlementsState>((resolve) => {
      resolveSecondRead = resolve;
    });
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements(),
        entitlementsQueue: [resolvedEntitlements(), secondRead],
      },
    );
    try {
      openMenu(container);
      const header = (): Element | null =>
        container.querySelector(
          '[data-testid="sidebar-account-menu-subscription-header"]',
        );
      expect(header()?.textContent).toContain('BusinessTrial');
      const menu = container.querySelector(
        '[data-testid="sidebar-account-menu"]',
      );
      const removed: Node[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) removed.push(...record.removedNodes);
      });
      if (menu) observer.observe(menu, { childList: true, subtree: true });

      await dispatchAccountChanged();
      observer.disconnect();

      // The plan is held, not re-loaded: the header never leaves the menu.
      expect(
        removed.some(
          (node) =>
            node instanceof Element &&
            (node.matches(
              '[data-testid="sidebar-account-menu-subscription-header"]',
            ) ||
              node.querySelector(
                '[data-testid="sidebar-account-menu-subscription-header"]',
              ) !== null),
        ),
      ).toBe(false);
      expect(header()?.textContent).toContain('BusinessTrial');

      await act(async () => {
        resolveSecondRead?.(resolvedEntitlements());
        await secondRead;
        await Promise.resolve();
      });
    } finally {
      unmount();
    }
  });

  it('keeps the account name when a background account re-read fails', async () => {
    let rejectRefresh: (error: Error) => void = () => undefined;
    const rejectedRefresh = new Promise<CanopyCloudAccountPublicState>(
      (_resolve, reject) => {
        rejectRefresh = reject;
      },
    );
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements(),
        accountQueue: [
          signedInAccount,
          signedInAccount,
          rejectedRefresh,
          rejectedRefresh,
        ],
      },
    );
    try {
      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toBe('Ada Lovelace');

      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        rejectRefresh(new Error('offline'));
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });

      // A failed read is inconclusive — it must not demote a signed-in user.
      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toBe('Ada Lovelace');
    } finally {
      unmount();
    }
  });

  it('still clears the account name and plan on a real sign-out', async () => {
    // Guards against over-holding: a sign-out *resolves* (it does not reject),
    // so the hold-last-known-good rule above must not swallow it.
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements(),
        accountQueue: [
          signedInAccount,
          signedInAccount,
          makeAccount(),
          makeAccount(),
        ],
        entitlementsQueue: [
          resolvedEntitlements(),
          resolvedEntitlements({ source: 'none', plan: null, trial: null }),
        ],
      },
    );
    try {
      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toBe('Ada Lovelace');

      await dispatchAccountChanged();

      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toBe('Sign in');
    } finally {
      unmount();
    }
  });

  // A degraded secure-store read *resolves* with a signed-out-looking snapshot
  // instead of rejecting, so the rejection test above cannot cover it. This is
  // the dominant real failure mode: an ambient re-probe past the account cache
  // TTL re-decrypts from disk, and a transient failure there would otherwise
  // blank a signed-in user's name and plan.
  it.each(['unavailable', 'error'] as const)(
    'keeps the account name when a background account re-read is degraded (%s)',
    async (read) => {
      const degraded = makeAccount({ read });
      const { container, unmount } = await renderMenu(
        {},
        {
          account: signedInAccount,
          entitlements: resolvedEntitlements(),
          accountQueue: [signedInAccount, signedInAccount, degraded, degraded],
        },
      );
      try {
        expect(
          container.querySelector('[data-testid="sidebar-account-identity"]')
            ?.textContent,
        ).toBe('Ada Lovelace');

        await dispatchAccountChanged();

        expect(
          container.querySelector('[data-testid="sidebar-account-identity"]')
            ?.textContent,
        ).toBe('Ada Lovelace');
      } finally {
        unmount();
      }
    },
  );

  it('does not let a superseded slow account read restore a stale identity', async () => {
    // Two account-changed events overlap: an earlier ambient re-probe is still
    // in flight when a sign-out refresh completes. Without a per-refresh
    // sequence token the last-*completed* read wins, so the stale signed-in
    // snapshot would overwrite the cleared account and strand the former user's
    // name in the footer until some later refresh happened to correct it.
    let resolveStale: (value: CanopyCloudAccountPublicState) => void = () =>
      undefined;
    const stalePending = new Promise<CanopyCloudAccountPublicState>(
      (resolve) => {
        resolveStale = resolve;
      },
    );
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements(),
        accountQueue: [
          // Mount.
          signedInAccount,
          signedInAccount,
          // Refresh #1 (older, deliberately left pending).
          stalePending,
          stalePending,
          // Refresh #2 (newer, resolves immediately as a sign-out).
          makeAccount(),
          makeAccount(),
        ],
        entitlementsQueue: [
          resolvedEntitlements(),
          resolvedEntitlements(),
          resolvedEntitlements({ source: 'none', plan: null, trial: null }),
        ],
      },
    );
    try {
      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toBe('Ada Lovelace');

      // Refresh #1 starts and stays pending.
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      // Refresh #2 starts and completes, clearing the account.
      await dispatchAccountChanged();

      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toBe('Sign in');

      // The superseded read finally lands. It must be discarded.
      await act(async () => {
        resolveStale(signedInAccount);
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });

      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toBe('Sign in');
    } finally {
      unmount();
    }
  });

  it('truncates a long name on one line', async () => {
    const longName =
      'Ada Lovelace with a deliberately long organization account name';
    const longEmail =
      'ada.lovelace.with.a.very.long.address@example-organization.com';
    const { container, unmount } = await renderMenu(
      {},
      {
        account: makeAccount({
          hasApiKey: true,
          account: {
            id: 'acct_long_name',
            name: longName,
            email: longEmail,
            role: 'DEVELOPER',
          },
        }),
        entitlements: resolvedEntitlements(),
      },
    );
    try {
      const accountItem = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-list-item"]',
      );
      const identity = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-identity"]',
      );
      expect(accountItem?.className).toMatch(/(^|\s)h-8(\s|$)/);
      expect(identity?.textContent).toBe(longName);
      expect(identity?.className).toContain('min-w-0');
      expect(identity?.className).toContain('truncate');
      expect(identity?.getAttribute('title')).toBe(longName);
      expect(accountItem?.textContent).not.toContain(longEmail);
      expect(
        accessibleLabel(
          container.querySelector('[data-testid="sidebar-account-row"]'),
        ),
      ).toBe(longName);
    } finally {
      unmount();
    }
  });

  it('shows the higher-priced displayPlan (org Business) over a personal plan in the menu header', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        // Wallet-primary is the personal Pro subscription, but the user is also
        // covered by a pricier org Business plan — the badge must show Business.
        entitlements: resolvedEntitlements({
          source: 'subscription',
          plan: { key: 'individual', displayName: 'Pro' },
          trial: null,
          displayPlan: {
            key: 'business',
            displayName: 'Business',
            source: 'org_seat',
          },
        }),
      },
    );
    try {
      // The menu header names the visible tier; the row shows the email.
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-subscription-header"]',
        )?.textContent,
      ).toBe('Business');
    } finally {
      unmount();
    }
  });

  it('falls back to a Free menu header when a fetched trial expires', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements({
          trial: {
            active: false,
            endsAt: new Date(Date.now() - DAY_MS).toISOString(),
          },
        }),
      },
    );
    try {
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-subscription-trial-pill"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-subscription-header"]',
        )?.textContent,
      ).toBe('Free');
    } finally {
      unmount();
    }
  });

  it('hides the menu plan header when the billing flag is off', async () => {
    setBillingFlag(false);
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements(),
      },
    );
    try {
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-subscription-header"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('hides the menu plan header when entitlements are unresolved', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount, entitlements: UNRESOLVED_ENTITLEMENTS },
    );
    try {
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-subscription-header"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  const guestAccount = makeAccount({
    hasApiKey: true,
    credentialSource: 'guest',
    account: {
      id: 'guest_1',
      name: 'Guest',
      email: 'guest+abc@example.com',
      role: 'DEVELOPER',
    },
  });

  it('keeps guest sign-in in the account menu without the promotional panel', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: guestAccount, entitlements: resolvedEntitlements() },
    );
    try {
      // A guest row has no second line: no plan and no device email.
      expect(
        container.querySelector(
          '[data-testid="sidebar-subscription-plan-subtitle"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-account-list-item"]')
          ?.textContent,
      ).not.toContain('guest+abc@example.com');
      expect(
        container.querySelector(
          '[data-testid="sidebar-subscription-pill-guest-cta"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-account-identity"]')
          ?.textContent,
      ).toContain('Guest');
      expect(
        container.querySelector('[data-testid="sidebar-account-initials"]')
          ?.textContent,
      ).toBe('G');
      expect(
        accessibleLabel(
          container.querySelector('[data-testid="sidebar-account-row"]'),
        ),
      ).toBe('Guest');
      const accountItem = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-list-item"]',
      );
      expect(accountItem?.className).toContain('h-8');
      expect(accountItem?.className).toContain('gap-2');
      expect(accountItem?.className).toContain('px-2');
      expect(accountItem?.className).not.toContain('pl-');
      expect(accountItem?.className).not.toContain('pr-');
      expect(accountItem?.className).toContain('text-s');
      expect(accountItem?.className).toContain('rounded-row');
      openMenu(container);
      const signInAction = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-menu-item-sign-in-out"]',
      );
      expect(signInAction).not.toBeNull();
      expect(signInAction?.textContent).toContain(GUEST_SIGN_IN_CTA_LABEL);
      expect(useCloudConnectGateStore.getState().pending).toBeNull();
    } finally {
      unmount();
    }
  });

  it('opens the sync sign-in gate from the guest account menu', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: guestAccount, entitlements: resolvedEntitlements() },
    );
    try {
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-login-icon"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-sync-icon"]',
        ),
      ).toBeNull();
      await act(async () => {
        clickTestId(container, 'sidebar-account-menu-item-sign-in-out');
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(startOAuthLogin).not.toHaveBeenCalled();
      expect(useCloudConnectGateStore.getState().pending?.context.title).toBe(
        GUEST_SIGN_IN_CTA_LABEL,
      );
    } finally {
      unmount();
    }
  });

  describe('free app access', () => {
    const freeAccessEntitlements = resolvedEntitlements({
      source: 'none',
      plan: null,
      trial: null,
      canRemoteControl: true,
      freeAccess: true,
    });

    function aiCredits(
      overrides: Partial<CanopyCloudAiCreditsState> = {},
    ): CanopyCloudAiCreditsState {
      return {
        connected: true,
        email: 'ada@example.com',
        subscription: null,
        balance: {
          email: 'ada@example.com',
          credits: 688.77,
          eligible: true,
          source: 'canopy',
        },
        noUdAccount: false,
        error: null,
        ...overrides,
      };
    }

    async function renderFreeAccessMenu(
      apiOverrides: Parameters<typeof installWindowApi>[0] = {},
    ): ReturnType<typeof renderMenu> {
      // The credits hook caches at module scope; expire it so each case reads
      // the balance its own bridge returns.
      invalidateAiCreditsUsageCache();
      const rendered = await renderMenu(
        {},
        {
          account: signedInAccount,
          entitlements: freeAccessEntitlements,
          aiCredits: aiCredits(),
          baseUrl: 'https://cloud.example.com',
          ...apiOverrides,
        },
      );
      await act(async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      return rendered;
    }

    it('replaces the plan header and billing action with the AI Credits row', async () => {
      const { container, unmount } = await renderFreeAccessMenu();
      try {
        expect(
          container.querySelector(
            '[data-testid="sidebar-subscription-plan-subtitle"]',
          ),
        ).toBeNull();
        openMenu(container);
        expect(
          container.querySelector(
            '[data-testid="sidebar-account-menu-subscription-header"]',
          ),
        ).toBeNull();
        expect(
          container.querySelector(
            '[data-testid="sidebar-account-menu-item-billing"]',
          ),
        ).toBeNull();
        expect(
          container.querySelector(
            '[data-testid="sidebar-account-menu-item-ai-credits-balance"]',
          )?.textContent,
        ).toBe('689');

        expect(menuShape(container)).toEqual([
          'sidebar-account-menu-header-identity',
          'sidebar-account-menu-item-ai-credits',
          '---',
          'sidebar-account-menu-item-usage',
          'sidebar-account-menu-item-remote-control',
          '---',
          'sidebar-account-menu-item-sign-in-out',
        ]);
      } finally {
        unmount();
      }
    });

    it.each(['OWNER', 'ADMIN', 'MEMBER'] as const)(
      'shows the personal wallet and opens account billing to an %s in an organization (CAN-4056)',
      async (role) => {
        const acme = '11111111-1111-4111-8111-111111111111';
        setOrgProjectsFlag(true);
        useWorkspaceContextStore.setState({
          state: {
            context: { kind: 'organization', organizationId: acme },
            revision: 1,
            organizations: [{ id: acme, name: 'Acme', role }],
          },
          hydrated: true,
        });
        const { container, unmount } = await renderFreeAccessMenu({
          // The organization's pool is the switcher's; the menu never shows it.
          nativeAvailability: {
            personalEligible: true,
            inOrg: true,
            orgCreditPoolCovered: true,
            orgSpendable: true,
            ownerOrganization: { id: acme, name: 'Acme' },
            ownerOrganizationBalanceCredits: 412.5,
            pricingUrl: 'https://cloud.example.com/pricing',
          },
        });
        try {
          expect(
            container.querySelector('[data-testid="sidebar-account-identity"]')
              ?.textContent,
          ).toBe('Ada Lovelace');
          openMenu(container);
          expect(
            container.querySelector(
              '[data-testid="sidebar-account-menu-item-ai-credits-balance"]',
            )?.textContent,
          ).toBe('689');
          await act(async () => {
            container
              .querySelector<HTMLButtonElement>(
                '[data-testid="sidebar-account-menu-item-ai-credits"]',
              )
              ?.click();
            await Promise.resolve();
            await Promise.resolve();
          });
          expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
            '/account/billing',
          );
          expect(openAuthenticatedPortalPage).not.toHaveBeenCalledWith(
            organizationBillingPath(acme),
          );
        } finally {
          unmount();
          setOrgProjectsFlag(false);
          seedWorkspaceContext([]);
        }
      },
    );

    it('opens account billing from the AI Credits row and closes the menu', async () => {
      const { container, unmount } = await renderFreeAccessMenu();
      try {
        openMenu(container);
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="sidebar-account-menu-item-ai-credits"]',
            )
            ?.click();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
          '/account/billing',
        );
        expect(
          container.querySelector(
            '[data-testid="sidebar-account-menu-item-ai-credits"]',
          ),
        ).toBeNull();
      } finally {
        unmount();
      }
    });

    it('opens account billing inside Settings when hosted settings are available', async () => {
      mockHostedSettingsClient = {};
      const { container, unmount } = await renderFreeAccessMenu();
      try {
        openMenu(container);
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="sidebar-account-menu-item-ai-credits"]',
            )
            ?.click();
          await Promise.resolve();
          await Promise.resolve();
        });
        const navigation = useNavigationStore.getState();
        expect(navigation.settingsOpen).toBe(true);
        expect(navigation.settingsHostedLocation?.route).toEqual({
          scope: 'account',
          page: 'billing',
        });
        expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
      } finally {
        unmount();
        mockHostedSettingsClient = null;
        useNavigationStore.getState().closeSettings();
      }
    });

    it('keeps the web hand-off while the hosted settings flag is off', async () => {
      mockHostedSettingsClient = {};
      const { container, unmount } = await renderFreeAccessMenu();
      try {
        const { snapshot } = useFeatureFlagsStore.getState();
        useFeatureFlagsStore.setState({
          snapshot: {
            ...snapshot,
            values: {
              ...snapshot.values,
              'canopy-desktop-hosted-settings': false,
            },
          },
        });
        openMenu(container);
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="sidebar-account-menu-item-ai-credits"]',
            )
            ?.click();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
          '/account/billing',
        );
        expect(useNavigationStore.getState().settingsOpen).toBe(false);
      } finally {
        unmount();
        mockHostedSettingsClient = null;
      }
    });

    it('shows a zero balance and omits an unknown one', async () => {
      const zero = await renderFreeAccessMenu({
        aiCredits: aiCredits({
          balance: {
            email: 'ada@example.com',
            credits: 0,
            eligible: false,
            source: 'canopy',
          },
        }),
      });
      try {
        openMenu(zero.container);
        expect(
          zero.container.querySelector(
            '[data-testid="sidebar-account-menu-item-ai-credits-balance"]',
          )?.textContent,
        ).toBe('0');
      } finally {
        zero.unmount();
      }

      const failed = await renderFreeAccessMenu({
        // A different account, so the credits hook has no same-account
        // balance to carry over from the read above.
        aiCredits: aiCredits({
          email: 'grace@example.com',
          balance: null,
          error: 'Request failed',
        }),
      });
      try {
        openMenu(failed.container);
        expect(
          failed.container.querySelector(
            '[data-testid="sidebar-account-menu-item-ai-credits"]',
          ),
        ).not.toBeNull();
        expect(
          failed.container.querySelector(
            '[data-testid="sidebar-account-menu-item-ai-credits-balance"]',
          ),
        ).toBeNull();
      } finally {
        failed.unmount();
      }
    });

    it('offers a guest sign-in and no AI Credits row', async () => {
      const { container, unmount } = await renderFreeAccessMenu({
        account: makeAccount({
          hasApiKey: true,
          authMode: 'guest',
          credentialSource: 'guest',
          account: {
            id: 'guest_1',
            name: 'Guest',
            email: 'guest+1@guest.canopy.invalid',
            role: 'DEVELOPER',
          },
        }),
      });
      try {
        openMenu(container);
        expect(
          container.querySelector(
            '[data-testid="sidebar-account-menu-item-ai-credits"]',
          ),
        ).toBeNull();
        expect(
          container.querySelector(
            '[data-testid="sidebar-account-menu-item-sign-in-out"]',
          )?.textContent,
        ).toBe(GUEST_SIGN_IN_CTA_LABEL);
      } finally {
        unmount();
      }
    });

    it('keeps the plan header and no AI Credits row without free access', async () => {
      const { container, unmount } = await renderFreeAccessMenu({
        entitlements: resolvedEntitlements({
          source: 'subscription',
          plan: { key: 'individual', displayName: 'Pro' },
          trial: null,
        }),
      });
      try {
        openMenu(container);
        expect(
          container.querySelector(
            '[data-testid="sidebar-account-menu-subscription-header"]',
          ),
        ).not.toBeNull();
        expect(
          container.querySelector(
            '[data-testid="sidebar-account-menu-item-ai-credits"]',
          ),
        ).toBeNull();
      } finally {
        unmount();
      }
    });
  });

  it('opens the account billing page from the menu for a non-org user', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements({
          source: 'subscription',
          plan: { key: 'individual', displayName: 'Pro' },
          trial: null,
        }),
        baseUrl: 'https://cloud.example.com',
      },
    );
    try {
      openMenu(container);
      const billing = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-menu-item-billing"]',
      );
      await act(async () => {
        billing?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
        '/account/billing',
      );
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('opens pricing for a trial account even when the user manages org billing', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements({
          billingManageableOrg: { id: 'org_42', name: 'Acme' },
        }),
        baseUrl: 'https://cloud.example.com',
      },
    );
    try {
      openMenu(container);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-account-menu-item-billing"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith('/pricing');
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('opens personal trial conversion directly with matching copy and intent', async () => {
    const endsAt = new Date(Date.now() + DAY_MS * 12).toISOString();
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements({
          billingPresentation: {
            plan: { key: 'individual', displayName: 'Pro' },
            owner: { type: 'user' },
            lifecycle: 'trial',
            trialEndsAt: endsAt,
            action: 'subscribe',
          },
        }),
      },
    );
    try {
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-subscription-header"]',
        )?.textContent,
      ).toContain('ProTrial');
      const cta = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-menu-item-billing"]',
      );
      expect(cta?.textContent).toContain('Subscribe to Pro');
      // The upgrade glyph is the app icon set's arrow, like every other
      // item in this menu, not a hand-drawn path.
      expect(cta?.querySelector('svg[data-app-icon="true"]')).not.toBeNull();
      await act(async () => {
        cta?.click();
        await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
        '/account/billing?plan=individual',
      );
    } finally {
      unmount();
    }
  });

  it('binds a Business trial to its exact organization and owner action', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements({
          billingManageableOrg: { id: 'wrong-org', name: 'Wrong' },
          billingPresentation: {
            plan: { key: 'business', displayName: 'Business' },
            owner: { type: 'organization', id: 'org_exact', name: 'Acme' },
            lifecycle: 'trial',
            trialEndsAt: new Date(Date.now() + DAY_MS * 7).toISOString(),
            action: 'subscribe',
          },
        }),
      },
    );
    try {
      openMenu(container);
      const cta = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-menu-item-billing"]',
      );
      expect(cta?.textContent).toContain('Subscribe to Business');
      await act(async () => {
        cta?.click();
        await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
        '/organization/org_exact/settings?tab=billing&plan=business',
      );
    } finally {
      unmount();
    }
  });

  it('lets an organization admin view billing without a purchase intent', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements({
          billingPresentation: {
            plan: { key: 'business', displayName: 'Business' },
            owner: { type: 'organization', id: 'org_exact', name: 'Acme' },
            lifecycle: 'trial',
            trialEndsAt: new Date(Date.now() + DAY_MS * 7).toISOString(),
            action: 'view',
          },
        }),
      },
    );
    try {
      openMenu(container);
      const cta = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-menu-item-billing"]',
      );
      expect(cta?.textContent).toContain('View organization billing');
      await act(async () => {
        cta?.click();
        await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
        '/organization/org_exact/settings?tab=billing',
      );
    } finally {
      unmount();
    }
  });

  it('opens pricing from the menu for a free account', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements({
          source: 'none',
          plan: null,
          trial: null,
        }),
        baseUrl: 'https://cloud.example.com',
      },
    );
    try {
      openMenu(container);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-account-menu-item-billing"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith('/pricing');
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('falls back to the plain pricing page when the upgrade hand-off rejects', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements(),
        baseUrl: 'https://cloud.example.com',
      },
    );
    openAuthenticatedPortalPage.mockRejectedValue(new Error('unavailable'));
    try {
      openMenu(container);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-account-menu-item-billing"]',
          )
          ?.click();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });
      expect(openExternal).toHaveBeenCalledWith({
        url: 'https://cloud.example.com/pricing',
      });
    } finally {
      unmount();
    }
  });

  it('deep-links a paid billing-manageable org owner to org billing', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements({
          source: 'subscription',
          plan: { key: 'business', displayName: 'Business' },
          trial: null,
          billingManageableOrg: { id: 'org_42', name: 'Acme' },
        }),
      },
    );
    try {
      openMenu(container);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-account-menu-item-billing"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
        '/organization/org_42/settings?tab=billing',
      );
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('shows a trial pill, countdown, and legacy Upgrade CTA for an older-server trial', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount, entitlements: resolvedEntitlements() },
    );
    try {
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-subscription-header"]',
        )?.textContent,
      ).toBe('BusinessTrial12 days left');
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-subscription-header"]',
        )?.textContent,
      ).toContain('Trial');
      const cta = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-menu-item-billing"]',
      );
      expect(cta?.textContent).toContain('Upgrade');
    } finally {
      unmount();
    }
  });

  it('labels the menu billing CTA "Manage plan" for a paid subscription', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        entitlements: resolvedEntitlements({
          source: 'subscription',
          plan: { key: 'pro', displayName: 'Pro' },
          trial: null,
        }),
      },
    );
    try {
      openMenu(container);
      const cta = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-account-menu-item-billing"]',
      );
      expect(cta?.textContent).toContain('Manage plan');
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-subscription-header"]',
        )?.textContent,
      ).toContain('Pro');
    } finally {
      unmount();
    }
  });

  it('announces the guest name but never surfaces the synthetic email (CAN-936)', async () => {
    const guestAccount = makeAccount({
      hasApiKey: true,
      credentialSource: 'guest',
      authMode: 'guest',
      account: {
        id: 'guest_1',
        name: 'Guest',
        email:
          'guest+32bce771-85a6-4535-b0c3-15eab9be71e1@guest.canopy.invalid',
        role: 'DEVELOPER',
      },
    });
    const { container, unmount } = await renderMenu(
      {},
      { account: guestAccount },
    );
    try {
      expect(
        accessibleLabel(
          container.querySelector('[data-testid="sidebar-account-row"]'),
        ),
      ).toBe('Guest');
      expect(container.textContent).toContain('Guest');
      expect(
        container.querySelector('[data-testid="sidebar-account-initials"]')
          ?.textContent,
      ).toBe('G');
      expect(container.textContent).not.toContain('guest.canopy.invalid');
    } finally {
      unmount();
    }
  });
});

/**
 * The sidebar banner is the ONLY recovery entry point in a guest-mode build or
 * with the identity gate off: `guestConsentSatisfiesGate` short-circuits
 * `cloudGateSatisfied`, so the sign-in wall never renders and the Settings tile
 * is never reached automatically — while `isModelBlockedByStoredPolicy` refuses
 * every non-Ollama model with nothing on screen pointing at the cause.
 */
describe('SidebarAccountMenu — cloud account recovery banner', () => {
  const unreadableAccount = makeAccount({ read: 'error' });

  afterEach(() => {
    mockForeignProjection = { epoch: '', sequence: 0, groups: [] };
    mockUpdateState = { phase: 'idle' };
    useNavigationStore.setState({
      settingsOpen: false,
      settingsInitialSection: undefined,
      settingsScrollTarget: undefined,
    });
  });

  it('is absent for a readable account', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount({ read: 'ok' }) },
    );
    try {
      expect(
        container.querySelector(
          '[data-testid="sidebar-cloud-account-recovery"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('renders above the update prompt when both qualify', async () => {
    mockForeignProjection = { epoch: '', sequence: 0, groups: [] };
    mockUpdateState = {
      phase: 'available',
      info: { version: '9.9.9' },
    } as UpdateState;
    const { container, unmount } = await renderMenu(
      {},
      { account: unreadableAccount },
    );
    try {
      const banner = container.querySelector(
        '[data-testid="sidebar-cloud-account-recovery"]',
      );
      const update = container.querySelector('[data-testid="update-prompt"]');
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain('Sign-in needs repair');
      expect(update).not.toBeNull();
      // `DOCUMENT_POSITION_FOLLOWING` on the update prompt means the recovery
      // banner precedes it in the stack.
      expect(
        banner?.compareDocumentPosition(update as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      unmount();
    }
  });

  it('opens the Settings recovery notice without mutating anything', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: unreadableAccount },
    );
    try {
      act(() => {
        container
          .querySelector('[data-testid="sidebar-cloud-account-recovery"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const navigation = useNavigationStore.getState();
      expect(navigation.settingsOpen).toBe(true);
      expect(navigation.settingsInitialSection).toBe('account');
      expect(navigation.settingsScrollTarget).toBe(
        'cloud-account-recovery-notice',
      );
      expect(disconnectAccount).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('disappears once a later read reports a readable account', async () => {
    const { container, unmount } = await renderMenu(
      {},
      {
        // Two consumers read the account per refresh (this menu and
        // `useSubscriptionStatus`), so each round needs a pair.
        accountQueue: [
          unreadableAccount,
          unreadableAccount,
          makeAccount({ read: 'ok' }),
          makeAccount({ read: 'ok' }),
        ],
      },
    );
    try {
      await act(async () => {
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="sidebar-cloud-account-recovery"]',
        ),
      ).not.toBeNull();
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="sidebar-cloud-account-recovery"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });
});

describe('SidebarAccountMenu workspace context', () => {
  beforeEach(() => {
    setBillingFlag(true);
    useObservabilityStore.setState({
      usage: { updatedAt: new Date(0).toISOString(), providers: [] },
    });
    useCloudConnectGateStore.setState({ pending: null });
    mockForeignProjection = { epoch: '', sequence: 0, groups: [] };
    mockUpdateState = { phase: 'idle' };
    seedWorkspaceContext([{ id: ORG_A, name: 'Acme' }]);
  });

  afterEach(() => {
    setOrgProjectsFlag(false);
    seedWorkspaceContext([]);
  });

  it('does not render for an unrelated workspace-context revision update', async (): Promise<void> => {
    setOrgProjectsFlag(true);
    const { unmount } = await renderMenu({}, { account: signedInAccount });
    try {
      mockMenuRender.mockClear();
      act((): void => {
        useWorkspaceContextStore.setState(({ state }) => ({
          state: { ...state, revision: state.revision + 1 },
        }));
      });
      expect(mockMenuRender).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it.each([
    ['the org-projects flag is off', false, [{ id: ORG_A, name: 'Acme' }]],
    ['the account has no organizations', true, []],
    ['organizations are available', true, [{ id: ORG_A, name: 'Acme' }]],
  ])(
    'leaves no switcher in the footer when %s',
    async (_label, enabled, organizations): Promise<void> => {
      setOrgProjectsFlag(enabled);
      seedWorkspaceContext(organizations);
      const { container, unmount } = await renderMenu(
        {},
        { account: signedInAccount },
      );
      try {
        const footer = container.querySelector(
          '[data-testid="sidebar-account-footer"]',
        );
        expect(
          footer?.querySelector('[data-testid="sidebar-context-row"]'),
        ).toBeNull();
        // The account row is the footer's only row.
        expect(footer?.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(
          1,
        );
      } finally {
        unmount();
      }
    },
  );
});

describe('SidebarAccountMenu sync paused status (CAN-3512)', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

  beforeEach(() => {
    setBillingFlag(true);
    useObservabilityStore.setState({
      usage: { updatedAt: new Date(0).toISOString(), providers: [] },
    });
    mockForeignProjection = { epoch: '', sequence: 0, groups: [] };
    mockUpdateState = { phase: 'idle' };
    telemetrySyncStatusListener = null;
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  function pausedRow(root: ParentNode): HTMLElement | null {
    return root.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-menu-sync-paused"]',
    );
  }

  it('shows a quiet Sync paused line while the queue is stalled', async (): Promise<void> => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: signedInAccount,
        telemetrySyncStatus: makeTelemetrySyncStatus({
          pendingCount: 12,
          pausedReason: 'queue-stalled',
        }),
      },
    );
    openMenu(container);

    const row = pausedRow(container);
    expect(row?.textContent).toBe('Sync paused');
    expect(row?.getAttribute('role')).toBe('status');
    unmount();
  });

  it('follows live status events in both directions', async (): Promise<void> => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    openMenu(container);
    expect(pausedRow(container)).toBeNull();

    act(() => {
      telemetrySyncStatusListener?.(
        makeTelemetrySyncStatus({ pausedReason: 'queue-stalled' }),
      );
    });
    expect(pausedRow(container)?.textContent).toBe('Sync paused');

    act(() => {
      telemetrySyncStatusListener?.(makeTelemetrySyncStatus());
    });
    expect(pausedRow(container)).toBeNull();
    unmount();
  });

  it('stays hidden while signed out', async (): Promise<void> => {
    const { container, unmount } = await renderMenu(
      {},
      {
        telemetrySyncStatus: makeTelemetrySyncStatus({
          pausedReason: 'queue-stalled',
        }),
      },
    );
    openMenu(container);
    expect(pausedRow(container)).toBeNull();
    unmount();
  });
});

describe('SidebarAccountMenu personal menu across access modes (CAN-4055)', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

  const nearLimitUsage = (usedPercent: number): void => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: new Date(0).toISOString(),
        providers: [
          {
            provider: 'claude',
            authState: 'authenticated',
            hasRemainingLimits: true,
            rateLimits: [{ primary: { usedPercent } }],
          },
        ],
      },
    });
  };

  const accountWithAvatar = makeAccount({
    hasApiKey: true,
    account: {
      id: 'acct_header',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'DEVELOPER',
      image: 'https://example.com/ada.png',
    },
  });

  const stalled = makeTelemetrySyncStatus({
    pendingCount: 12,
    pausedReason: 'queue-stalled',
  });

  function tokens(testId: string): string[] {
    return (
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
        ?.className ?? ''
    ).split(/\s+/);
  }

  beforeEach(() => {
    setBillingFlag(true);
    useObservabilityStore.setState({
      usage: { updatedAt: new Date(0).toISOString(), providers: [] },
    });
    useCloudConnectGateStore.setState({ pending: null });
    mockForeignProjection = { epoch: '', sequence: 0, groups: [] };
    mockUpdateState = { phase: 'idle' };
    telemetrySyncStatusListener = null;
    setOrgProjectsFlag(true);
    seedWorkspaceContext([{ id: ORG_A, name: 'Acme' }]);
  });

  afterEach(() => {
    setTestEarlyAccessFeatures({ enabled: false });
    setOrgProjectsFlag(false);
    seedWorkspaceContext([]);
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it.each([
    ['normal access', false],
    ['early access', true],
  ])(
    'lists the person, Usage, Sync paused, then Sign out under %s, in any context',
    async (_label, earlyAccess): Promise<void> => {
      setTestEarlyAccessFeatures({ enabled: earlyAccess });
      useWorkspaceContextStore.setState(({ state }) => ({
        state: {
          ...state,
          context: { kind: 'organization', organizationId: ORG_A },
        },
      }));
      const { container, unmount } = await renderMenu(
        {},
        { account: accountWithAvatar, telemetrySyncStatus: stalled },
      );
      try {
        // The account row names the person, never the organization.
        expect(
          container.querySelector('[data-testid="sidebar-account-identity"]')
            ?.textContent,
        ).toBe('Ada Lovelace');
        openMenu(container);
        expect(menuShape(container)).toEqual([
          'sidebar-account-menu-header-identity',
          '---',
          'sidebar-account-menu-item-usage',
          'sidebar-account-menu-item-remote-control',
          'sidebar-account-menu-sync-paused',
          '---',
          'sidebar-account-menu-item-sign-in-out',
        ]);
        expect(
          document
            .querySelector(
              '[data-testid="sidebar-account-menu-header-identity"] [data-testid="sidebar-person-avatar"]',
            )
            ?.getAttribute('src'),
        ).toBe('https://example.com/ada.png');
        for (const removed of [
          'sidebar-account-menu-item-settings',
          'sidebar-account-menu-item-feedback',
          'sidebar-context-option-personal',
          'sidebar-account-menu-account-options',
        ]) {
          expect(
            document.querySelector(`[data-testid="${removed}"]`),
          ).toBeNull();
        }
      } finally {
        unmount();
      }
    },
  );

  it('keeps the plan rows inside the identity block with one divider after them', async (): Promise<void> => {
    const { container, unmount } = await renderMenu(
      {},
      {
        account: accountWithAvatar,
        entitlements: resolvedEntitlements(),
      },
    );
    try {
      openMenu(container);
      expect(menuShape(container)).toEqual([
        'sidebar-account-menu-header-identity',
        'sidebar-account-menu-subscription-header',
        'sidebar-account-menu-item-billing',
        '---',
        'sidebar-account-menu-item-usage',
        'sidebar-account-menu-item-remote-control',
        '---',
        'sidebar-account-menu-item-sign-in-out',
      ]);
    } finally {
      unmount();
    }
  });

  it('draws Sync paused as an aligned status row that explains itself', async (): Promise<void> => {
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount, telemetrySyncStatus: stalled },
    );
    try {
      openMenu(container);
      const row = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-menu-sync-paused"]',
      );
      expect(row?.getAttribute('role')).toBe('status');
      // Not an action: no button and no menu item to arrow onto.
      expect(row?.tagName).not.toBe('BUTTON');
      expect(row?.getAttribute('role')).not.toMatch(/^menuitem/);
      // The action rows' geometry, type, and ink, with the icon column.
      const usageTokens = tokens('sidebar-account-menu-item-usage');
      for (const token of ['h-8', 'w-full', 'gap-2', 'px-2', 'text-xs']) {
        expect(usageTokens).toContain(token);
        expect(row?.className.split(/\s+/)).toContain(token);
      }
      expect(row?.className.split(/\s+/)).toContain('fg-primary');
      expect(
        row?.querySelector('[data-testid="sidebar-account-menu-sync-icon"]')
          ?.parentElement?.className,
      ).toContain('h-4 w-4 shrink-0');
      expect(
        row?.querySelector('[data-testid="sidebar-account-menu-sync-label"]')
          ?.textContent,
      ).toBe('Sync paused');
      // Status on the right, in Usage's dot frame.
      const dot = row?.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-sync-paused-dot"]',
      );
      expect(dot?.className).toContain('h-1.5 w-1.5 rounded-full');
      expect(dot?.parentElement?.className).toContain(
        'ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center',
      );

      const explanation = `Activity you share hasn't reached ${brandText.appName} in over 6 hours. It's saved on this device and will upload automatically. If this continues, check your internet connection or open Settings → Privacy.`;
      // Assistive tech reads the explanation without hovering.
      const describedBy = row?.getAttribute('aria-describedby') ?? '';
      expect(
        describedBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent)
          .filter(Boolean),
      ).toContain(explanation);
      // Hovering shows it as a tooltip.
      act(() => {
        row?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        explanation,
      );
    } finally {
      unmount();
    }
  });

  it.each([
    ['nearing', 85, 'bg-warning', 'fg-warning'],
    ['at', 99, 'bg-destructive', 'fg-destructive'],
  ])(
    'leaves the name and Usage row in their own ink %s the limit under early access, with only the dot',
    async (_label, usedPercent, dotClass, ink): Promise<void> => {
      setTestEarlyAccessFeatures({ enabled: true });
      nearLimitUsage(usedPercent);
      const { container, unmount } = await renderMenu(
        {},
        { account: accountWithAvatar },
      );
      try {
        expect(tokens('sidebar-account-identity')).not.toContain(ink);
        // The avatar keeps its status dot.
        expect(tokens('sidebar-account-attention-dot')).toContain(dotClass);
        openMenu(container);
        const usage = tokens('sidebar-account-menu-item-usage');
        expect(usage).not.toContain(ink);
        expect(usage).toContain('fg-primary');
        expect(tokens('sidebar-account-usage-alert-dot')).toContain(dotClass);
      } finally {
        unmount();
      }
    },
  );

  it('keeps the name and Usage row neutral under normal access', async (): Promise<void> => {
    nearLimitUsage(85);
    const { container, unmount } = await renderMenu(
      {},
      { account: accountWithAvatar },
    );
    try {
      expect(tokens('sidebar-account-identity')).not.toContain('fg-warning');
      openMenu(container);
      expect(tokens('sidebar-account-menu-item-usage')).not.toContain(
        'fg-warning',
      );
    } finally {
      unmount();
    }
  });
});

describe('SidebarAccountMenu Remote Control (CAN-3659)', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

  beforeEach(() => {
    setBillingFlag(true);
    useObservabilityStore.setState({
      usage: { updatedAt: new Date(0).toISOString(), providers: [] },
    });
    mockForeignProjection = { epoch: '', sequence: 0, groups: [] };
    mockUpdateState = { phase: 'idle' };
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  const guest = makeAccount({
    hasApiKey: true,
    credentialSource: 'guest',
    account: {
      id: 'guest_1',
      name: 'Guest',
      email: 'guest+abc@example.com',
      role: 'DEVELOPER',
    },
  });

  function statusSubtitle(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-remote-control-subtitle"]',
    );
  }

  function rowLabel(container: HTMLElement): string | null {
    return accessibleLabel(
      container.querySelector('[data-testid="sidebar-account-row"]'),
    );
  }

  function listItemClassName(container: HTMLElement): string {
    return (
      container.querySelector('[data-testid="sidebar-account-list-item"]')
        ?.className ?? ''
    );
  }

  it('reports an active session as the second line', async () => {
    seedPortal(PORTAL_ACTIVE);
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount, entitlements: resolvedEntitlements() },
    );
    try {
      const subtitle = statusSubtitle(container);
      expect(subtitle?.textContent).toBe('Remote control active');
      expect(subtitle?.getAttribute('data-status')).toBe('active');
      expect(listItemClassName(container)).toMatch(/(^|\s)h-10(\s|$)/);
      expect(rowLabel(container)).toBe('Ada Lovelace, Remote control active');
    } finally {
      unmount();
    }
  });

  it('marks a reconnecting session with the ping and names it', async () => {
    seedPortal(PORTAL_RECONNECTING);
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      const subtitle = statusSubtitle(container);
      expect(subtitle?.getAttribute('data-status')).toBe('reconnecting');
      expect(subtitle?.textContent).toBe('Remote control reconnecting');
      expect(
        subtitle?.querySelector(
          '[data-testid="sidebar-account-remote-control-ping"]',
        ),
      ).not.toBeNull();
      expect(rowLabel(container)).toBe(
        'Ada Lovelace, Remote control reconnecting',
      );
    } finally {
      unmount();
    }
  });

  it('reports a dropped session in the failed ink', async () => {
    seedPortal(PORTAL_DISCONNECTED);
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      const subtitle = statusSubtitle(container);
      expect(subtitle?.textContent).toBe('Remote control disconnected');
      expect(subtitle?.className).toContain('fg-destructive-strong');
      expect(rowLabel(container)).toBe(
        'Ada Lovelace, Remote control disconnected',
      );
    } finally {
      unmount();
    }
  });

  it('has no second line, not a stale active snapshot, once the flag is off', async () => {
    seedPortal(PORTAL_ACTIVE);
    const { container, unmount } = await renderMenu(
      { canopyPortalEnabled: false },
      { account: signedInAccount },
    );
    try {
      expect(statusSubtitle(container)).toBeNull();
      expect(listItemClassName(container)).toMatch(/(^|\s)h-8(\s|$)/);
      expect(rowLabel(container)).toBe('Ada Lovelace');
    } finally {
      unmount();
    }
  });

  it('has no second line for a guest while Remote Control is off', async () => {
    const { container, unmount } = await renderMenu({}, { account: guest });
    try {
      expect(statusSubtitle(container)).toBeNull();
      expect(listItemClassName(container)).toContain('h-8');
    } finally {
      unmount();
    }
  });

  it('still reports the worker state for a guest', async () => {
    seedPortal(PORTAL_ACTIVE);
    const { container, unmount } = await renderMenu({}, { account: guest });
    try {
      expect(statusSubtitle(container)?.textContent).toBe(
        'Remote control active',
      );
      expect(listItemClassName(container)).toMatch(/(^|\s)h-10(\s|$)/);
    } finally {
      unmount();
    }
  });

  it('has no second line when signed out', async () => {
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount() },
    );
    try {
      expect(statusSubtitle(container)).toBeNull();
      expect(listItemClassName(container)).toContain('h-8');
    } finally {
      unmount();
    }
  });

  // The signed-out trigger is named "Sign in", so a status line there would
  // be shown but never announced.
  it('has no status line when signed out, even with a stale snapshot', async () => {
    seedPortal(PORTAL_ACTIVE);
    const { container, unmount } = await renderMenu(
      {},
      { account: makeAccount() },
    );
    try {
      expect(statusSubtitle(container)).toBeNull();
      expect(listItemClassName(container)).toContain('h-8');
    } finally {
      unmount();
    }
  });

  it('keeps the attention state after the status in the row name', async () => {
    seedPortal(PORTAL_ACTIVE);
    useObservabilityStore.setState({
      usage: {
        updatedAt: new Date(0).toISOString(),
        providers: [
          {
            provider: 'claude',
            authState: 'authenticated',
            hasRemainingLimits: true,
            rateLimits: [{ primary: { usedPercent: 85 } }],
          },
        ],
      },
    });
    const { container, unmount } = await renderMenu(
      {},
      { account: signedInAccount },
    );
    try {
      expect(rowLabel(container)).toBe(
        'Ada Lovelace, Remote control active, usage is nearing its limit',
      );
    } finally {
      unmount();
    }
  });

  it.each([
    ['signed out', makeAccount()],
    ['a guest', guest],
  ])(
    'lists Remote Control in the menu for %s while the flag is on',
    async (_label, account) => {
      const { container, unmount } = await renderMenu({}, { account });
      try {
        openMenu(container);
        expect(
          container.querySelector(
            '[data-testid="sidebar-account-menu-item-remote-control"]',
          ),
        ).not.toBeNull();
      } finally {
        unmount();
      }
    },
  );

  it('leaves Remote Control out of the menu when the flag is off', async () => {
    const { container, unmount } = await renderMenu(
      { canopyPortalEnabled: false },
      { account: signedInAccount },
    );
    try {
      openMenu(container);
      expect(
        container.querySelector(
          '[data-testid="sidebar-account-menu-item-remote-control"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('opens the Remote Control dialog from a plain menu row and closes the menu', async () => {
    seedPortal(PORTAL_DISCONNECTED);
    const onCanopyPortalClick = jest.fn();
    const { container, unmount } = await renderMenu(
      { onCanopyPortalClick },
      { account: signedInAccount },
    );
    try {
      openMenu(container);
      const item = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-account-menu-item-remote-control"]',
      );
      expect(item?.textContent).toBe('Remote Control');
      // The row carries the status; the menu item stays a plain action.
      expect(item?.querySelector('[data-status]')).toBeNull();
      expect(
        item?.querySelector(
          '[data-testid="sidebar-account-remote-control-dot"]',
        ),
      ).toBeNull();
      clickTestId(container, 'sidebar-account-menu-item-remote-control');
      expect(onCanopyPortalClick).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('[data-testid="sidebar-account-menu"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });
});

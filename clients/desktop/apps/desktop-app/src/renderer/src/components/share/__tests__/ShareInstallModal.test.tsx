/**
 * @jest-environment jsdom
 *
 * CAN-3710: every shared resource installs through one review with one
 * primary action. A finished install closes the review and lands on the
 * result; a failure keeps it open for a retry; a request that arrives while
 * the review writes waits for the write to settle.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DeepLinkShareOpenEvent,
  PublicShareSnapshot,
} from '@canopy/desktop-shared/types';
import type {
  PublicShareInstallResult,
  PublicShareInstalledTarget,
  PublicShareLanding,
  PublicShareLandingOptions,
} from '../usePublicShareLanding';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SKILL_ID = '4f4f51c1-a72b-4e12-9320-a038b90189f0';

type SkillSnapshot = Extract<PublicShareSnapshot, { entity: 'skill' }>;

const skillSnapshot: SkillSnapshot = {
  entity: 'skill',
  externalId: SKILL_ID,
  name: 'release-notes',
  description: '**Writes** release notes.',
  rawSkill: '---\nname: release-notes\n---\n# Release notes',
  contentHash: 'c'.repeat(64),
  dependencies: [],
  authorUsername: 'morgan',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
let mockSnapshot: PublicShareSnapshot = skillSnapshot;
let mockResolving = false;
let mockResolveError:
  | false
  | Extract<PublicShareLanding['state'], { phase: 'error' }>['reason'] = false;
const mockRetryResolve = jest.fn();
const mockSignIn = jest.fn();
const mockSwitchAccount = jest.fn();

let mockInstalled: PublicShareInstalledTarget | null = null;
let mockInstalling = false;
let mockUninstalling = false;
let mockInstallError = '';
let mockVerificationError = '';
let mockNeedsRefresh = false;
const mockRefresh = jest.fn();
const mockInstall = jest.fn<Promise<PublicShareInstallResult | null>, []>();
const mockManage = jest.fn();
const mockUninstall = jest.fn(() => Promise.resolve(true));
const mockLandingOptions: Array<PublicShareLandingOptions | undefined> = [];

jest.mock('../usePublicShareLanding', () => ({
  usePublicShareLanding: (
    _link: DeepLinkShareOpenEvent,
    options?: PublicShareLandingOptions,
  ): Partial<PublicShareLanding> => {
    mockLandingOptions.push(options);
    return {
      state: mockResolving
        ? { phase: 'loading' }
        : mockResolveError
          ? { phase: 'error', reason: mockResolveError }
          : { phase: 'ready', snapshot: mockSnapshot },
      snapshot: mockResolving || mockResolveError ? null : mockSnapshot,
      detecting: false,
      verificationError: mockVerificationError,
      needsRefresh: mockNeedsRefresh,
      refresh: mockRefresh,
      installed: mockInstalled,
      installing: mockInstalling,
      installError: mockInstallError,
      installProgress: '',
      installStatus: '',
      uninstalling: mockUninstalling,
      agentReadinessLoading: false,
      install: mockInstall,
      manage: mockManage,
      uninstall: mockUninstall,
      tryNow: jest.fn(),
      installReview: null,
      openingInstallReview: false,
      closeInstallReview: jest.fn(),
      completeInstallReview: jest.fn(),
      retryResolve: mockRetryResolve,
      signIn: mockSignIn,
      switchAccount: mockSwitchAccount,
    };
  },
}));
jest.mock('@/hooks/useAutomationScope', () => ({
  useAutomationScope: (): { projectsInContext: [] } => ({
    projectsInContext: [],
  }),
}));
jest.mock('@/components/automations/InstallSharedAutomationModal', () => ({
  InstallSharedAutomationModal: (): JSX.Element => <div />,
}));
const mockAddToast = jest.fn();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof mockAddToast } => ({
      addToast: mockAddToast,
    }),
  },
}));

import { useNavigationStore } from '@/stores/navigationStore';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { ResourceContextProvider } from '@canopy/ui-app/capability';
import { ShareInstallModalHost } from '../ShareInstallModal';

const LINK: DeepLinkShareOpenEvent = {
  entity: 'skill',
  externalId: SKILL_ID,
  intent: 'install',
};

let container: HTMLDivElement;
let root: Root;
let mockPersonalOrganizationId: string | null = null;
let mockContext: WorkspaceContext | undefined;

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function renderHost(): void {
  act(() => {
    root.render(
      <ResourceContextProvider
        context={mockContext}
        personalOrganizationId={mockPersonalOrganizationId}
      >
        <ShareInstallModalHost />
      </ResourceContextProvider>,
    );
  });
}

function open(
  link: DeepLinkShareOpenEvent = LINK,
  origin: 'deep-link' | 'in-app' = 'deep-link',
): void {
  act(() => {
    useNavigationStore.getState().openShareInstall(link, origin);
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const INSTALLED_SKILL: PublicShareInstallResult = {
  target: {
    entity: 'skill',
    sourceId: 'custom:app',
    skillName: 'release-notes',
  },
  status: '',
  partial: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockInstalled = null;
  mockInstalling = false;
  mockUninstalling = false;
  mockInstallError = '';
  mockVerificationError = '';
  mockNeedsRefresh = false;
  mockLandingOptions.length = 0;
  mockSnapshot = skillSnapshot;
  mockResolveError = false;
  mockResolving = false;
  mockContext = undefined;
  mockPersonalOrganizationId = null;
  useNavigationStore.setState({
    activePage: 'overview',
    pendingShareInstall: undefined,
    heldShareInstall: undefined,
    shareInstallBusy: false,
    pendingSkillViewer: undefined,
    settingsOpen: false,
  });
  useCloudConnectGateStore.setState({ pending: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('ShareInstallModal', () => {
  it('describes the item and offers one primary, with nothing installed yet', () => {
    renderHost();
    open();

    const dialog = byTestId('deep-link-share-landing');
    expect(dialog?.textContent).toContain('release-notes');
    expect(byTestId('share-install-type-label')?.textContent).toBe('Skill');
    // Markdown is flattened: no raw `**` reaches the reader.
    expect(byTestId('share-install-description')?.textContent).toBe(
      'Writes release notes.',
    );
    expect(byTestId('deep-link-share-install')?.textContent).toBe('Install');
    const labels = Array.from(dialog?.querySelectorAll('button') ?? []).map(
      (button) => button.textContent,
    );
    expect(labels).not.toContain('Cancel');
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('falls back to the per-type description when the item has none', () => {
    mockSnapshot = { ...skillSnapshot, description: '', rawSkill: '# Notes' };
    renderHost();
    open();
    expect(byTestId('share-install-description')?.textContent).toBe(
      'A skill your agents can use when it fits the task.',
    );
  });

  it('closing writes nothing', () => {
    renderHost();
    open();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('installs on one click, closes, and lands on the result with a notice', async () => {
    mockInstall.mockResolvedValue(INSTALLED_SKILL);
    renderHost();
    open();

    await act(async () => {
      byTestId('deep-link-share-install')?.click();
      await Promise.resolve();
    });

    expect(mockInstall).toHaveBeenCalledTimes(1);
    const state = useNavigationStore.getState();
    expect(state.pendingShareInstall).toBeUndefined();
    expect(state.activePage).toBe('plugins');
    expect(state.pendingSkillViewer).toEqual({
      kind: 'installed',
      sourceId: 'custom:app',
      skillName: 'release-notes',
    });
    expect(mockAddToast).toHaveBeenCalledWith('Skill installed.', 'success');
  });

  it('keeps the review open after a failed install so the same primary retries', async () => {
    mockInstall.mockResolvedValue(null);
    renderHost();
    open();

    await act(async () => {
      byTestId('deep-link-share-install')?.click();
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().pendingShareInstall?.link).toEqual(
      LINK,
    );
    expect(useNavigationStore.getState().activePage).toBe('overview');
    expect(mockAddToast).not.toHaveBeenCalled();
    expect(byTestId('deep-link-share-install')?.textContent).toBe('Install');
  });

  it('shows an install failure as the blocker line', () => {
    mockInstallError = 'digest mismatch';
    renderHost();
    open();
    expect(byTestId('share-install-blocker')?.textContent).toBe(
      'digest mismatch',
    );
  });

  it('holds a newer request until the write settles, then shows it', async () => {
    const pending = deferred<PublicShareInstallResult | null>();
    mockInstall.mockReturnValue(pending.promise);
    renderHost();
    open();

    act(() => {
      byTestId('deep-link-share-install')?.click();
    });
    const newer: DeepLinkShareOpenEvent = {
      entity: 'skill',
      externalId: '9a9a51c1-a72b-4e12-9320-a038b90189f0',
      intent: 'install',
    };
    open(newer, 'in-app');
    // The write in flight is never unmounted.
    expect(useNavigationStore.getState().pendingShareInstall?.link).toEqual(
      LINK,
    );
    // Closing is inert while writing.
    act(() => {
      useNavigationStore.getState().consumeShareInstall();
    });
    expect(useNavigationStore.getState().pendingShareInstall?.link).toEqual(
      LINK,
    );

    await act(async () => {
      pending.resolve(INSTALLED_SKILL);
      await Promise.resolve();
    });

    const state = useNavigationStore.getState();
    expect(state.pendingShareInstall).toEqual({
      link: newer,
      origin: 'in-app',
    });
    expect(state.heldShareInstall).toBeUndefined();
    expect(state.shareInstallBusy).toBe(false);
    // The finished install still landed.
    expect(mockAddToast).toHaveBeenCalledWith('Skill installed.', 'success');
  });

  it('keeps holding when a second click lands before the busy render', async () => {
    const pending = deferred<PublicShareInstallResult | null>();
    mockInstall.mockReturnValue(pending.promise);
    renderHost();
    open();

    await act(async () => {
      byTestId('deep-link-share-install')?.click();
      byTestId('deep-link-share-install')?.click();
      await Promise.resolve();
    });
    const newer: DeepLinkShareOpenEvent = {
      entity: 'skill',
      externalId: '9a9a51c1-a72b-4e12-9320-a038b90189f0',
      intent: 'install',
    };
    open(newer, 'in-app');

    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().shareInstallBusy).toBe(true);
    expect(useNavigationStore.getState().pendingShareInstall?.link).toEqual(
      LINK,
    );

    await act(async () => {
      pending.resolve(INSTALLED_SKILL);
      await Promise.resolve();
    });
    expect(useNavigationStore.getState().pendingShareInstall?.link).toBe(newer);
  });

  it('still closes and lands when the same link repeats during the write', async () => {
    const pending = deferred<PublicShareInstallResult | null>();
    mockInstall.mockReturnValue(pending.promise);
    renderHost();
    open();
    act(() => {
      byTestId('deep-link-share-install')?.click();
    });
    // A second Install click on the web sends the identical link.
    open({ ...LINK }, 'deep-link');

    await act(async () => {
      pending.resolve(INSTALLED_SKILL);
      await Promise.resolve();
    });

    const state = useNavigationStore.getState();
    expect(state.pendingShareInstall).toBeUndefined();
    expect(state.heldShareInstall).toBeUndefined();
    expect(mockAddToast).toHaveBeenCalledWith('Skill installed.', 'success');
  });

  it('keeps a held try link for the same share, which is a different request', async () => {
    const pending = deferred<PublicShareInstallResult | null>();
    mockInstall.mockReturnValue(pending.promise);
    renderHost();
    open();
    act(() => {
      byTestId('deep-link-share-install')?.click();
    });
    open({ ...LINK, intent: 'try' }, 'deep-link');

    await act(async () => {
      pending.resolve(INSTALLED_SKILL);
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().pendingShareInstall?.link).toEqual({
      ...LINK,
      intent: 'try',
    });
  });

  it('reports the web handoff only for a deep link', () => {
    renderHost();
    open(LINK, 'deep-link');
    expect(mockLandingOptions.at(-1)?.reportHandoffEvents).toBe(true);

    act(() => {
      useNavigationStore.getState().consumeShareInstall();
    });
    open(LINK, 'in-app');
    expect(mockLandingOptions.at(-1)?.reportHandoffEvents).toBe(false);
  });

  it('stages Try instead of revealing for a try link from the web', async () => {
    mockInstall.mockResolvedValue(INSTALLED_SKILL);
    renderHost();
    open({ ...LINK, intent: 'try' });

    await act(async () => {
      byTestId('deep-link-share-install')?.click();
      await Promise.resolve();
    });

    // The review stays mounted so the landing's try effect can stage the
    // installed item; closing here would unmount it before it runs.
    expect(useNavigationStore.getState().pendingShareInstall).toBeDefined();
    expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
    expect(mockAddToast).not.toHaveBeenCalled();

    // Staging closes the review through the landing's auto-navigate.
    act(() => {
      mockLandingOptions.at(-1)?.onAutoNavigate?.();
    });
    expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
  });

  it('opens an installed item from its one primary', () => {
    mockInstalled = INSTALLED_SKILL.target;
    renderHost();
    open();

    expect(byTestId('deep-link-share-installed-status')?.textContent).toBe(
      'Installed as “release-notes”.',
    );
    const primary = byTestId('deep-link-share-open');
    expect(primary?.textContent).toBe('Open skill');
    act(() => {
      primary?.click();
    });
    const state = useNavigationStore.getState();
    expect(state.pendingShareInstall).toBeUndefined();
    expect(state.pendingSkillViewer).toEqual({
      kind: 'installed',
      sourceId: 'custom:app',
      skillName: 'release-notes',
    });
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  describe('a receipted skill copy that differs from the share (CAN-5307)', () => {
    const STALE_SKILL: PublicShareInstalledTarget = {
      entity: 'skill',
      sourceId: 'custom:app',
      skillName: 'release-notes',
      updateAvailable: true,
      replacement: {
        expectedLocalContentHash: 'a'.repeat(64),
        expectedSourceContentHash: 'c'.repeat(64),
        locallyEdited: false,
      },
    };
    const EDITED_SKILL: PublicShareInstalledTarget = {
      ...STALE_SKILL,
      replacement: {
        expectedLocalContentHash: 'a'.repeat(64),
        expectedSourceContentHash: 'c'.repeat(64),
        locallyEdited: true,
      },
    };

    it('offers Update, never Install, beside Open and Uninstall', () => {
      mockInstalled = STALE_SKILL;
      renderHost();
      open();

      expect(byTestId('deep-link-share-installed-status')?.textContent).toBe(
        'Installed as “release-notes”. An update is available.',
      );
      expect(byTestId('deep-link-share-update')?.textContent).toBe('Update');
      expect(byTestId('deep-link-share-install')).toBeNull();
      expect(byTestId('share-install-effect')).toBeNull();
      expect(byTestId('deep-link-share-kebab')).not.toBeNull();
    });

    it('updates an unedited copy on one click, with no confirmation', async () => {
      mockInstalled = STALE_SKILL;
      mockInstall.mockResolvedValue(INSTALLED_SKILL);
      renderHost();
      open();

      await act(async () => {
        byTestId('deep-link-share-update')?.click();
        await Promise.resolve();
      });

      expect(byTestId('deep-link-share-replace-dialog')).toBeNull();
      expect(mockInstall).toHaveBeenCalledTimes(1);
      expect(mockAddToast).toHaveBeenCalledWith('Skill updated.', 'success');
    });

    it('asks before replacing edits; cancelling writes nothing', () => {
      mockInstalled = EDITED_SKILL;
      renderHost();
      open();

      act(() => {
        byTestId('deep-link-share-update')?.click();
      });
      const dialog = byTestId('deep-link-share-replace-dialog');
      expect(dialog?.textContent).toContain('Replace your edits?');
      expect(dialog?.textContent).toContain('release-notes');
      act(() => {
        byTestId('deep-link-share-replace-cancel')?.click();
      });
      expect(byTestId('deep-link-share-replace-dialog')).toBeNull();
      expect(mockInstall).not.toHaveBeenCalled();
    });

    it('updates once after the replacement is confirmed', async () => {
      mockInstalled = EDITED_SKILL;
      mockInstall.mockResolvedValue(INSTALLED_SKILL);
      renderHost();
      open();

      act(() => {
        byTestId('deep-link-share-update')?.click();
      });
      await act(async () => {
        byTestId('deep-link-share-replace-confirm')?.click();
        byTestId('deep-link-share-replace-confirm')?.click();
        await Promise.resolve();
      });

      expect(mockInstall).toHaveBeenCalledTimes(1);
    });

    it('offers only a retry while the installed copy cannot be verified', () => {
      mockVerificationError =
        'Your installed copy of this skill could not be checked. Try again.';
      renderHost();
      open();

      expect(byTestId('deep-link-share-install')).toBeNull();
      expect(byTestId('deep-link-share-update')).toBeNull();
      expect(byTestId('share-install-effect')).toBeNull();
      expect(byTestId('deep-link-share-landing')?.textContent).toContain(
        mockVerificationError,
      );
      act(() => {
        byTestId('deep-link-share-retry')?.click();
      });
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockInstall).not.toHaveBeenCalled();
    });

    it('requires a fresh review after a conflict instead of retrying', () => {
      mockInstalled = STALE_SKILL;
      mockNeedsRefresh = true;
      mockInstallError =
        'Skill unavailable (local-conflict). Your installed skill changed.';
      renderHost();
      open();

      expect(byTestId('deep-link-share-update')).toBeNull();
      expect(byTestId('deep-link-share-retry')).not.toBeNull();
    });
  });

  it('cannot be closed while an uninstall is running', () => {
    mockInstalled = INSTALLED_SKILL.target;
    mockUninstalling = true;
    renderHost();
    open();

    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    );
    expect(close?.disabled).toBe(true);
    expect(byTestId('deep-link-share-kebab')?.hasAttribute('disabled')).toBe(
      true,
    );
    expect(byTestId('deep-link-share-open')?.hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('keeps Uninstall behind a confirm in the installed menu', async () => {
    mockInstalled = INSTALLED_SKILL.target;
    renderHost();
    open();

    act(() => {
      byTestId('deep-link-share-kebab')?.click();
    });
    act(() => {
      byTestId('deep-link-share-uninstall')?.click();
    });
    expect(byTestId('deep-link-share-uninstall-dialog')?.textContent).toContain(
      'Uninstall this skill?',
    );
    expect(mockUninstall).not.toHaveBeenCalled();
    await act(async () => {
      byTestId('deep-link-share-uninstall-confirm')?.click();
      await Promise.resolve();
    });
    expect(mockUninstall).toHaveBeenCalledTimes(1);
  });

  it('holds a newer request while an uninstall runs', async () => {
    const pending = deferred<boolean>();
    mockUninstall.mockReturnValueOnce(pending.promise);
    mockInstalled = INSTALLED_SKILL.target;
    renderHost();
    open();
    act(() => {
      byTestId('deep-link-share-kebab')?.click();
    });
    act(() => {
      byTestId('deep-link-share-uninstall')?.click();
    });
    await act(async () => {
      byTestId('deep-link-share-uninstall-confirm')?.click();
      await Promise.resolve();
    });
    const newer: DeepLinkShareOpenEvent = {
      entity: 'skill',
      externalId: '9a9a51c1-a72b-4e12-9320-a038b90189f0',
      intent: 'install',
    };
    open(newer, 'in-app');
    expect(useNavigationStore.getState().pendingShareInstall?.link).toEqual(
      LINK,
    );

    await act(async () => {
      pending.resolve(true);
      await Promise.resolve();
    });
    expect(useNavigationStore.getState().shareInstallBusy).toBe(false);
    expect(useNavigationStore.getState().pendingShareInstall?.link).toBe(newer);
  });
});

describe('ShareInstallModal skill provenance and effect (CAN-5017)', () => {
  const ACME = {
    type: 'organization',
    id: '5b0d7c1e-3f4a-4a8e-9c2d-1e6f7a8b9c0d',
    name: 'Acme',
  } as const;
  const PLATFORM = {
    type: 'team',
    id: 'team-platform',
    name: 'Platform',
    organization: { id: '5b0d7c1e-3f4a-4a8e-9c2d-1e6f7a8b9c0d', name: 'Acme' },
  } as const;
  const NOTE =
    "Later edits to the shared skill won't automatically update this copy.";

  function scoped(
    sharedBy: SkillSnapshot['sharedBy'],
    bound = true,
  ): SkillSnapshot {
    return {
      ...skillSnapshot,
      scopedShare: true,
      // Main sets a coincidental public username to null on scoped reads; a
      // mixed snapshot still prefers authenticated provenance.
      authorUsername: 'morgan',
      ...(bound ? { sourceRemoteId: SKILL_ID } : {}),
      ...(sharedBy !== undefined ? { sharedBy } : {}),
    };
  }

  function subtitle(): string | undefined {
    const type = byTestId('share-install-type-label')?.textContent ?? '';
    const publisher = byTestId('share-install-publisher')?.textContent;
    return publisher === undefined ? type : `${type} · ${publisher}`;
  }

  function effect(): string | null | undefined {
    return byTestId('share-install-effect')?.textContent;
  }

  function show(): void {
    renderHost();
    open({ ...LINK, audience: 'ORGANIZATION' });
  }

  it('names the sharer, owning organization, audience and context', () => {
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: ACME,
      shareScope: 'organization',
    });
    show();
    expect(subtitle()).toBe(
      'Skill · Shared by Lena Park · Acme · Organization',
    );
    expect(effect()).toBe(
      `Adds a copy to this device for the Acme context. ${NOTE}`,
    );
  });

  it('shows a team under its parent organization', () => {
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: PLATFORM,
      shareScope: 'team',
    });
    show();
    expect(subtitle()).toBe(
      'Skill · Shared by Lena Park · Acme · Team: Platform',
    );
    expect(effect()).toBe(
      `Adds a copy to this device for the Acme context. ${NOTE}`,
    );
  });

  it('blocks new owner, team and effect context names while keeping labels recorded', () => {
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: PLATFORM,
      shareScope: 'team',
    });
    show();
    const publisher = byTestId('share-install-publisher');
    expect(
      Array.from(publisher?.querySelectorAll('.ph-no-capture') ?? []).map(
        (node) => node.textContent,
      ),
    ).toEqual(['Lena Park', 'Acme', 'Platform']);
    expect(publisher?.classList.contains('ph-no-capture')).toBe(false);
    const effectLine = byTestId('share-install-effect');
    expect(effectLine?.querySelector('.ph-no-capture')?.textContent).toBe(
      'Acme',
    );
    expect(effectLine?.classList.contains('ph-no-capture')).toBe(false);
  });

  it('says Personal only for the account’s explicit personal organization', () => {
    mockPersonalOrganizationId = '5b0d7c1e-3f4a-4a8e-9c2d-1e6f7a8b9c0d';
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: { ...ACME, name: 'Lena’s organization' },
      shareScope: 'organization',
    });
    show();
    expect(subtitle()).toBe('Skill · Shared by Lena Park · Personal');
    expect(effect()).toBe(
      `Adds a copy to this device for your Personal context. ${NOTE}`,
    );
  });

  it('does not reinterpret a team in the personal organization as Personal', () => {
    mockPersonalOrganizationId = '5b0d7c1e-3f4a-4a8e-9c2d-1e6f7a8b9c0d';
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: PLATFORM,
      shareScope: 'team',
    });
    show();
    expect(subtitle()).toBe(
      'Skill · Shared by Lena Park · Acme · Team: Platform',
    );
    expect(effect()).toBe(
      `Adds a copy to this device for your Personal context. ${NOTE}`,
    );
  });

  it('names the owner, not some other personal organization', () => {
    mockContext = {
      kind: 'organization',
      organizationId: 'selected-other-org',
    };
    mockPersonalOrganizationId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: ACME,
      shareScope: 'organization',
    });
    show();
    expect(subtitle()).toBe(
      'Skill · Shared by Lena Park · Acme · Organization',
    );
    expect(effect()).toBe(
      `Adds a copy to this device for the Acme context. ${NOTE}`,
    );
  });

  it.each([null, '', '   '])('omits a blank owner and team name %p', (name) => {
    mockSnapshot = scoped({
      name: ' Lena Park ',
      owner: {
        ...PLATFORM,
        name,
        organization: { ...PLATFORM.organization, name },
      },
      shareScope: 'team',
    });
    show();
    expect(subtitle()).toBe('Skill · Shared by Lena Park · Team');
    expect(effect()).toBe(
      `Adds a copy to this device for the owning organization's context. ${NOTE}`,
    );
  });

  it('trims owner and team names as text', () => {
    mockSnapshot = scoped({
      name: ' Lena Park ',
      owner: {
        ...PLATFORM,
        name: ' Platform ',
        organization: { ...PLATFORM.organization, name: ' Acme ' },
      },
      shareScope: 'team',
    });
    show();
    expect(subtitle()).toBe(
      'Skill · Shared by Lena Park · Acme · Team: Platform',
    );
    expect(effect()).toBe(
      `Adds a copy to this device for the Acme context. ${NOTE}`,
    );
  });

  it.each([null, '', '   '])(
    'drops a %p sharer without a dangling separator',
    (name) => {
      mockSnapshot = scoped({ name, owner: ACME, shareScope: 'organization' });
      show();
      expect(subtitle()).toBe('Skill · Acme · Organization');
    },
  );

  it("falls back to the owning organization's context without a name", () => {
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: { ...ACME, name: null },
      shareScope: 'organization',
    });
    show();
    expect(subtitle()).toBe('Skill · Shared by Lena Park · Organization');
    expect(effect()).toBe(
      `Adds a copy to this device for the owning organization's context. ${NOTE}`,
    );
  });

  it('keeps a long sharer name whole and blocked from replay', () => {
    const long = 'Lena '.repeat(40).trim();
    mockSnapshot = scoped({
      name: long,
      owner: ACME,
      shareScope: 'organization',
    });
    show();
    const blocked = byTestId('share-install-publisher')?.querySelectorAll(
      '.ph-no-capture',
    );
    expect(Array.from(blocked ?? []).map((node) => node.textContent)).toEqual([
      long,
      'Acme',
    ]);
    expect(byTestId('deep-link-share-install')).not.toBeNull();
  });

  it('describes a scoped copy resolved with context scoping off as everywhere', () => {
    mockSnapshot = scoped(
      { name: 'Lena Park', owner: ACME, shareScope: 'organization' },
      false,
    );
    show();
    expect(effect()).toBe(
      `Adds a copy to this device, available in every context. ${NOTE}`,
    );
  });

  it('never calls a legacy scoped snapshot available everywhere', () => {
    mockSnapshot = scoped(undefined, false);
    show();
    expect(subtitle()).toBe('Skill · Shared by morgan');
    expect(effect()).toBe(`Adds a copy to this device. ${NOTE}`);
  });

  it('uses the generic scoped fallback for a bound legacy snapshot', () => {
    mockSnapshot = scoped(undefined, true);
    show();
    expect(effect()).toBe(
      `Adds a copy to this device for the owning organization's context. ${NOTE}`,
    );
  });

  it('keeps public attribution and says the copy is available everywhere', () => {
    renderHost();
    open();
    expect(subtitle()).toBe('Skill · Shared by morgan');
    expect(
      byTestId('share-install-publisher')?.querySelector('.ph-no-capture')
        ?.textContent,
    ).toBe('morgan');
    expect(effect()).toBe(
      `Adds a copy to this device, available in every context. ${NOTE}`,
    );
  });

  it('shows no effect once the skill is installed', () => {
    mockInstalled = INSTALLED_SKILL.target;
    renderHost();
    open();
    expect(effect()).toBeUndefined();
  });

  it('shows no effect and the existing publisher for a non-skill share', () => {
    mockSnapshot = {
      entity: 'plugin',
      externalId: SKILL_ID,
      name: 'Release kit',
      description: 'Tools for releases.',
      ref: {
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'acme/plugins' },
        plugin_name: 'release-kit',
      },
      refKey: 'acme/release-kit',
      marketplaceOrigin: 'https://example.com/acme',
      authorUsername: 'morgan',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    renderHost();
    open({ ...LINK, entity: 'plugin' });
    expect(subtitle()).toBe('Plugin · Shared by morgan');
    expect(effect()).toBeUndefined();
  });

  it('drops the previous share’s provenance when the snapshot changes', () => {
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: ACME,
      shareScope: 'organization',
    });
    show();
    expect(subtitle()).toContain('Acme');
    mockSnapshot = skillSnapshot;
    renderHost();
    expect(subtitle()).toBe('Skill · Shared by morgan');
    expect(effect()).toBe(
      `Adds a copy to this device, available in every context. ${NOTE}`,
    );
  });

  it('drops provenance and effect after a new share fails to resolve', () => {
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: ACME,
      shareScope: 'organization',
    });
    show();
    expect(subtitle()).toContain('Acme');
    mockResolveError = 'not-found';
    renderHost();
    expect(byTestId('share-install-publisher')).toBeNull();
    expect(effect()).toBeUndefined();
    expect(byTestId('deep-link-share-landing')?.textContent).not.toContain(
      'Acme',
    );
  });

  it('keeps automation publisher behavior and omits a skill effect', () => {
    mockSnapshot = {
      entity: 'automation',
      externalId: SKILL_ID,
      contentHash: 'a'.repeat(64),
      automation: {
        version: 1,
        name: 'Nightly digest',
        description: '',
        trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Check the queue',
          plugins: [],
        },
        hasRunCondition: false,
      },
      authorUsername: 'morgan',
      updatedAt: skillSnapshot.updatedAt,
    };
    renderHost();
    open({ ...LINK, entity: 'automation' });
    expect(subtitle()).toBe('Automation · Shared by morgan');
    expect(effect()).toBeUndefined();
  });

  it('starts keyboard focus on close and reaches Install inside the review', () => {
    mockSnapshot = scoped({
      name: 'Lena Park',
      owner: ACME,
      shareScope: 'organization',
    });
    show();
    const close = byTestId('deep-link-share-landing')?.querySelector(
      'button[aria-label="Close"]',
    );
    expect(document.activeElement).toBe(close);
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(document.activeElement).toBe(byTestId('deep-link-share-install'));
  });
});

describe('ShareInstallModal failure recovery (CAN-5222)', () => {
  const landingDialog = (): HTMLElement | null =>
    byTestId('deep-link-share-landing');

  it('offers Sign in and steps aside for the connect gate without losing the share', () => {
    mockResolveError = 'sign-in-required';
    renderHost();
    open();
    expect(landingDialog()?.textContent).toContain(
      'Sign in to open this skill.',
    );
    const signIn = byTestId('deep-link-share-sign-in');
    expect(signIn?.textContent).toBe('Sign in');
    act(() => signIn?.click());
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    // The gate opens after its account read; the dialog waits for it.
    expect(landingDialog()).not.toBeNull();

    act(() => {
      useCloudConnectGateStore.setState({
        pending: { context: {}, proceed: jest.fn() },
      });
    });
    expect(landingDialog()).toBeNull();
    expect(useNavigationStore.getState().pendingShareInstall?.link).toBe(LINK);

    // Cancelling the gate brings the landing back, still recoverable.
    act(() => {
      useCloudConnectGateStore.setState({ pending: null });
    });
    expect(byTestId('deep-link-share-sign-in')).not.toBeNull();
  });

  it('offers Switch account and steps aside while account settings are open', () => {
    mockResolveError = 'not-a-member';
    renderHost();
    open();
    expect(landingDialog()?.textContent).toContain(
      "This account doesn't have access to this skill. Try signing in with another account.",
    );
    const switchAccount = byTestId('deep-link-share-switch-account');
    expect(switchAccount?.textContent).toBe('Switch account');
    act(() => switchAccount?.click());
    expect(mockSwitchAccount).toHaveBeenCalledTimes(1);
    act(() => {
      useNavigationStore.setState({ settingsOpen: true });
    });
    expect(landingDialog()).toBeNull();
    expect(useNavigationStore.getState().pendingShareInstall?.link).toBe(LINK);
    act(() => {
      useNavigationStore.setState({ settingsOpen: false });
    });
    expect(landingDialog()).not.toBeNull();
  });

  it('stays over Settings that were open before any recovery was chosen', () => {
    mockResolveError = 'not-a-member';
    act(() => {
      useNavigationStore.setState({ settingsOpen: true });
    });
    renderHost();
    open();
    expect(landingDialog()).not.toBeNull();
  });

  it('offers Retry for an unreachable service', () => {
    mockResolveError = 'cloud-unreachable';
    renderHost();
    open();
    const retry = byTestId('deep-link-share-retry');
    expect(retry?.textContent).toBe('Retry');
    act(() => retry?.click());
    expect(mockRetryResolve).toHaveBeenCalledTimes(1);
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('runs the existing Check for updates action', () => {
    const previousApi = window.api;
    const checkForUpdates = jest.fn().mockResolvedValue(undefined);
    Object.assign(window, { api: { update: { checkForUpdates } } });
    try {
      mockResolveError = 'client-upgrade-required';
      renderHost();
      open();
      const update = byTestId('deep-link-share-update-app');
      expect(update?.textContent).toBe('Check for updates');
      act(() => update?.click());
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(window, { api: previousApi });
    }
  });

  it('removes recovery actions and obsolete errors while Retry resolves', () => {
    mockResolveError = 'cloud-unreachable';
    renderHost();
    open();
    expect(byTestId('deep-link-share-retry')).not.toBeNull();
    mockResolving = true;
    renderHost();
    expect(byTestId('deep-link-share-retry')).toBeNull();
    expect(landingDialog()?.textContent).not.toContain("Couldn't reach");
    expect(landingDialog()?.textContent).toContain('Loading');
  });

  it.each(['not-found', 'share-changed'] as const)(
    'offers no primary for %s',
    (reason) => {
      mockResolveError = reason;
      renderHost();
      open();
      expect(landingDialog()).not.toBeNull();
      for (const testId of [
        'deep-link-share-sign-in',
        'deep-link-share-switch-account',
        'deep-link-share-retry',
        'deep-link-share-update-app',
        'deep-link-share-install',
      ]) {
        expect(byTestId(testId)).toBeNull();
      }
    },
  );

  it('keeps an unavailable share neutral about revocation', () => {
    mockResolveError = 'not-found';
    renderHost();
    open();
    expect(landingDialog()?.textContent).toContain(
      "This share isn't available. It may no longer exist, or you may not have access.",
    );
    expect(landingDialog()?.textContent).not.toMatch(/revoked/i);
  });
});

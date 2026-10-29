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
let mockSnapshot: SkillSnapshot = skillSnapshot;

let mockInstalled: PublicShareInstalledTarget | null = null;
let mockInstalling = false;
let mockUninstalling = false;
let mockInstallError = '';
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
      state: { phase: 'ready', snapshot: mockSnapshot },
      snapshot: mockSnapshot,
      detecting: false,
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
import { ShareInstallModalHost } from '../ShareInstallModal';

const LINK: DeepLinkShareOpenEvent = {
  entity: 'skill',
  externalId: SKILL_ID,
  intent: 'install',
};

let container: HTMLDivElement;
let root: Root;

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function renderHost(): void {
  act(() => {
    root.render(<ShareInstallModalHost />);
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
  mockLandingOptions.length = 0;
  mockSnapshot = skillSnapshot;
  useNavigationStore.setState({
    activePage: 'overview',
    pendingShareInstall: undefined,
    heldShareInstall: undefined,
    shareInstallBusy: false,
    pendingSkillViewer: undefined,
  });
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

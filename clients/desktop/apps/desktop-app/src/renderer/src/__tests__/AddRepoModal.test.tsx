/**
 * @jest-environment jsdom
 */
import type { WorkspaceContextOrganizationRole } from '@canopy/protocol/workspace-context';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type { OrgProjectsStoreState } from '@canopy/app-state';
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  GitHubPermissionsStatus,
  GitHubRepoSummary,
  NavigationMode,
  RepoSelection,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));
import { recordAutomationCreatedProject } from '@/stores/automationInstallContinuationStore';
jest.mock('@/stores/automationInstallContinuationStore', () => ({
  recordAutomationCreatedProject: jest.fn(),
}));
import {
  AddRepoModal,
  AddWorkspaceModalHost,
} from '@/components/worktree/AddRepoModal';
import { offerCursorRulesReview } from '@/lib/cursorRulesOffer';
jest.mock('@/lib/cursorRulesOffer', () => ({
  offerCursorRulesReview: jest.fn(() => Promise.resolve()),
}));
let mockHostedSettingsClient: unknown = null;
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient: (): unknown => mockHostedSettingsClient,
}));
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import * as sidebarScoping from '@/components/sidebar/useSidebarScopingContext';

jest.mock('@/components/sidebar/useSidebarScopingContext', () => {
  const actual = jest.requireActual<typeof sidebarScoping>(
    '@/components/sidebar/useSidebarScopingContext',
  );
  return {
    ...actual,
    useSidebarScopingContext: jest.fn(actual.useSidebarScopingContext),
  };
});
const useSidebarScopingContextMock = jest.mocked(
  sidebarScoping.useSidebarScopingContext,
);
import { navigateAfterRepositoryWorkspaceCreated } from '@/lib/postWorkspaceCreateNavigation';
import { invalidateGitHubPermissionsCache } from '@/hooks/useGitHubPermissions';
import { setNativeInputValue } from '@/test-utils/dom';
import { brandText } from '@/lib/brand';
import { saveWorkspacePrivateMemory } from '@/lib/privateMemory';
import { makeTestPreferences } from '@/test-utils/preferences';

// The dialog's one Private memory write path (CAN-3562); the helper's own
// IPC and row reload are covered in privateMemory.test.ts.
jest.mock('@/lib/privateMemory', () => ({
  saveWorkspacePrivateMemory: jest.fn(),
}));
const savePrivateMemory = jest.mocked(saveWorkspacePrivateMemory);

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let resolveCloneHandoff: () => void = () => undefined;
jest.mock('@/lib/cloneHandoff', () => ({
  CLONE_HANDOFF_DELAY_MS: 3_000,
  waitForCloneHandoff: (): Promise<void> =>
    new Promise<void>((resolve) => {
      resolveCloneHandoff = resolve;
    }),
}));

const mockProjectsState = {
  browseForRepo: jest.fn(),
  addLocalRepo: jest.fn(),
  addRemoteRepo: jest.fn<
    Promise<string | null>,
    [string, string, { jobId?: string }?]
  >(),
  initLocalRepo: jest.fn(),
  createOrgMemberCodeProject: jest.fn(),
  createOrgMemberMultiRepoProject: jest.fn(),
  createWorkspace: jest.fn(),
  loadProjects: jest.fn(),
  projects: [] as SidebarItem[],
  registerCreatedWorkspaceWorktree: jest.fn(),
};

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: Object.assign(
    <T,>(selector: (state: typeof mockProjectsState) => T): T =>
      selector(mockProjectsState),
    {
      getState: (): typeof mockProjectsState => mockProjectsState,
      setState: (
        updater:
          | Partial<typeof mockProjectsState>
          | ((
              state: typeof mockProjectsState,
            ) => Partial<typeof mockProjectsState>),
      ): void => {
        Object.assign(
          mockProjectsState,
          typeof updater === 'function' ? updater(mockProjectsState) : updater,
        );
      },
    },
  ),
}));

const mockStandaloneChatState = {
  createChatProject: jest.fn(),
  createChatProjectFromBlueprint: jest.fn(),
  createOrgCoworkProject: jest.fn(),
  activateCreatedCoworkWorkspace: jest.fn(),
};

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: <T,>(
    selector: (state: typeof mockStandaloneChatState) => T,
  ): T => selector(mockStandaloneChatState),
}));

const mockGitHubState = {
  addToast: jest.fn(),
};

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: Object.assign(
    <T,>(selector: (state: typeof mockGitHubState) => T): T =>
      selector(mockGitHubState),
    {
      getState: (): typeof mockGitHubState => mockGitHubState,
    },
  ),
}));

const mockNavigationState = {
  navigate: jest.fn(),
  openAccountOrganizationSettings: jest.fn(),
  // AddWorkspaceModalHost state (CAN-2053 offer tests).
  addWorkspaceModalOpen: false,
  addWorkspaceInitialRepoUrl: undefined as string | undefined,
  addWorkspaceInitialProjectType: undefined as string | undefined,
  closeAddWorkspaceModal: jest.fn(),
  openWorkspaceSettings: jest.fn(),
};

jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: Object.assign(
    <T,>(selector: (state: typeof mockNavigationState) => T): T =>
      selector(mockNavigationState),
    {
      getState: (): typeof mockNavigationState => mockNavigationState,
    },
  ),
}));

const mockNavigationModeState: { mode: NavigationMode } = { mode: 'code' };

jest.mock('@/stores/navigationModeStore', () => ({
  useNavigationMode: (): NavigationMode => mockNavigationModeState.mode,
  useNavigationModeStore: Object.assign(
    <T,>(selector: (state: typeof mockNavigationModeState) => T): T =>
      selector(mockNavigationModeState),
    {
      getState: (): typeof mockNavigationModeState => mockNavigationModeState,
    },
  ),
}));

const mockHomeComposerState: {
  selectWorkspace: jest.Mock;
  setPendingCreateFromReference: jest.Mock;
  pendingCreateFromReference: string | null;
} = {
  selectWorkspace: jest.fn(),
  setPendingCreateFromReference: jest.fn(),
  pendingCreateFromReference: null,
};

jest.mock('@/stores/homeComposerStore', () => ({
  useHomeComposerStore: {
    getState: (): typeof mockHomeComposerState => mockHomeComposerState,
  },
}));

jest.mock('@/components/shared', () => {
  return {
    DialogModal: ({
      children,
      title,
    }: {
      children: ReactNode;
      title: ReactNode;
    }): JSX.Element => (
      <section>
        <h1>{title}</h1>
        {children}
      </section>
    ),
    GitHubRepoPicker: ({
      repos,
      testId,
      onSelect,
    }: {
      repos: GitHubRepoSummary[];
      testId?: string;
      onSelect: (fullName: string) => void;
    }): JSX.Element => (
      <div data-testid={testId}>
        {repos.map((item) => (
          <button
            type="button"
            key={item.fullName}
            onClick={() => onSelect(item.fullName)}
          >
            {item.fullName}
          </button>
        ))}
      </div>
    ),
  };
});

const mockCatalog: OrgProjectsStoreState = {
  snapshots: {},
  accountEpoch: 0,
  loading: {},
  errors: {},
  setupProgress: {},
  setupRequest: null,
  requestSetup: jest.fn(),
  clearSetupRequest: jest.fn(),
  load: jest.fn().mockResolvedValue(undefined),
  setPreference: jest.fn().mockResolvedValue(undefined),
  startSetup: jest.fn(),
  cancelSetup: jest.fn(),
  applySnapshot: jest.fn(),
  applySetupProgress: jest.fn(),
};
jest.mock('@canopy/app-state', () => ({
  useOrgProjectsStore: <T,>(selector: (state: OrgProjectsStoreState) => T): T =>
    selector(mockCatalog),
  useOrgProjectsStoreApi: (): {
    getState: () => OrgProjectsStoreState;
    subscribe: () => () => void;
  } => ({
    getState: (): OrgProjectsStoreState => mockCatalog,
    subscribe: (): (() => void) => (): void => {},
  }),
}));

jest.mock('@/components/worktree/WorkspaceMultiSelectPicker', () => ({
  WorkspaceMultiSelectPicker: (): JSX.Element => <div />,
}));

function permissions(
  overrides: Partial<GitHubPermissionsStatus>,
): GitHubPermissionsStatus {
  return {
    tokenAvailable: false,
    tokenType: 'unknown',
    scopes: [],
    permissions: [],
    canListRepos: false,
    ...overrides,
    error: overrides.error === undefined ? null : overrides.error,
  };
}

function repo(overrides: Partial<GitHubRepoSummary> = {}): GitHubRepoSummary {
  return {
    fullName: 'octo/repo',
    ownerLogin: 'octo',
    name: 'repo',
    cloneUrl: 'https://github.com/octo/repo.git',
    sshUrl: 'git@github.com:octo/repo.git',
    htmlUrl: 'https://github.com/octo/repo',
    description: 'A repository available through GitHub auth',
    isPrivate: false,
    isFork: false,
    isArchived: false,
    defaultBranch: 'main',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (cause) {
      lastError = cause;
      await flush();
    }
  }
  throw lastError;
}

function clickButton(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim().includes(label),
  );
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function click(testId: string): void {
  const button = document.querySelector(`[data-testid="${testId}"]`);
  if (button === null) throw new Error(`Missing control ${testId}`);
  act((): void => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Private memory sits beside the panel's action (CAN-3909). */
function togglePrivateMemory(): void {
  click('add-workspace-private-memory-toggle');
}

/**
 * Inside an organization scope the + dialog makes only projects the
 * organization owns (CAN-3469). A flow that asks to clone one repository,
 * such as the Home picker's no-match row, is a Personal one: it switches to
 * Personal before it opens the dialog with this URL.
 */
const PERSONAL_REPO_URL = 'https://github.com/octo/personal';

/** A native drag event carrying one dropped item. */
function folderDragEvent(
  type: 'dragover' | 'drop',
  item: { isDirectory: boolean } | null | 'text',
  { leadingString = false }: { leadingString?: boolean } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const file = new File([''], 'payments');
  const fileItem = {
    kind: 'file',
    getAsFile: (): File => file,
    webkitGetAsEntry: (): typeof item => item,
  };
  const stringItem = {
    kind: 'string',
    getAsFile: (): null => null,
    webkitGetAsEntry: (): null => null,
  };
  Object.defineProperty(event, 'dataTransfer', {
    value:
      item === 'text'
        ? { types: ['text/plain'], files: [], items: [stringItem] }
        : {
            types: ['Files'],
            files: [file],
            items: leadingString ? [stringItem, fileItem] : [fileItem],
          },
  });
  return event;
}

describe('AddRepoModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getGitHubPermissions: jest.Mock;
  let listUserGitHubRepos: jest.Mock;
  let listBlueprints: jest.Mock;
  let refreshBlueprints: jest.Mock;
  let getOrgCoworkEligibility: jest.Mock;
  let getOrgCodeEligibility: jest.Mock;
  let inspectOrgFolder: jest.Mock;
  let findRepositoryOwner: jest.Mock;
  let loadCanopyCloudAccount: jest.Mock;
  let closeOrgModal: jest.Mock;
  let checkAddWorkspaceFromFolder: jest.Mock;

  beforeEach(() => {
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
      hydrated: true,
      accountEpoch: 0,
    });
    invalidateGitHubPermissionsCache();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getGitHubPermissions = jest.fn().mockResolvedValue(permissions({}));
    listUserGitHubRepos = jest.fn();
    listBlueprints = jest.fn(() =>
      Promise.resolve({ blueprints: [], available: true }),
    );
    refreshBlueprints = jest.fn(() =>
      Promise.resolve({ blueprints: [], available: true }),
    );
    getOrgCoworkEligibility = jest.fn(() => Promise.resolve('eligible'));
    // Off unless a test opts in: without it the form is the Cowork-only one.
    getOrgCodeEligibility = jest.fn(() => Promise.resolve('ineligible'));
    inspectOrgFolder = jest.fn();
    // The create-time nudge's lookup: nothing owns the repository unless a
    // test says so.
    findRepositoryOwner = jest.fn(() => Promise.resolve({ kind: 'none' }));
    loadCanopyCloudAccount = jest.fn(() => Promise.resolve(null));
    closeOrgModal = jest.fn();
    checkAddWorkspaceFromFolder = jest.fn(() =>
      Promise.resolve({ status: 'not-tracked' }),
    );
    Object.assign(mockCatalog, { snapshots: {}, setupProgress: {} });
    mockProjectsState.projects = [];
    mockStandaloneChatState.activateCreatedCoworkWorkspace
      .mockReset()
      .mockResolvedValue(true);
    mockStandaloneChatState.createOrgCoworkProject.mockReset();
    mockProjectsState.createOrgMemberCodeProject.mockReset();
    mockProjectsState.createOrgMemberMultiRepoProject.mockReset();
    mockNavigationState.navigate.mockReset();
    savePrivateMemory.mockReset().mockResolvedValue(undefined);
    mockHomeComposerState.pendingCreateFromReference = null;
    mockNavigationModeState.mode = 'code';
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount,
        checkAddWorkspaceFromFolder,
        openAuthenticatedPortalPage: jest.fn().mockResolvedValue(true),
        getGitHubPermissions,
        listUserGitHubRepos,
        getDefaultCloneDirectory: jest.fn(() => Promise.resolve('C:\\repos')),
        chatProject: {
          listBlueprints: (): unknown => listBlueprints(),
          refreshBlueprints: (): unknown => refreshBlueprints(),
          getOrgDefaultCoworkEligibility: (organizationId: string): unknown =>
            getOrgCoworkEligibility(organizationId),
        },
        browseForCloneDirectory: jest.fn(),
        probeCloneDestination: jest.fn(),
        loadPreferences: jest.fn().mockResolvedValue({}),
        savePreferences: jest.fn().mockResolvedValue(undefined),
        orgProjects: {
          linksList: jest
            .fn()
            .mockResolvedValue({ status: 'resolved', links: [] }),
          getMemberCodeEligibility: (organizationId: string): unknown =>
            getOrgCodeEligibility(organizationId),
          inspectFolder: (request: unknown): unknown =>
            inspectOrgFolder(request),
          findRepositoryOwner: (request: unknown): unknown =>
            findRepositoryOwner(request),
        },
      },
    });
    // Links for the test organization are resolved unless a test says not.
    useLinkedPersonalWorkspacesStore.setState({
      ids: [],
      projectIds: [],
      resolvedOrganizationId: 'org-a',
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
    invalidateGitHubPermissionsCache();
  });

  function openOrganization(): void {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: 'org-a' },
        revision: 1,
        organizations: [{ id: 'org-a', name: 'Acme', role: 'MEMBER' }],
      },
    });
  }

  it.each(['context', 'account'])(
    'ignores an import completed after the %s changes',
    async (change): Promise<void> => {
      let complete: (workspace: {
        id: string;
        type: 'single-repo';
      }) => void = (): void => {
        throw new Error('Import not started');
      };
      mockProjectsState.browseForRepo.mockResolvedValue({ path: '/repo' });
      mockProjectsState.addLocalRepo.mockImplementation(
        (): Promise<{ id: string; type: 'single-repo' }> =>
          new Promise((resolve): void => {
            complete = resolve;
          }),
      );
      const selected = jest.fn();
      const closed = jest.fn();
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(
          <AddRepoModal
            isOpen
            initialRepoUrl={PERSONAL_REPO_URL}
            onClose={closed}
            onWorkspaceCreated={selected}
          />,
        );
      });
      click('add-workspace-mode-existing');
      await act(async (): Promise<void> => {
        await Promise.resolve();
        click('add-workspace-choose-folder');
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        if (change === 'account')
          useWorkspaceContextStore.setState({ accountEpoch: 1 });
        else
          useWorkspaceContextStore.setState({
            state: {
              ...useWorkspaceContextStore.getState().state,
              context: { kind: 'organization', organizationId: 'org-a' },
            },
          });
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        complete({ id: 'repo', type: 'single-repo' });
      });
      expect(selected).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
    },
  );

  it('keeps one import pending and selects the repository without switching context', async (): Promise<void> => {
    const calls: string[] = [];
    let complete: (workspace: {
      id: string;
      type: 'single-repo';
    }) => void = (): void => {
      throw new Error('Import not started');
    };
    mockProjectsState.browseForRepo.mockResolvedValue({ path: '/repo' });
    mockProjectsState.addLocalRepo.mockImplementation(
      (): Promise<{ id: string; type: 'single-repo' }> => {
        calls.push('import');
        return new Promise((resolve): void => {
          complete = resolve;
        });
      },
    );
    Object.assign(window.api, {
      workspaceContext: {
        set: jest.fn(
          async (): Promise<
            ReturnType<typeof useWorkspaceContextStore.getState>['state']
          > => {
            await Promise.resolve();
            calls.push('switch');
            return {
              ...useWorkspaceContextStore.getState().state,
              context: { kind: 'personal' },
              revision: 2,
            };
          },
        ),
      },
    });
    const selected = jest.fn((): void => {
      calls.push('select');
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <AddRepoModal
          isOpen
          initialRepoUrl={PERSONAL_REPO_URL}
          onClose={jest.fn()}
          onWorkspaceCreated={selected}
        />,
      );
    });
    click('add-workspace-mode-existing');
    await act(async (): Promise<void> => {
      await Promise.resolve();
      click('add-workspace-choose-folder');
      click('add-workspace-choose-folder');
    });
    expect(mockProjectsState.addLocalRepo).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['import']);
    expect(container.querySelector('fieldset')?.disabled).toBe(true);
    await act(async (): Promise<void> => {
      await Promise.resolve();
      complete({ id: 'repo', type: 'single-repo' });
    });
    expect(calls).toEqual(['import', 'select']);
    expect(
      mockStandaloneChatState.activateCreatedCoworkWorkspace,
    ).not.toHaveBeenCalled();
  });

  it.each(['context', 'account'])(
    'resets %s changes visibly and clears the prefilled URL',
    async (change): Promise<void> => {
      const flags = getDefaultFeatureFlagSnapshot();
      flags.values['canopy-shared-org-projects-enabled'] = true;
      useFeatureFlagsStore.setState({ snapshot: flags });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(
          <AddRepoModal
            isOpen
            onClose={jest.fn()}
            initialRepoUrl="https://github.com/acme/repo"
          />,
        );
      });
      expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
        'addWorkspace.modal',
        expect.objectContaining({ contextChanged: false, mode: 'personal' }),
      );
      expect(
        container.querySelector('[data-testid="add-workspace-remote-panel"]'),
      ).not.toBeNull();
      await act(async (): Promise<void> => {
        await Promise.resolve();
        if (change === 'account')
          useWorkspaceContextStore.setState({ accountEpoch: 1 });
        else
          useWorkspaceContextStore.setState({
            state: {
              ...useWorkspaceContextStore.getState().state,
              context: { kind: 'organization', organizationId: 'org-b' },
            },
          });
      });
      expect(container.textContent).toContain(
        change === 'account'
          ? "You're now in Personal, so this form was cleared."
          : "You're now in your organization, so this form was cleared.",
      );
      expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
        'addWorkspace.modal',
        expect.objectContaining({
          contextChanged: true,
          mode: change === 'account' ? 'personal' : 'organization',
        }),
      );
      expect(container.querySelector('input')?.value ?? '').not.toContain(
        'https://github.com/acme/repo',
      );
      // The form starts over on the new scope's first tile: an organization's
      // catalog, or Personal's Clone with an empty URL (CAN-3909).
      const remotePanel = container.querySelector(
        '[data-testid="add-workspace-remote-panel"]',
      );
      if (change === 'account') {
        expect(remotePanel).not.toBeNull();
        expect(
          container.querySelector<HTMLInputElement>(
            '[data-testid="add-workspace-remote-url-input"]',
          )?.value,
        ).toBe('');
      } else expect(remotePanel).toBeNull();
    },
  );

  it.each(['single-repo', 'multi-repo', 'cowork'])(
    'creates %s and selects it without switching context',
    async (kind): Promise<void> => {
      const calls: string[] = [];
      mockProjectsState.initLocalRepo.mockImplementation(
        async (): Promise<string> => {
          await Promise.resolve();
          calls.push('create');
          return 'new-project';
        },
      );
      mockProjectsState.createWorkspace.mockImplementation(
        async (): Promise<string> => {
          await Promise.resolve();
          calls.push('create');
          return 'new-project';
        },
      );
      mockStandaloneChatState.createChatProject.mockImplementation(
        async (): Promise<{ id: string }> => {
          await Promise.resolve();
          calls.push('create');
          return { id: 'new-project' };
        },
      );
      mockProjectsState.loadProjects.mockResolvedValue(undefined);
      mockStandaloneChatState.activateCreatedCoworkWorkspace.mockImplementation(
        async (): Promise<boolean> => {
          await Promise.resolve();
          calls.push('activate');
          return true;
        },
      );
      Object.assign(window.api, {
        workspaceContext: {
          set: jest.fn(
            async (): Promise<
              ReturnType<typeof useWorkspaceContextStore.getState>['state']
            > => {
              await Promise.resolve();
              calls.push('switch');
              return {
                ...useWorkspaceContextStore.getState().state,
                context: { kind: 'personal' },
                revision: 2,
              };
            },
          ),
        },
      });
      const selected = jest.fn((): void => {
        calls.push('select');
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(
          <AddRepoModal
            isOpen
            initialRepoUrl={PERSONAL_REPO_URL}
            onClose={jest.fn()}
            onWorkspaceCreated={selected}
          />,
        );
      });
      click('add-workspace-mode-existing');
      click('add-workspace-mode-create');
      click(`add-workspace-type-${kind}`);
      const input = container.querySelector(
        '[data-testid="add-workspace-name-input"]',
      );
      if (!(input instanceof HTMLInputElement))
        throw new Error('Missing name input');
      act((): void => {
        setNativeInputValue(input, 'New project');
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        click('add-workspace-create-submit');
      });
      expect(calls).toEqual([
        'create',
        kind === 'cowork' ? 'activate' : 'select',
      ]);
      if (kind === 'cowork')
        expect(recordAutomationCreatedProject).toHaveBeenCalledWith(
          'new-project',
        );
      // A new multi-repo project opens its settings to add repositories.
      if (kind === 'multi-repo')
        expect(selected).toHaveBeenCalledWith('new-project', {
          openSettings: true,
        });
    },
  );

  it('keeps the Personal draft open when activation fails after import', async (): Promise<void> => {
    mockProjectsState.browseForRepo.mockResolvedValue({ path: '/notes' });
    mockProjectsState.projects = [
      {
        id: 'notes',
        type: 'cowork',
        name: 'notes',
        color: '',
        collapsed: false,
        order: 0,
      },
    ];
    mockProjectsState.addLocalRepo.mockResolvedValue({
      id: 'notes',
      type: 'cowork',
    });
    mockStandaloneChatState.activateCreatedCoworkWorkspace.mockRejectedValue(
      new Error('Unable to open work entry'),
    );
    const closed = jest.fn();
    await act(async (): Promise<void> => {
      root.render(<AddRepoModal isOpen onClose={closed} />);
      await Promise.resolve();
    });
    click('add-workspace-mode-existing');
    await act(async (): Promise<void> => {
      click('add-workspace-choose-folder');
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Unable to open work entry');
    expect(closed).not.toHaveBeenCalled();
  });

  it.each<WorkspaceContextOrganizationRole>(['OWNER', 'ADMIN', 'MEMBER'])(
    'opens an organization scope on its catalog with no scope buttons for %s',
    async (role): Promise<void> => {
      const snapshot = getDefaultFeatureFlagSnapshot();
      snapshot.values['canopy-shared-org-projects-enabled'] = true;
      useFeatureFlagsStore.setState({ snapshot });
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'organization', organizationId: 'org-a' },
          revision: 1,
          organizations: [{ id: 'org-a', name: 'Acme', role }],
        },
        hydrated: true,
        accountEpoch: 0,
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      });
      await flush();
      expect(
        document.querySelector('[data-testid="add-workspace-org-catalog"]'),
      ).not.toBeNull();
      expect(document.body.textContent).toContain('Add project to Acme');
      expect(
        document.querySelector('[data-testid="add-workspace-mode-catalog"]')
          ?.textContent,
      ).toBe('From my orgTeam projects');
      expect(document.body.textContent).not.toContain(
        'Create a Personal project',
      );
      // No path to Personal, and no clone: a clone lands as a Personal project.
      for (const testId of [
        'add-workspace-personal-mode',
        'add-workspace-org-create',
        'add-workspace-mode-remote',
        'add-workspace-personal-notice',
      ])
        expect(document.querySelector(`[data-testid="${testId}"]`)).toBeNull();
      expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
        'addWorkspace.modal',
        expect.objectContaining({ mode: 'organization' }),
      );
      expect(
        jest.mocked(window.api).openAuthenticatedPortalPage,
      ).not.toHaveBeenCalled();
    },
  );

  it('keeps an organization dialog on its catalog when passed a Personal clone URL', async (): Promise<void> => {
    openOrganization();
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <AddRepoModal
          isOpen
          initialRepoUrl={PERSONAL_REPO_URL}
          onClose={jest.fn()}
        />,
      );
    });
    await flush();
    expect(
      document.querySelector('[data-testid="add-workspace-org-catalog"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain(
      'This project will be Personal',
    );
    for (const testId of [
      'add-workspace-mode-remote',
      'add-workspace-remote-panel',
    ])
      expect(document.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    expect(
      document
        .querySelector('[data-testid="add-workspace-mode-catalog"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('offers the catalog, Existing folder and Create new as tiles in an organization', async (): Promise<void> => {
    openOrganization();
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
    });
    await flush();
    const tile = (id: string): Element | null =>
      document.querySelector(`[data-testid="add-workspace-mode-${id}"]`);
    // The catalog is the first tile; the others are the Personal dialog's.
    // The dialog title names the organization, so the tiles need no
    // description (CAN-3909).
    expect(tile('catalog')?.textContent).toBe('From my orgTeam projects');
    expect(tile('catalog')?.getAttribute('aria-pressed')).toBe('true');
    expect(tile('existing')?.textContent).toBe(
      'Existing folderOn this computer',
    );
    expect(tile('create')?.textContent).toBe('Create newStart fresh');
    expect(tile('catalog')?.nextElementSibling).toBe(tile('existing'));
    expect(tile('remote')).toBeNull();
    expect(getOrgCoworkEligibility).toHaveBeenCalledWith('org-a');
    // The catalog makes nothing, so it carries no ownership notice.
    expect(
      document.querySelector('[data-testid="add-workspace-org-notice"]'),
    ).toBeNull();
    click('add-workspace-mode-create');
    expect(tile('create')?.getAttribute('aria-pressed')).toBe('true');
    expect(
      document.querySelector('[data-testid="add-workspace-org-catalog"]'),
    ).toBeNull();
    // The title already names the organization; without required chat sync
    // there is nothing more to say (CAN-3909).
    expect(
      document.querySelector('[data-testid="add-workspace-org-notice"]'),
    ).toBeNull();
    expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'addWorkspace.modal',
      expect.objectContaining({
        mode: 'organization-create',
        projectKind: 'cowork',
      }),
    );
    expect(
      jest.mocked(useCurrentUiStateReporter).mock.lastCall?.[1],
    ).not.toHaveProperty('folderKind');
    click('add-workspace-mode-existing');
    expect(
      document.querySelector('[data-testid="add-workspace-org-notice"]'),
    ).toBeNull();
    expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'addWorkspace.modal',
      expect.objectContaining({
        mode: 'organization-existing',
        folderKind: 'none',
      }),
    );
    click('add-workspace-mode-catalog');
    expect(
      document.querySelector('[data-testid="add-workspace-org-catalog"]'),
    ).not.toBeNull();
  });

  it('discloses when the selected organization requires chat sharing', async (): Promise<void> => {
    loadCanopyCloudAccount.mockResolvedValue({
      enforcedSettings: [
        {
          organizationId: 'org-a',
          organizationName: 'Acme',
          policies: [
            {
              kind: 'telemetry-sync',
              scopes: {
                transcripts: true,
                plans: false,
                metadata: false,
                summaries: false,
              },
            },
          ],
        },
      ],
    });
    await openOrgTile('create');
    await flush();
    expect(
      document.querySelector('[data-testid="add-workspace-org-notice"]')
        ?.textContent,
    ).toBe(
      `Acme requires your chats here to sync to ${brandText.appName} Cloud, where Acme can see them.`,
    );
    // Existing folder makes an organization project too, so it says the same.
    click('add-workspace-mode-existing');
    expect(
      document.querySelector('[data-testid="add-workspace-org-notice"]')
        ?.textContent,
    ).toBe(
      `Acme requires your chats here to sync to ${brandText.appName} Cloud, where Acme can see them.`,
    );
  });

  it('shows only the catalog tile when the organization is not eligible', async (): Promise<void> => {
    openOrganization();
    getOrgCoworkEligibility.mockResolvedValue('ineligible');
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
    });
    await flush();
    expect(
      document.querySelector('[data-testid="add-workspace-mode-catalog"]'),
    ).not.toBeNull();
    for (const testId of [
      'add-workspace-mode-existing',
      'add-workspace-mode-create',
    ])
      expect(document.querySelector(`[data-testid="${testId}"]`)).toBeNull();
  });

  const orgSelected = jest.fn();

  /** Opens an organization's dialog on its Existing folder or Create new tile. */
  async function openOrgTile(tile: 'existing' | 'create'): Promise<void> {
    orgSelected.mockReset();
    openOrganization();
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <AddRepoModal
          isOpen
          onClose={closeOrgModal}
          onWorkspaceCreated={orgSelected}
        />,
      );
    });
    await flush();
    click(`add-workspace-mode-${tile}`);
  }

  function byTestId(testId: string): Element | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  function button(testId: string): HTMLButtonElement {
    const element = byTestId(testId);
    if (!(element instanceof HTMLButtonElement))
      throw new Error(`Missing button ${testId}`);
    return element;
  }

  function nameInput(): HTMLInputElement {
    const input = byTestId('add-workspace-name-input');
    if (!(input instanceof HTMLInputElement))
      throw new Error('Missing project name input');
    return input;
  }

  function typeProjectName(value: string): void {
    const input = nameInput();
    act((): void => {
      setNativeInputValue(input, value);
    });
  }

  async function clickAndSettle(testId: string): Promise<void> {
    await act(async (): Promise<void> => {
      click(testId);
      await Promise.resolve();
    });
    await flush();
  }

  it('creates an organization Cowork project in place, without switching context', async (): Promise<void> => {
    const calls: string[] = [];
    mockProjectsState.loadProjects.mockResolvedValue(undefined);
    mockStandaloneChatState.createOrgCoworkProject.mockImplementation(
      async (): Promise<unknown> => {
        await Promise.resolve();
        calls.push('create');
        return {
          ok: true,
          organizationProjectId: 'project-1',
          localWorkspaceId: 'cowork-project-project-1',
          attachedGitRepository: false,
        };
      },
    );
    mockStandaloneChatState.activateCreatedCoworkWorkspace.mockImplementation(
      async (): Promise<boolean> => {
        await Promise.resolve();
        calls.push('activate');
        return true;
      },
    );
    mockNavigationState.navigate.mockImplementation((): void => {
      calls.push('navigate');
    });
    await openOrgTile('create');
    // Where the organization takes only Cowork projects there is no type to
    // choose.
    expect(byTestId('add-workspace-type-single-repo')).toBeNull();
    expect(byTestId('add-workspace-type-cowork')).toBeNull();
    expect(button('add-workspace-create-submit').textContent).toBe(
      'Create Cowork project',
    );
    // As in Personal, a missing name is said on Create.
    await clickAndSettle('add-workspace-create-submit');
    expect(byTestId('add-workspace-org-error')?.textContent).toBe(
      'Project name is required',
    );
    expect(
      mockStandaloneChatState.createOrgCoworkProject,
    ).not.toHaveBeenCalled();
    typeProjectName('  Q4 research ');
    expect(byTestId('add-workspace-org-error')).toBeNull();
    await clickAndSettle('add-workspace-create-submit');
    expect(mockStandaloneChatState.createOrgCoworkProject).toHaveBeenCalledWith(
      { organizationId: 'org-a', name: 'Q4 research' },
    );
    expect(calls).toEqual(['create', 'activate', 'navigate']);
    expect(
      mockStandaloneChatState.activateCreatedCoworkWorkspace,
    ).toHaveBeenCalledWith('cowork-project-project-1');
    expect(mockNavigationState.navigate).toHaveBeenCalledWith('chat');
    expect(closeOrgModal).toHaveBeenCalled();
    expect(useWorkspaceContextStore.getState().state.context).toEqual({
      kind: 'organization',
      organizationId: 'org-a',
    });
  });

  it('attaches a folder as a Cowork project, unchecked, where the organization takes no Code projects', async (): Promise<void> => {
    mockProjectsState.browseForRepo.mockResolvedValue({
      name: 'acme-site',
      path: '/Users/me/acme-site',
    });
    mockProjectsState.loadProjects.mockResolvedValue(undefined);
    mockStandaloneChatState.createOrgCoworkProject.mockResolvedValue({
      ok: true,
      organizationProjectId: 'project-1',
      localWorkspaceId: 'cowork-project-project-1',
      attachedGitRepository: false,
    });
    await openOrgTile('existing');
    // Said before the pick, since the pick adds the folder.
    expect(byTestId('add-workspace-existing-description')?.textContent).toBe(
      "The folder is added as a Cowork project, and its files stay where they are. If it's a git repository, branches, worktrees and other git features aren't available.",
    );
    await clickAndSettle('add-workspace-choose-folder');
    expect(inspectOrgFolder).not.toHaveBeenCalled();
    expect(mockStandaloneChatState.createOrgCoworkProject).toHaveBeenCalledWith(
      {
        organizationId: 'org-a',
        name: 'acme-site',
        folderPath: '/Users/me/acme-site',
      },
    );
    expect(mockProjectsState.createOrgMemberCodeProject).not.toHaveBeenCalled();
    expect(mockNavigationState.navigate).toHaveBeenCalledWith('chat');
    expect(closeOrgModal).toHaveBeenCalled();
  });

  it('finishes a successful organization Cowork create when the project refresh fails', async (): Promise<void> => {
    mockProjectsState.loadProjects.mockRejectedValue(
      new Error('refresh failed'),
    );
    mockStandaloneChatState.createOrgCoworkProject.mockResolvedValue({
      ok: true,
      organizationProjectId: 'project-1',
      localWorkspaceId: 'cowork-project-project-1',
      attachedGitRepository: false,
    });
    mockStandaloneChatState.activateCreatedCoworkWorkspace.mockResolvedValue(
      true,
    );
    await openOrgTile('create');
    typeProjectName('Q4 research');
    await clickAndSettle('add-workspace-create-submit');

    expect(
      mockStandaloneChatState.createOrgCoworkProject,
    ).toHaveBeenCalledTimes(1);
    expect(
      mockStandaloneChatState.activateCreatedCoworkWorkspace,
    ).toHaveBeenCalledWith('cowork-project-project-1');
    expect(mockNavigationState.navigate).toHaveBeenCalledWith('chat');
    expect(closeOrgModal).toHaveBeenCalled();
    expect(byTestId('add-workspace-org-error')).toBeNull();
  });

  it('disables Create and offers no Try again when the member limit is reached', async (): Promise<void> => {
    mockStandaloneChatState.createOrgCoworkProject.mockResolvedValue({
      ok: false,
      code: 'limit-reached',
      attachedGitRepository: false,
    });
    await openOrgTile('create');
    typeProjectName('Q4 research');
    await clickAndSettle('add-workspace-create-submit');
    expect(byTestId('add-workspace-org-error')?.textContent).toBe(
      "You've reached the limit of 100 private projects in Acme. Delete one to make another.",
    );
    expect(button('add-workspace-create-submit').disabled).toBe(true);
    expect(byTestId('add-workspace-org-retry')).toBeNull();
    expect(
      mockStandaloneChatState.activateCreatedCoworkWorkspace,
    ).not.toHaveBeenCalled();
  });

  it('locks Create new after a setup failure and Try again only sets up the same project', async (): Promise<void> => {
    mockProjectsState.loadProjects.mockResolvedValue(undefined);
    mockStandaloneChatState.createOrgCoworkProject
      .mockResolvedValueOnce({
        ok: false,
        code: 'setup-failed',
        organizationProjectId: 'project-1',
        attachedGitRepository: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        organizationProjectId: 'project-1',
        localWorkspaceId: 'cowork-project-project-1',
        attachedGitRepository: false,
      });
    mockStandaloneChatState.activateCreatedCoworkWorkspace.mockResolvedValue(
      true,
    );
    await openOrgTile('create');
    typeProjectName('Q4 research');
    await clickAndSettle('add-workspace-create-submit');
    expect(byTestId('add-workspace-org-error')?.textContent).toBe(
      "Q4 research was created in Acme, but couldn't be set up on this computer. Try again.",
    );
    expect(nameInput().disabled).toBe(true);
    expect(byTestId('add-workspace-create-submit')).toBeNull();
    expect(button('add-workspace-org-retry').textContent).toBe('Try again');
    await clickAndSettle('add-workspace-org-retry');
    expect(
      mockStandaloneChatState.createOrgCoworkProject,
    ).toHaveBeenLastCalledWith({
      organizationId: 'org-a',
      name: 'Q4 research',
      organizationProjectId: 'project-1',
    });
    expect(mockNavigationState.navigate).toHaveBeenCalledWith('chat');
  });

  it('keeps Create new editable after a create failure', async (): Promise<void> => {
    mockStandaloneChatState.createOrgCoworkProject.mockResolvedValue({
      ok: false,
      code: 'create-failed',
      attachedGitRepository: false,
    });
    await openOrgTile('create');
    typeProjectName('Q4 research');
    await clickAndSettle('add-workspace-create-submit');
    expect(byTestId('add-workspace-org-error')?.textContent).toBe(
      "Couldn't create Q4 research in Acme. Try again.",
    );
    expect(nameInput().disabled).toBe(false);
    expect(byTestId('add-workspace-org-retry')).toBeNull();
    expect(closeOrgModal).not.toHaveBeenCalled();
    // The failure is the other option's no longer: it stays with Create new.
    click('add-workspace-mode-existing');
    expect(byTestId('add-workspace-org-error')).toBeNull();
  });

  describe('organization Code projects (CAN-3534)', (): void => {
    it.each([
      ['single-repo', mockProjectsState.createOrgMemberCodeProject],
      ['multi-repo', mockProjectsState.createOrgMemberMultiRepoProject],
      ['cowork', mockStandaloneChatState.createOrgCoworkProject],
    ] as const)(
      'sends Private memory when creating a new %s definition',
      async (kind, create): Promise<void> => {
        create.mockResolvedValue({ ok: false, code: 'create-failed' });
        await openOrgTile('create');
        click(`add-workspace-type-${kind}`);
        togglePrivateMemory();
        typeProjectName('Private project');
        await clickAndSettle('add-workspace-create-submit');
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({ privateMemory: true }),
        );
      },
    );
    const ACME_SITE = { name: 'acme-site', path: '/Users/me/acme-site' };
    const NEW_CODE = {
      kind: 'code',
      target: 'new',
      repository: { host: 'github.com', owner: 'acme', name: 'acme-site' },
    };
    const LINKED = {
      kind: 'code',
      target: { projectId: 'payments', projectName: 'Payments' },
      repository: { host: 'github.com', owner: 'acme', name: 'payments' },
    };
    const CODE_CREATED = {
      ok: true,
      organizationProjectId: 'project-1',
      localWorkspaceId: 'workspace-1',
    };

    beforeEach((): void => {
      getOrgCodeEligibility.mockResolvedValue('eligible');
    });

    /** Pick a folder; `inspection` is what main says it becomes. */
    async function chooseFolder(inspection: unknown): Promise<void> {
      mockProjectsState.browseForRepo.mockResolvedValue(ACME_SITE);
      inspectOrgFolder.mockResolvedValue(inspection);
      await clickAndSettle('add-workspace-choose-folder');
    }

    function outcome(): Element | null {
      return byTestId('add-workspace-org-folder-kind');
    }

    it('waits for Code eligibility before offering the create options', async (): Promise<void> => {
      let resolveEligibility: (value: 'eligible') => void = () => undefined;
      getOrgCodeEligibility.mockReturnValue(
        new Promise<'eligible'>((resolve) => {
          resolveEligibility = resolve;
        }),
      );
      openOrganization();
      await act(async (): Promise<void> => {
        root.render(<AddRepoModal isOpen onClose={closeOrgModal} />);
        await Promise.resolve();
      });
      await flush();

      expect(getOrgCoworkEligibility).toHaveBeenCalledWith('org-a');
      expect(getOrgCodeEligibility).toHaveBeenCalledWith('org-a');
      // The catalog tile keeps its place while the others are unresolved.
      expect(byTestId('add-workspace-mode-catalog')).not.toBeNull();
      expect(byTestId('add-workspace-mode-existing')).toBeNull();
      expect(byTestId('add-workspace-mode-create')).toBeNull();

      await act(async (): Promise<void> => {
        resolveEligibility('eligible');
        await Promise.resolve();
      });
      await flush();
      click('add-workspace-mode-create');

      expect(
        button('add-workspace-type-single-repo').getAttribute('aria-pressed'),
      ).toBe('true');
      expect(button('add-workspace-create-submit').textContent).toBe(
        'Create project',
      );
    });

    it.each([
      { mode: 'code', type: 'single-repo', label: 'Create project' },
      { mode: 'work', type: 'cowork', label: 'Create Cowork project' },
    ] as const)(
      'defaults the project type to $type in $mode mode',
      async ({ mode, type, label }): Promise<void> => {
        mockNavigationModeState.mode = mode;
        await openOrgTile('create');
        expect(getOrgCodeEligibility).toHaveBeenCalledWith('org-a');
        for (const candidate of ['single-repo', 'cowork'])
          expect(
            button(`add-workspace-type-${candidate}`).getAttribute(
              'aria-pressed',
            ),
          ).toBe(String(candidate === type));
        expect(button('add-workspace-create-submit').textContent).toBe(label);
        expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
          'addWorkspace.modal',
          expect.objectContaining({
            mode: 'organization-create',
            projectKind: type === 'cowork' ? 'cowork' : 'code',
          }),
        );
      },
    );

    it('offers only the project types an organization can take', async (): Promise<void> => {
      // Two Personal projects would enable Temporary in Personal.
      mockProjectsState.projects = ['one', 'two'].map(
        (id, order): SidebarItem => ({
          id,
          type: 'single-repo',
          name: id,
          repoPath: `/repos/${id}`,
          color: '',
          collapsed: false,
          order,
          worktrees: [],
        }),
      );
      await openOrgTile('create');
      expect(byTestId('add-workspace-type-single-repo')).not.toBeNull();
      expect(byTestId('add-workspace-type-multi-repo')).not.toBeNull();
      expect(byTestId('add-workspace-type-cowork')).not.toBeNull();
      expect(byTestId('add-workspace-type-temporary')).toBeNull();
      expect(container.textContent).not.toContain('Temporary');
    });

    describe('Multi-Repo (CAN-3546)', (): void => {
      const OWNER = {
        type: 'organization' as const,
        organizationId: 'org-a',
        projectId: 'billing-project',
        instanceId: 'instance-1',
        bindingGeneration: 0,
      };
      function singleRepo(
        id: string,
        name: string,
        owner?: SidebarItem['owner'],
      ): SidebarItem {
        return {
          id,
          type: 'single-repo',
          name,
          repoPath: `/repos/${id}`,
          color: '',
          collapsed: false,
          order: 0,
          worktrees: [],
          ...(owner ? { owner } : {}),
        };
      }

      beforeEach((): void => {
        mockProjectsState.projects = [
          singleRepo('payments', 'Payments'),
          singleRepo('billing', 'Billing', OWNER),
          singleRepo('beta', 'Beta', {
            ...OWNER,
            organizationId: 'org-b',
          }),
          singleRepo('side', 'Side repository'),
        ];
      });

      it('creates an empty project in the organization and opens its settings, with no repository picker', async (): Promise<void> => {
        mockProjectsState.createOrgMemberMultiRepoProject.mockResolvedValue({
          ok: true,
          organizationProjectId: 'platform-project',
          localWorkspaceId: 'acme-platform',
        });
        await openOrgTile('create');
        click('add-workspace-type-multi-repo');
        expect(
          button('add-workspace-type-multi-repo').getAttribute('aria-pressed'),
        ).toBe('true');
        // Repositories are added in the project's settings, as in Personal.
        expect(
          container.querySelector(
            '[data-testid^="add-workspace-org-multi-repo-picker"]',
          ),
        ).toBeNull();
        expect(byTestId('add-workspace-type-description')?.textContent).toBe(
          'For changes that touch several repositories at once. Add them after you create it.',
        );
        expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
          'addWorkspace.modal',
          expect.objectContaining({
            mode: 'organization-create',
            projectKind: 'code',
          }),
        );
        typeProjectName(' Acme platform ');
        expect(button('add-workspace-create-submit').disabled).toBe(false);
        await clickAndSettle('add-workspace-create-submit');
        expect(
          mockProjectsState.createOrgMemberMultiRepoProject,
        ).toHaveBeenCalledWith({
          organizationId: 'org-a',
          name: 'Acme platform',
        });
        expect(
          mockProjectsState.createOrgMemberCodeProject,
        ).not.toHaveBeenCalled();
        expect(closeOrgModal).toHaveBeenCalled();
        expect(orgSelected).toHaveBeenCalledWith('acme-platform', {
          openSettings: true,
        });
      });

      it('retries the same local project after a failed setup', async (): Promise<void> => {
        mockProjectsState.createOrgMemberMultiRepoProject
          .mockResolvedValueOnce({
            ok: false,
            code: 'setup-failed',
            localWorkspaceId: 'acme-platform',
          })
          .mockResolvedValueOnce({
            ok: true,
            organizationProjectId: 'platform-project',
            localWorkspaceId: 'acme-platform',
          });
        await openOrgTile('create');
        click('add-workspace-type-multi-repo');
        typeProjectName('Acme platform');
        await clickAndSettle('add-workspace-create-submit');
        expect(byTestId('add-workspace-org-error')?.textContent).toContain(
          "Couldn't set up Acme platform on this computer. Try again.",
        );
        await clickAndSettle('add-workspace-org-retry');
        expect(
          mockProjectsState.createOrgMemberMultiRepoProject,
        ).toHaveBeenLastCalledWith({
          organizationId: 'org-a',
          name: 'Acme platform',
          localWorkspaceId: 'acme-platform',
        });
        expect(orgSelected).toHaveBeenCalledWith('acme-platform', {
          openSettings: true,
        });
      });

      it('moves a Personal multi-repo project from Existing folder once confirmed', async (): Promise<void> => {
        mockProjectsState.projects = [
          ...mockProjectsState.projects,
          {
            id: 'personal-platform',
            type: 'multi-repo',
            name: 'Platform',
            color: '',
            repos: [],
            worktrees: [],
            collapsed: false,
            order: 1,
          },
        ];
        mockProjectsState.createOrgMemberMultiRepoProject.mockResolvedValue({
          ok: true,
          organizationProjectId: 'platform-project',
          localWorkspaceId: 'personal-platform',
        });
        await openOrgTile('existing');
        await chooseFolder({
          kind: 'multi-repo',
          repositoryCount: 2,
          personalWorkspaceId: 'personal-platform',
        });
        expect(outcome()?.textContent).toBe(
          'Your Personal project Platform moves to Acme. You can move it back.',
        );
        expect(
          mockProjectsState.createOrgMemberMultiRepoProject,
        ).not.toHaveBeenCalled();
        await clickAndSettle('add-workspace-org-folder-add');
        expect(
          mockProjectsState.createOrgMemberMultiRepoProject,
        ).toHaveBeenCalledWith({
          organizationId: 'org-a',
          name: 'acme-site',
          folderPath: '/Users/me/acme-site',
        });
      });

      it('refuses a multi-repo folder with repositories outside the organization', async (): Promise<void> => {
        await openOrgTile('existing');
        await chooseFolder({
          kind: 'refused',
          reason: 'outside-organization',
          repositories: ['side', 'tools'],
        });
        expect(outcome()?.textContent).toBe(
          "side and tools don't belong to Acme. Choose repositories that belong to Acme.",
        );
      });
    });

    it.each([
      ['the organization cannot take Code projects', 'ineligible'],
      ['the eligibility check cannot answer', new Error('No handler')],
    ])(
      'makes only Cowork projects when %s',
      async (_reason, answer): Promise<void> => {
        if (answer instanceof Error)
          getOrgCodeEligibility.mockRejectedValue(answer);
        else getOrgCodeEligibility.mockResolvedValue(answer);
        mockProjectsState.loadProjects.mockResolvedValue(undefined);
        mockStandaloneChatState.createOrgCoworkProject.mockResolvedValue({
          ok: true,
          organizationProjectId: 'project-1',
          localWorkspaceId: 'cowork-project-project-1',
          attachedGitRepository: false,
        });
        await openOrgTile('create');
        expect(byTestId('add-workspace-type-single-repo')).toBeNull();
        expect(button('add-workspace-create-submit').textContent).toBe(
          'Create Cowork project',
        );
        click('add-workspace-mode-existing');
        mockProjectsState.browseForRepo.mockResolvedValue(ACME_SITE);
        await clickAndSettle('add-workspace-choose-folder');
        // A folder is attached as Cowork without being checked.
        expect(inspectOrgFolder).not.toHaveBeenCalled();
        expect(
          mockStandaloneChatState.createOrgCoworkProject,
        ).toHaveBeenCalledWith({
          organizationId: 'org-a',
          name: 'acme-site',
          folderPath: '/Users/me/acme-site',
        });
      },
    );

    it('offers starting points for Cowork only', async (): Promise<void> => {
      mockNavigationModeState.mode = 'work';
      await openOrgTile('create');
      expect(byTestId('add-workspace-blueprint-picker')).not.toBeNull();
      click('add-workspace-type-single-repo');
      expect(byTestId('add-workspace-blueprint-picker')).toBeNull();
      expect(button('add-workspace-create-submit').textContent).toBe(
        'Create project',
      );
    });

    it('starts a new repository as a Code project and opens it like a Personal repository', async (): Promise<void> => {
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue(
        CODE_CREATED,
      );
      await openOrgTile('create');
      // The Personal panel's own description of what Create makes.
      expect(byTestId('add-workspace-type-description')?.textContent).toBe(
        'Create a git repository with starter files.',
      );
      typeProjectName('  Billing api ');
      await clickAndSettle('add-workspace-create-submit');
      expect(mockProjectsState.createOrgMemberCodeProject).toHaveBeenCalledWith(
        { organizationId: 'org-a', name: 'Billing api' },
      );
      expect(
        mockStandaloneChatState.createOrgCoworkProject,
      ).not.toHaveBeenCalled();
      expect(mockProjectsState.initLocalRepo).not.toHaveBeenCalled();
      expect(closeOrgModal).toHaveBeenCalledTimes(1);
      expect(orgSelected).toHaveBeenCalledWith('workspace-1');
      // Not a Cowork project: nothing is activated and Chat is not opened.
      expect(
        mockStandaloneChatState.activateCreatedCoworkWorkspace,
      ).not.toHaveBeenCalled();
      expect(mockNavigationState.navigate).not.toHaveBeenCalled();
      expect(useWorkspaceContextStore.getState().state.context).toEqual({
        kind: 'organization',
        organizationId: 'org-a',
      });
    });

    it('creates a Cowork project when that type is chosen', async (): Promise<void> => {
      mockProjectsState.loadProjects.mockResolvedValue(undefined);
      mockStandaloneChatState.createOrgCoworkProject.mockResolvedValue({
        ok: true,
        organizationProjectId: 'project-1',
        localWorkspaceId: 'cowork-project-project-1',
        attachedGitRepository: false,
      });
      await openOrgTile('create');
      click('add-workspace-type-cowork');
      expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
        'addWorkspace.modal',
        expect.objectContaining({ projectKind: 'cowork' }),
      );
      typeProjectName('Q4 research');
      await clickAndSettle('add-workspace-create-submit');
      expect(
        mockStandaloneChatState.createOrgCoworkProject,
      ).toHaveBeenCalledWith({ organizationId: 'org-a', name: 'Q4 research' });
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).not.toHaveBeenCalled();
      expect(mockStandaloneChatState.createChatProject).not.toHaveBeenCalled();
      expect(mockNavigationState.navigate).toHaveBeenCalledWith('chat');
    });

    it('adds a git folder as a Code project in place on pick, named after the folder', async (): Promise<void> => {
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue(
        CODE_CREATED,
      );
      await openOrgTile('existing');
      // Where the organization takes Code projects the drop area says
      // enough; the description is only for the Cowork-only case (CAN-3909).
      expect(byTestId('add-workspace-existing-description')).toBeNull();
      expect(byTestId('add-workspace-folder-drop')).not.toBeNull();
      expect(button('add-workspace-choose-folder').textContent).toBe(
        'Choose folder',
      );
      await chooseFolder(NEW_CODE);
      expect(inspectOrgFolder).toHaveBeenCalledWith({
        organizationId: 'org-a',
        path: '/Users/me/acme-site',
      });
      // A routine outcome needs no confirmation, as in Personal.
      expect(mockProjectsState.createOrgMemberCodeProject).toHaveBeenCalledWith(
        {
          organizationId: 'org-a',
          name: 'acme-site',
          folderPath: '/Users/me/acme-site',
        },
      );
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
      expect(orgSelected).toHaveBeenCalledWith('workspace-1');
      expect(closeOrgModal).toHaveBeenCalledTimes(1);
    });

    it('adds a folder that is not a git repository as a Cowork project on pick', async (): Promise<void> => {
      mockProjectsState.loadProjects.mockResolvedValue(undefined);
      mockStandaloneChatState.createOrgCoworkProject.mockResolvedValue({
        ok: true,
        organizationProjectId: 'project-1',
        localWorkspaceId: 'cowork-project-project-1',
        attachedGitRepository: false,
      });
      await openOrgTile('existing');
      await chooseFolder({ kind: 'cowork' });
      expect(
        mockStandaloneChatState.createOrgCoworkProject,
      ).toHaveBeenCalledWith({
        organizationId: 'org-a',
        name: 'acme-site',
        folderPath: '/Users/me/acme-site',
      });
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).not.toHaveBeenCalled();
      expect(mockNavigationState.navigate).toHaveBeenCalledWith('chat');
    });

    it('waits for the member before linking a folder to a project the organization has', async (): Promise<void> => {
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue({
        ...CODE_CREATED,
        organizationProjectId: 'payments',
      });
      await openOrgTile('existing');
      await chooseFolder(LINKED);
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).not.toHaveBeenCalled();
      expect(
        byTestId('add-workspace-org-folder-path')?.querySelector('bdi')
          ?.textContent,
      ).toBe('/Users/me/acme-site');
      // The drop area gives way to the chosen folder.
      expect(byTestId('add-workspace-folder-drop')).toBeNull();
      expect(outcome()?.getAttribute('data-folder-kind')).toBe('linked');
      expect(outcome()?.textContent).toBe(
        "This folder is already in Acme as Payments. It'll be linked, not copied.",
      );
      // The folder joins a project the organization already shares, so
      // nothing above may call it private.
      expect(byTestId('add-workspace-org-notice')).toBeNull();
      expect(container.textContent).not.toContain('private to you');
      // The path is a quiet, left-aligned line that still truncates from
      // the left: small secondary text in a flex row, not a wide block.
      const path = byTestId('add-workspace-org-folder-path');
      expect(path?.className).toContain('text-xs');
      expect(path?.className).toContain('fg-secondary');
      expect(path?.className).toContain('flex');
      expect(path?.getAttribute('dir')).toBeNull();
      expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
        'addWorkspace.modal',
        expect.objectContaining({
          mode: 'organization-existing',
          projectKind: 'code',
          folderKind: 'git-repository',
        }),
      );
      expect(button('add-workspace-org-folder-add').textContent).toBe(
        'Add project',
      );
      expect(button('add-workspace-choose-folder').textContent).toBe('Change');
      await clickAndSettle('add-workspace-org-folder-add');
      // The project keeps the organization's name for it.
      expect(mockProjectsState.createOrgMemberCodeProject).toHaveBeenCalledWith(
        {
          organizationId: 'org-a',
          name: 'Payments',
          folderPath: '/Users/me/acme-site',
        },
      );
      expect(orgSelected).toHaveBeenCalledWith('workspace-1');
    });

    it.each([
      [
        'a new project',
        NEW_CODE,
        'Your Personal project acme-site moves to Acme. You can move it back.',
      ],
      [
        'a link to an existing project',
        LINKED,
        'This folder is already in Acme as Payments. Your Personal project acme-site moves to Acme. You can move it back.',
      ],
    ])(
      'says before adding that a Personal project moves, for %s',
      async (_case, inspection, text): Promise<void> => {
        mockProjectsState.projects = [
          {
            id: 'personal-1',
            type: 'cowork',
            name: 'acme-site',
            color: '',
            collapsed: false,
            order: 0,
          },
        ];
        await openOrgTile('existing');
        await chooseFolder({
          ...inspection,
          personalWorkspaceId: 'personal-1',
        });
        expect(outcome()?.getAttribute('data-folder-kind')).toBe('personal');
        expect(outcome()?.textContent).toBe(text);
        // Nothing moves until the member says so.
        expect(
          mockProjectsState.createOrgMemberCodeProject,
        ).not.toHaveBeenCalled();
        expect(button('add-workspace-org-folder-add').disabled).toBe(false);
      },
    );

    it('still says a Personal project moves when the sidebar does not know its name', async (): Promise<void> => {
      await openOrgTile('existing');
      await chooseFolder({ ...NEW_CODE, personalWorkspaceId: 'unknown' });
      expect(outcome()?.textContent).toBe(
        'Your Personal project moves to Acme. You can move it back.',
      );
    });

    it.each([
      [
        'inside-repo',
        "This folder is inside a git repository. Choose the repository's top folder.",
      ],
      [
        'linked-worktree',
        "This folder is a git worktree. Choose the repository's main folder.",
      ],
      [
        'multi-repo',
        'This folder is a multi-repo project. Choose a folder with one repository.',
      ],
      [
        'already-org-project',
        'This folder is already an organization project. Choose another folder.',
      ],
      [
        'overlaps-project',
        'This folder overlaps a project you already have. Choose another folder.',
      ],
      [
        'no-access',
        'Acme already has a project for this repository. Ask an admin for access.',
      ],
      // No picker between matches: it reads like no access.
      [
        'ambiguous',
        'Acme already has a project for this repository. Ask an admin for access.',
      ],
      ['unreadable', "Couldn't check this folder. Choose it again."],
    ])(
      'refuses a folder that is %s and adds nothing',
      async (reason, text): Promise<void> => {
        await openOrgTile('existing');
        await chooseFolder({ kind: 'refused', reason });
        expect(outcome()?.getAttribute('data-folder-kind')).toBe('refused');
        expect(outcome()?.getAttribute('data-refusal-reason')).toBe(reason);
        expect(outcome()?.textContent).toBe(text);
        expect(byTestId('add-workspace-org-folder-add')).toBeNull();
        expect(
          mockProjectsState.createOrgMemberCodeProject,
        ).not.toHaveBeenCalled();
        expect(
          mockStandaloneChatState.createOrgCoworkProject,
        ).not.toHaveBeenCalled();
        expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
          'addWorkspace.modal',
          expect.objectContaining({ folderKind: 'refused' }),
        );
        expect(
          jest.mocked(useCurrentUiStateReporter).mock.lastCall?.[1],
        ).not.toHaveProperty('projectKind');
        // Choosing another folder is the way out.
        const choose = button('add-workspace-choose-folder');
        expect(choose.textContent).toBe('Change');
        expect(choose.disabled).toBe(false);
      },
    );

    it('refuses a folder whose check fails instead of guessing Cowork', async (): Promise<void> => {
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue(
        CODE_CREATED,
      );
      await openOrgTile('existing');
      mockProjectsState.browseForRepo.mockResolvedValue(ACME_SITE);
      inspectOrgFolder.mockRejectedValue(new Error('git failed'));
      await clickAndSettle('add-workspace-choose-folder');
      expect(outcome()?.textContent).toBe(
        "Couldn't check this folder. Choose it again.",
      );
      expect(
        mockStandaloneChatState.createOrgCoworkProject,
      ).not.toHaveBeenCalled();
      // Choosing the same folder again checks it again.
      inspectOrgFolder.mockResolvedValue(NEW_CODE);
      await clickAndSettle('add-workspace-choose-folder');
      expect(inspectOrgFolder).toHaveBeenCalledTimes(2);
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).toHaveBeenCalledTimes(1);
    });

    it('shows the check while it runs and adds nothing until it answers', async (): Promise<void> => {
      let answer: (inspection: unknown) => void = (): void => {
        throw new Error('The folder check never started');
      };
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue(
        CODE_CREATED,
      );
      await openOrgTile('existing');
      mockProjectsState.browseForRepo.mockResolvedValue(ACME_SITE);
      inspectOrgFolder.mockImplementation(
        (): Promise<unknown> =>
          new Promise((resolve): void => {
            answer = resolve;
          }),
      );
      await clickAndSettle('add-workspace-choose-folder');
      expect(outcome()?.getAttribute('data-folder-kind')).toBe('checking');
      expect(outcome()?.textContent).toBe('Checking this folder…');
      expect(byTestId('add-workspace-org-folder-add')).toBeNull();
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).not.toHaveBeenCalled();
      expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
        'addWorkspace.modal',
        expect.objectContaining({ folderKind: 'checking' }),
      );
      await act(async (): Promise<void> => {
        answer(NEW_CODE);
        await Promise.resolve();
      });
      await flush();
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).toHaveBeenCalledTimes(1);
    });

    it('adds nothing when the folder check answers after the account changed', async (): Promise<void> => {
      let answer: (inspection: unknown) => void = (): void => {
        throw new Error('The folder check never started');
      };
      await openOrgTile('existing');
      mockProjectsState.browseForRepo.mockResolvedValue(ACME_SITE);
      inspectOrgFolder.mockImplementation(
        (): Promise<unknown> =>
          new Promise((resolve): void => {
            answer = resolve;
          }),
      );
      await clickAndSettle('add-workspace-choose-folder');
      await act(async (): Promise<void> => {
        useWorkspaceContextStore.setState({ accountEpoch: 1 });
        await Promise.resolve();
      });
      await act(async (): Promise<void> => {
        answer(NEW_CODE);
        await Promise.resolve();
      });
      await flush();
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).not.toHaveBeenCalled();
      expect(closeOrgModal).not.toHaveBeenCalled();
    });

    it('shows a refusal found at create time on the folder and withdraws Add', async (): Promise<void> => {
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue({
        ok: false,
        code: 'refused',
        reason: 'no-access',
      });
      await openOrgTile('existing');
      await chooseFolder(NEW_CODE);
      expect(outcome()?.textContent).toBe(
        'Acme already has a project for this repository. Ask an admin for access.',
      );
      expect(byTestId('add-workspace-org-error')).toBeNull();
      expect(byTestId('add-workspace-org-folder-add')).toBeNull();
      expect(closeOrgModal).not.toHaveBeenCalled();
      expect(orgSelected).not.toHaveBeenCalled();
    });

    it.each([
      [
        'limit-reached',
        "You've reached the limit of 100 private projects in Acme. Delete one to make another.",
      ],
      ['unavailable', "You can't create projects in Acme right now."],
      ['create-failed', "Couldn't create Billing api in Acme. Try again."],
    ])(
      'reports %s without opening anything',
      async (code, message): Promise<void> => {
        mockProjectsState.createOrgMemberCodeProject.mockResolvedValue({
          ok: false,
          code,
        });
        await openOrgTile('create');
        typeProjectName('Billing api');
        await clickAndSettle('add-workspace-create-submit');
        expect(byTestId('add-workspace-org-error')?.textContent).toBe(message);
        expect(closeOrgModal).not.toHaveBeenCalled();
        expect(orgSelected).not.toHaveBeenCalled();
      },
    );

    it('keeps a folder that failed to add, with Add project to try it again', async (): Promise<void> => {
      mockProjectsState.createOrgMemberCodeProject
        .mockResolvedValueOnce({ ok: false, code: 'create-failed' })
        .mockResolvedValueOnce(CODE_CREATED);
      await openOrgTile('existing');
      await chooseFolder(NEW_CODE);
      expect(byTestId('add-workspace-org-error')?.textContent).toBe(
        "Couldn't create acme-site in Acme. Try again.",
      );
      // The routine outcome has no line of its own.
      expect(outcome()).toBeNull();
      // Nothing was created, so this is not the Try again of a setup failure.
      expect(byTestId('add-workspace-org-retry')).toBeNull();
      await clickAndSettle('add-workspace-org-folder-add');
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).toHaveBeenLastCalledWith({
        organizationId: 'org-a',
        name: 'acme-site',
        folderPath: '/Users/me/acme-site',
      });
      expect(orgSelected).toHaveBeenCalledWith('workspace-1');
    });

    it('locks the folder after a setup failure and Try again sets up the same project', async (): Promise<void> => {
      mockProjectsState.createOrgMemberCodeProject
        .mockResolvedValueOnce({
          ok: false,
          code: 'setup-failed',
          organizationProjectId: 'project-1',
        })
        .mockResolvedValueOnce(CODE_CREATED);
      await openOrgTile('existing');
      await chooseFolder(NEW_CODE);
      expect(byTestId('add-workspace-org-error')?.textContent).toBe(
        "acme-site was created in Acme, but couldn't be set up on this computer. Try again.",
      );
      expect(byTestId('add-workspace-org-folder-add')).toBeNull();
      // Another folder would make a second project.
      expect(button('add-workspace-choose-folder').disabled).toBe(true);
      // So would a dropped one.
      Object.assign(window.api, {
        getPathForFile: jest.fn(() => '/Users/me/other-site'),
      });
      const drop = byTestId('add-workspace-drop-target');
      if (drop === null) throw new Error('Drop target not found');
      await act(async (): Promise<void> => {
        drop.dispatchEvent(folderDragEvent('drop', { isDirectory: true }));
        await Promise.resolve();
      });
      expect(inspectOrgFolder).toHaveBeenCalledTimes(1);
      expect(byTestId('add-workspace-org-folder-path')?.textContent).toContain(
        '/Users/me/acme-site',
      );
      await clickAndSettle('add-workspace-org-retry');
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).toHaveBeenLastCalledWith({
        organizationId: 'org-a',
        name: 'acme-site',
        folderPath: '/Users/me/acme-site',
        organizationProjectId: 'project-1',
      });
      expect(orgSelected).toHaveBeenCalledWith('workspace-1');
    });

    it('locks Create new after a setup failure, type and name included', async (): Promise<void> => {
      mockProjectsState.createOrgMemberCodeProject
        .mockResolvedValueOnce({
          ok: false,
          code: 'setup-failed',
          organizationProjectId: 'project-1',
        })
        .mockResolvedValueOnce(CODE_CREATED);
      await openOrgTile('create');
      typeProjectName('Billing api');
      await clickAndSettle('add-workspace-create-submit');
      expect(nameInput().disabled).toBe(true);
      expect(button('add-workspace-type-single-repo').disabled).toBe(true);
      expect(button('add-workspace-type-cowork').disabled).toBe(true);
      // The other option is not this project's: it stays usable.
      click('add-workspace-mode-existing');
      expect(byTestId('add-workspace-org-retry')).toBeNull();
      expect(button('add-workspace-choose-folder').disabled).toBe(false);
      click('add-workspace-mode-create');
      await clickAndSettle('add-workspace-org-retry');
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).toHaveBeenLastCalledWith({
        organizationId: 'org-a',
        name: 'Billing api',
        organizationProjectId: 'project-1',
      });
      expect(orgSelected).toHaveBeenCalledWith('workspace-1');
    });

    it('does not say a linked project was created when its setup fails', async (): Promise<void> => {
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue({
        ok: false,
        code: 'setup-failed',
        organizationProjectId: 'payments',
      });
      await openOrgTile('existing');
      await chooseFolder(LINKED);
      await clickAndSettle('add-workspace-org-folder-add');
      expect(byTestId('add-workspace-org-error')?.textContent).toBe(
        "Couldn't set up Payments on this computer. Try again.",
      );
    });
  });

  it('keeps the Personal scope on the local options', async (): Promise<void> => {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
    });
    expect(
      document.querySelector('[data-testid="add-workspace-org-catalog"]'),
    ).toBeNull();
    for (const testId of [
      'add-workspace-mode-remote',
      'add-workspace-mode-existing',
      'add-workspace-mode-create',
    ])
      expect(
        document.querySelector(`[data-testid="${testId}"]`),
      ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="add-workspace-personal-notice"]'),
    ).toBeNull();
  });

  it('groups catalog projects and hands Add to on-demand setup', async (): Promise<void> => {
    const flags = getDefaultFeatureFlagSnapshot();
    flags.values['canopy-shared-org-projects-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot: flags });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: 'org-a' },
        revision: 1,
        organizations: [{ id: 'org-a', name: 'Acme', role: 'MEMBER' }],
      },
    });
    const project: OrgProjectSummary = {
      id: 'catalog-1',
      organizationId: 'org-a',
      name: 'Payments',
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'organization',
      memberOwned: false,
      location: 'LOCAL',
      repository: {
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'payments',
        providerRepoId: '1',
        defaultBranch: 'main',
        verification: 'VERIFIED',
      },
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: false,
      preference: 'FOLLOW_DEFAULTS',
      listed: false,
      capabilities: { use: true, administer: false, manageCloud: false },
      instance: null,
    };
    Object.assign(mockCatalog, {
      snapshots: {
        'org:org-a': {
          context: 'org:org-a',
          revision: '1',
          fetchedAt: '',
          projects: [
            project,
            {
              ...project,
              id: 'added',
              preference: 'ADDED',
              listed: true,
              instance: { id: 'ready-instance', state: 'READY' },
            },
            {
              ...project,
              id: 'detached',
              preference: 'ADDED',
              listed: true,
              instance: { id: 'detached-instance', state: 'DETACHED' },
            },
            { ...project, id: 'dismissed', preference: 'DISMISSED' },
          ],
        },
      },
    });
    await act(async (): Promise<void> => {
      root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      await Promise.resolve();
    });
    // One list with no groups; projects to add come before those already
    // on this computer (CAN-3469).
    expect(document.body.textContent).not.toContain('Available');
    expect(
      document.querySelector('[data-testid="add-workspace-org-catalog"] h2'),
    ).toBeNull();
    // A project on this computer shows a disabled Added button in Add's place.
    const added = document.querySelector<HTMLButtonElement>(
      '[data-testid="add-workspace-org-catalog-added-added"]',
    );
    expect(added?.textContent).toBe('Added');
    expect(added?.disabled).toBe(true);
    const order = Array.from(
      document.querySelectorAll(
        '[data-testid^="add-workspace-org-catalog-row-"]',
      ),
    ).map((row): string =>
      (row.getAttribute('data-testid') ?? '').replace(
        'add-workspace-org-catalog-row-',
        '',
      ),
    );
    expect(order[order.length - 1]).toBe('added');
    // No Dismiss and no Dismissed group (CAN-3469): a project dismissed
    // earlier is available again.
    expect(document.body.textContent).not.toContain('Dismiss');
    expect(
      document.querySelector(
        '[data-testid="add-workspace-org-catalog-add-dismissed"]',
      ),
    ).not.toBeNull();
    // Rows name the GitHub repository; the shared owner is not repeated
    // (CAN-3489).
    expect(
      document.querySelector(
        '[data-testid="add-workspace-org-catalog-name-catalog-1"]',
      )?.textContent,
    ).toBe('payments');
    expect(document.body.textContent).not.toContain('acme/payments');
    // A project ready to set up shows no status line (CAN-3469).
    expect(document.body.textContent).not.toContain('Ready to set up');
    // A project on this computer offers nothing to add.
    expect(
      document.querySelector(
        '[data-testid="add-workspace-org-catalog-row-added"]',
      )?.textContent,
    ).toContain('Added');
    expect(
      document.querySelector(
        '[data-testid="add-workspace-org-catalog-add-added"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="add-workspace-org-catalog-add-detached"]',
      ),
    ).not.toBeNull();
    // Add on a listed project hands straight to the setup consent dialog.
    await act(async (): Promise<void> => {
      click('add-workspace-org-catalog-add-detached');
      await Promise.resolve();
    });
    expect(mockCatalog.requestSetup).toHaveBeenCalledWith('org-a', 'detached');
    expect(mockCatalog.setPreference).not.toHaveBeenCalled();
    // Add on an unlisted project lists it first, then hands over to setup.
    await act(async (): Promise<void> => {
      click('add-workspace-org-catalog-add-catalog-1');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockCatalog.setPreference).toHaveBeenCalledWith(
      { kind: 'organization', organizationId: 'org-a' },
      'catalog-1',
      'ADDED',
    );
    expect(mockCatalog.requestSetup).toHaveBeenLastCalledWith(
      'org-a',
      'catalog-1',
    );
    for (const state of ['cancelled', 'failed', 'materializing']) {
      Object.assign(mockCatalog, {
        setupProgress: {
          detached: {
            projectId: 'detached',
            instanceId: null,
            state,
            message: null,
            percent: null,
            updatedAt: '',
          },
        },
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      });
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-add-detached"]',
        ) !== null,
      ).toBe(state !== 'materializing');
    }
    expect(mockCatalog.startSetup).not.toHaveBeenCalled();
    expect(mockProjectsState.addRemoteRepo).not.toHaveBeenCalled();
    expect(mockProjectsState.initLocalRepo).not.toHaveBeenCalled();
    Object.assign(mockCatalog, { snapshots: {}, setupProgress: {} });
  });

  it('never offers a multi-repo project for setup, and lists it where it is converted (CAN-3532)', async (): Promise<void> => {
    const flags = getDefaultFeatureFlagSnapshot();
    flags.values['canopy-shared-org-projects-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot: flags });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: 'org-a' },
        revision: 1,
        organizations: [{ id: 'org-a', name: 'Acme', role: 'MEMBER' }],
      },
    });
    const multiRepo: OrgProjectSummary = {
      id: 'platform',
      organizationId: 'org-a',
      name: 'Platform',
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'private',
      memberOwned: true,
      topology: 'multi-repo',
      location: 'LOCAL',
      repository: {
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'web',
        providerRepoId: '1',
        defaultBranch: 'main',
        verification: 'VERIFIED',
      },
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      capabilities: { use: true, administer: true, manageCloud: false },
      instance: null,
    };
    Object.assign(mockCatalog, {
      snapshots: {
        'org:org-a': {
          context: 'org:org-a',
          revision: '1',
          fetchedAt: '',
          projects: [
            multiRepo,
            {
              ...multiRepo,
              id: 'here',
              instance: { id: 'ready-instance', state: 'READY' },
            },
          ],
        },
      },
    });
    await act(async (): Promise<void> => {
      root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      await Promise.resolve();
    });
    // Cloning its first repository on another computer would be a different
    // project, so the catalog does not offer it there.
    expect(
      document.querySelector(
        '[data-testid="add-workspace-org-catalog-row-platform"]',
      ),
    ).toBeNull();
    // Where it was converted it is on this computer, like any other.
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="add-workspace-org-catalog-added-here"]',
      )?.disabled,
    ).toBe(true);
    Object.assign(mockCatalog, { snapshots: {}, setupProgress: {} });
  });

  it('searches and filters the catalog, and sets up only the project added', async (): Promise<void> => {
    const flags = getDefaultFeatureFlagSnapshot();
    flags.values['canopy-shared-org-projects-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot: flags });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: 'org-a' },
        revision: 1,
        organizations: [{ id: 'org-a', name: 'Acme', role: 'MEMBER' }],
      },
    });
    const base: OrgProjectSummary = {
      id: 'payments',
      organizationId: 'org-a',
      name: 'Payments',
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'organization',
      memberOwned: false,
      location: 'LOCAL',
      repository: {
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'payments-api',
        providerRepoId: '1',
        defaultBranch: 'main',
        verification: 'VERIFIED',
      },
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: false,
      preference: 'FOLLOW_DEFAULTS',
      listed: false,
      capabilities: { use: true, administer: false, manageCloud: false },
      instance: null,
    };
    const repository = (name: string): OrgProjectSummary['repository'] => ({
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name,
      providerRepoId: name,
      defaultBranch: 'main',
      verification: 'VERIFIED',
    });
    mockProjectsState.projects = [
      {
        id: 'bound-workspace',
        name: 'Web app',
        type: 'single-repo',
        repoPath: '/repos/web',
        color: '',
        collapsed: false,
        order: 0,
        worktrees: [],
        owner: {
          type: 'organization',
          organizationId: 'org-a',
          projectId: 'web',
          instanceId: 'web-instance',
          bindingGeneration: 1,
        },
      },
    ];
    Object.assign(mockCatalog, {
      snapshots: {
        'org:org-a': {
          context: 'org:org-a',
          revision: '1',
          fetchedAt: '',
          projects: [
            base,
            {
              ...base,
              id: 'billing',
              name: 'Billing',
              repository: repository('ledger'),
              defaultListed: true,
              listed: true,
            },
            {
              ...base,
              id: 'web',
              name: 'Web app',
              repository: repository('web'),
              defaultListed: true,
              listed: true,
              instance: { id: 'web-instance', state: 'READY' },
            },
          ],
        },
      },
    });
    const onClose = jest.fn();
    await act(async (): Promise<void> => {
      root.render(<AddRepoModal isOpen onClose={onClose} />);
      await Promise.resolve();
    });
    const rowIds = (): string[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid^="add-workspace-org-catalog-row-"]',
        ),
      ).map((row) =>
        (row.dataset.testid ?? '').replace(
          'add-workspace-org-catalog-row-',
          '',
        ),
      );
    // Opening the dialog sets nothing up.
    expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
    expect(mockCatalog.startSetup).not.toHaveBeenCalled();
    expect(rowIds().sort()).toEqual(['billing', 'payments', 'web']);
    expect(
      document.querySelector(
        '[data-testid="add-workspace-org-catalog-row-web"]',
      )?.textContent,
    ).toContain('Added');
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="add-workspace-org-catalog-search"]',
    );
    if (search === null) throw new Error('Missing catalog search');
    expect(search.getAttribute('aria-label')).toBe('Search projects');
    const type = async (value: string): Promise<void> => {
      await act(async (): Promise<void> => {
        setNativeInputValue(search, value);
        await Promise.resolve();
      });
    };
    // Repository names match, not only project names.
    await type('ledger');
    expect(rowIds()).toEqual(['billing']);
    await type('payments-api');
    expect(rowIds()).toEqual(['payments']);
    await type('PAY');
    expect(rowIds()).toEqual(['payments']);
    // Never the owner (CAN-3469): every repository is under `acme`, and no
    // project or repository name contains it.
    await type('acme');
    expect(rowIds()).toEqual([]);
    await type('acme/payments');
    expect(rowIds()).toEqual([]);
    await type('');
    // The dialog adds new projects; there is no "Not on this computer"
    // filter (CAN-3469).
    expect(
      document.querySelector(
        '[data-testid="add-workspace-org-catalog-not-local"]',
      ),
    ).toBeNull();
    await type('zzz');
    expect(rowIds()).toEqual([]);
    expect(
      document.querySelector(
        '[data-testid="add-workspace-org-catalog-no-match"]',
      )?.textContent,
    ).toContain('No matching projects');
    await type('');
    await act(async (): Promise<void> => {
      click('add-workspace-org-catalog-add-payments');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockCatalog.setPreference).toHaveBeenCalledTimes(1);
    expect(mockCatalog.setPreference).toHaveBeenCalledWith(
      { kind: 'organization', organizationId: 'org-a' },
      'payments',
      'ADDED',
    );
    expect(mockCatalog.requestSetup).toHaveBeenCalledTimes(1);
    expect(mockCatalog.requestSetup).toHaveBeenCalledWith('org-a', 'payments');
    expect(onClose).toHaveBeenCalled();
    expect(mockCatalog.startSetup).not.toHaveBeenCalled();
    Object.assign(mockCatalog, { snapshots: {}, setupProgress: {} });
    mockProjectsState.projects = [];
  });

  describe('one-click Add (CAN-3469)', () => {
    function catalogProject(
      overrides: Partial<OrgProjectSummary>,
    ): OrgProjectSummary {
      return {
        id: 'payments',
        organizationId: 'org-a',
        name: 'Payments',
        description: null,
        kind: 'CODE',
        location: 'LOCAL',
        repository: {
          provider: 'github',
          host: 'github.com',
          owner: 'acme',
          name: 'payments',
          providerRepoId: '1',
          defaultBranch: 'main',
          verification: 'VERIFIED',
        },
        state: 'ACTIVE',
        revision: 1,
        authorizationVersion: 1,
        defaultListed: false,
        preference: 'FOLLOW_DEFAULTS',
        listed: false,
        capabilities: { use: true, administer: false, manageCloud: false },
        instance: null,
        ...overrides,
        purpose: overrides.purpose ?? 'project',
        visibility: overrides.visibility ?? 'organization',
        memberOwned: overrides.memberOwned ?? false,
      };
    }

    async function renderCatalog(
      projects: OrgProjectSummary[],
      destination: string | undefined,
    ): Promise<jest.Mock> {
      openOrganization();
      jest
        .mocked(window.api.loadPreferences)
        .mockResolvedValue(
          makeTestPreferences(
            destination === undefined
              ? {}
              : { orgProjectDefaultDestinationRoot: destination },
          ),
        );
      Object.assign(mockCatalog, {
        snapshots: {
          'org:org-a': {
            context: 'org:org-a',
            revision: '1',
            fetchedAt: '',
            projects,
          },
        },
      });
      const onClose = jest.fn();
      await act(async (): Promise<void> => {
        root.render(<AddRepoModal isOpen onClose={onClose} />);
        await Promise.resolve();
      });
      await flush();
      return onClose;
    }

    afterEach((): void => {
      Object.assign(mockCatalog, { snapshots: {}, setupProgress: {} });
    });

    it('offers Add when a ready Cowork project is missing from the local index', async (): Promise<void> => {
      await renderCatalog(
        [
          catalogProject({
            kind: 'COWORK',
            repository: null,
            listed: true,
            instance: { id: 'ready-instance', state: 'READY' },
          }),
        ],
        undefined,
      );

      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-added-payments"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-add-payments"]',
        ),
      ).not.toBeNull();

      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
      });
      expect(mockCatalog.requestSetup).toHaveBeenCalledWith(
        'org-a',
        'payments',
      );
    });

    it('sets a project up in the remembered folder without the setup dialog', async (): Promise<void> => {
      jest.mocked(mockCatalog.startSetup).mockResolvedValue(undefined);
      const onClose = await renderCatalog(
        [
          catalogProject({}),
          catalogProject({ id: 'billing', name: 'Billing', listed: true }),
        ],
        '/Users/member/code',
      );
      const destination = document.querySelector(
        '[data-testid="add-workspace-org-catalog-destination"]',
      );
      expect(destination?.textContent).toContain('/Users/member/code');
      expect(destination?.getAttribute('title')).toBe('/Users/member/code');
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-billing');
        await Promise.resolve();
      });
      expect(mockCatalog.startSetup).toHaveBeenCalledWith(
        'billing',
        '/Users/member/code',
      );
      expect(mockCatalog.setPreference).not.toHaveBeenCalled();
      expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
      // An unlisted project is listed first, then set up the same way.
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockCatalog.setPreference).toHaveBeenCalledWith(
        { kind: 'organization', organizationId: 'org-a' },
        'payments',
        'ADDED',
      );
      expect(mockCatalog.startSetup).toHaveBeenLastCalledWith(
        'payments',
        '/Users/member/code',
      );
      expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
    });

    it('changes the remembered folder from the pinned Change button', async (): Promise<void> => {
      jest.mocked(mockCatalog.startSetup).mockResolvedValue(undefined);
      jest.mocked(window.api.browseForCloneDirectory).mockResolvedValue({
        canceled: false,
        directoryPath: '/Users/member/other',
      });
      await renderCatalog(
        [catalogProject({ listed: true })],
        '/Users/member/code',
      );
      // One folder control for the whole list, not one per row (CAN-3469).
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-choose-folder-payments"]',
        ),
      ).toBeNull();
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-change-destination');
        await Promise.resolve();
      });
      await flush();
      expect(window.api.savePreferences).toHaveBeenCalledWith({
        orgProjectDefaultDestinationRoot: '/Users/member/other',
      });
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-destination"]',
        )?.textContent,
      ).toContain('/Users/member/other');
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
      });
      await flush();
      expect(mockCatalog.startSetup).toHaveBeenLastCalledWith(
        'payments',
        '/Users/member/other',
      );
      expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
    });

    it('falls back to the setup dialog when no folder was ever chosen', async (): Promise<void> => {
      await renderCatalog([catalogProject({ listed: true })], undefined);
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-destination"]',
        ),
      ).toBeNull();
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
      });
      expect(mockCatalog.requestSetup).toHaveBeenCalledWith(
        'org-a',
        'payments',
      );
      expect(mockCatalog.startSetup).not.toHaveBeenCalled();
    });

    it('keeps the setup dialog for a project that is not ready to set up', async (): Promise<void> => {
      await renderCatalog(
        [
          catalogProject({
            listed: true,
            repository: {
              provider: 'github',
              host: 'github.com',
              owner: 'acme',
              name: 'payments',
              providerRepoId: '1',
              defaultBranch: 'main',
              verification: 'UNVERIFIED',
            },
          }),
        ],
        '/Users/member/code',
      );
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
      });
      expect(mockCatalog.requestSetup).toHaveBeenCalledWith(
        'org-a',
        'payments',
      );
      expect(mockCatalog.startSetup).not.toHaveBeenCalled();
    });

    it('adds a project with no GitHub repository through the setup dialog, never a clone (CAN-3534)', async (): Promise<void> => {
      await renderCatalog(
        [
          catalogProject({
            listed: true,
            memberOwned: true,
            visibility: 'private',
            repository: null,
          }),
        ],
        '/Users/member/code',
      );
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-row-payments"]',
        )?.textContent,
      ).toContain('Choose the project folder');
      const add = document.querySelector(
        '[data-testid="add-workspace-org-catalog-add-payments"]',
      );
      expect(add instanceof HTMLButtonElement && add.disabled).toBe(false);
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
      });
      // A remembered folder is where clones go; this project clones nothing.
      expect(mockCatalog.requestSetup).toHaveBeenCalledWith(
        'org-a',
        'payments',
      );
      expect(mockCatalog.startSetup).not.toHaveBeenCalled();
    });

    it('reports a setup that could not start', async (): Promise<void> => {
      jest
        .mocked(mockCatalog.startSetup)
        .mockRejectedValue(new Error('Choose an existing absolute folder'));
      await renderCatalog(
        [catalogProject({ listed: true })],
        '/Users/member/code',
      );
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
      });
      await flush();
      expect(mockGitHubState.addToast).toHaveBeenCalledWith(
        'Choose an existing absolute folder',
        'error',
      );
    });

    it('keeps Add unavailable until linked checkouts are resolved', async (): Promise<void> => {
      useLinkedPersonalWorkspacesStore.setState({
        resolvedOrganizationId: null,
      });
      const onClose = await renderCatalog(
        [catalogProject({ listed: true })],
        '/Users/member/code',
      );
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="add-workspace-org-catalog-add-payments"]',
        )?.disabled,
      ).toBe(true);
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
      });
      expect(mockCatalog.startSetup).not.toHaveBeenCalled();
      expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      // Links resolved for another organization do not count here.
      act((): void => {
        useLinkedPersonalWorkspacesStore.setState({
          resolvedOrganizationId: 'org-b',
        });
      });
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="add-workspace-org-catalog-add-payments"]',
        )?.disabled,
      ).toBe(true);
      act((): void => {
        useLinkedPersonalWorkspacesStore.setState({
          resolvedOrganizationId: 'org-a',
          projectIds: ['payments'],
        });
      });
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-row-payments"]',
        )?.textContent,
      ).toContain('Added');
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-add-payments"]',
        ),
      ).toBeNull();
    });

    it('asks for fresh links after listing and starts nothing for a linked project', async (): Promise<void> => {
      // Main links only listed projects, so an unlisted project's Personal
      // checkout is unknown until Add lists it. The store is still empty.
      const linksList = jest.fn().mockResolvedValue({
        status: 'resolved',
        links: [{ projectId: 'payments', personalWorkspaceId: 'payments-2' }],
      });
      Object.assign(window.api.orgProjects, { linksList });
      const onClose = await renderCatalog(
        [catalogProject({})],
        '/Users/member/code',
      );
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
      });
      await flush();
      expect(mockCatalog.setPreference).toHaveBeenCalledWith(
        { kind: 'organization', organizationId: 'org-a' },
        'payments',
        'ADDED',
      );
      expect(linksList).toHaveBeenCalled();
      expect(mockCatalog.startSetup).not.toHaveBeenCalled();
      expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('hands the project to the setup dialog when fresh links are unknown', async (): Promise<void> => {
      const linksList = jest.fn().mockResolvedValue({
        status: 'unknown',
        reason: 'remote-unavailable',
      });
      Object.assign(window.api.orgProjects, { linksList });
      await renderCatalog([catalogProject({})], '/Users/member/code');
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
      });
      await flush();
      expect(mockCatalog.startSetup).not.toHaveBeenCalled();
      expect(mockCatalog.requestSetup).toHaveBeenCalledWith(
        'org-a',
        'payments',
      );
    });

    it('does not start setup when a link arrives before the start', async (): Promise<void> => {
      // Listing awaits the server; a links answer can land in between.
      jest
        .mocked(mockCatalog.setPreference)
        .mockImplementationOnce(async (): Promise<void> => {
          useLinkedPersonalWorkspacesStore.setState({
            projectIds: ['payments'],
          });
          await Promise.resolve();
        });
      const onClose = await renderCatalog(
        [catalogProject({})],
        '/Users/member/code',
      );
      await act(async (): Promise<void> => {
        click('add-workspace-org-catalog-add-payments');
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockCatalog.setPreference).toHaveBeenCalledTimes(1);
      expect(mockCatalog.startSetup).not.toHaveBeenCalled();
      expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('shows a project with a linked Personal checkout as on this computer', async (): Promise<void> => {
      useLinkedPersonalWorkspacesStore.setState({
        ids: ['payments-2'],
        projectIds: ['payments'],
      });
      await renderCatalog(
        [
          catalogProject({ listed: true }),
          catalogProject({ id: 'billing', name: 'Billing', listed: true }),
        ],
        '/Users/member/code',
      );
      const row = document.querySelector(
        '[data-testid="add-workspace-org-catalog-row-payments"]',
      );
      expect(row?.textContent).toContain('Added');
      expect(row?.textContent).not.toContain('Ready to set up');
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-add-payments"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-add-billing"]',
        ),
      ).not.toBeNull();
    });
  });

  it('keeps setup unrequested when listing the added project fails', async (): Promise<void> => {
    openOrganization();
    const project: OrgProjectSummary = {
      id: 'payments',
      organizationId: 'org-a',
      name: 'Payments',
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'organization',
      memberOwned: false,
      location: 'LOCAL',
      repository: {
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'payments',
        providerRepoId: '1',
        defaultBranch: 'main',
        verification: 'VERIFIED',
      },
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: false,
      preference: 'FOLLOW_DEFAULTS',
      listed: false,
      capabilities: { use: true, administer: false, manageCloud: false },
      instance: null,
    };
    Object.assign(mockCatalog, {
      snapshots: {
        'org:org-a': {
          context: 'org:org-a',
          revision: '1',
          fetchedAt: '',
          projects: [project],
        },
      },
    });
    jest
      .mocked(mockCatalog.setPreference)
      .mockRejectedValueOnce(new Error('refused'));
    const onClose = jest.fn();
    await act(async (): Promise<void> => {
      root.render(<AddRepoModal isOpen onClose={onClose} />);
      await Promise.resolve();
    });
    await act(async (): Promise<void> => {
      click('add-workspace-org-catalog-add-payments');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Failed to add project');
    expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    Object.assign(mockCatalog, { snapshots: {}, setupProgress: {} });
  });

  it.each(['offline', 'access-changed'])(
    'explains a catalog %s state',
    async (error): Promise<void> => {
      const flags = getDefaultFeatureFlagSnapshot();
      flags.values['canopy-shared-org-projects-enabled'] = true;
      useFeatureFlagsStore.setState({ snapshot: flags });
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'organization', organizationId: 'org-a' },
          revision: 1,
          organizations: [{ id: 'org-a', name: 'Acme', role: 'MEMBER' }],
        },
      });
      Object.assign(mockCatalog, {
        snapshots: {
          'org:org-a': {
            context: 'org:org-a',
            revision: '1',
            fetchedAt: '',
            projects: [],
            stale: true,
            error,
          },
        },
      });
      await act(async (): Promise<void> => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
        await Promise.resolve();
      });
      expect(document.body.textContent).toContain(
        error === 'offline' ? 'Offline' : 'Access changed',
      );
      expect(document.body.textContent).not.toContain('Nothing in');
      Object.assign(mockCatalog, { snapshots: {}, setupProgress: {} });
    },
  );

  it('does not read the sidebar scoping context while the dialog is closed', () => {
    getGitHubPermissions.mockResolvedValue(permissions({}));
    useSidebarScopingContextMock.mockClear();
    act(() => {
      root.render(<AddRepoModal isOpen={false} onClose={jest.fn()} />);
    });
    expect(useSidebarScopingContextMock).not.toHaveBeenCalled();
    act(() => {
      root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
    });
    expect(useSidebarScopingContextMock).toHaveBeenCalled();
  });

  it('waits for the workspace context to hydrate before showing the organization mode row, like the sidebar', () => {
    const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    getGitHubPermissions.mockResolvedValue(permissions({}));
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: ORG_A },
        revision: 1,
        organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
      },
      hydrated: false,
    });
    try {
      act(() => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      });
      expect(
        document.querySelector('[data-testid="add-workspace-org-mode"]'),
      ).toBeNull();
    } finally {
      useFeatureFlagsStore.setState({
        snapshot: getDefaultFeatureFlagSnapshot(),
      });
      useWorkspaceContextStore.setState({ hydrated: true });
    }
  });

  it('refreshes GitHub permissions on open before choosing the remote project flow', async () => {
    getGitHubPermissions
      .mockResolvedValueOnce(
        permissions({
          error: 'GitHub auth is not configured.',
        }),
      )
      .mockResolvedValueOnce(
        permissions({
          tokenAvailable: true,
          tokenType: 'gh-cli',
          canListRepos: true,
        }),
      );
    listUserGitHubRepos.mockResolvedValue([repo()]);

    act(() => {
      root.render(<AddRepoModal isOpen={false} onClose={jest.fn()} />);
    });

    await waitFor(() => {
      expect(getGitHubPermissions).toHaveBeenCalledTimes(1);
    });
    await flush();

    act(() => {
      root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
    });

    await waitFor(() => {
      expect(getGitHubPermissions).toHaveBeenCalledTimes(2);
    });

    clickButton(container, 'Clone repository');

    await waitFor(() => {
      expect(listUserGitHubRepos).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector(
          '[data-testid="add-workspace-github-repo-list"]',
        ),
      ).not.toBeNull();
      expect(container.textContent).toContain('octo/repo');
    });
  });

  it('seeds the Remote → URL clone input from initialRepoUrl on open', async () => {
    getGitHubPermissions.mockResolvedValue(permissions({}));

    act(() => {
      root.render(
        <AddRepoModal
          isOpen
          onClose={jest.fn()}
          initialRepoUrl="https://github.com/other/repo"
        />,
      );
    });

    await waitFor(() => {
      expect(getGitHubPermissions).toHaveBeenCalledTimes(1);
    });

    // The seed switches to the Remote → URL flow and pre-fills the URL input
    // (located by its placeholder) so the existing clone/reuse machinery runs.
    await waitFor(() => {
      const urlInput = Array.from(container.querySelectorAll('input')).find(
        (input) =>
          input.getAttribute('placeholder') ===
          'https://github.com/org/repo.git',
      );
      if (!(urlInput instanceof HTMLInputElement)) {
        throw new Error('Remote URL input not found');
      }
      expect(urlInput.value).toBe('https://github.com/other/repo');
    });
  });

  it('creates a new Cowork project, activates it, and navigates to chat', async () => {
    getGitHubPermissions.mockResolvedValue(permissions({}));
    const createdProject = { id: 'cowork-new' };
    mockStandaloneChatState.createChatProject.mockResolvedValue(createdProject);
    mockStandaloneChatState.activateCreatedCoworkWorkspace.mockResolvedValue(
      true,
    );
    const onClose = jest.fn();

    act(() => {
      root.render(<AddRepoModal isOpen onClose={onClose} />);
    });

    await waitFor(() => {
      expect(getGitHubPermissions).toHaveBeenCalledTimes(1);
    });

    const createModeButton = container.querySelector(
      '[data-testid="add-workspace-mode-create"]',
    );
    if (!(createModeButton instanceof HTMLButtonElement)) {
      throw new Error('Create-new mode button not found');
    }
    act(() => {
      createModeButton.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    const coworkTypeButton = container.querySelector(
      '[data-testid="add-workspace-type-cowork"]',
    );
    if (!(coworkTypeButton instanceof HTMLButtonElement)) {
      throw new Error('Cowork type button not found');
    }
    act(() => {
      coworkTypeButton.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    const nameInput = container.querySelector(
      '[data-testid="add-workspace-name-input"]',
    );
    if (!(nameInput instanceof HTMLInputElement)) {
      throw new Error('Project name input not found');
    }
    // Native DOM property setter, not an object method; explicitly bound to
    // `nameInput` via Reflect.apply so `this` scoping is not a concern.
    /* eslint-disable @typescript-eslint/unbound-method */
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      if (nativeInputValueSetter) {
        Reflect.apply(nativeInputValueSetter, nameInput, ['My Cowork Space']);
      }
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    /* eslint-enable @typescript-eslint/unbound-method */

    const submitButton = container.querySelector(
      '[data-testid="add-workspace-create-submit"]',
    );
    if (!(submitButton instanceof HTMLButtonElement)) {
      throw new Error('Create submit button not found');
    }
    act(() => {
      submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => {
      expect(mockStandaloneChatState.createChatProject).toHaveBeenCalledWith(
        'My Cowork Space',
      );
      expect(mockProjectsState.loadProjects).toHaveBeenCalledWith({
        silent: true,
      });
      expect(
        mockStandaloneChatState.activateCreatedCoworkWorkspace,
      ).toHaveBeenCalledWith('cowork-new');
      expect(mockNavigationState.navigate).toHaveBeenCalledWith('chat');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('opens an added non-git folder as an active Cowork project chat', async () => {
    getGitHubPermissions.mockResolvedValue(permissions({}));
    mockProjectsState.browseForRepo.mockResolvedValue({
      path: '/Users/me/notes',
      name: 'notes',
    });
    mockProjectsState.addLocalRepo.mockImplementation(() => {
      mockProjectsState.projects = [
        {
          id: 'cowork-folder',
          type: 'cowork',
          name: 'notes',
          color: '#7c3aed',
          collapsed: false,
          order: 0,
          externalPath: '/Users/me/notes',
        },
      ];
      return Promise.resolve({ id: 'cowork-folder', type: 'cowork' });
    });
    const onClose = jest.fn();
    const onWorkspaceCreated = jest.fn();

    act(() => {
      root.render(
        <AddRepoModal
          isOpen
          onClose={onClose}
          onWorkspaceCreated={onWorkspaceCreated}
        />,
      );
    });

    await waitFor(() => {
      expect(getGitHubPermissions).toHaveBeenCalledTimes(1);
    });
    click('add-workspace-mode-existing');

    const chooseFolderButton = container.querySelector(
      '[data-testid="add-workspace-choose-folder"]',
    );
    if (!(chooseFolderButton instanceof HTMLButtonElement)) {
      throw new Error('Choose folder button not found');
    }
    act(() => {
      chooseFolderButton.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    await waitFor(() => {
      expect(mockProjectsState.addLocalRepo).toHaveBeenCalledWith(
        '/Users/me/notes',
        { activate: false },
      );
      expect(mockNavigationState.navigate).toHaveBeenCalledWith('chat');
      expect(onWorkspaceCreated).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('preselects a new Code project and lands in the New Task composer without creating a worktree', () => {
    mockProjectsState.projects = [
      {
        id: 'code-workspace',
        type: 'single-repo',
        name: 'app',
        repoPath: '/repos/app',
        color: '#7c3aed',
        collapsed: false,
        order: 0,
        worktrees: [],
      },
    ];

    navigateAfterRepositoryWorkspaceCreated('code-workspace');

    expect(mockHomeComposerState.selectWorkspace).toHaveBeenCalledWith(
      'code-workspace',
    );
    // The composer IS the next action for a brand-new workspace — describe a
    // task and a worktree is created for it. `navigate('home')` also bumps
    // `homeComposerFocusRequest`, so the page-variant composer autofocuses.
    expect(mockNavigationState.navigate).toHaveBeenCalledWith('home');
    // Exactly one navigation: a transient hop through another page would
    // satisfy `toHaveBeenCalledWith` alone.
    expect(mockNavigationState.navigate).toHaveBeenCalledTimes(1);
  });

  it('never navigates for a cowork project', () => {
    // Unreachable from AddRepoModal today (its cowork paths call
    // navigate('chat') and skip onWorkspaceCreated), but the guard is the
    // backstop that keeps a future caller from yanking a cowork user into the
    // code-workspace New Task composer.
    mockProjectsState.projects = [
      {
        id: 'cowork-1',
        type: 'cowork',
        name: 'notes',
        color: '#7c3aed',
        collapsed: false,
        order: 0,
      },
    ];

    navigateAfterRepositoryWorkspaceCreated('cowork-1');

    expect(mockHomeComposerState.selectWorkspace).toHaveBeenCalledWith(
      'cowork-1',
    );
    expect(mockNavigationState.navigate).not.toHaveBeenCalled();
  });

  it('never navigates for a project id that has not hydrated', () => {
    mockProjectsState.projects = [];

    navigateAfterRepositoryWorkspaceCreated('unknown-workspace');

    expect(mockNavigationState.navigate).not.toHaveBeenCalled();
  });

  it('preserves the destination of temporary flows that already created a worktree', () => {
    mockProjectsState.projects = [
      {
        id: 'temporary',
        type: 'multi-repo',
        name: 'Temporary',
        color: '#7c3aed',
        collapsed: false,
        order: 0,
        repos: [],
        temporary: true,
        worktrees: [
          {
            id: 'worktree-1',
            branchName: 'feature',
            createdAt: new Date(0).toISOString(),
          },
        ],
      },
    ];

    navigateAfterRepositoryWorkspaceCreated('temporary');

    expect(mockHomeComposerState.selectWorkspace).toHaveBeenCalledWith(
      'temporary',
    );
    expect(mockNavigationState.navigate).not.toHaveBeenCalled();
  });

  it('keeps Home mounted while a create-from flow resumes in the new project', () => {
    mockHomeComposerState.pendingCreateFromReference =
      'https://github.com/octo/repo/pull/123';
    mockProjectsState.projects = [
      {
        id: 'code-workspace',
        type: 'single-repo',
        name: 'app',
        repoPath: '/repos/app',
        color: '#7c3aed',
        collapsed: false,
        order: 0,
        worktrees: [],
      },
    ];

    navigateAfterRepositoryWorkspaceCreated('code-workspace');

    expect(mockHomeComposerState.selectWorkspace).toHaveBeenCalledWith(
      'code-workspace',
    );
    expect(mockNavigationState.navigate).not.toHaveBeenCalled();
  });

  describe('GitHub-style rows and a fresh list on open (CAN-3489)', () => {
    const MINUTE = 60_000;

    function row(
      id: string,
      repository: Partial<NonNullable<OrgProjectSummary['repository']>>,
      overrides: Partial<OrgProjectSummary> = {},
    ): OrgProjectSummary {
      return {
        id,
        organizationId: 'org-a',
        name: `Project ${id}`,
        description: null,
        kind: 'CODE',
        location: 'LOCAL',
        repository: {
          provider: 'github',
          host: 'github.com',
          owner: 'acme',
          name: id,
          providerRepoId: id,
          defaultBranch: 'main',
          verification: 'VERIFIED',
          ...repository,
        },
        state: 'ACTIVE',
        revision: 1,
        authorizationVersion: 1,
        defaultListed: false,
        preference: 'FOLLOW_DEFAULTS',
        listed: false,
        capabilities: { use: true, administer: false, manageCloud: false },
        instance: null,
        ...overrides,
        purpose: overrides.purpose ?? 'project',
        visibility: overrides.visibility ?? 'organization',
        memberOwned: overrides.memberOwned ?? false,
      };
    }

    async function renderRows(
      projects: OrgProjectSummary[],
      extra: Record<string, unknown> = {},
    ): Promise<void> {
      openOrganization();
      Object.assign(mockCatalog, {
        snapshots: {
          'org:org-a': {
            context: 'org:org-a',
            revision: '1',
            fetchedAt: '',
            projects,
            ...extra,
          },
        },
      });
      await act(async (): Promise<void> => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
        await Promise.resolve();
      });
      await flush();
    }

    function rowIds(group: string): string[] {
      return Array.from(
        document.querySelectorAll(
          `section[aria-label="${group}"] [data-testid^="add-workspace-org-catalog-row-"]`,
        ),
      ).map((element) =>
        (element.getAttribute('data-testid') ?? '').replace(
          'add-workspace-org-catalog-row-',
          '',
        ),
      );
    }

    afterEach((): void => {
      Object.assign(mockCatalog, { snapshots: {}, setupProgress: {} });
    });

    it('shows the repository name, description, type, and last update', async (): Promise<void> => {
      await renderRows([
        row('payments', {
          description: 'Moves money between accounts',
          visibility: 'INTERNAL',
          updatedAt: new Date(Date.now() - 7 * MINUTE).toISOString(),
        }),
      ]);

      const element = document.querySelector(
        '[data-testid="add-workspace-org-catalog-row-payments"]',
      );
      expect(
        element?.querySelector(
          '[data-testid="add-workspace-org-catalog-name-payments"]',
        )?.textContent,
      ).toBe('payments');
      expect(
        element?.querySelector(
          '[data-testid="add-workspace-org-catalog-description-payments"]',
        )?.textContent,
      ).toBe('Moves money between accounts');
      expect(
        element?.querySelector(
          '[data-testid="add-workspace-org-catalog-visibility-payments"]',
        )?.textContent,
      ).toBe('Internal');
      expect(
        element?.querySelector(
          '[data-testid="add-workspace-org-catalog-updated-payments"]',
        )?.textContent,
      ).toBe('Updated 7m ago');
      // The owner is every row's, so it is not repeated (CAN-3489).
      expect(element?.textContent).not.toContain('acme/');
    });

    it('labels each visibility and leaves out what GitHub has not told us', async (): Promise<void> => {
      await renderRows([
        row('open', { visibility: 'PUBLIC' }),
        row('closed', { visibility: 'PRIVATE' }),
        row('unknown', {}),
      ]);

      const label = (id: string): string | null | undefined =>
        document.querySelector(
          `[data-testid="add-workspace-org-catalog-visibility-${id}"]`,
        )?.textContent;
      expect(label('open')).toBe('Public');
      expect(label('closed')).toBe('Private');
      expect(label('unknown')).toBeUndefined();
      for (const part of ['description', 'updated'])
        expect(
          document.querySelector(
            `[data-testid="add-workspace-org-catalog-${part}-unknown"]`,
          ),
        ).toBeNull();
    });

    it('lists the most recently updated repositories first, like GitHub', async (): Promise<void> => {
      const ago = (minutes: number): string =>
        new Date(Date.now() - minutes * MINUTE).toISOString();
      await renderRows([
        row('old', { updatedAt: ago(600) }),
        row('never', {}),
        row('newest', { updatedAt: ago(1) }),
        row('middle', { updatedAt: ago(60) }),
        row('added-old', { updatedAt: ago(900) }, { listed: true }),
        row('added-new', { updatedAt: ago(2) }, { listed: true }),
      ]);

      // One list (CAN-3469): whether a project is listed does not split it.
      expect(rowIds('Projects')).toEqual([
        'newest',
        'added-new',
        'middle',
        'old',
        'added-old',
        'never',
      ]);
    });

    it('reloads the list from GitHub each time it opens, after showing what it has', async (): Promise<void> => {
      await renderRows([row('payments', {})]);

      expect(jest.mocked(mockCatalog.load).mock.calls).toEqual([
        [{ kind: 'organization', organizationId: 'org-a' }],
        [
          { kind: 'organization', organizationId: 'org-a' },
          { refresh: true, repositories: true },
        ],
      ]);
    });

    it('notes quietly when GitHub could not be read, and keeps Add', async (): Promise<void> => {
      await renderRows([row('payments', {})], {
        stale: false,
        error: null,
        repositoriesRefresh: 'failed',
      });

      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-github-refresh-failed"]',
        )?.textContent,
      ).toBe("Couldn't refresh from GitHub. New repositories may be missing.");
      expect(
        document
          .querySelector(
            '[data-testid="add-workspace-org-catalog-add-payments"]',
          )
          ?.hasAttribute('disabled'),
      ).toBe(false);
    });

    it('shows no note when GitHub was read', async (): Promise<void> => {
      await renderRows([row('payments', {})], { stale: false, error: null });

      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-catalog-github-refresh-failed"]',
        ),
      ).toBeNull();
    });
  });

  describe('slow clones (background hand-off)', () => {
    function testId(id: string): HTMLElement | null {
      const el = container.querySelector(`[data-testid="${id}"]`);
      return el instanceof HTMLElement ? el : null;
    }

    async function startClone(
      onClose: jest.Mock,
      onWorkspaceCreated: jest.Mock,
      options: { privateMemory?: boolean } = {},
    ): Promise<void> {
      getGitHubPermissions.mockResolvedValue(
        permissions({ canListRepos: false }),
      );
      Object.assign(window.api, {
        probeCloneDestination: jest.fn().mockResolvedValue({
          repoName: 'big-repo',
          candidateExists: false,
          reusablePath: null,
        }),
      });
      act(() => {
        root.render(
          <AddRepoModal
            isOpen
            onClose={onClose}
            onWorkspaceCreated={onWorkspaceCreated}
          />,
        );
      });
      await flush();
      act(() => {
        testId('add-workspace-mode-remote')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });
      await waitFor(() => {
        expect(testId('add-workspace-remote-url-input')).not.toBeNull();
      });
      const input = testId('add-workspace-remote-url-input');
      if (!(input instanceof HTMLInputElement))
        throw new Error('Remote URL input not found');
      act(() => {
        setNativeInputValue(input, 'https://github.com/org/big-repo.git');
      });
      await waitFor(() => {
        expect(testId('add-workspace-clone-destination')?.textContent).toBe(
          'Downloads toC:\\reposChange',
        );
      });
      if (options.privateMemory === true) togglePrivateMemory();
      act(() => {
        testId('add-workspace-clone-submit')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });
      await waitFor(() => {
        expect(mockProjectsState.addRemoteRepo).toHaveBeenCalledTimes(1);
      });
      const [call] = mockProjectsState.addRemoteRepo.mock.calls;
      expect(call?.slice(0, 2)).toEqual([
        'https://github.com/org/big-repo.git',
        'C:\\repos',
      ]);
      expect(cloneJobId()).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }

    function cloneJobId(): string {
      const jobId = mockProjectsState.addRemoteRepo.mock.calls[0]?.[2]?.jobId;
      if (jobId === undefined) throw new Error('Clone job id missing');
      return jobId;
    }

    it('hands a clone still running after the hand-off delay to the sidebar', async () => {
      const onClose = jest.fn();
      const onWorkspaceCreated = jest.fn();
      let finishClone: (workspaceId: string) => void = () => undefined;
      mockProjectsState.addRemoteRepo.mockReturnValue(
        new Promise<string>((resolve) => {
          finishClone = resolve;
        }),
      );
      const backgroundCloneJob = jest.fn().mockResolvedValue(true);
      Object.assign(window.api, { backgroundCloneJob });

      await startClone(onClose, onWorkspaceCreated);
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => {
        resolveCloneHandoff();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(backgroundCloneJob).toHaveBeenCalledWith(cloneJobId());
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        finishClone('big-repo');
        await Promise.resolve();
      });
      await flush();
      expect(onWorkspaceCreated).not.toHaveBeenCalled();
      expect(mockNavigationState.navigate).not.toHaveBeenCalled();
    });

    it('offers the Cursor rules review when a handed-off clone lands (CAN-2053)', async () => {
      let finishClone: (workspaceId: string) => void = () => undefined;
      mockProjectsState.addRemoteRepo.mockReturnValue(
        new Promise<string>((resolve) => {
          finishClone = resolve;
        }),
      );
      Object.assign(window.api, {
        backgroundCloneJob: jest.fn().mockResolvedValue(true),
      });
      jest.mocked(offerCursorRulesReview).mockClear();

      await startClone(jest.fn(), jest.fn());
      await act(async () => {
        resolveCloneHandoff();
        await Promise.resolve();
      });
      await flush();
      expect(offerCursorRulesReview).not.toHaveBeenCalled();

      await act(async () => {
        finishClone('big-repo');
        await Promise.resolve();
      });
      await flush();
      expect(offerCursorRulesReview).toHaveBeenCalledWith(
        [{ workspaceId: 'big-repo' }],
        'add-project',
      );
    });

    it('still hands the clone to the sidebar when the dialog was dismissed first', async () => {
      const onClose = jest.fn();
      mockProjectsState.addRemoteRepo.mockReturnValue(
        new Promise<string>(() => undefined),
      );
      const backgroundCloneJob = jest.fn().mockResolvedValue(true);
      Object.assign(window.api, { backgroundCloneJob });

      await startClone(onClose, jest.fn());
      act(() => {
        root.render(<AddRepoModal isOpen={false} onClose={onClose} />);
      });
      await act(async () => {
        resolveCloneHandoff();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(backgroundCloneJob).toHaveBeenCalledWith(cloneJobId());
      });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('finishes in the dialog when the clone completes before the hand-off', async () => {
      const onClose = jest.fn();
      const onWorkspaceCreated = jest.fn();
      mockProjectsState.addRemoteRepo.mockResolvedValue('big-repo');
      const backgroundCloneJob = jest.fn().mockResolvedValue(true);
      Object.assign(window.api, { backgroundCloneJob });

      await startClone(onClose, onWorkspaceCreated);
      await waitFor(() => {
        expect(onWorkspaceCreated).toHaveBeenCalledWith('big-repo');
      });
      await act(async () => {
        resolveCloneHandoff();
        await Promise.resolve();
      });
      await flush();
      expect(backgroundCloneJob).not.toHaveBeenCalled();
    });

    it('turns on Private memory before a clone that finishes in the dialog is opened (CAN-3562)', async () => {
      const onWorkspaceCreated = jest.fn();
      mockProjectsState.addRemoteRepo.mockResolvedValue('big-repo');
      Object.assign(window.api, {
        backgroundCloneJob: jest.fn().mockResolvedValue(true),
      });

      await startClone(jest.fn(), onWorkspaceCreated, { privateMemory: true });
      await waitFor(() => {
        expect(onWorkspaceCreated).toHaveBeenCalledWith('big-repo');
      });
      expect(savePrivateMemory).toHaveBeenCalledWith('big-repo', true);
      expect(savePrivateMemory.mock.invocationCallOrder[0]).toBeLessThan(
        onWorkspaceCreated.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('turns on Private memory when a handed-off clone lands, and reports a failed save (CAN-3562)', async () => {
      const onClose = jest.fn();
      const onWorkspaceCreated = jest.fn();
      let finishClone: (workspaceId: string) => void = () => undefined;
      mockProjectsState.addRemoteRepo.mockReturnValue(
        new Promise<string>((resolve) => {
          finishClone = resolve;
        }),
      );
      Object.assign(window.api, {
        backgroundCloneJob: jest.fn().mockResolvedValue(true),
      });
      savePrivateMemory.mockRejectedValue(new Error('disk full'));

      await startClone(onClose, onWorkspaceCreated, { privateMemory: true });
      await act(async () => {
        resolveCloneHandoff();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      // Nothing is written until the project exists.
      expect(savePrivateMemory).not.toHaveBeenCalled();

      await act(async () => {
        finishClone('big-repo');
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(savePrivateMemory).toHaveBeenCalledWith('big-repo', true);
        expect(mockGitHubState.addToast).toHaveBeenCalledWith(
          "Couldn't turn on Private memory for the project you added. Turn it on in the project's settings before you start a chat.",
          'error',
          undefined,
          { forceInApp: true, title: 'Private memory is off' },
        );
      });
      expect(onWorkspaceCreated).not.toHaveBeenCalled();
    });

    it('writes nothing for a handed-off clone that left Private memory off (CAN-3562)', async () => {
      let finishClone: (workspaceId: string) => void = () => undefined;
      mockProjectsState.addRemoteRepo.mockReturnValue(
        new Promise<string>((resolve) => {
          finishClone = resolve;
        }),
      );
      Object.assign(window.api, {
        backgroundCloneJob: jest.fn().mockResolvedValue(true),
      });

      await startClone(jest.fn(), jest.fn());
      await act(async () => {
        resolveCloneHandoff();
        await Promise.resolve();
      });
      await act(async () => {
        finishClone('big-repo');
        await Promise.resolve();
      });
      await flush();
      expect(savePrivateMemory).not.toHaveBeenCalled();
    });

    it('stays in the dialog when the clone finished just as the hand-off began', async () => {
      const onClose = jest.fn();
      const onWorkspaceCreated = jest.fn();
      let finishClone: (workspaceId: string) => void = () => undefined;
      mockProjectsState.addRemoteRepo.mockReturnValue(
        new Promise<string>((resolve) => {
          finishClone = resolve;
        }),
      );
      const backgroundCloneJob = jest.fn().mockResolvedValue(false);
      Object.assign(window.api, { backgroundCloneJob });

      await startClone(onClose, onWorkspaceCreated);
      await act(async () => {
        resolveCloneHandoff();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(backgroundCloneJob).toHaveBeenCalled();
      });
      await act(async () => {
        finishClone('big-repo');
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(onWorkspaceCreated).toHaveBeenCalledWith('big-repo');
      });
    });

    it.each([
      'This change was saved but did not finish and needs recovery.',
      'This request was saved but did not finish and needs recovery.',
      'An earlier attempt of this request was interrupted and needs recovery.',
      "Error invoking remote method 'workspace:add-from-remote': Error: This change was saved but did not finish and needs recovery.",
      "Error invoking remote method 'workspace:add-from-remote': W5CommitRefusedError: This change was saved but did not finish and needs recovery.",
    ])(
      'preserves workspace recovery guidance before the hand-off: %s',
      async (message) => {
        const onClose = jest.fn();
        const onWorkspaceCreated = jest.fn();
        mockProjectsState.addRemoteRepo.mockRejectedValue(new Error(message));

        await startClone(onClose, onWorkspaceCreated);
        await waitFor(() => {
          expect(testId('add-workspace-error')?.textContent).toBe(
            message.replace(
              /^Error invoking remote method '[^']+': (?:Error|W5CommitRefusedError): /,
              '',
            ),
          );
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(onWorkspaceCreated).not.toHaveBeenCalled();
      },
    );

    it.each([
      "fatal: repository 'x' not found",
      'This change was saved but did not finish and needs recovery. fatal: private diagnostics',
      "Error invoking remote method 'workspace:add-from-remote': GitHubAuthFailureError: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ])(
      'shows safe clone failure copy before the hand-off: %s',
      async (message) => {
        const onClose = jest.fn();
        mockProjectsState.addRemoteRepo.mockRejectedValue(new Error(message));
        Object.assign(window.api, { backgroundCloneJob: jest.fn() });

        await startClone(onClose, jest.fn());
        await waitFor(() => {
          expect(testId('add-workspace-error')?.textContent).toContain(
            'Failed to clone the repository. Check the URL and access, then try again.',
          );
        });
        expect(testId('add-workspace-error')?.getAttribute('role')).toBe(
          'alert',
        );
        expect(onClose).not.toHaveBeenCalled();
      },
    );
  });

  describe('Clone panel (CAN-3909)', () => {
    function testId(id: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    }

    async function openClone(
      probe: unknown,
      onWorkspaceCreated: jest.Mock = jest.fn(),
    ): Promise<void> {
      Object.assign(window.api, {
        probeCloneDestination: jest.fn().mockResolvedValue(probe),
      });
      act(() => {
        root.render(
          <AddRepoModal
            isOpen
            onClose={jest.fn()}
            onWorkspaceCreated={onWorkspaceCreated}
          />,
        );
      });
      await waitFor(() => {
        expect(
          testId('add-workspace-clone-destination')?.querySelector('bdi')
            ?.textContent,
        ).toBe('C:\\repos');
      });
      const input = testId('add-workspace-remote-url-input');
      if (!(input instanceof HTMLInputElement))
        throw new Error('Remote URL input not found');
      act(() => {
        setNativeInputValue(input, 'https://github.com/org/big-repo.git');
      });
    }

    it('changes the destination through the folder picker', async () => {
      jest.mocked(window.api.browseForCloneDirectory).mockResolvedValue({
        canceled: false,
        directoryPath: 'D:\\work',
      });
      await openClone({
        repoName: 'big-repo',
        candidateExists: false,
        reusablePath: null,
      });
      expect(
        container.querySelector(
          '[data-testid="add-workspace-remote-panel"] label',
        )?.textContent,
      ).toContain('Repository URL');
      await act(async () => {
        click('add-workspace-clone-destination-change');
        await Promise.resolve();
      });
      await flush();
      expect(window.api.browseForCloneDirectory).toHaveBeenCalledTimes(1);
      expect(
        testId('add-workspace-clone-destination')?.querySelector('bdi')
          ?.textContent,
      ).toBe('D:\\work');
    });

    it('keeps Clone and add reading "Clone and add" while the folder picker is open', async () => {
      // Opening the picker locks the form, but nothing is cloning yet.
      let answer: (value: {
        canceled: boolean;
        directoryPath: string | null;
      }) => void = () => undefined;
      jest.mocked(window.api.browseForCloneDirectory).mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      await openClone({
        repoName: 'big-repo',
        candidateExists: false,
        reusablePath: null,
      });
      await act(async () => {
        click('add-workspace-clone-destination-change');
        await Promise.resolve();
      });
      const submit = testId('add-workspace-clone-submit');
      expect(submit?.textContent).toBe('Clone and add');
      expect(submit?.hasAttribute('disabled')).toBe(true);
      await act(async () => {
        answer({ canceled: true, directoryPath: null });
        await Promise.resolve();
      });
      await flush();
      expect(testId('add-workspace-clone-submit')?.textContent).toBe(
        'Clone and add',
      );
    });

    it('shows progress only on the found-clone action that is running', async () => {
      mockProjectsState.addLocalRepo.mockReturnValue(new Promise(() => {}));
      await openClone({
        repoName: 'big-repo',
        candidateExists: true,
        reusablePath: 'C:\\repos\\big-repo',
      });
      await act(async () => {
        click('add-workspace-clone-submit');
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(testId('add-workspace-reuse-clone')).not.toBeNull();
      });
      await act(async () => {
        click('add-workspace-reuse-clone-existing');
        await Promise.resolve();
      });
      expect(testId('add-workspace-reuse-clone-existing')?.textContent).toBe(
        'Adding…',
      );
      expect(testId('add-workspace-reuse-clone-new')?.textContent).toBe(
        'Create a new copy',
      );
    });

    it('withdraws a found clone when the source changes', async () => {
      getGitHubPermissions.mockResolvedValue(
        permissions({ tokenAvailable: true, canListRepos: true }),
      );
      listUserGitHubRepos.mockResolvedValue([repo()]);
      await act(async () => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(testId('add-workspace-remote-source-url')).not.toBeNull();
      });
      click('add-workspace-remote-source-url');
      await openClone({
        repoName: 'big-repo',
        candidateExists: true,
        reusablePath: 'C:\\repos\\big-repo',
      });
      await act(async () => {
        click('add-workspace-clone-submit');
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(testId('add-workspace-reuse-clone')).not.toBeNull();
      });
      act(() => {
        click('add-workspace-remote-source-github');
      });
      expect(testId('add-workspace-reuse-clone')).toBeNull();
      expect(testId('add-workspace-clone-submit')).not.toBeNull();
    });

    it('offers a found clone as a notice with a new copy or this copy', async () => {
      mockProjectsState.addLocalRepo.mockResolvedValue({
        id: 'big-repo',
        type: 'single-repo',
      });
      const onWorkspaceCreated = jest.fn();
      await openClone(
        {
          repoName: 'big-repo',
          candidateExists: true,
          reusablePath: 'C:\\repos\\big-repo',
        },
        onWorkspaceCreated,
      );
      await act(async () => {
        click('add-workspace-clone-submit');
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(testId('add-workspace-reuse-clone')).not.toBeNull();
      });
      const notice = testId('add-workspace-reuse-clone');
      expect(notice?.textContent).toContain(
        'This repository is already cloned here.',
      );
      expect(notice?.textContent).toContain('C:\\repos\\big-repo');
      expect(
        Array.from(notice?.querySelectorAll('button') ?? [], (b) =>
          b.getAttribute('data-testid'),
        ),
      ).toEqual([
        'add-workspace-reuse-clone-new',
        'add-workspace-reuse-clone-existing',
      ]);
      expect(testId('add-workspace-reuse-clone-new')?.textContent).toBe(
        'Create a new copy',
      );
      expect(testId('add-workspace-reuse-clone-existing')?.textContent).toBe(
        'Use this copy',
      );
      // The prompt replaces the form's own action and Private memory.
      expect(testId('add-workspace-clone-submit')).toBeNull();
      expect(testId('add-workspace-private-memory')).toBeNull();
      await act(async () => {
        click('add-workspace-reuse-clone-existing');
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(onWorkspaceCreated).toHaveBeenCalledWith('big-repo');
      });
      expect(mockProjectsState.addLocalRepo).toHaveBeenCalledWith(
        'C:\\repos\\big-repo',
        { activate: false },
      );
      expect(mockProjectsState.addRemoteRepo).not.toHaveBeenCalled();
    });
  });

  describe('folder drop (CAN-3909)', () => {
    function dropTarget(): HTMLElement {
      const target = container.querySelector<HTMLElement>(
        '[data-testid="add-workspace-drop-target"]',
      );
      if (target === null) throw new Error('Drop target not found');
      return target;
    }

    async function openPersonal(): Promise<void> {
      Object.assign(window.api, {
        getPathForFile: jest.fn(() => '/Users/me/payments'),
      });
      mockProjectsState.addLocalRepo.mockResolvedValue({
        id: 'payments',
        type: 'single-repo',
      });
      await act(async (): Promise<void> => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
        await Promise.resolve();
      });
    }

    it('adds a folder dropped on another panel through the Existing folder checks', async () => {
      await openPersonal();
      // The dialog opens on Clone; the drop still lands.
      expect(
        container.querySelector('[data-testid="add-workspace-remote-panel"]'),
      ).not.toBeNull();
      const over = folderDragEvent('dragover', { isDirectory: true });
      act((): void => {
        dropTarget().dispatchEvent(over);
      });
      expect(over.defaultPrevented).toBe(true);
      const drop = folderDragEvent('drop', { isDirectory: true });
      await act(async (): Promise<void> => {
        dropTarget().dispatchEvent(drop);
        await Promise.resolve();
      });
      await flush();
      expect(drop.defaultPrevented).toBe(true);
      expect(
        container.querySelector('[data-testid="add-workspace-existing-panel"]'),
      ).not.toBeNull();
      expect(checkAddWorkspaceFromFolder).toHaveBeenCalledWith({
        repoPath: '/Users/me/payments',
      });
      expect(findRepositoryOwner).toHaveBeenCalledWith({
        path: '/Users/me/payments',
      });
      expect(mockProjectsState.addLocalRepo).toHaveBeenCalledWith(
        '/Users/me/payments',
        { activate: false },
      );
    });

    it.each([
      ['a file', { isDirectory: false }],
      ['an item with no entry', null],
    ])('refuses %s', async (_name, item) => {
      await openPersonal();
      await act(async (): Promise<void> => {
        dropTarget().dispatchEvent(folderDragEvent('drop', item));
        await Promise.resolve();
      });
      expect(container.textContent).toContain('Drop a folder, not a file.');
      // A refused drop leaves the open panel alone.
      expect(
        container.querySelector('[data-testid="add-workspace-remote-panel"]'),
      ).not.toBeNull();
      expect(checkAddWorkspaceFromFolder).not.toHaveBeenCalled();
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
    });

    it('takes the folder even when a non-file item comes first', async () => {
      await openPersonal();
      await act(async (): Promise<void> => {
        dropTarget().dispatchEvent(
          folderDragEvent(
            'drop',
            { isDirectory: true },
            { leadingString: true },
          ),
        );
        await Promise.resolve();
      });
      await flush();
      expect(container.textContent).not.toContain('Drop a folder, not a file.');
      expect(mockProjectsState.addLocalRepo).toHaveBeenCalledWith(
        '/Users/me/payments',
        { activate: false },
      );
    });

    it('says so when the dropped folder has no path', async () => {
      await openPersonal();
      Object.assign(window.api, { getPathForFile: jest.fn(() => '') });
      await act(async (): Promise<void> => {
        dropTarget().dispatchEvent(
          folderDragEvent('drop', { isDirectory: true }),
        );
        await Promise.resolve();
      });
      expect(container.textContent).toContain(
        "Couldn't read that folder. Use Choose folder instead.",
      );
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
    });

    it('leaves drags that carry no files alone', async () => {
      await openPersonal();
      const over = folderDragEvent('dragover', 'text');
      act((): void => {
        dropTarget().dispatchEvent(over);
      });
      expect(over.defaultPrevented).toBe(false);
      const drop = folderDragEvent('drop', 'text');
      act((): void => {
        dropTarget().dispatchEvent(drop);
      });
      expect(drop.defaultPrevented).toBe(false);
      expect(
        container.querySelector('[data-testid="add-workspace-remote-panel"]'),
      ).not.toBeNull();
    });

    it('says Adding… while a dropped folder is added, since no picker opened', async () => {
      await openPersonal();
      click('add-workspace-mode-existing');
      mockProjectsState.addLocalRepo.mockReturnValue(new Promise(() => {}));
      await act(async (): Promise<void> => {
        dropTarget().dispatchEvent(
          folderDragEvent('drop', { isDirectory: true }),
        );
        await Promise.resolve();
      });
      await flush();
      expect(mockProjectsState.addLocalRepo).toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="add-workspace-choose-folder"]')
          ?.textContent,
      ).toBe('Adding…');
    });

    it('says Opening… only while the folder picker is open', async () => {
      await openPersonal();
      click('add-workspace-mode-existing');
      let pick: (selection: { path: string }) => void = () => {};
      mockProjectsState.browseForRepo.mockReturnValue(
        new Promise((resolve) => {
          pick = resolve;
        }),
      );
      mockProjectsState.addLocalRepo.mockReturnValue(new Promise(() => {}));
      const chooseLabel = (): string | null | undefined =>
        container.querySelector('[data-testid="add-workspace-choose-folder"]')
          ?.textContent;
      click('add-workspace-choose-folder');
      await flush();
      expect(chooseLabel()).toBe('Opening…');
      await act(async (): Promise<void> => {
        pick({ path: '/Users/me/payments' });
        await Promise.resolve();
      });
      await flush();
      expect(mockProjectsState.addLocalRepo).toHaveBeenCalled();
      expect(chooseLabel()).toBe('Adding…');
    });

    it('keeps the highlight while the pointer moves between children', async () => {
      await openPersonal();
      click('add-workspace-mode-existing');
      act((): void => {
        dropTarget().dispatchEvent(
          folderDragEvent('dragover', { isDirectory: true }),
        );
      });
      const area = (): HTMLElement | null =>
        container.querySelector<HTMLElement>(
          '[data-testid="add-workspace-folder-drop"]',
        );
      expect(area()?.dataset.dragActive).toBe('true');
      const chooseButton = container.querySelector(
        '[data-testid="add-workspace-choose-folder"]',
      );
      act((): void => {
        dropTarget().dispatchEvent(
          new MouseEvent('dragleave', {
            bubbles: true,
            relatedTarget: chooseButton,
          }),
        );
      });
      expect(area()?.dataset.dragActive).toBe('true');
      act((): void => {
        dropTarget().dispatchEvent(
          new MouseEvent('dragleave', { bubbles: true, relatedTarget: null }),
        );
      });
      expect(area()?.dataset.dragActive).toBeUndefined();
    });

    it('keeps the highlight when a dragleave inside has no relatedTarget', async () => {
      await openPersonal();
      click('add-workspace-mode-existing');
      act((): void => {
        dropTarget().dispatchEvent(
          folderDragEvent('dragover', { isDirectory: true }),
        );
      });
      jest
        .spyOn(dropTarget(), 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 400, 300));
      act((): void => {
        dropTarget().dispatchEvent(
          new MouseEvent('dragleave', {
            bubbles: true,
            relatedTarget: null,
            clientX: 200,
            clientY: 150,
          }),
        );
      });
      expect(
        container.querySelector<HTMLElement>(
          '[data-testid="add-workspace-folder-drop"]',
        )?.dataset.dragActive,
      ).toBe('true');
    });
  });

  describe('Create new project type (CAN-3909)', () => {
    function testId(id: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    }

    function openCreate(): void {
      act(() => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      });
      click('add-workspace-mode-create');
    }

    it('orders the types and describes the chosen one', () => {
      openCreate();
      expect(
        Array.from(
          testId('add-workspace-type')?.querySelectorAll('button') ?? [],
          (option) => [option.getAttribute('data-testid'), option.textContent],
        ),
      ).toEqual([
        ['add-workspace-type-single-repo', 'New repository'],
        ['add-workspace-type-cowork', 'Cowork'],
        ['add-workspace-type-multi-repo', 'Multi-repo'],
        ['add-workspace-type-temporary', 'Temporary'],
      ]);
      for (const [type, text] of [
        ['single-repo', 'Create a git repository with starter files.'],
        [
          'cowork',
          "A new folder for your documents, research and other work that isn't code.",
        ],
        [
          'multi-repo',
          'For changes that touch several repositories at once. Add them after you create it.',
        ],
      ] as const) {
        click(`add-workspace-type-${type}`);
        expect(
          testId(`add-workspace-type-${type}`)?.getAttribute('aria-pressed'),
        ).toBe('true');
        expect(testId('add-workspace-type-description')?.textContent).toBe(
          text,
        );
      }
    });

    it('keeps Temporary in place but unavailable with fewer than two projects', () => {
      openCreate();
      const temporary = testId('add-workspace-type-temporary');
      expect(temporary?.getAttribute('aria-disabled')).toBe('true');
      click('add-workspace-type-temporary');
      expect(temporary?.getAttribute('aria-pressed')).toBe('false');
      act(() => {
        temporary?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Add another project to use Temporary.',
      );
    });

    it('offers Temporary, without Private memory, once two projects exist', () => {
      mockProjectsState.projects = ['one', 'two'].map(
        (id, order): SidebarItem => ({
          id,
          type: 'single-repo',
          name: id,
          repoPath: `/repos/${id}`,
          color: '',
          collapsed: false,
          order,
          worktrees: [],
        }),
      );
      openCreate();
      expect(
        testId('add-workspace-type-temporary')?.getAttribute('aria-disabled'),
      ).toBeNull();
      click('add-workspace-type-temporary');
      expect(testId('add-workspace-type-description')?.textContent).toBe(
        'Work across repositories from several projects. Automatically removed when its last worktree is deleted.',
      );
      expect(testId('add-workspace-private-memory')).toBeNull();
    });
  });

  describe('navigation mode (CAN-1817)', () => {
    function testId(id: string): HTMLElement | null {
      const el = container.querySelector(`[data-testid="${id}"]`);
      return el instanceof HTMLElement ? el : null;
    }

    function render(): void {
      getGitHubPermissions.mockResolvedValue(
        permissions({ canListRepos: false }),
      );
      act(() => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      });
    }

    // Code mode keeps Clone first and selected (CAN-3909).
    it('opens on the Clone tile, first of the three, in code mode', async () => {
      mockNavigationModeState.mode = 'code';
      render();
      await flush();
      const tiles = Array.from(
        container.querySelectorAll('[data-testid^="add-workspace-mode-"]'),
      ).map((tile) => tile.getAttribute('data-testid'));
      expect(tiles).toEqual([
        'add-workspace-mode-remote',
        'add-workspace-mode-existing',
        'add-workspace-mode-create',
      ]);
      expect(
        testId('add-workspace-mode-remote')?.getAttribute('aria-pressed'),
      ).toBe('true');
      expect(testId('add-workspace-remote-panel')).not.toBeNull();
      expect(container.textContent).not.toContain('Clone from GitHub or a URL');
    });

    it('reveals the remote flow in Work mode when a repo URL seeds it', async () => {
      mockNavigationModeState.mode = 'work';
      getGitHubPermissions.mockResolvedValue(
        permissions({ canListRepos: false }),
      );
      act(() => {
        root.render(
          <AddRepoModal
            isOpen
            onClose={jest.fn()}
            initialRepoUrl="https://github.com/octo/repo.git"
          />,
        );
      });
      await flush();
      expect(testId('add-workspace-mode-remote')).not.toBeNull();
      expect(testId('add-workspace-remote-panel')).not.toBeNull();
    });
  });

  describe('Work-mode defaults (CAN-5041)', () => {
    function testId(id: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    }

    function tileIds(): (string | null)[] {
      return Array.from(
        container.querySelectorAll('[data-testid^="add-workspace-mode-"]'),
        (tile) => tile.getAttribute('data-testid'),
      );
    }

    /** Assert each copy string independently, without fixing the card markup. */
    function expectTileCopy(
      id: string,
      title: string,
      description: string,
    ): void {
      const tile = testId(`add-workspace-mode-${id}`);
      expect(tile).not.toBeNull();
      const texts = Array.from(
        tile?.querySelectorAll('*') ?? [],
        (element) => element.textContent,
      );
      expect(texts).toContain(title);
      expect(texts).toContain(description);
    }

    function pressed(id: string): string | null | undefined {
      return testId(id)?.getAttribute('aria-pressed');
    }

    function nameInput(): HTMLInputElement {
      const input = testId('add-workspace-name-input');
      if (!(input instanceof HTMLInputElement))
        throw new Error('Missing project name input');
      return input;
    }

    async function open(
      props: Partial<Parameters<typeof AddRepoModal>[0]> = {},
    ): Promise<void> {
      getGitHubPermissions.mockResolvedValue(
        permissions({ canListRepos: false }),
      );
      act(() => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} {...props} />);
      });
      await flush();
    }

    it('opens Work mode on Use a folder, without clone fields', async () => {
      mockNavigationModeState.mode = 'work';
      await open();
      expect(tileIds()).toEqual([
        'add-workspace-mode-existing',
        'add-workspace-mode-create',
        'add-workspace-mode-remote',
      ]);
      expect(pressed('add-workspace-mode-existing')).toBe('true');
      expectTileCopy(
        'existing',
        'Use a folder',
        'Work with files already on this computer',
      );
      expectTileCopy('remote', 'Clone repository', 'GitHub or a URL');
      expectTileCopy('create', 'Create new', 'Start fresh');
      expect(testId('add-workspace-existing-description')?.textContent).toBe(
        'Your files stay where they are.',
      );
      expect(testId('add-workspace-remote-panel')).toBeNull();
      expect(testId('add-workspace-remote-url-input')).toBeNull();
      expect(testId('add-workspace-clone-destination')).toBeNull();
      // Clone stays reachable.
      click('add-workspace-mode-remote');
      expect(testId('add-workspace-remote-url-input')).not.toBeNull();
    });

    it('keeps the Existing folder copy without reassurance in Code mode', async () => {
      await open();
      expectTileCopy('existing', 'Existing folder', 'On this computer');
      click('add-workspace-mode-existing');
      expect(testId('add-workspace-existing-panel')).not.toBeNull();
      expect(testId('add-workspace-existing-description')).toBeNull();
    });

    it.each([
      {
        mode: 'work',
        type: 'cowork',
        description:
          "A new folder for your documents, research and other work that isn't code.",
        placeholder: 'Thursday design review',
      },
      {
        mode: 'code',
        type: 'single-repo',
        description: 'Create a git repository with starter files.',
        placeholder: 'my-project',
      },
    ] as const)(
      'defaults Create new to $type in $mode mode',
      async ({ mode, type, description, placeholder }) => {
        mockNavigationModeState.mode = mode;
        await open();
        click('add-workspace-mode-create');
        expect(pressed(`add-workspace-type-${type}`)).toBe('true');
        expect(testId('add-workspace-type-description')?.textContent).toBe(
          description,
        );
        expect(nameInput().placeholder).toBe(placeholder);
      },
    );

    it('follows the chosen type for the name placeholder without touching the name', async () => {
      mockNavigationModeState.mode = 'work';
      await open();
      click('add-workspace-mode-create');
      act(() => {
        setNativeInputValue(nameInput(), 'Field notes');
      });
      click('add-workspace-type-single-repo');
      expect(nameInput().placeholder).toBe('my-project');
      expect(nameInput().value).toBe('Field notes');
      click('add-workspace-type-multi-repo');
      expect(nameInput().placeholder).toBe('Thursday design review');
      click('add-workspace-type-cowork');
      expect(nameInput().placeholder).toBe('Thursday design review');
      expect(nameInput().value).toBe('Field notes');
    });

    it('keeps manual choices for the open dialog', async () => {
      mockNavigationModeState.mode = 'work';
      await open();
      click('add-workspace-mode-create');
      click('add-workspace-type-multi-repo');
      click('add-workspace-mode-existing');
      click('add-workspace-mode-create');
      expect(pressed('add-workspace-type-multi-repo')).toBe('true');
      click('add-workspace-mode-remote');
      await open();
      expect(pressed('add-workspace-mode-remote')).toBe('true');
    });

    it('opens a New repository seed as New repository in Work mode', async () => {
      mockNavigationModeState.mode = 'work';
      await open({ initialProjectType: 'single-repo' });
      expect(pressed('add-workspace-mode-create')).toBe('true');
      expect(pressed('add-workspace-type-single-repo')).toBe('true');
      expect(nameInput().placeholder).toBe('my-project');
    });

    it('lets a repository URL seed win over a project type seed', async () => {
      mockNavigationModeState.mode = 'work';
      await open({
        initialProjectType: 'cowork',
        initialRepoUrl: 'https://github.com/octo/repo.git',
      });
      expect(pressed('add-workspace-mode-remote')).toBe('true');
      const url = testId('add-workspace-remote-url-input');
      expect(url instanceof HTMLInputElement ? url.value : null).toBe(
        'https://github.com/octo/repo.git',
      );
    });

    it.each([
      { from: 'work', to: 'code', tile: 'remote', type: 'single-repo' },
      { from: 'code', to: 'work', tile: 'existing', type: 'cowork' },
    ] as const)(
      'applies $to defaults when reopened after leaving $from mode',
      async ({ from, to, tile, type }) => {
        mockNavigationModeState.mode = from;
        await open();
        // A choice made in the last open is not carried into the next one.
        click('add-workspace-mode-create');
        click('add-workspace-type-multi-repo');
        await open({ isOpen: false });
        mockNavigationModeState.mode = to;
        await open();
        expect(pressed(`add-workspace-mode-${tile}`)).toBe('true');
        click('add-workspace-mode-create');
        expect(pressed(`add-workspace-type-${type}`)).toBe('true');
      },
    );

    it('keeps an organization on its catalog, then the Work order', async () => {
      mockNavigationModeState.mode = 'work';
      openOrganization();
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      });
      await flush();
      expect(tileIds()).toEqual([
        'add-workspace-mode-catalog',
        'add-workspace-mode-existing',
        'add-workspace-mode-create',
      ]);
      expect(pressed('add-workspace-mode-catalog')).toBe('true');
      expectTileCopy(
        'existing',
        'Use a folder',
        'Work with files already on this computer',
      );
      click('add-workspace-mode-existing');
      // Without the Code capability the organization's own description
      // stays, once, and Personal's reassurance does not join it.
      const descriptions = container.querySelectorAll(
        '[data-testid="add-workspace-existing-description"]',
      );
      expect(descriptions).toHaveLength(1);
      expect(descriptions[0]?.textContent).not.toBe(
        'Your files stay where they are.',
      );
      click('add-workspace-mode-create');
      expect(testId('add-workspace-type-description')?.textContent).toBe(
        "A new folder for your documents, research and other work that isn't code.",
      );
      expect(nameInput().placeholder).toBe('Thursday design review');
    });
  });

  describe('curated Blueprint picker (CAN-2964)', () => {
    const blueprint = {
      externalId: 'b1111111-1111-4111-8111-111111111111',
      contentHash: 'a'.repeat(64),
      document: {
        version: 2 as const,
        name: 'Marketing',
        description: 'Campaigns, copy, launch content.',
        instructions: 'Write like a marketer.',
        defaultPluginSelections: {
          plugins: [],
          skills: [],
          mcpServers: [],
        },
        githubRepositories: [],
        customSkills: [],
        starterPrompts: [{ id: 'ws-1', text: 'Draft a launch post' }],
      },
    };

    async function openCoworkCreate(): Promise<void> {
      getGitHubPermissions.mockResolvedValue(permissions({}));
      act(() => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      });
      await flush();
      clickButton(container, 'Create new');
      await flush();
      const coworkButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="add-workspace-type-cowork"]',
      );
      act(() => {
        coworkButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();
    }

    it('shows the picker in Work mode with nothing preselected', async () => {
      mockNavigationModeState.mode = 'work';
      listBlueprints.mockResolvedValue({
        blueprints: [blueprint],
        available: true,
      });

      await openCoworkCreate();

      await waitFor(() => {
        expect(
          container.querySelector(
            '[data-testid="add-workspace-blueprint-picker"]',
          ),
        ).not.toBeNull();
      });
      const option = container.querySelector(
        `[data-testid="add-workspace-blueprint-${blueprint.externalId}"]`,
      );
      // §9.2: no option is pre-checked. There is no Empty chip to check
      // either: not picking one IS the empty project.
      expect(option?.getAttribute('aria-pressed')).toBe('false');
      expect(
        container.querySelector(
          '[data-testid="add-workspace-blueprint-empty"]',
        ),
      ).toBeNull();
    });

    it('deselects the active Blueprint when it is clicked again', async () => {
      // With the Empty chip gone, toggling the active chip off is the ONLY way
      // back to an empty project inside one modal session.
      mockNavigationModeState.mode = 'work';
      listBlueprints.mockResolvedValue({
        blueprints: [blueprint],
        available: true,
      });

      await openCoworkCreate();
      const selector = `[data-testid="add-workspace-blueprint-${blueprint.externalId}"]`;
      await waitFor(() => {
        expect(container.querySelector(selector)).not.toBeNull();
      });
      const click = (): void => {
        act(() => {
          container
            .querySelector<HTMLButtonElement>(selector)
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      };

      click();
      expect(
        container.querySelector(selector)?.getAttribute('aria-pressed'),
      ).toBe('true');

      click();
      expect(
        container.querySelector(selector)?.getAttribute('aria-pressed'),
      ).toBe('false');
    });

    it('clears a Blueprint selection before the next modal session', async () => {
      mockNavigationModeState.mode = 'work';
      listBlueprints.mockResolvedValue({
        blueprints: [blueprint],
        available: true,
      });

      await openCoworkCreate();
      const selector = `[data-testid="add-workspace-blueprint-${blueprint.externalId}"]`;
      const firstOption = container.querySelector<HTMLButtonElement>(selector);
      act(() => {
        firstOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(firstOption?.getAttribute('aria-pressed')).toBe('true');

      act(() => {
        root.render(<AddRepoModal isOpen={false} onClose={jest.fn()} />);
      });
      await flush();
      await openCoworkCreate();

      expect(
        container.querySelector(selector)?.getAttribute('aria-pressed'),
      ).toBe('false');
    });

    it('hides the picker in Code mode', async () => {
      mockNavigationModeState.mode = 'code';
      listBlueprints.mockResolvedValue({
        blueprints: [blueprint],
        available: true,
      });

      await openCoworkCreate();

      expect(
        container.querySelector(
          '[data-testid="add-workspace-blueprint-picker"]',
        ),
      ).toBeNull();
      expect(listBlueprints).not.toHaveBeenCalled();
    });

    it('seeds from the selected Blueprint, and takes the plain path for Empty', async () => {
      mockNavigationModeState.mode = 'work';
      listBlueprints.mockResolvedValue({
        blueprints: [blueprint],
        available: true,
      });
      mockStandaloneChatState.createChatProjectFromBlueprint.mockResolvedValue({
        project: { id: 'seeded' },
        unresolvedRefs: [],
      });
      mockStandaloneChatState.createChatProject.mockResolvedValue({
        id: 'plain',
      });
      mockProjectsState.loadProjects.mockResolvedValue(undefined);
      mockStandaloneChatState.activateCreatedCoworkWorkspace.mockResolvedValue(
        true,
      );

      await openCoworkCreate();
      await waitFor(() => {
        expect(
          container.querySelector(
            `[data-testid="add-workspace-blueprint-${blueprint.externalId}"]`,
          ),
        ).not.toBeNull();
      });

      const nameInput = container.querySelector<HTMLInputElement>(
        '[data-testid="add-workspace-name-input"]',
      );
      act(() => {
        if (nameInput) setNativeInputValue(nameInput, 'Launch');
      });
      act(() => {
        container
          .querySelector(
            `[data-testid="add-workspace-blueprint-${blueprint.externalId}"]`,
          )
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      act(() => {
        container
          .querySelector('[data-testid="add-workspace-create-submit"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();

      expect(
        mockStandaloneChatState.createChatProjectFromBlueprint,
      ).toHaveBeenCalledWith(blueprint, 'Launch');
      expect(mockStandaloneChatState.createChatProject).not.toHaveBeenCalled();
      // Everything resolved, so there is nothing to warn about.
      expect(mockGitHubState.addToast).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'warns about unresolved Blueprint refs only for current completion (context changed: %s)',
      async (contextChanges) => {
        mockNavigationModeState.mode = 'work';
        listBlueprints.mockResolvedValue({
          blueprints: [blueprint],
          available: true,
        });
        // A curated seed now applies the Blueprint's plugin/skill refs. Refs the
        // resolver cannot map are reported, never fatal: the project still
        // lands, so the create completes and the warning follows it.
        mockStandaloneChatState.createChatProjectFromBlueprint.mockResolvedValue(
          {
            project: { id: 'seeded' },
            unresolvedRefs: [
              'skill:builtin:app:missing-skill',
              'plugin:github:acme/tools:missing',
            ],
          },
        );
        mockProjectsState.loadProjects.mockImplementation(async () => {
          await Promise.resolve();
          if (contextChanges) {
            useWorkspaceContextStore.setState({
              state: {
                ...useWorkspaceContextStore.getState().state,
                context: { kind: 'organization', organizationId: 'org-b' },
                revision: 2,
              },
            });
          }
        });
        mockStandaloneChatState.activateCreatedCoworkWorkspace.mockResolvedValue(
          true,
        );

        await openCoworkCreate();
        await waitFor(() => {
          expect(
            container.querySelector(
              `[data-testid="add-workspace-blueprint-${blueprint.externalId}"]`,
            ),
          ).not.toBeNull();
        });

        const nameInput = container.querySelector<HTMLInputElement>(
          '[data-testid="add-workspace-name-input"]',
        );
        act(() => {
          if (nameInput) setNativeInputValue(nameInput, 'Launch');
        });
        act(() => {
          container
            .querySelector(
              `[data-testid="add-workspace-blueprint-${blueprint.externalId}"]`,
            )
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        act(() => {
          container
            .querySelector('[data-testid="add-workspace-create-submit"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flush();

        if (contextChanges) {
          expect(
            mockStandaloneChatState.activateCreatedCoworkWorkspace,
          ).not.toHaveBeenCalled();
          expect(mockGitHubState.addToast).not.toHaveBeenCalled();
          return;
        }
        expect(
          mockStandaloneChatState.activateCreatedCoworkWorkspace,
        ).toHaveBeenCalledWith('seeded');
        expect(mockGitHubState.addToast).toHaveBeenCalledWith(
          'Added with 2 items unavailable on this device.',
          'warning',
          undefined,
          { category: 'Chat', forceInApp: true, title: 'Project added' },
        );
      },
    );

    it('turns on Private memory before a Blueprint project opens, then reports its unresolved refs (CAN-3562)', async () => {
      mockNavigationModeState.mode = 'work';
      listBlueprints.mockResolvedValue({
        blueprints: [blueprint],
        available: true,
      });
      mockStandaloneChatState.createChatProjectFromBlueprint.mockResolvedValue({
        project: { id: 'seeded' },
        unresolvedRefs: ['plugin:missing'],
      });
      mockProjectsState.loadProjects.mockResolvedValue(undefined);
      mockStandaloneChatState.activateCreatedCoworkWorkspace.mockResolvedValue(
        true,
      );

      await openCoworkCreate();
      await waitFor(() => {
        expect(
          container.querySelector(
            `[data-testid="add-workspace-blueprint-${blueprint.externalId}"]`,
          ),
        ).not.toBeNull();
      });
      const nameInput = container.querySelector<HTMLInputElement>(
        '[data-testid="add-workspace-name-input"]',
      );
      act(() => {
        if (nameInput) setNativeInputValue(nameInput, 'Launch');
      });
      click(`add-workspace-blueprint-${blueprint.externalId}`);
      togglePrivateMemory();
      click('add-workspace-create-submit');

      await waitFor(() => {
        expect(
          mockStandaloneChatState.activateCreatedCoworkWorkspace,
        ).toHaveBeenCalledWith('seeded');
        expect(mockGitHubState.addToast).toHaveBeenCalledTimes(1);
      });
      expect(savePrivateMemory).toHaveBeenCalledWith('seeded', true);
      expect(savePrivateMemory.mock.invocationCallOrder[0]).toBeLessThan(
        mockStandaloneChatState.activateCreatedCoworkWorkspace.mock
          .invocationCallOrder[0] ?? 0,
      );
    });

    it('creates through the plain path when the picker is never touched', async () => {
      mockNavigationModeState.mode = 'work';
      listBlueprints.mockResolvedValue({
        blueprints: [blueprint],
        available: true,
      });
      mockStandaloneChatState.createChatProject.mockResolvedValue({
        id: 'plain',
      });
      mockProjectsState.loadProjects.mockResolvedValue(undefined);
      mockStandaloneChatState.activateCreatedCoworkWorkspace.mockResolvedValue(
        true,
      );

      await openCoworkCreate();
      const nameInput = container.querySelector<HTMLInputElement>(
        '[data-testid="add-workspace-name-input"]',
      );
      act(() => {
        if (nameInput) setNativeInputValue(nameInput, 'Plain');
      });
      act(() => {
        container
          .querySelector('[data-testid="add-workspace-create-submit"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();

      expect(mockStandaloneChatState.createChatProject).toHaveBeenCalledWith(
        'Plain',
      );
      expect(
        mockStandaloneChatState.createChatProjectFromBlueprint,
      ).not.toHaveBeenCalled();
    });
  });
  describe('create-time nudge to the owning organization (hybrid model)', () => {
    const FOLDER = { name: 'payments', path: '/Users/me/payments' };
    const REMOTE_URL = 'https://github.com/acme/payments.git';
    const ACME_OWNER = {
      kind: 'organization',
      organizationId: 'org-a',
      organizationName: 'Acme',
      projectId: 'payments',
      projectName: 'Payments',
      repositoryName: 'acme/payments',
    };
    const ORGANIZATIONS: Array<{
      id: string;
      name: string;
      role: WorkspaceContextOrganizationRole;
    }> = [
      { id: 'org-a', name: 'Acme', role: 'MEMBER' },
      { id: 'org-b', name: 'Beta', role: 'MEMBER' },
    ];
    let setWorkspaceContext: jest.Mock;
    const selected = jest.fn();
    const closed = jest.fn();

    function byTestId(testId: string): Element | null {
      return document.querySelector(`[data-testid="${testId}"]`);
    }

    function notice(): Element | null {
      return byTestId('add-workspace-org-owner-notice');
    }

    async function clickAndSettle(testId: string): Promise<void> {
      await act(async (): Promise<void> => {
        click(testId);
        await Promise.resolve();
      });
      await flush();
      await flush();
    }

    /** The organization-projects flag on, in `scope`, with two organizations. */
    async function open(
      scope:
        | { kind: 'personal' }
        | { kind: 'organization'; organizationId: string },
    ): Promise<void> {
      const flags = getDefaultFeatureFlagSnapshot();
      flags.values['canopy-shared-org-projects-enabled'] = true;
      useFeatureFlagsStore.setState({ snapshot: flags });
      useWorkspaceContextStore.setState({
        state: { context: scope, revision: 1, organizations: ORGANIZATIONS },
        hydrated: true,
        accountEpoch: 0,
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(
          <AddRepoModal
            isOpen
            onClose={closed}
            onWorkspaceCreated={selected}
          />,
        );
      });
      await flush();
    }

    beforeEach((): void => {
      selected.mockReset();
      closed.mockReset();
      mockProjectsState.browseForRepo.mockReset().mockResolvedValue(FOLDER);
      mockProjectsState.addLocalRepo
        .mockReset()
        .mockResolvedValue({ id: 'personal-payments', type: 'single-repo' });
      mockProjectsState.addRemoteRepo
        .mockReset()
        .mockResolvedValue('personal-payments');
      setWorkspaceContext = jest.fn(
        (request: {
          context: { kind: 'organization'; organizationId: string };
          expectedRevision: number;
        }) =>
          Promise.resolve({
            context: request.context,
            revision: request.expectedRevision + 1,
            organizations: ORGANIZATIONS,
          }),
      );
      Object.assign(window.api, {
        workspaceContext: { set: setWorkspaceContext },
        probeCloneDestination: jest.fn().mockResolvedValue({
          repoName: 'payments',
          candidateExists: false,
          reusablePath: null,
        }),
      });
    });

    it('stops a Personal folder of an organization repository and adds it to Personal only when asked', async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue(ACME_OWNER);
      await open({ kind: 'personal' });
      click('add-workspace-mode-existing');
      await clickAndSettle('add-workspace-choose-folder');
      expect(findRepositoryOwner).toHaveBeenCalledWith({
        path: '/Users/me/payments',
      });
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
      // A local folder is named by the folder the member picked.
      expect(notice()?.textContent).toContain('Acme has set up payments.');
      expect(notice()?.textContent).toContain(
        'Adding it to Personal leaves out its skills, connectors and shared settings.',
      );
      expect(byTestId('add-workspace-org-owner-notice-add')?.textContent).toBe(
        'Add to Acme',
      );
      expect(
        byTestId('add-workspace-org-owner-notice-continue')?.textContent,
      ).toBe('Add to Personal');
      expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
        'addWorkspace.modal',
        expect.objectContaining({
          mode: 'personal',
          orgOwnerNudge: { organizationId: 'org-a' },
        }),
      );

      await clickAndSettle('add-workspace-org-owner-notice-continue');
      expect(mockProjectsState.addLocalRepo).toHaveBeenCalledTimes(1);
      expect(mockProjectsState.addLocalRepo).toHaveBeenCalledWith(
        '/Users/me/payments',
        { activate: false },
      );
      // Continuing skips the lookup for that one pick.
      expect(findRepositoryOwner).toHaveBeenCalledTimes(1);
      expect(selected).toHaveBeenCalledWith('personal-payments');
      expect(setWorkspaceContext).not.toHaveBeenCalled();
    });

    it('saves Private memory before opening a Personal folder after the organization nudge', async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue(ACME_OWNER);
      await open({ kind: 'personal' });
      click('add-workspace-mode-existing');
      togglePrivateMemory();
      await clickAndSettle('add-workspace-choose-folder');
      // The nudge carries its own choices, so the toggle steps aside.
      expect(byTestId('add-workspace-private-memory')).toBeNull();
      expect(
        byTestId('add-workspace-org-owner-folder-path')?.querySelector('bdi')
          ?.textContent,
      ).toBe('/Users/me/payments');
      expect(
        byTestId('add-workspace-org-owner-folder-path')?.querySelector(
          '[data-testid="add-workspace-choose-folder"]',
        )?.textContent,
      ).toBe('Change');
      await clickAndSettle('add-workspace-org-owner-notice-continue');

      expect(savePrivateMemory).toHaveBeenCalledWith('personal-payments', true);
      expect(savePrivateMemory.mock.invocationCallOrder[0]).toBeLessThan(
        selected.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(selected).toHaveBeenCalledWith('personal-payments');
    });

    it('switches to the organization and checks the same folder there', async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue(ACME_OWNER);
      getOrgCodeEligibility.mockResolvedValue('eligible');
      inspectOrgFolder.mockResolvedValue({
        kind: 'code',
        target: { projectId: 'payments', projectName: 'Payments' },
        repository: { host: 'github.com', owner: 'acme', name: 'payments' },
      });
      await open({ kind: 'personal' });
      click('add-workspace-mode-existing');
      await clickAndSettle('add-workspace-choose-folder');
      await clickAndSettle('add-workspace-org-owner-notice-add');
      expect(setWorkspaceContext).toHaveBeenCalledWith({
        context: { kind: 'organization', organizationId: 'org-a' },
        expectedRevision: 1,
      });
      await waitFor((): void => {
        expect(inspectOrgFolder).toHaveBeenCalledWith({
          organizationId: 'org-a',
          path: '/Users/me/payments',
        });
      });
      await flush();
      // The switch was the member's own choice: no "Context changed" reset.
      expect(byTestId('add-workspace-context-changed')).toBeNull();
      expect(
        byTestId('add-workspace-mode-existing')?.getAttribute('aria-pressed'),
      ).toBe('true');
      expect(
        byTestId('add-workspace-org-folder-kind')?.getAttribute(
          'data-folder-kind',
        ),
      ).toBe('linked');
      expect(byTestId('add-workspace-org-folder-add')).not.toBeNull();
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
      expect(notice()).toBeNull();
      // The browse is not asked again: the same folder carries over.
      expect(mockProjectsState.browseForRepo).toHaveBeenCalledTimes(1);
    });

    it('keeps the Personal draft and adds nothing when the switch is refused', async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue(ACME_OWNER);
      setWorkspaceContext.mockRejectedValue(new Error('stale revision'));
      await open({ kind: 'personal' });
      click('add-workspace-mode-existing');
      await clickAndSettle('add-workspace-choose-folder');
      await clickAndSettle('add-workspace-org-owner-notice-add');
      expect(container.textContent).toContain(
        "Couldn't switch to Acme. Try again.",
      );
      expect(notice()).not.toBeNull();
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
      expect(inspectOrgFolder).not.toHaveBeenCalled();
    });

    async function openRemote(): Promise<void> {
      await open({ kind: 'personal' });
      click('add-workspace-mode-remote');
      await waitFor((): void => {
        expect(byTestId('add-workspace-remote-url-input')).not.toBeNull();
      });
      const input = byTestId('add-workspace-remote-url-input');
      if (!(input instanceof HTMLInputElement))
        throw new Error('Remote URL input not found');
      act((): void => {
        setNativeInputValue(input, REMOTE_URL);
      });
      await waitFor((): void => {
        expect(
          byTestId('add-workspace-clone-destination')?.querySelector('bdi')
            ?.textContent,
        ).toBe('C:\\repos');
      });
    }

    it('preserves destination validation failures before cloning (CAN-4342)', async () => {
      findRepositoryOwner.mockResolvedValue({ kind: 'none' });
      jest
        .mocked(window.api.probeCloneDestination)
        .mockRejectedValueOnce(
          new Error('Destination directory must be an absolute path'),
        );
      await openRemote();
      await clickAndSettle('add-workspace-clone-submit');
      expect(mockProjectsState.addRemoteRepo).not.toHaveBeenCalled();
      expect(byTestId('add-workspace-error')?.textContent).toBe(
        'Destination directory must be an absolute path',
      );
    });

    it('normalizes a GitHub picker selection and shows friendly rejection copy (CAN-4342)', async () => {
      findRepositoryOwner.mockResolvedValue({ kind: 'none' });
      getGitHubPermissions.mockResolvedValue(
        permissions({ tokenAvailable: true, canListRepos: true }),
      );
      listUserGitHubRepos.mockResolvedValue([
        repo({
          cloneUrl: 'https://github.com/cursor/plugins/tree/main/pstack',
        }),
      ]);
      mockProjectsState.addRemoteRepo.mockRejectedValue(
        new Error('fatal: private credentials'),
      );
      await open({ kind: 'personal' });
      click('add-workspace-mode-remote');
      await waitFor(() =>
        expect(
          byTestId('add-workspace-github-repo-list')?.querySelector('button'),
        ).not.toBeNull(),
      );
      act(() =>
        byTestId('add-workspace-github-repo-list')
          ?.querySelector('button')
          ?.click(),
      );
      await clickAndSettle('add-workspace-clone-submit');
      expect(findRepositoryOwner).toHaveBeenCalledWith({
        remoteUrl: 'https://github.com/cursor/plugins',
      });
      expect(mockProjectsState.addRemoteRepo).toHaveBeenCalledWith(
        'https://github.com/cursor/plugins',
        'C:\\repos',
        expect.anything(),
      );
      expect(byTestId('add-workspace-error')?.textContent).toBe(
        'Failed to clone the repository. Check the URL and access, then try again.',
      );
    });

    it('normalizes ownership, probing and cloning while retaining the draft on failure (CAN-4342)', async () => {
      findRepositoryOwner.mockResolvedValue({ kind: 'none' });
      mockProjectsState.addRemoteRepo.mockRejectedValue(
        new Error('fatal: private credentials'),
      );
      await openRemote();
      const input = byTestId('add-workspace-remote-url-input');
      if (!(input instanceof HTMLInputElement)) throw new Error('Missing URL');
      act(() =>
        setNativeInputValue(
          input,
          'https://github.com/cursor/plugins/tree/main/pstack',
        ),
      );
      await clickAndSettle('add-workspace-clone-submit');
      expect(findRepositoryOwner).toHaveBeenCalledWith({
        remoteUrl: 'https://github.com/cursor/plugins',
      });
      expect(window.api.probeCloneDestination).toHaveBeenCalledWith({
        remoteUrl: 'https://github.com/cursor/plugins',
        destinationDir: 'C:\\repos',
      });
      expect(mockProjectsState.addRemoteRepo).toHaveBeenCalledWith(
        'https://github.com/cursor/plugins',
        'C:\\repos',
        expect.anything(),
      );
      expect(input.value).toBe(
        'https://github.com/cursor/plugins/tree/main/pstack',
      );
      expect(byTestId('add-workspace-error')?.textContent).toBe(
        'Failed to clone the repository. Check the URL and access, then try again.',
      );
    });

    it('stops a Personal clone of an organization repository before probing, and clones only when asked', async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue(ACME_OWNER);
      await openRemote();
      await clickAndSettle('add-workspace-clone-submit');
      expect(findRepositoryOwner).toHaveBeenCalledWith({
        remoteUrl: REMOTE_URL,
      });
      expect(window.api.probeCloneDestination).not.toHaveBeenCalled();
      expect(mockProjectsState.addRemoteRepo).not.toHaveBeenCalled();
      // A clone has no folder yet, so it is named by its repository.
      expect(notice()?.textContent).toContain('Acme has set up acme/payments.');
      expect(byTestId('add-workspace-clone-submit')).toBeNull();

      await clickAndSettle('add-workspace-org-owner-notice-continue');
      expect(window.api.probeCloneDestination).toHaveBeenCalledWith({
        remoteUrl: REMOTE_URL,
        destinationDir: 'C:\\repos',
      });
      await waitFor((): void => {
        expect(mockProjectsState.addRemoteRepo).toHaveBeenCalledTimes(1);
      });
      expect(findRepositoryOwner).toHaveBeenCalledTimes(1);
    });

    it('switches a clone to the organization and adds its project from the catalog', async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue(ACME_OWNER);
      jest.mocked(mockCatalog.startSetup).mockResolvedValue(undefined);
      Object.assign(mockCatalog, {
        snapshots: {
          'org:org-a': {
            context: 'org:org-a',
            revision: '1',
            fetchedAt: '',
            projects: [
              {
                id: 'payments',
                organizationId: 'org-a',
                name: 'Payments',
                description: null,
                kind: 'CODE',
                purpose: 'project',
                visibility: 'organization',
                memberOwned: false,
                location: 'LOCAL',
                repository: {
                  provider: 'github',
                  host: 'github.com',
                  owner: 'acme',
                  name: 'payments',
                  providerRepoId: '1',
                  defaultBranch: 'main',
                  verification: 'VERIFIED',
                },
                state: 'ACTIVE',
                revision: 1,
                authorizationVersion: 1,
                defaultListed: true,
                preference: 'FOLLOW_DEFAULTS',
                listed: true,
                capabilities: {
                  use: true,
                  administer: false,
                  manageCloud: false,
                },
                instance: null,
              },
            ],
          },
        },
      });
      await openRemote();
      await clickAndSettle('add-workspace-clone-submit');
      await clickAndSettle('add-workspace-org-owner-notice-add');
      expect(setWorkspaceContext).toHaveBeenCalledWith({
        context: { kind: 'organization', organizationId: 'org-a' },
        expectedRevision: 1,
      });
      await waitFor((): void => {
        expect(mockCatalog.startSetup).toHaveBeenCalledWith(
          'payments',
          'C:\\repos',
        );
      });
      expect(window.api.probeCloneDestination).not.toHaveBeenCalled();
      expect(mockProjectsState.addRemoteRepo).not.toHaveBeenCalled();
      expect(byTestId('add-workspace-context-changed')).toBeNull();
      // Added once, however often the catalog re-renders.
      await flush();
      expect(mockCatalog.startSetup).toHaveBeenCalledTimes(1);
    });

    it("names the current organization when another organization owns the folder's repository", async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue(ACME_OWNER);
      getOrgCodeEligibility.mockResolvedValue('eligible');
      inspectOrgFolder.mockResolvedValue({
        kind: 'code',
        target: 'new',
        repository: { host: 'github.com', owner: 'acme', name: 'payments' },
      });
      useLinkedPersonalWorkspacesStore.setState({
        resolvedOrganizationId: 'org-b',
      });
      await open({ kind: 'organization', organizationId: 'org-b' });
      click('add-workspace-mode-existing');
      await clickAndSettle('add-workspace-choose-folder');
      expect(inspectOrgFolder).not.toHaveBeenCalled();
      expect(
        byTestId('add-workspace-org-owner-notice-continue')?.textContent,
      ).toBe('Add to Beta');
      await clickAndSettle('add-workspace-org-owner-notice-continue');
      expect(inspectOrgFolder).toHaveBeenCalledWith({
        organizationId: 'org-b',
        path: '/Users/me/payments',
      });
    });

    it('checks a folder owned by the current organization without a nudge', async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue(ACME_OWNER);
      getOrgCodeEligibility.mockResolvedValue('eligible');
      inspectOrgFolder.mockResolvedValue({
        kind: 'code',
        target: { projectId: 'payments', projectName: 'Payments' },
        repository: { host: 'github.com', owner: 'acme', name: 'payments' },
      });
      await open({ kind: 'organization', organizationId: 'org-a' });
      click('add-workspace-mode-existing');
      await clickAndSettle('add-workspace-choose-folder');
      expect(notice()).toBeNull();
      expect(inspectOrgFolder).toHaveBeenCalledTimes(1);
    });

    it.each<[string, () => void]>([
      ['no owner', (): void => undefined],
      [
        'a failed lookup',
        (): void => {
          findRepositoryOwner.mockRejectedValue(new Error('timed out'));
        },
      ],
    ])(
      'adds a Personal folder at once for %s',
      async (_case, arrange): Promise<void> => {
        arrange();
        await open({ kind: 'personal' });
        click('add-workspace-mode-existing');
        await clickAndSettle('add-workspace-choose-folder');
        expect(findRepositoryOwner).toHaveBeenCalledTimes(1);
        expect(notice()).toBeNull();
        expect(mockProjectsState.addLocalRepo).toHaveBeenCalledTimes(1);
        expect(selected).toHaveBeenCalledWith('personal-payments');
      },
    );

    it('clones at once when nothing owns the repository', async (): Promise<void> => {
      await openRemote();
      await clickAndSettle('add-workspace-clone-submit');
      expect(notice()).toBeNull();
      await waitFor((): void => {
        expect(mockProjectsState.addRemoteRepo).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Cursor rules offer after creation (CAN-2053)', () => {
    function nameProject(name: string): void {
      const input = container.querySelector(
        '[data-testid="add-workspace-name-input"]',
      );
      if (!(input instanceof HTMLInputElement))
        throw new Error('Project name input not found');
      act(() => {
        setNativeInputValue(input, name);
      });
    }

    async function openHost(): Promise<void> {
      mockNavigationState.addWorkspaceModalOpen = true;
      act(() => {
        root.render(<AddWorkspaceModalHost />);
      });
      await waitFor(() => {
        expect(getGitHubPermissions).toHaveBeenCalledTimes(1);
      });
    }

    beforeEach(() => {
      jest.mocked(offerCursorRulesReview).mockClear();
      mockNavigationState.closeAddWorkspaceModal.mockReset();
      mockNavigationState.openWorkspaceSettings.mockReset();
      mockHomeComposerState.setPendingCreateFromReference.mockClear();
    });

    afterEach(() => {
      mockNavigationState.addWorkspaceModalOpen = false;
    });

    it('offers the review for a new Code project', async () => {
      mockProjectsState.initLocalRepo.mockResolvedValue('new-repo');
      await openHost();
      click('add-workspace-mode-create');
      nameProject('new-repo');
      click('add-workspace-create-submit');
      await waitFor(() => {
        expect(offerCursorRulesReview).toHaveBeenCalledWith(
          [{ workspaceId: 'new-repo' }],
          'add-project',
        );
      });
    });

    it('offers nothing when the dialog closes without a project', async () => {
      await openHost();
      mockNavigationState.addWorkspaceModalOpen = false;
      act(() => {
        root.render(<AddWorkspaceModalHost />);
      });
      expect(
        container.querySelector('[data-testid="add-workspace-mode-create"]'),
      ).toBeNull();
      // The host saw a close without a project, so the offer had its chance.
      expect(
        mockHomeComposerState.setPendingCreateFromReference,
      ).toHaveBeenCalledWith(null);
      expect(offerCursorRulesReview).not.toHaveBeenCalled();
    });
  });

  describe('Private memory (CAN-3562)', () => {
    const EXPLANATION =
      "Agents won't use memory from other projects or your organization. New memories stay here.";

    function control(id: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    }

    function toggle(): HTMLElement | null {
      return control('add-workspace-private-memory-toggle');
    }

    /** The explanation lives in the info button's tooltip (CAN-3909). */
    function explanation(): string | null | undefined {
      const info = control('add-workspace-private-memory-info');
      act(() => {
        info?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      const text = document.querySelector('[role="tooltip"]')?.textContent;
      act(() => {
        info?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      return text;
    }

    async function open(
      onClose: jest.Mock = jest.fn(),
      onWorkspaceCreated: jest.Mock = jest.fn(),
    ): Promise<void> {
      act(() => {
        root.render(
          <AddRepoModal
            isOpen
            onClose={onClose}
            onWorkspaceCreated={onWorkspaceCreated}
          />,
        );
      });
      await waitFor(() => {
        expect(getGitHubPermissions).toHaveBeenCalledTimes(1);
      });
    }

    function nameProject(name: string): void {
      const input = control('add-workspace-name-input');
      if (!(input instanceof HTMLInputElement))
        throw new Error('Project name input not found');
      act(() => {
        setNativeInputValue(input, name);
      });
    }

    it('offers the toggle, off, with the approved explanation in every Personal option', async () => {
      await open();
      for (const mode of ['existing', 'remote', 'create']) {
        click(`add-workspace-mode-${mode}`);
        // A compact switch beside the panel's action, with no Advanced
        // disclosure in front of it (CAN-3909).
        expect(control('add-workspace-advanced-toggle')).toBeNull();
        expect(toggle()?.getAttribute('aria-checked')).toBe('false');
        expect(explanation()).toBe(EXPLANATION);
        expect(control('add-workspace-private-memory-managed')).toBeNull();
      }
    });

    it('keeps the choice when the option or project type changes', async () => {
      await open();
      togglePrivateMemory();
      click('add-workspace-mode-create');
      // A choice left on stays on in the next option's switch.
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
      click('add-workspace-type-cowork');
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
      click('add-workspace-mode-existing');
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    });

    it('uses the server for a new organization definition and never writes a local choice', async () => {
      openOrganization();
      mockStandaloneChatState.createOrgCoworkProject.mockResolvedValue({
        ok: true,
        organizationProjectId: 'org-project',
        localWorkspaceId: 'cowork-project-org-project',
        attachedGitRepository: false,
      });
      mockProjectsState.loadProjects.mockResolvedValue(undefined);
      act(() => {
        root.render(<AddRepoModal isOpen onClose={jest.fn()} />);
      });
      await waitFor(() => {
        expect(control('add-workspace-mode-create')).not.toBeNull();
      });
      click('add-workspace-mode-catalog');
      expect(control('add-workspace-private-memory')).toBeNull();
      for (const mode of ['existing', 'create']) {
        click(`add-workspace-mode-${mode}`);
        expect(control('add-workspace-private-memory')).not.toBeNull();
      }
      nameProject('Org notes');
      click('add-workspace-create-submit');
      await waitFor(() => {
        expect(
          mockStandaloneChatState.activateCreatedCoworkWorkspace,
        ).toHaveBeenCalledWith('cowork-project-org-project');
      });
      expect(savePrivateMemory).not.toHaveBeenCalled();
    });

    it('writes nothing when the toggle is left off', async () => {
      const onWorkspaceCreated = jest.fn();
      mockProjectsState.initLocalRepo.mockResolvedValue('new-repo');
      await open(jest.fn(), onWorkspaceCreated);
      click('add-workspace-mode-create');
      nameProject('new-repo');
      click('add-workspace-create-submit');
      await waitFor(() => {
        expect(onWorkspaceCreated).toHaveBeenCalledWith('new-repo');
      });
      expect(savePrivateMemory).not.toHaveBeenCalled();
    });

    it('holds a new single-repo project closed until Private memory is saved', async () => {
      const onClose = jest.fn();
      const onWorkspaceCreated = jest.fn();
      mockProjectsState.initLocalRepo.mockResolvedValue('new-repo');
      let finishSave: () => void = () => undefined;
      savePrivateMemory.mockReturnValue(
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
      );
      await open(onClose, onWorkspaceCreated);
      click('add-workspace-mode-create');
      nameProject('new-repo');
      togglePrivateMemory();
      click('add-workspace-create-submit');

      await waitFor(() => {
        expect(savePrivateMemory).toHaveBeenCalledWith('new-repo', true);
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(onWorkspaceCreated).not.toHaveBeenCalled();

      await act(async () => {
        finishSave();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(onWorkspaceCreated).toHaveBeenCalledWith('new-repo');
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('saves it before a multi-repo project opens its settings', async () => {
      const onWorkspaceCreated = jest.fn();
      mockProjectsState.createWorkspace.mockResolvedValue('multi');
      await open(jest.fn(), onWorkspaceCreated);
      click('add-workspace-mode-create');
      click('add-workspace-type-multi-repo');
      nameProject('multi');
      togglePrivateMemory();
      click('add-workspace-create-submit');
      await waitFor(() => {
        expect(onWorkspaceCreated).toHaveBeenCalledWith('multi', {
          openSettings: true,
        });
      });
      expect(savePrivateMemory).toHaveBeenCalledWith('multi', true);
      expect(savePrivateMemory.mock.invocationCallOrder[0]).toBeLessThan(
        onWorkspaceCreated.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('saves it before a Cowork project is activated and its first chat starts', async () => {
      mockStandaloneChatState.createChatProject.mockResolvedValue({
        id: 'cowork-new',
      });
      mockProjectsState.loadProjects.mockResolvedValue(undefined);
      await open();
      click('add-workspace-mode-create');
      click('add-workspace-type-cowork');
      nameProject('Notes');
      togglePrivateMemory();
      click('add-workspace-create-submit');
      await waitFor(() => {
        expect(mockNavigationState.navigate).toHaveBeenCalledWith('chat');
      });
      expect(savePrivateMemory).toHaveBeenCalledWith('cowork-new', true);
      expect(savePrivateMemory.mock.invocationCallOrder[0]).toBeLessThan(
        mockStandaloneChatState.activateCreatedCoworkWorkspace.mock
          .invocationCallOrder[0] ?? 0,
      );
    });

    it('saves it for the folder an Existing folder pick adds', async () => {
      const onWorkspaceCreated = jest.fn();
      mockProjectsState.browseForRepo.mockResolvedValue({
        path: '/repo',
        name: 'repo',
      });
      mockProjectsState.addLocalRepo.mockResolvedValue({
        id: 'repo',
        type: 'single-repo',
      });
      await open(jest.fn(), onWorkspaceCreated);
      click('add-workspace-mode-existing');
      togglePrivateMemory();
      click('add-workspace-choose-folder');
      await waitFor(() => {
        expect(onWorkspaceCreated).toHaveBeenCalledWith('repo');
      });
      expect(savePrivateMemory).toHaveBeenCalledWith('repo', true);
      expect(savePrivateMemory.mock.invocationCallOrder[0]).toBeLessThan(
        onWorkspaceCreated.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('keeps the created project, unopened, when the save fails, and retries only that project', async () => {
      const onClose = jest.fn();
      const onWorkspaceCreated = jest.fn();
      mockProjectsState.initLocalRepo.mockResolvedValue('new-repo');
      savePrivateMemory.mockRejectedValueOnce(new Error('disk full'));
      await open(onClose, onWorkspaceCreated);
      click('add-workspace-mode-create');
      nameProject('new-repo');
      togglePrivateMemory();
      click('add-workspace-create-submit');

      await waitFor(() => {
        expect(
          control('add-workspace-private-memory-failed')?.textContent,
        ).toContain(
          "The project was added, but Private memory isn't on yet. Try again before you open it.",
        );
      });
      // A private-selected project never opens as a non-private one.
      expect(onClose).not.toHaveBeenCalled();
      expect(onWorkspaceCreated).not.toHaveBeenCalled();
      // The form is locked, so the way forward is this project, not another.
      expect(container.querySelector('fieldset')?.disabled).toBe(true);

      // A second failure keeps the project waiting.
      savePrivateMemory.mockRejectedValueOnce(new Error('disk full'));
      click('add-workspace-private-memory-retry');
      await waitFor(() => {
        expect(savePrivateMemory).toHaveBeenCalledTimes(2);
      });
      await flush();
      expect(control('add-workspace-private-memory-failed')).not.toBeNull();
      expect(onWorkspaceCreated).not.toHaveBeenCalled();

      click('add-workspace-private-memory-retry');
      await waitFor(() => {
        expect(onWorkspaceCreated).toHaveBeenCalledWith('new-repo');
      });
      expect(savePrivateMemory).toHaveBeenCalledTimes(3);
      for (const call of savePrivateMemory.mock.calls)
        expect(call).toEqual(['new-repo', true]);
      // Retrying never creates a second project.
      expect(mockProjectsState.initLocalRepo).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when the project itself could not be created', async () => {
      const onWorkspaceCreated = jest.fn();
      mockProjectsState.initLocalRepo.mockRejectedValue(
        new Error('A folder with that name already exists'),
      );
      await open(jest.fn(), onWorkspaceCreated);
      click('add-workspace-mode-create');
      nameProject('new-repo');
      togglePrivateMemory();
      click('add-workspace-create-submit');

      await waitFor(() => {
        expect(container.textContent).toContain(
          'A folder with that name already exists',
        );
      });
      expect(savePrivateMemory).not.toHaveBeenCalled();
      expect(onWorkspaceCreated).not.toHaveBeenCalled();
      expect(control('add-workspace-private-memory-failed')).toBeNull();
      // The form stays editable with the choice intact for the next attempt.
      expect(container.querySelector('fieldset')?.disabled).toBe(false);
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    });

    it('still saves the choice for the project it created after the dialog is dismissed', async () => {
      const onWorkspaceCreated = jest.fn();
      let finishCreate: (workspaceId: string) => void = () => undefined;
      mockProjectsState.initLocalRepo.mockReturnValue(
        new Promise<string>((resolve) => {
          finishCreate = resolve;
        }),
      );
      savePrivateMemory.mockRejectedValue(new Error('disk full'));
      await open(jest.fn(), onWorkspaceCreated);
      click('add-workspace-mode-create');
      nameProject('new-repo');
      togglePrivateMemory();
      click('add-workspace-create-submit');
      await waitFor(() => {
        expect(mockProjectsState.initLocalRepo).toHaveBeenCalledTimes(1);
      });
      act(() => {
        root.render(<AddRepoModal isOpen={false} onClose={jest.fn()} />);
      });
      await act(async () => {
        finishCreate('new-repo');
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(savePrivateMemory).toHaveBeenCalledWith('new-repo', true);
        expect(mockGitHubState.addToast).toHaveBeenCalledWith(
          expect.stringContaining("Couldn't turn on Private memory"),
          'error',
          undefined,
          { forceInApp: true, title: 'Private memory is off' },
        );
      });
      expect(onWorkspaceCreated).not.toHaveBeenCalled();
    });
  });

  describe('Personal Existing folder of an organization checkout (CAN-3648)', () => {
    const owner = {
      type: 'organization' as const,
      organizationId: 'org-a',
      projectId: 'p',
      instanceId: 'i',
      bindingGeneration: 2,
    };
    const boundRow: SidebarItem = {
      id: 'w',
      name: 'local-only-name',
      type: 'single-repo',
      repoPath: '/repo',
      color: '#123456',
      worktrees: [],
      order: 0,
      collapsed: false,
      owner,
    };
    const orgProject = (
      overrides: Partial<OrgProjectSummary> = {},
    ): OrgProjectSummary => ({
      id: 'p',
      organizationId: 'org-a',
      name: 'Payments',
      description: null,
      kind: 'CODE',
      location: 'LOCAL',
      repository: null,
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      capabilities: { use: true, administer: false, manageCloud: false },
      instance: { id: 'i', state: 'READY' },
      ...overrides,
      purpose: overrides.purpose ?? 'project',
      visibility: overrides.visibility ?? 'organization',
      memberOwned: overrides.memberOwned ?? false,
    });
    const organizations = [
      { id: 'org-a', name: 'Acme', role: 'MEMBER' as const },
    ];
    let setContext: jest.Mock;
    let closed: jest.Mock;

    function catalogWith(project: OrgProjectSummary | null): void {
      Object.assign(mockCatalog, {
        errors: {},
        snapshots: {
          'org:org-a': {
            context: 'org:org-a',
            revision: '1',
            fetchedAt: '',
            projects: project === null ? [] : [project],
          },
        },
      });
    }

    function notice(): HTMLElement | null {
      return document.querySelector(
        '[data-testid="add-workspace-org-conflict"]',
      );
    }

    // The dialog's own close button cancels, so the notice offers no Cancel.
    function noticeButtons(): (string | null)[] {
      return Array.from(
        notice()?.querySelectorAll('button') ?? [],
        (button): string | null => button.textContent,
      );
    }

    async function pickConflictingFolder(): Promise<void> {
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(<AddRepoModal isOpen onClose={closed} />);
      });
      click('add-workspace-mode-existing');
      await clickAndSettle('add-workspace-choose-folder');
      await waitFor((): void => {
        expect(notice()).not.toBeNull();
        expect(notice()?.getAttribute('data-conflict-status')).not.toBe(
          'resolving',
        );
      });
    }

    beforeEach((): void => {
      const snapshot = getDefaultFeatureFlagSnapshot();
      snapshot.values['canopy-shared-org-projects-enabled'] = true;
      useFeatureFlagsStore.setState({ snapshot });
      useWorkspaceContextStore.setState({
        state: { context: { kind: 'personal' }, revision: 1, organizations },
        hydrated: true,
        accountEpoch: 0,
      });
      Object.assign(mockCatalog, { accountEpoch: 0, errors: {} });
      catalogWith(orgProject());
      mockProjectsState.projects = [boundRow];
      mockProjectsState.loadProjects.mockResolvedValue(undefined);
      mockProjectsState.addLocalRepo.mockReset();
      mockProjectsState.browseForRepo.mockReset().mockResolvedValue({
        path: '/repo',
        name: 'repo',
      });
      jest.mocked(mockCatalog.load).mockReset().mockResolvedValue(undefined);
      checkAddWorkspaceFromFolder.mockResolvedValue({
        status: 'already-tracked',
        workspaceId: 'w',
        owner,
      });
      mockHomeComposerState.selectWorkspace.mockReset();
      closed = jest.fn();
      const switched = {
        context: { kind: 'organization', organizationId: 'org-a' },
        revision: 2,
        organizations,
      };
      setContext = jest.fn(() => Promise.resolve(switched));
      Object.assign(window.api, {
        workspaceContext: {
          set: setContext,
          get: jest.fn(() =>
            Promise.resolve(useWorkspaceContextStore.getState().state),
          ),
        },
      });
    });

    it('uses the tracked-folder conflict when the ownership nudge also finds the repository', async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue({
        kind: 'organization',
        organizationId: 'org-a',
        organizationName: 'Acme',
        projectId: 'payments',
        projectName: 'Payments',
        repositoryName: 'acme/payments',
      });
      await pickConflictingFolder();
      expect(notice()?.getAttribute('data-conflict-status')).toBe('ready');
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-owner-notice"]',
        ),
      ).toBeNull();
      expect(findRepositoryOwner).not.toHaveBeenCalled();
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
    });

    it('opens the existing organization project instead of showing the IPC error', async (): Promise<void> => {
      await pickConflictingFolder();
      expect(checkAddWorkspaceFromFolder).toHaveBeenCalledWith({
        repoPath: '/repo',
      });
      expect(notice()?.textContent).toContain(
        'This repository is already managed by Acme as "Payments". Open the organization project to continue.',
      );
      expect(noticeButtons()).toEqual([
        'Choose another folder',
        'Open in Acme',
      ]);
      expect(notice()?.textContent).not.toContain('local-only-name');
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
      const open = document.querySelector(
        '[data-testid="add-workspace-org-conflict-open"]',
      );
      expect(open?.textContent).toBe('Open in Acme');
      await clickAndSettle('add-workspace-org-conflict-open');
      await waitFor((): void => {
        expect(mockHomeComposerState.selectWorkspace).toHaveBeenCalledWith('w');
      });
      expect(setContext).toHaveBeenCalledTimes(1);
      expect(setContext).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { kind: 'organization', organizationId: 'org-a' },
        }),
      );
      expect(closed).toHaveBeenCalledTimes(1);
      expect(mockNavigationState.navigate).toHaveBeenCalledWith('home');
      expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
      expect(mockGitHubState.addToast).not.toHaveBeenCalled();
    });

    it('shows an unfinished project without selecting it or starting setup', async (): Promise<void> => {
      catalogWith(orgProject({ instance: { id: 'i', state: 'CLAIMED' } }));
      await pickConflictingFolder();
      expect(notice()?.getAttribute('data-conflict-status')).toBe('unfinished');
      expect(notice()?.textContent).toContain(
        "its setup didn't finish on this device. Finishing it isn't available yet.",
      );
      const show = document.querySelector(
        '[data-testid="add-workspace-org-conflict-open"]',
      );
      expect(show?.textContent).toBe('Show in Acme');
      await clickAndSettle('add-workspace-org-conflict-open');
      await waitFor((): void => {
        expect(closed).toHaveBeenCalledTimes(1);
      });
      expect(setContext).toHaveBeenCalledTimes(1);
      expect(mockHomeComposerState.selectWorkspace).not.toHaveBeenCalled();
      expect(mockCatalog.requestSetup).not.toHaveBeenCalled();
      expect(mockCatalog.startSetup).not.toHaveBeenCalled();
    });

    it.each(['membership', 'project access'])(
      'redacts a settled notice and Advisor identity after idle %s revocation',
      async (revocation): Promise<void> => {
        await pickConflictingFolder();
        expect(notice()?.textContent).toContain('Payments');
        act((): void => {
          if (revocation === 'membership') {
            useWorkspaceContextStore.setState({
              state: {
                context: { kind: 'personal' },
                revision: 1,
                organizations: [],
              },
            });
          } else {
            catalogWith(
              orgProject({
                capabilities: {
                  use: false,
                  administer: false,
                  manageCloud: false,
                },
              }),
            );
            root.render(<AddRepoModal isOpen onClose={closed} />);
          }
        });
        expect(notice()?.getAttribute('data-conflict-status')).toBe('denied');
        expect(notice()?.textContent).not.toContain('Payments');
        if (revocation === 'membership')
          expect(notice()?.textContent).not.toContain('Acme');
        expect(
          document.querySelector(
            '[data-testid="add-workspace-org-conflict-open"]',
          ),
        ).toBeNull();
        expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
          'addWorkspace.modal',
          expect.objectContaining({ folderConflict: { status: 'denied' } }),
        );
        expect(setContext).not.toHaveBeenCalled();
        expect(mockHomeComposerState.selectWorkspace).not.toHaveBeenCalled();
      },
    );

    it('tells a non-member why without an action or names', async (): Promise<void> => {
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'personal' },
          revision: 1,
          organizations: [],
        },
      });
      await pickConflictingFolder();
      expect(notice()?.textContent).toContain(
        "This repository is managed by an organization you're not a member of, so it can't be opened here.",
      );
      expect(notice()?.textContent).not.toContain('Payments');
      expect(
        document.querySelector(
          '[data-testid="add-workspace-org-conflict-open"]',
        ),
      ).toBeNull();
      expect(mockCatalog.load).not.toHaveBeenCalled();
      expect(noticeButtons()).toEqual(['Choose another folder']);
    });

    it('denies an inaccessible project without naming it', async (): Promise<void> => {
      catalogWith(null);
      await pickConflictingFolder();
      expect(notice()?.textContent).toContain(
        "This repository is managed by Acme, but it can't be opened right now.",
      );
      expect(notice()?.textContent).not.toContain('Payments');
    });

    it('never falls through to a Personal import when the feature is off', async (): Promise<void> => {
      const snapshot = getDefaultFeatureFlagSnapshot();
      snapshot.values['canopy-shared-org-projects-enabled'] = false;
      useFeatureFlagsStore.setState({ snapshot });
      await pickConflictingFolder();
      expect(notice()?.textContent).toContain(
        "organization projects aren't available right now.",
      );
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
    });

    it('retries an unknown check with a real refresh', async (): Promise<void> => {
      Object.assign(mockCatalog, { errors: { 'org:org-a': 'offline' } });
      await pickConflictingFolder();
      expect(notice()?.getAttribute('data-conflict-status')).toBe('unknown');
      expect(notice()?.textContent).toContain(
        "Couldn't check this organization project right now. Try again.",
      );
      jest
        .mocked(mockCatalog.load)
        .mockImplementationOnce((): Promise<void> => {
          Object.assign(mockCatalog, { errors: {} });
          return Promise.resolve();
        });
      await clickAndSettle('add-workspace-org-conflict-retry');
      await waitFor((): void => {
        expect(notice()?.getAttribute('data-conflict-status')).toBe('ready');
      });
      expect(mockCatalog.load).toHaveBeenLastCalledWith(
        { kind: 'organization', organizationId: 'org-a' },
        { refresh: true },
      );
    });

    it('keeps the action after an ordinary switch failure and switches once per click', async (): Promise<void> => {
      setContext.mockRejectedValueOnce(new Error('offline'));
      await pickConflictingFolder();
      await act(async (): Promise<void> => {
        click('add-workspace-org-conflict-open');
        click('add-workspace-org-conflict-open');
        await Promise.resolve();
      });
      await waitFor((): void => {
        expect(notice()?.textContent).toContain(
          "Couldn't switch to Acme. Try again.",
        );
      });
      expect(setContext).toHaveBeenCalledTimes(1);
      expect(closed).not.toHaveBeenCalled();
      await clickAndSettle('add-workspace-org-conflict-open');
      await waitFor((): void => {
        expect(mockHomeComposerState.selectWorkspace).toHaveBeenCalledWith('w');
      });
      expect(setContext).toHaveBeenCalledTimes(2);
    });

    it('updates the notice instead of switching when readiness changed', async (): Promise<void> => {
      await pickConflictingFolder();
      catalogWith(orgProject({ instance: { id: 'i', state: 'CLAIMED' } }));
      await clickAndSettle('add-workspace-org-conflict-open');
      await waitFor((): void => {
        expect(notice()?.getAttribute('data-conflict-status')).toBe(
          'unfinished',
        );
      });
      expect(setContext).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
    });

    it('reports a target that became unavailable after switching once, selecting nothing', async (): Promise<void> => {
      await pickConflictingFolder();
      let loads = 0;
      jest.mocked(mockCatalog.load).mockImplementation((): Promise<void> => {
        loads += 1;
        // Pre-flight still sees READY; the post-switch open does not.
        if (loads > 1)
          catalogWith(orgProject({ instance: { id: 'i', state: 'CLAIMED' } }));
        return Promise.resolve();
      });
      await clickAndSettle('add-workspace-org-conflict-open');
      await waitFor((): void => {
        expect(mockGitHubState.addToast).toHaveBeenCalledTimes(1);
      });
      expect(mockGitHubState.addToast).toHaveBeenCalledWith(
        'Project not available',
        'error',
      );
      expect(closed).toHaveBeenCalledTimes(1);
      expect(mockHomeComposerState.selectWorkspace).not.toHaveBeenCalled();
    });

    it('does not close or open after an unrelated scope excursion during the switch', async (): Promise<void> => {
      await pickConflictingFolder();
      setContext.mockImplementationOnce((): Promise<unknown> => {
        const context = useWorkspaceContextStore.getState();
        context.applyBroadcast({
          context: { kind: 'organization', organizationId: 'org-b' },
          revision: 2,
          organizations,
          reason: 'switch',
        });
        context.applyBroadcast({
          context: { kind: 'organization', organizationId: 'org-a' },
          revision: 3,
          organizations,
          reason: 'switch',
        });
        return Promise.resolve(useWorkspaceContextStore.getState().state);
      });
      await clickAndSettle('add-workspace-org-conflict-open');
      await flush();
      expect(closed).not.toHaveBeenCalled();
      expect(mockHomeComposerState.selectWorkspace).not.toHaveBeenCalled();
    });

    // Main broadcasts the committed switch before it answers. The broadcast
    // remounts this draft into the organization's cleared form, so the dialog
    // must close with it rather than paint that form until the reply lands.
    it('closes with the broadcast of its own switch, before the reply', async (): Promise<void> => {
      await pickConflictingFolder();
      // The parent really closes the dialog, ending its lifetime before the
      // reply; the open must still continue.
      closed.mockImplementation((): void => {
        root.render(<AddRepoModal isOpen={false} onClose={closed} />);
      });
      let reply: (state: unknown) => void = (): void => {};
      setContext.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            reply = resolve;
          }),
      );
      await clickAndSettle('add-workspace-org-conflict-open');
      expect(closed).not.toHaveBeenCalled();
      act((): void => {
        useWorkspaceContextStore.getState().applyBroadcast({
          context: { kind: 'organization', organizationId: 'org-a' },
          revision: 2,
          organizations,
          reason: 'switch',
        });
      });
      expect(closed).toHaveBeenCalledTimes(1);
      await act(async (): Promise<void> => {
        await Promise.resolve();
        reply(useWorkspaceContextStore.getState().state);
      });
      await waitFor((): void => {
        expect(mockHomeComposerState.selectWorkspace).toHaveBeenCalledWith('w');
      });
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('does not close or open after an account change during the switch', async (): Promise<void> => {
      await pickConflictingFolder();
      setContext.mockImplementationOnce((): Promise<unknown> => {
        useWorkspaceContextStore.setState({ accountEpoch: 5 });
        return Promise.resolve({
          context: { kind: 'organization', organizationId: 'org-a' },
          revision: 2,
          organizations,
        });
      });
      await clickAndSettle('add-workspace-org-conflict-open');
      await flush();
      expect(closed).not.toHaveBeenCalled();
      expect(mockHomeComposerState.selectWorkspace).not.toHaveBeenCalled();
    });

    it('drops the old target when the member picks again and cancels', async (): Promise<void> => {
      await pickConflictingFolder();
      mockProjectsState.browseForRepo.mockResolvedValueOnce(null);
      await clickAndSettle('add-workspace-org-conflict-choose-another');
      expect(notice()).toBeNull();
      expect(
        document.querySelector('[data-testid="add-workspace-choose-folder"]'),
      ).not.toBeNull();
    });

    it('imports a Personal duplicate as before, without the IPC wrapper', async (): Promise<void> => {
      checkAddWorkspaceFromFolder.mockResolvedValue({
        status: 'already-tracked',
        workspaceId: 'w',
        owner: null,
      });
      mockProjectsState.addLocalRepo.mockRejectedValue(
        new Error(
          'Error invoking remote method \'workspace:add-from-folder\': Error: This repository is already tracked as project "repo"',
        ),
      );
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(<AddRepoModal isOpen onClose={closed} />);
      });
      click('add-workspace-mode-existing');
      await clickAndSettle('add-workspace-choose-folder');
      await waitFor((): void => {
        expect(container.textContent).toContain(
          'This repository is already tracked as project "repo"',
        );
      });
      expect(container.textContent).not.toContain('Error invoking');
      expect(notice()).toBeNull();
    });

    it('discards a picker result after changing options', async (): Promise<void> => {
      let release: (selection: {
        path: string;
        name: string;
      }) => void = (): void => {};
      mockProjectsState.browseForRepo.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(<AddRepoModal isOpen onClose={closed} />);
      });
      click('add-workspace-mode-existing');
      await clickAndSettle('add-workspace-choose-folder');
      await clickAndSettle('add-workspace-mode-create');
      await act(async (): Promise<void> => {
        await Promise.resolve();
        release({ path: '/repo', name: 'repo' });
      });
      await clickAndSettle('add-workspace-mode-existing');
      expect(notice()).toBeNull();
      expect(checkAddWorkspaceFromFolder).not.toHaveBeenCalled();
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
    });

    it('disables conflict controls while opening', async (): Promise<void> => {
      await pickConflictingFolder();
      let release: () => void = (): void => {};
      jest.mocked(mockCatalog.load).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await clickAndSettle('add-workspace-org-conflict-open');
      expect(button('add-workspace-org-conflict-open').disabled).toBe(true);
      expect(button('add-workspace-org-conflict-choose-another').disabled).toBe(
        true,
      );
      await act(async (): Promise<void> => {
        await Promise.resolve();
        release();
      });
    });

    it('does not close a newer dialog after the parent closes during a switch', async (): Promise<void> => {
      await pickConflictingFolder();
      let release: (state: unknown) => void = (): void => {};
      setContext.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      await clickAndSettle('add-workspace-org-conflict-open');
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(<AddRepoModal isOpen={false} onClose={closed} />);
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(<AddRepoModal isOpen onClose={closed} />);
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        release({
          context: { kind: 'organization', organizationId: 'org-a' },
          revision: 2,
          organizations,
        });
      });
      await flush();
      expect(closed).not.toHaveBeenCalled();
      expect(mockHomeComposerState.selectWorkspace).not.toHaveBeenCalled();
    });

    it.each(['account', 'context', 'close', 'option'])(
      'discards a pending catalog answer after %s supersedes the dialog',
      async (change): Promise<void> => {
        let release: () => void = (): void => {};
        jest.mocked(mockCatalog.load).mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        await act(async (): Promise<void> => {
          await Promise.resolve();
          root.render(<AddRepoModal isOpen onClose={closed} />);
        });
        click('add-workspace-mode-existing');
        await clickAndSettle('add-workspace-choose-folder');
        expect(notice()?.getAttribute('data-conflict-status')).toBe(
          'resolving',
        );
        expect(notice()?.getAttribute('role')).toBe('status');
        expect(notice()?.getAttribute('aria-busy')).toBe('true');
        expect(jest.mocked(useCurrentUiStateReporter)).toHaveBeenLastCalledWith(
          'addWorkspace.modal',
          expect.objectContaining({ folderConflict: { status: 'resolving' } }),
        );
        await act(async (): Promise<void> => {
          await Promise.resolve();
          if (change === 'account')
            useWorkspaceContextStore.setState({ accountEpoch: 10 });
          if (change === 'context')
            useWorkspaceContextStore.setState({
              state: {
                context: { kind: 'organization', organizationId: 'org-a' },
                revision: 2,
                organizations,
              },
            });
          if (change === 'close')
            root.render(<AddRepoModal isOpen={false} onClose={closed} />);
        });
        if (change === 'option')
          await clickAndSettle('add-workspace-mode-create');
        await act(async (): Promise<void> => {
          await Promise.resolve();
          release();
        });
        await flush();
        if (change === 'option')
          await clickAndSettle('add-workspace-mode-existing');
        expect(notice()).toBeNull();
        expect(closed).not.toHaveBeenCalled();
        expect(mockHomeComposerState.selectWorkspace).not.toHaveBeenCalled();
        expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
      },
    );

    it('reports the conflict to App Advisor with ids only once access is established', async (): Promise<void> => {
      const reporter = jest.mocked(useCurrentUiStateReporter);
      await pickConflictingFolder();
      expect(reporter).toHaveBeenLastCalledWith(
        'addWorkspace.modal',
        expect.objectContaining({
          folderConflict: {
            status: 'ready',
            organizationId: 'org-a',
            projectId: 'p',
          },
        }),
      );
      expect(JSON.stringify(reporter.mock.calls)).not.toContain('/repo');
      catalogWith(null);
      await clickAndSettle('add-workspace-org-conflict-open');
      await waitFor((): void => {
        expect(reporter).toHaveBeenLastCalledWith(
          'addWorkspace.modal',
          expect.objectContaining({ folderConflict: { status: 'denied' } }),
        );
      });
    });
  });

  // CAN-3984: a member whose organization has nothing to add yet goes
  // straight to an option that can add something, including Remote; an owner
  // or admin keeps the catalog, whose empty state offers its setup.
  describe('an empty organization catalog (CAN-3984)', () => {
    const REMOTE_URL = 'https://github.com/acme/site.git';
    const CLONED = { name: 'site', path: 'C:\\repos\\site' };
    const NEW_CODE = {
      kind: 'code',
      target: 'new',
      repository: { host: 'github.com', owner: 'acme', name: 'site' },
    };
    let addRemoteRepoIpc: jest.Mock;

    beforeEach((): void => {
      getOrgCodeEligibility.mockResolvedValue('eligible');
      addRemoteRepoIpc = jest.fn().mockResolvedValue(CLONED);
      Object.assign(window.api, { addRemoteRepo: addRemoteRepoIpc });
      jest.mocked(window.api.probeCloneDestination).mockResolvedValue({
        repoName: 'site',
        candidateExists: false,
        reusablePath: null,
      });
    });

    async function openCatalog(
      role: WorkspaceContextOrganizationRole,
      snapshot: Record<string, unknown> = {},
      onClose: jest.Mock = closeOrgModal,
    ): Promise<void> {
      openOrganization();
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'organization', organizationId: 'org-a' },
          revision: 1,
          organizations: [{ id: 'org-a', name: 'Acme', role }],
        },
      });
      Object.assign(mockCatalog, {
        snapshots: {
          'org:org-a': {
            context: 'org:org-a',
            revision: '1',
            fetchedAt: '',
            projects: [],
            stale: false,
            error: null,
            ...snapshot,
          },
        },
      });
      await act(async (): Promise<void> => {
        root.render(<AddRepoModal isOpen onClose={onClose} />);
        await Promise.resolve();
      });
      await flush();
    }

    function tile(mode: string): Element | null {
      return byTestId(`add-workspace-mode-${mode}`);
    }

    it('opens a member on Existing folder, with Remote beside it', async (): Promise<void> => {
      await openCatalog('MEMBER');
      expect(tile('catalog')).toBeNull();
      expect(tile('existing')?.getAttribute('aria-pressed')).toBe('true');
      expect(tile('remote')).not.toBeNull();
      expect(tile('create')).not.toBeNull();
      expect(byTestId('add-workspace-org-catalog')).toBeNull();
      // The catalog is still read, shown or not.
      expect(mockCatalog.load).toHaveBeenCalledWith(
        { kind: 'organization', organizationId: 'org-a' },
        { refresh: true, repositories: true },
      );
    });

    // CAN-5041: a withheld catalog leaves the mode's own order.
    it.each([
      { mode: 'work', order: ['existing', 'create', 'remote'] },
      { mode: 'code', order: ['remote', 'existing', 'create'] },
    ] as const)(
      'orders the remaining tiles for $mode mode',
      async ({ mode, order }): Promise<void> => {
        mockNavigationModeState.mode = mode;
        await openCatalog('MEMBER');
        expect(
          Array.from(
            document.querySelectorAll('[data-testid^="add-workspace-mode-"]'),
            (element) => element.getAttribute('data-testid'),
          ),
        ).toEqual(order.map((id) => `add-workspace-mode-${id}`));
        expect(tile('existing')?.getAttribute('aria-pressed')).toBe('true');
      },
    );

    it("reads the catalog under the store's own key", async (): Promise<void> => {
      openOrganization();
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'organization', organizationId: 'Org-A' },
          revision: 1,
          organizations: [{ id: 'Org-A', name: 'Acme', role: 'MEMBER' }],
        },
      });
      // The store keys snapshots by `serializeWorkspaceContext`, lowercased.
      Object.assign(mockCatalog, {
        snapshots: {
          'org:org-a': {
            context: 'org:org-a',
            revision: '1',
            fetchedAt: '',
            projects: [],
            stale: false,
            error: null,
          },
        },
      });
      await act(async (): Promise<void> => {
        root.render(<AddRepoModal isOpen onClose={closeOrgModal} />);
        await Promise.resolve();
      });
      await flush();
      expect(tile('catalog')).toBeNull();
      expect(tile('existing')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('offers Clone repository unfolded in Work mode', async (): Promise<void> => {
      mockNavigationModeState.mode = 'work';
      await openCatalog('MEMBER');
      expect(
        document.querySelector('[data-testid="add-workspace-see-more"]'),
      ).toBeNull();
      expect(tile('remote')?.getAttribute('aria-pressed')).toBe('false');
    });

    it('keeps the catalog for a member with nothing else to choose', async (): Promise<void> => {
      getOrgCoworkEligibility.mockResolvedValue('ineligible');
      await openCatalog('MEMBER');
      expect(tile('catalog')?.getAttribute('aria-pressed')).toBe('true');
      expect(document.body.textContent).toContain('Nothing in Acme yet');
      expect(tile('remote')).toBeNull();
    });

    it.each([
      ['a stale', { stale: true }],
      ['an unauthorized', { error: 'access-changed' }],
    ])(
      'keeps the catalog for %s read',
      async (_label, snapshot): Promise<void> => {
        await openCatalog('MEMBER', snapshot);
        expect(tile('catalog')?.getAttribute('aria-pressed')).toBe('true');
        expect(tile('remote')).toBeNull();
      },
    );

    it.each([
      ['a failed catalog', { error: 'offline', stale: false }],
      ['a failed repository refresh', { repositoriesRefresh: 'failed' }],
      ['a mismatched snapshot', { context: 'org:org-b' }],
    ])('retains Catalog for %s', async (_label, snapshot): Promise<void> => {
      await openCatalog('MEMBER', snapshot);
      expect(tile('catalog')).not.toBeNull();
      expect(tile('remote')).toBeNull();
    });

    it('does not refresh an old organization after its initial load completes in a new account', async (): Promise<void> => {
      let finish: () => void = () => undefined;
      jest.mocked(mockCatalog.load).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      await openCatalog('MEMBER');
      act(() =>
        root.render(<AddRepoModal isOpen={false} onClose={closeOrgModal} />),
      );
      await act(async () => {
        finish();
        await Promise.resolve();
      });
      expect(mockCatalog.load).toHaveBeenCalledTimes(1);
    });

    it('moves focus from a hidden Catalog tile to Existing folder', async (): Promise<void> => {
      let settle: () => void = () => undefined;
      jest.mocked(mockCatalog.load).mockImplementation(
        (_context, options): Promise<void> =>
          options?.repositories === true
            ? new Promise<void>((resolve) => {
                settle = resolve;
              })
            : Promise.resolve(),
      );
      try {
        await openCatalog('MEMBER');
        const catalog = tile('catalog');
        if (!(catalog instanceof HTMLElement))
          throw new Error('Catalog tile not found');
        catalog.focus();
        await act(async () => {
          settle();
          await Promise.resolve();
        });
        await flush();
        expect(document.activeElement).toBe(tile('existing'));
      } finally {
        jest.mocked(mockCatalog.load).mockResolvedValue(undefined);
      }
    });

    it('keeps a catalog with projects to add', async (): Promise<void> => {
      await openCatalog('MEMBER', {
        projects: [
          {
            id: 'site',
            organizationId: 'org-a',
            name: 'Site',
            description: null,
            kind: 'CODE',
            purpose: 'project',
            location: 'LOCAL',
            repository: {
              provider: 'github',
              host: 'github.com',
              owner: 'acme',
              name: 'site',
              providerRepoId: 'site',
              defaultBranch: 'main',
              verification: 'VERIFIED',
            },
            state: 'ACTIVE',
            revision: 1,
            authorizationVersion: 1,
            defaultListed: false,
            preference: 'FOLLOW_DEFAULTS',
            listed: false,
            capabilities: { use: true, administer: false, manageCloud: false },
            instance: null,
          },
        ],
      });
      expect(tile('catalog')?.getAttribute('aria-pressed')).toBe('true');
      expect(tile('remote')).toBeNull();
    });

    it('keeps a seeded Create new selection', async (): Promise<void> => {
      openOrganization();
      Object.assign(mockCatalog, {
        snapshots: {
          'org:org-a': {
            context: 'org:org-a',
            revision: '1',
            fetchedAt: '',
            projects: [],
          },
        },
      });
      await act(async (): Promise<void> => {
        root.render(
          <AddRepoModal
            isOpen
            onClose={closeOrgModal}
            initialProjectType="cowork"
          />,
        );
        await Promise.resolve();
      });
      await flush();
      expect(tile('catalog')).toBeNull();
      expect(tile('create')?.getAttribute('aria-pressed')).toBe('true');
    });

    it.each(['OWNER', 'ADMIN'] as const)(
      'offers %s Connect GitHub when the organization is not connected',
      async (role): Promise<void> => {
        await openCatalog(role, { repositoriesRefresh: 'not-connected' });
        expect(tile('catalog')?.getAttribute('aria-pressed')).toBe('true');
        expect(tile('remote')).toBeNull();
        await clickAndSettle('add-workspace-org-catalog-connect-github');
        expect(window.api.openAuthenticatedPortalPage).toHaveBeenCalledWith(
          '/organization/org-a/settings?tab=integrations',
        );
        expect(closeOrgModal).toHaveBeenCalled();
      },
    );

    it.each([
      ['an unconfirmed', {}],
      ['a failed', { repositoriesRefresh: 'failed' }],
    ])(
      'offers an admin Choose projects after %s GitHub check',
      async (_label, snapshot): Promise<void> => {
        await openCatalog('ADMIN', snapshot);
        expect(byTestId('add-workspace-org-catalog-connect-github')).toBeNull();
        await clickAndSettle('add-workspace-org-catalog-choose-projects');
        expect(window.api.openAuthenticatedPortalPage).toHaveBeenCalledWith(
          '/organization/org-a/projects',
        );
        expect(closeOrgModal).toHaveBeenCalled();
      },
    );

    it('shows checking until the GitHub re-read settles', async (): Promise<void> => {
      let settle: () => void = () => undefined;
      jest.mocked(mockCatalog.load).mockImplementation(
        (_context, options): Promise<void> =>
          options?.repositories === true
            ? new Promise<void>((resolve) => {
                settle = resolve;
              })
            : Promise.resolve(),
      );
      try {
        await openCatalog('ADMIN');
        expect(
          byTestId('add-workspace-org-catalog-setup-checking'),
        ).not.toBeNull();
        await act(async (): Promise<void> => {
          settle();
          await Promise.resolve();
        });
        await flush();
        expect(
          byTestId('add-workspace-org-catalog-choose-projects'),
        ).not.toBeNull();
      } finally {
        jest.mocked(mockCatalog.load).mockResolvedValue(undefined);
      }
    });

    it('opens Connect GitHub inside Settings when hosted settings are openable', async (): Promise<void> => {
      mockHostedSettingsClient = {};
      try {
        await openCatalog('OWNER', { repositoriesRefresh: 'not-connected' });
        await clickAndSettle('add-workspace-org-catalog-connect-github');
        expect(
          mockNavigationState.openAccountOrganizationSettings,
        ).toHaveBeenCalledWith(
          {
            scope: 'organization',
            organizationId: 'org-a',
            page: 'settings',
            subtab: 'integrations',
          },
          expect.anything(),
        );
        expect(window.api.openAuthenticatedPortalPage).not.toHaveBeenCalled();
        expect(closeOrgModal).toHaveBeenCalled();
      } finally {
        mockHostedSettingsClient = null;
        mockNavigationState.openAccountOrganizationSettings.mockClear();
      }
    });

    it('keeps the dialog open when the page cannot open', async (): Promise<void> => {
      jest
        .mocked(window.api.openAuthenticatedPortalPage)
        .mockRejectedValueOnce(new Error('failed'));
      await openCatalog('ADMIN');
      await clickAndSettle('add-workspace-org-catalog-choose-projects');
      expect(closeOrgModal).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "Couldn't open the page in your browser.",
      );
    });

    async function cloneFromRemote(): Promise<void> {
      await openCatalog('MEMBER');
      click('add-workspace-mode-remote');
      const input = byTestId('add-workspace-remote-url-input');
      if (!(input instanceof HTMLInputElement))
        throw new Error('Remote URL input not found');
      act((): void => {
        setNativeInputValue(input, REMOTE_URL);
      });
      await waitFor((): void => {
        expect(
          byTestId('add-workspace-clone-destination')?.querySelector('bdi')
            ?.textContent,
        ).toBe('C:\\repos');
      });
      await clickAndSettle('add-workspace-clone-submit');
    }

    it('clones only, then creates the project in the organization', async (): Promise<void> => {
      inspectOrgFolder.mockResolvedValue(NEW_CODE);
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue({
        ok: true,
        organizationProjectId: 'project-1',
        localWorkspaceId: 'workspace-1',
      });
      await cloneFromRemote();
      await waitFor((): void => {
        expect(
          mockProjectsState.createOrgMemberCodeProject,
        ).toHaveBeenCalledWith({
          organizationId: 'org-a',
          name: 'site',
          folderPath: CLONED.path,
        });
      });
      expect(addRemoteRepoIpc).toHaveBeenCalledWith({
        remoteUrl: REMOTE_URL,
        destinationDir: 'C:\\repos',
      });
      expect(inspectOrgFolder).toHaveBeenCalledWith({
        organizationId: 'org-a',
        path: CLONED.path,
      });
      // Never a Personal project, and never handed to the background.
      expect(mockProjectsState.addRemoteRepo).not.toHaveBeenCalled();
      expect(closeOrgModal).toHaveBeenCalled();
    });

    it('reuses a matching clone in the organization without cloning', async (): Promise<void> => {
      jest.mocked(window.api.probeCloneDestination).mockResolvedValue({
        repoName: 'site',
        candidateExists: true,
        reusablePath: 'C:\\repos\\site\\',
      });
      inspectOrgFolder.mockResolvedValue(NEW_CODE);
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue({
        ok: true,
        organizationProjectId: 'project-1',
        localWorkspaceId: 'workspace-1',
      });
      await cloneFromRemote();
      click('add-workspace-reuse-clone-existing');
      await waitFor((): void => {
        expect(
          mockProjectsState.createOrgMemberCodeProject,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'site',
            folderPath: 'C:\\repos\\site\\',
          }),
        );
      });
      expect(addRemoteRepoIpc).not.toHaveBeenCalled();
      expect(mockProjectsState.addLocalRepo).not.toHaveBeenCalled();
    });

    it('confirms a linked clone without cloning again', async (): Promise<void> => {
      inspectOrgFolder.mockResolvedValue({
        kind: 'code',
        target: { projectId: 'site', projectName: 'Site' },
        repository: { host: 'github.com', owner: 'acme', name: 'site' },
      });
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue({
        ok: true,
        organizationProjectId: 'site',
        localWorkspaceId: 'workspace-1',
      });
      await cloneFromRemote();
      expect(byTestId('add-workspace-org-folder-path')?.textContent).toBe(
        CLONED.path,
      );
      expect(byTestId('add-workspace-clone-submit')).toBeNull();
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).not.toHaveBeenCalled();
      await clickAndSettle('add-workspace-org-folder-add');
      expect(addRemoteRepoIpc).toHaveBeenCalledTimes(1);
      expect(mockProjectsState.createOrgMemberCodeProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Site', folderPath: CLONED.path }),
      );
    });

    it('retries a failed setup on the same project, keeping the clone', async (): Promise<void> => {
      inspectOrgFolder.mockResolvedValue(NEW_CODE);
      mockProjectsState.createOrgMemberCodeProject
        .mockResolvedValueOnce({
          ok: false,
          code: 'setup-failed',
          organizationProjectId: 'project-1',
        })
        .mockResolvedValueOnce({
          ok: true,
          organizationProjectId: 'project-1',
          localWorkspaceId: 'workspace-1',
        });
      await cloneFromRemote();
      await waitFor((): void => {
        expect(byTestId('add-workspace-org-retry')).not.toBeNull();
      });
      await clickAndSettle('add-workspace-org-retry');
      expect(addRemoteRepoIpc).toHaveBeenCalledTimes(1);
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          organizationProjectId: 'project-1',
          folderPath: CLONED.path,
        }),
      );
    });

    it('reports a failed clone in the Remote form', async (): Promise<void> => {
      addRemoteRepoIpc.mockRejectedValue(new Error('Clone failed'));
      await cloneFromRemote();
      expect(document.body.textContent).toContain(
        'Failed to clone the repository. Check the URL and access, then try again.',
      );
      expect(inspectOrgFolder).not.toHaveBeenCalled();
      expect(byTestId('add-workspace-clone-submit')).not.toBeNull();
    });

    it('continues an owner nudge in the captured organization', async (): Promise<void> => {
      findRepositoryOwner.mockResolvedValue({
        kind: 'organization',
        organizationId: 'org-b',
        organizationName: 'Beta',
        projectId: 'site',
        projectName: 'Site',
        repositoryName: 'acme/site',
      });
      inspectOrgFolder.mockResolvedValue(NEW_CODE);
      await cloneFromRemote();
      expect(addRemoteRepoIpc).not.toHaveBeenCalled();
      await clickAndSettle('add-workspace-org-owner-notice-continue');
      expect(addRemoteRepoIpc).toHaveBeenCalledTimes(1);
      expect(mockProjectsState.createOrgMemberCodeProject).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-a',
          folderPath: CLONED.path,
        }),
      );
      expect(mockProjectsState.addRemoteRepo).not.toHaveBeenCalled();
    });

    it('retains a refused clone in the Remote form without registration', async (): Promise<void> => {
      inspectOrgFolder.mockResolvedValue({
        kind: 'refused',
        reason: 'overlaps-project',
      });
      await cloneFromRemote();
      expect(byTestId('add-workspace-remote-panel')).not.toBeNull();
      expect(document.body.textContent).toContain(
        'This folder overlaps a project you already have.',
      );
      expect(byTestId('add-workspace-org-folder-add')).toBeNull();
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).not.toHaveBeenCalled();
      expect(closeOrgModal).not.toHaveBeenCalled();
    });

    it('retries registration of the cloned folder without another clone', async (): Promise<void> => {
      inspectOrgFolder.mockResolvedValue(NEW_CODE);
      mockProjectsState.createOrgMemberCodeProject
        .mockResolvedValueOnce({ ok: false, code: 'create-failed' })
        .mockResolvedValueOnce({
          ok: true,
          organizationProjectId: 'project-1',
          localWorkspaceId: 'workspace-1',
        });
      await cloneFromRemote();
      expect(document.body.textContent).toContain(
        "Couldn't create site in Acme. Try again.",
      );
      expect(closeOrgModal).not.toHaveBeenCalled();
      await clickAndSettle('add-workspace-org-folder-add');
      expect(addRemoteRepoIpc).toHaveBeenCalledTimes(1);
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).toHaveBeenCalledTimes(2);
      expect(
        mockProjectsState.createOrgMemberCodeProject,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          organizationId: 'org-a',
          folderPath: CLONED.path,
        }),
      );
    });

    it('clones a new copy into the organization instead of reusing the existing clone', async (): Promise<void> => {
      jest.mocked(window.api.probeCloneDestination).mockResolvedValue({
        repoName: 'site',
        candidateExists: true,
        reusablePath: 'C:\\repos\\site',
      });
      inspectOrgFolder.mockResolvedValue(NEW_CODE);
      mockProjectsState.createOrgMemberCodeProject.mockResolvedValue({
        ok: true,
        organizationProjectId: 'project-1',
        localWorkspaceId: 'workspace-1',
      });
      await cloneFromRemote();
      click('add-workspace-reuse-clone-new');
      await flush();
      expect(addRemoteRepoIpc).toHaveBeenCalledTimes(1);
      expect(mockProjectsState.createOrgMemberCodeProject).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-a',
          folderPath: CLONED.path,
        }),
      );
      expect(mockProjectsState.addRemoteRepo).not.toHaveBeenCalled();
    });

    it.each(['close', 'context', 'account'] as const)(
      'does not register a clone after a %s change',
      async (change): Promise<void> => {
        let finish: (folder: RepoSelection) => void = () => undefined;
        addRemoteRepoIpc.mockImplementation(
          () =>
            new Promise<RepoSelection>((resolve) => {
              finish = resolve;
            }),
        );
        await cloneFromRemote();
        expect(addRemoteRepoIpc).toHaveBeenCalledTimes(1);
        if (change === 'close')
          act(() =>
            root.render(
              <AddRepoModal isOpen={false} onClose={closeOrgModal} />,
            ),
          );
        else if (change === 'account')
          act(() => useWorkspaceContextStore.setState({ accountEpoch: 1 }));
        else
          act(() =>
            useWorkspaceContextStore.setState({
              state: {
                context: { kind: 'organization', organizationId: 'org-b' },
                revision: 2,
                organizations: [{ id: 'org-b', name: 'Beta', role: 'MEMBER' }],
              },
            }),
          );
        act(() => {
          finish(CLONED);
        });
        await flush();
        expect(inspectOrgFolder).not.toHaveBeenCalled();
        expect(
          mockProjectsState.createOrgMemberCodeProject,
        ).not.toHaveBeenCalled();
        expect(closeOrgModal).not.toHaveBeenCalled();
      },
    );

    it('blocks a second submission while the organization clone is in flight', async (): Promise<void> => {
      let finish: (folder: RepoSelection) => void = () => undefined;
      addRemoteRepoIpc.mockImplementation(
        () =>
          new Promise<RepoSelection>((resolve) => {
            finish = resolve;
          }),
      );
      inspectOrgFolder.mockResolvedValue(NEW_CODE);
      await cloneFromRemote();
      click('add-workspace-clone-submit');
      expect(addRemoteRepoIpc).toHaveBeenCalledTimes(1);
      act(() => {
        finish(CLONED);
      });
      await flush();
    });
  });
});

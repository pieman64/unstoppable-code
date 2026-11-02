/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import type * as SettingsDestinationsModule from '@/lib/navigation/settings-destinations';
import { makeTestPreferences } from '@/test-utils/preferences';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { InviteTeammateModal } from '../InviteTeammateModal';
import type {
  CanopyCloudAccountPublicState,
  SaveSharedContainerFileScopeRequest,
  SharedContainerEligibilityResponse,
  SharedContainerSharePreview,
} from '@canopy/desktop-shared/types';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import { MAX_SHARED_CONTAINER_MEMBER_SEARCH_LIMIT } from '@canopy/protocol/shared-containers';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import {
  publicationStateKey,
  sharedWorktreeKey,
  useSharedContainersStore,
} from '@/stores/sharedContainersStore';
import { setNativeInputValue } from '@/test-utils/dom';
import { outermostReplayBlock } from '@/test-utils/replay';
import { requestSharedContainerRevocationConfirmation } from '@/lib/sharedContainerRevocationConfirmationEvents';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useNavigationStore } from '@/stores/navigationStore';

// Saving a layout commits the worktree's pending layout save first. Only that
// one function is replaced, so the order against the IPC can be asserted.
const mockFlushLayoutSave = jest.fn<Promise<void>, [string]>();
const mockOpenAccountOrganizationPage = jest.fn<
  'settings' | 'web',
  [unknown]
>();
jest.mock('@/lib/navigation/settings-destinations', () => {
  const actual = jest.requireActual<typeof SettingsDestinationsModule>(
    '@/lib/navigation/settings-destinations',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      openAccountOrganizationPage: {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (route: unknown): 'settings' | 'web' =>
          mockOpenAccountOrganizationPage(route),
      },
    },
  );
});

jest.mock('@/lib/panels/persistence-bridge', () => {
  const actual = jest.requireActual<Record<string, unknown>>(
    '@/lib/panels/persistence-bridge',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      flushPanelLayoutSaveForWorktree: {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (key: string): Promise<void> => mockFlushLayoutSave(key),
      },
    },
  );
});

const ORG = { id: 'org-1', name: 'Acme', createdAt: '', updatedAt: '' };

const PREVIEW: SharedContainerSharePreview = {
  containerType: 'CODE_WORKTREE',
  startPage: null,
  chatCount: 3,
  planCount: 1,
  attachmentCount: 2,
  repository: {
    remoteUrl: 'git@example.test:acme/app.git',
    baseCommitSha: 'abcdef1234',
  },
  noteCount: 0,
  promptCount: 0,
  notes: [],
  prompts: [],
  dirtyFileCount: 4,
  // Worktree files not in git are shared by default: main ranks the
  // candidates and reports which ones fit the budget.
  untrackedCandidates: ['src/a.ts'],
  untrackedCandidateCount: 1,
  defaultIncludedFilePaths: ['src/a.ts'],
  approvedFileScope: { includedPaths: [] },
  // The picker offers whatever the publisher's own Scripts panel resolves, so
  // the fixture carries a lifecycle pair plus a real-shaped custom name.
  availableRunScripts: ['setup', 'launch', 'Launch UD Mobile (Simulator)'],
  artifactBudget: { used: 12, limit: 200 },
};

function grant(
  id: string,
  userId: string,
  name: string,
): {
  id: string;
  containerId: string;
  recipient: { kind: 'member'; userId: string; name: string };
  capabilities: ['VIEW'];
  createdAt: string;
  updatedAt: string;
} {
  return {
    id,
    containerId: 'container-1',
    recipient: { kind: 'member', userId, name },
    capabilities: ['VIEW'],
    createdAt: '',
    updatedAt: '',
  };
}

describe('InviteTeammateModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let checkEligibility: jest.Mock;
  let searchMembers: jest.Mock;
  let listRecipients: jest.Mock;
  let listSharedByMe: jest.Mock;
  let invite: jest.Mock;
  let revokeRecipient: jest.Mock;
  let saveFileScope: jest.Mock;
  let preview: jest.Mock;
  let prepareGithub: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    const flagSnapshot = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...flagSnapshot,
        status: 'ready',
        values: {
          ...flagSnapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]: true,
          // The organization flow is the baseline; the external-sharing
          // describe block below turns this on.
          [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]:
            false,
          [CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.key]: true,
        },
      },
    });
    useCloudConnectGateStore.setState({ pending: null });
    useGitHubStore.setState({ toasts: [], notifications: [] });
    useNavigationStore.setState({
      pendingWorkspaceSettings: undefined,
      workspaceSettingsModalOpen: false,
    });
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
      hydrated: false,
      accountEpoch: 0,
      appliedGeneration: 0,
      lastChangeReason: null,
      lastSelectionByContext: {},
    });
    useSharedContainersStore.setState({
      accountHydrated: true,
      accountKind: 'connected',
      organizations: [ORG],
      teams: [],
      orgBillingStates: [],
      publicationStates: {},
      // The owner-listing caches are module-level state shared by every test
      // in this file, and several tests now write to them. Clear them here so
      // one test's badge entry cannot leak into the next one's assertions.
      sharedTargets: {},
      sharedWorktrees: {},
    });

    checkEligibility = jest.fn().mockResolvedValue({
      eligible: true,
      serverWorktreeExternalId: 'server-wt-1',
    } satisfies SharedContainerEligibilityResponse);
    preview = jest.fn().mockResolvedValue(PREVIEW);
    searchMembers = jest.fn().mockResolvedValue({
      members: [
        { userId: 'user-a', name: 'Ada' },
        { userId: 'user-b', name: 'Grace' },
      ],
    });
    listRecipients = jest.fn().mockResolvedValue({
      recipients: [],
      nextCursor: null,
    });
    listSharedByMe = jest
      .fn()
      .mockResolvedValue({ containers: [], nextCursor: null });
    invite = jest.fn().mockResolvedValue({
      invited: true,
      container: {
        id: 'container-1',
        organizationId: 'org-1',
        ownerUserId: 'me',
        worktreeId: 'server-wt-1',
        containerType: 'CODE_WORKTREE',
        revision: 0,
        createdAt: '',
        updatedAt: '',
        capabilities: ['VIEW'],
      },
      grant: grant('grant-a', 'user-a', 'Ada'),
      publicationState: {
        projectId: 'p1',
        worktreeId: 'w1',
        organizationId: 'org-1',
        status: 'not-published',
        updatedAt: '',
      },
    });
    revokeRecipient = jest.fn().mockResolvedValue({ revoked: true });
    prepareGithub = jest.fn().mockResolvedValue({ status: 'ready' });
    saveFileScope = jest.fn().mockResolvedValue({
      fileScope: { includedPaths: ['src/a.ts', 'new.txt'] },
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.assign(window, {
      api: {
        loadCanopyCloudAccount: jest
          .fn()
          .mockResolvedValue({ hasApiKey: true, organizations: [ORG] }),
        loadPreferences: jest.fn().mockResolvedValue(makeTestPreferences()),
        onPreferencesChanged: jest.fn((): (() => void) => (): void => {}),
        resolveProjectStartPage: jest.fn().mockResolvedValue({
          startPage: { kind: 'file', path: 'README.md' },
          source: 'source',
        }),
        sharedContainers: {
          checkEligibility,
          prepareGithub,
          preview,
          saveFileScope,
          invite,
          searchMembers,
          listRecipients,
          listSharedByMe,
          revokeRecipient,
          onPublicationChanged: jest.fn((): (() => void) => (): void => {}),
        },
      },
    });
  });

  function setScopingContext(
    context:
      | { kind: 'personal' }
      | { kind: 'organization'; organizationId: string },
    organizations = [ORG],
  ): void {
    const snapshot = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context,
        revision: 1,
        organizations: organizations.map((organization) => ({
          id: organization.id,
          name: organization.name,
          logoUrl: null,
          role: 'MEMBER' as const,
        })),
      },
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useGitHubStore.setState({ toasts: [], notifications: [] });
    jest.useRealTimers();
  });

  async function renderModal(
    containerType: SharedContainerType = 'CODE_WORKTREE',
  ): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(
        <InviteTeammateModal
          projectId="p1"
          worktreeId="w1"
          containerType={containerType}
          containerName="feature/thing"
          onClose={() => {}}
        />,
      );
    });
    // Flush the debounced member search.
    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });
  }

  function q(testId: string): HTMLElement | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  /**
   * Open the share-scope "Advanced" expander (CAN-2551).
   *
   * The summary sentence, the disclosure prose, the repository list, the
   * withheld notices, and every opt-out control start collapsed, so these
   * assertions open the expander the way an owner would. Anything that
   * *blocks* publishing stays outside and must never need this helper.
   * Idempotent: an already-open expander stays open.
   */
  async function expandScopeDetails(): Promise<void> {
    const toggle = q('shared-container-invite-modal-scope-details-toggle');
    expect(toggle).not.toBeNull();
    if (toggle?.getAttribute('aria-expanded') === 'true') return;
    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
  }

  it('renders the invite view once eligibility resolves', async () => {
    await renderModal();
    expect(q('shared-container-invite-modal')).not.toBeNull();
    expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    expect(checkEligibility).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      organizationId: 'org-1',
      audience: 'organization',
      containerType: 'CODE_WORKTREE',
    });
  });

  it('opens the published worktree source from the start-page Change action', async () => {
    preview.mockResolvedValueOnce({
      ...PREVIEW,
      startPage: { label: 'README.md', status: 'included' },
    });

    await renderModal();
    const change = q('shared-container-start-page')?.querySelector('button');
    expect(change).not.toBeNull();
    expect(q('shared-container-start-page')?.textContent).toContain(
      'README.md',
    );

    await act(async () => {
      change?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.api.resolveProjectStartPage).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
    });
    expect(useNavigationStore.getState().pendingWorkspaceSettings).toEqual({
      workspaceId: 'p1',
      initialTab: 'start-page',
      startPage: { mode: 'source' },
      worktreeId: 'w1',
    });
  });

  describe('open to my layout (CAN-4187)', () => {
    const PINNED_AT = '2026-10-13T12:00:00.000Z';
    let calls: string[];

    beforeEach(() => {
      calls = [];
      mockFlushLayoutSave.mockReset();
      mockFlushLayoutSave.mockImplementation((key) => {
        calls.push(`flush:${key}`);
        return Promise.resolve();
      });
    });

    function layoutSwitch(): HTMLButtonElement {
      return q('shared-container-layout-row-switch') as HTMLButtonElement;
    }

    async function click(element: HTMLElement | null): Promise<void> {
      await act(async () => {
        element?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it('is a plain switch, on by default', async () => {
      await renderModal();

      expect(layoutSwitch().getAttribute('role')).toBe('switch');
      expect(layoutSwitch().getAttribute('aria-checked')).toBe('true');
      expect(layoutSwitch().getAttribute('aria-label')).toBe(
        'Open to my layout',
      );
      expect(q('shared-container-layout-row')?.textContent).toBe(
        'Open to my layout',
      );
      expect(q('shared-container-layout-row-update')).toBeNull();
    });

    it('offers to update a saved layout and updates it after a flush', async () => {
      preview.mockResolvedValue({
        ...PREVIEW,
        approvedFileScope: {
          includedPaths: [],
          preferredLayout: { enabled: true, pinnedAt: PINNED_AT },
        },
      });
      saveFileScope.mockImplementation(() => {
        calls.push('save');
        return Promise.resolve({
          fileScope: {
            includedPaths: [],
            preferredLayout: { enabled: true, pinnedAt: PINNED_AT },
          },
        });
      });

      await renderModal();
      expect(q('shared-container-layout-row-update')?.textContent).toBe(
        'Update to current layout',
      );

      await click(q('shared-container-layout-row-update'));

      expect(calls).toEqual(['flush:p1/w1', 'save']);
      expect(saveFileScope).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'p1',
          worktreeId: 'w1',
          preferredLayout: 'pin-current',
        }),
      );
    });

    it('turns the layout off with a clear request and no flush', async () => {
      preview.mockResolvedValue({
        ...PREVIEW,
        approvedFileScope: {
          includedPaths: [],
          preferredLayout: { enabled: true, pinnedAt: PINNED_AT },
        },
      });
      saveFileScope.mockResolvedValue({
        fileScope: { includedPaths: [], preferredLayout: { enabled: false } },
      });

      await renderModal();
      await click(layoutSwitch());

      expect(mockFlushLayoutSave).not.toHaveBeenCalled();
      expect(saveFileScope).toHaveBeenCalledWith(
        expect.objectContaining({ preferredLayout: 'clear' }),
      );
      expect(layoutSwitch().getAttribute('aria-checked')).toBe('false');
      expect(q('shared-container-layout-row-update')).toBeNull();
      expect(q('shared-container-layout-row')?.textContent).toBe(
        'Open to my layout',
      );
    });

    it('turns the layout back on by saving the current layout', async () => {
      preview.mockResolvedValue({
        ...PREVIEW,
        approvedFileScope: {
          includedPaths: [],
          preferredLayout: { enabled: false },
        },
      });
      saveFileScope.mockResolvedValue({
        fileScope: {
          includedPaths: [],
          preferredLayout: { enabled: true, pinnedAt: PINNED_AT },
        },
      });

      await renderModal();
      expect(layoutSwitch().getAttribute('aria-checked')).toBe('false');
      await click(layoutSwitch());

      expect(mockFlushLayoutSave).toHaveBeenCalledWith('p1/w1');
      expect(saveFileScope).toHaveBeenCalledWith(
        expect.objectContaining({ preferredLayout: 'pin-current' }),
      );
      expect(q('shared-container-layout-row-update')).not.toBeNull();
    });

    it('restores the switch when the save fails', async () => {
      saveFileScope.mockRejectedValue(new Error('save failed'));

      await renderModal();
      await click(layoutSwitch());

      expect(layoutSwitch().getAttribute('aria-checked')).toBe('true');
    });

    it('leaves the layout alone on any other scope change', async () => {
      preview.mockResolvedValue({
        ...PREVIEW,
        untrackedCandidates: ['new.txt'],
        untrackedCandidateCount: 1,
        defaultIncludedFilePaths: ['new.txt'],
      });
      saveFileScope.mockResolvedValue({
        fileScope: { includedPaths: [], excludedPaths: ['new.txt'] },
      });

      await renderModal();
      await expandScopeDetails();
      await click(q('shared-container-invite-modal-file-review-new.txt'));

      expect(saveFileScope).toHaveBeenCalledTimes(1);
      for (const request of ['keep', 'pin-current', 'clear']) {
        expect(saveFileScope).not.toHaveBeenCalledWith(
          expect.objectContaining({ preferredLayout: request }),
        );
      }
      expect(mockFlushLayoutSave).not.toHaveBeenCalled();
    });

    it('flushes the layout save before the invite', async () => {
      invite.mockImplementation(() => {
        calls.push('invite');
        return new Promise(() => undefined);
      });

      await renderModal();
      const ada = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.includes('Ada'));
      await click(ada ?? null);
      await click(q('shared-container-invite-submit'));

      expect(calls).toEqual(['flush:p1/w1', 'invite']);
    });

    it('shows the layout main saved at the first invite', async () => {
      await renderModal();
      expect(q('shared-container-layout-row-update')).toBeNull();
      preview.mockResolvedValue({
        ...PREVIEW,
        approvedFileScope: {
          includedPaths: [],
          preferredLayout: { enabled: true, pinnedAt: PINNED_AT },
        },
      });

      const ada = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.includes('Ada'));
      await click(ada ?? null);
      await click(q('shared-container-invite-submit'));
      await click(null);

      expect(q('shared-container-layout-row-update')).not.toBeNull();
    });

    it('adds no layout note under a start page while the layout is on', async () => {
      preview.mockResolvedValue({
        ...PREVIEW,
        startPage: { label: 'README.md', status: 'withheld' },
      });

      await renderModal();

      expect(q('shared-container-start-page')?.textContent).not.toContain(
        'layout',
      );
      expect(q('shared-container-start-page')?.textContent).not.toContain(
        'withheld',
      );
    });

    it('keeps the withheld note for a start page once the layout is off', async () => {
      preview.mockResolvedValue({
        ...PREVIEW,
        startPage: { label: 'README.md', status: 'withheld' },
        approvedFileScope: {
          includedPaths: [],
          preferredLayout: { enabled: false },
        },
      });

      await renderModal();

      expect(q('shared-container-start-page')?.textContent).toContain(
        'This file is withheld, so receivers will see the default view instead.',
      );
    });
  });

  it('opens a management-only view and resolves existing access while rollout is off', async () => {
    const snapshot = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]: false,
        },
      },
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          title: 'Shared worktree',
          owner: { userId: 'me', name: 'Owner' },
          access: 'direct',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });

    expect(q('shared-container-invite-modal-tab-invite')).toBeNull();
    expect(
      q('shared-container-invite-modal-recipients')?.textContent,
    ).toContain('Ada');
    expect(checkEligibility).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(searchMembers).not.toHaveBeenCalled();
    expect(listSharedByMe).toHaveBeenCalledWith({
      organizationId: 'org-1',
      projectId: 'p1',
      worktreeId: 'w1',
    });
  });

  it('renders management-only access without scope or invite controls', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    const snapshot = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]: false,
        },
      },
    });
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'organization', organizationId: ORG.id }, [
      ORG,
      secondOrg,
    ]);
    listSharedByMe.mockImplementation(({ organizationId }) =>
      Promise.resolve({
        containers:
          organizationId === 'org-2'
            ? [
                {
                  id: 'container-2',
                  organizationId: 'org-2',
                  ownerUserId: 'me',
                  worktreeId: 'server-wt-2',
                  containerType: 'CODE_WORKTREE',
                  revision: 0,
                  createdAt: '',
                  updatedAt: '',
                  capabilities: ['VIEW'],
                },
              ]
            : [],
        nextCursor: null,
      }),
    );
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();
    expect(q('shared-container-invite-modal-organization')).toBeNull();
    expect(q('shared-container-invite-scope')).toBeNull();
    expect(q('shared-container-invite-modal-member-picker')).toBeNull();
    expect(q('shared-container-invite-people')).not.toBeNull();
    expect(q('shared-container-invite-done')?.textContent).toBe('Done');
  });

  it('switches away from a blocked default organization', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'organization', organizationId: ORG.id }, [
      ORG,
      secondOrg,
    ]);
    checkEligibility.mockImplementation(({ organizationId }) =>
      Promise.resolve(
        organizationId === 'org-1'
          ? {
              eligible: false,
              reason: 'blocked-by-org-billing',
              blockedByOrganizationNames: ['Acme'],
            }
          : {
              eligible: true,
              serverWorktreeExternalId: 'server-wt-2',
            },
      ),
    );

    await renderModal();
    expect(q('shared-container-invite-blocked')).not.toBeNull();
    const option = q('shared-container-invite-modal-organization-option-org-2');
    expect(option).not.toBeNull();
    await act(async () => {
      option?.click();
      await Promise.resolve();
    });

    expect(checkEligibility).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: 'org-2' }),
    );
    expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
  });

  it('describes granting access and does NOT promise content transfer', async () => {
    await renderModal();
    await expandScopeDetails();
    const disclosure = q('shared-container-invite-modal-disclosure');
    expect(disclosure).not.toBeNull();
    const text = disclosure?.textContent ?? '';
    expect(text).toContain('granted access');
    // Negative assertion, deliberately load-bearing: CAN-2544 shipped no
    // content sink, so nothing is uploaded on invite. A future copy edit that
    // reintroduces a transfer promise must fail here rather than ship a lie.
    expect(text).not.toMatch(/transcript/i);
    expect(text).not.toMatch(/\bsent\b|\bsending\b|\bupload/i);
  });

  it('excludes teammates who already have a grant', async () => {
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });
    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });
    const picker = q('shared-container-invite-modal-member-picker');
    expect(picker?.textContent).not.toContain('Ada');
    expect(picker?.textContent).toContain('Grace');
  });

  it('invites a teammate, clears and refocuses the picker, and keeps the dialog open', async () => {
    await renderModal();
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    );
    const ada = buttons.find((b) => b.textContent?.includes('Ada'));
    await act(async () => {
      ada?.click();
      await Promise.resolve();
    });
    const submit = q('shared-container-invite-submit');
    await act(async () => {
      (submit as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(invite).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: { kind: 'member', userId: 'user-a' },
        capabilities: ['VIEW'],
        organizationId: 'org-1',
      }),
    );
    expect(q('shared-container-invite-modal-recipients')).not.toBeNull();
    expect(
      q('shared-container-invite-modal-recipients')?.textContent,
    ).toContain('Ada');
    expect(document.body.textContent).not.toContain('Invite successfully sent');
    expect(q('shared-container-invite-done')?.textContent).toBe('Done');
    expect(
      (q('shared-container-invite-submit') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      q('shared-container-invite-modal-member-picker')?.querySelector('input'),
    ).toBe(document.activeElement);
    expect(useGitHubStore.getState().toasts.at(-1)?.message).toBe(
      'Invited Ada',
    );
    // The message names a person: replay records a box for it.
    expect(
      useGitHubStore.getState().toasts.at(-1)?.meta?.blockMessageFromReplay,
    ).toBe(true);
    const publishState = q('shared-container-invite-modal-publication-state');
    // CAN-2551: `not-published` is an explicit resolved status rather than the
    // fallback for "no local record". The invite handler writes that record
    // and schedules the publish together, so from the owner's side work is
    // already underway — show it, instead of a static line that has to
    // promise a timing the UI does not control.
    expect(publishState?.dataset.publishStatus).toBe('not-published');
    expect(publishState?.dataset.publishQueued).toBe('true');
    expect(publishState?.textContent).toContain('Publishing');
    expect(publishState?.textContent).not.toMatch(/not yet published/i);
    expect(publishState?.textContent).not.toContain(
      'published shortly after the first invite',
    );
  });

  it('uses the common Share project title', async () => {
    await renderModal();
    expect(document.querySelector('#dialog-modal-title')?.textContent).toBe(
      'Share project',
    );
    expect(document.body.textContent).not.toContain('Invite a teammate');
  });

  it('keeps the "Manage teammate access" title when new invites are off', async () => {
    // With the shared-containers flag off the owner may only manage access
    // that was already granted, and naming that restriction is the whole point
    // of the variant - so this title does NOT follow the menu item's rename.
    const flagSnapshot = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...flagSnapshot,
        status: 'ready',
        values: {
          ...flagSnapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]: false,
        },
      },
    });

    await renderModal();

    expect(document.querySelector('#dialog-modal-title')?.textContent).toBe(
      'Manage teammate access',
    );
  });

  it('records the sidebar shared target with the revision the server reported', async () => {
    // Inviting a second teammate reuses an already-published container, so the
    // recorded target must carry the server's real revision. Writing a
    // fabricated `0` would contradict the field's own contract, where `0`
    // means "created, never published".
    invite.mockResolvedValue({
      invited: true,
      container: {
        id: 'container-1',
        organizationId: 'org-1',
        ownerUserId: 'me',
        worktreeId: 'server-wt-1',
        containerType: 'CODE_WORKTREE',
        revision: 3,
        createdAt: '',
        updatedAt: '',
        capabilities: ['VIEW'],
      },
      grant: grant('grant-b', 'user-b', 'Grace'),
      publicationState: {
        projectId: 'p1',
        worktreeId: 'w1',
        organizationId: 'org-1',
        status: 'published',
        revision: 3,
        updatedAt: '',
      },
    });
    await renderModal();
    const grace = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.includes('Grace'));
    await act(async () => {
      grace?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (q('shared-container-invite-submit') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    const state = useSharedContainersStore.getState();
    expect(state.sharedWorktrees[sharedWorktreeKey('p1', 'w1')]).toEqual({
      projectId: 'p1',
      worktreeId: 'w1',
      organizationId: 'org-1',
      containerId: 'container-1',
      revision: 3,
    });
    expect(
      state.sharedTargets[publicationStateKey('p1', 'w1', 'org-1')]?.revision,
    ).toBe(3);
  });

  it('says recipients retain the last revision when an update fails', async () => {
    useSharedContainersStore.setState({
      publicationStates: {
        'p1:w1:org-1': {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          containerId: 'container-1',
          containerType: 'COWORK_WORK_ENTRY',
          status: 'error',
          revision: 4,
          error: 'offline',
          updatedAt: '2026-08-30T12:00:00.000Z',
        },
      },
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'COWORK_WORK_ENTRY',
          revision: 4,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    // A recipient has to actually hold a grant for this assertion to be about
    // anything: the scope line is a claim about access, so with an empty list
    // the component correctly refuses to name recipients at all.
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal('COWORK_WORK_ENTRY');
    // People with access is always visible below the invite controls.

    const text =
      q('shared-container-invite-modal-publication-state')?.textContent ?? '';
    expect(text).toContain('Recipients can still access revision 4');
    expect(text).toContain('newer changes could not be published');
    expect(text).not.toContain('contents are not available');
  });

  it('renders an owner-actionable remedy instead of the publisher exception', async () => {
    useSharedContainersStore.setState({
      publicationStates: {
        'p1:w1:org-1': {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          containerId: 'container-1',
          containerType: 'CODE_WORKTREE',
          status: 'error',
          error: 'Error: base commit 0f1e2d3 is not reachable from any remote',
          errorReason: 'unpushed-head',
          updatedAt: '2026-08-30T12:00:00.000Z',
        },
      },
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });

    // People with access, and its publish status, render once somebody
    // holds a grant.
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();

    const remedy = q('shared-container-invite-modal-publication-error-reason');
    expect(remedy?.textContent).toContain('is not on GitHub yet');
    // The raw publisher exception is a diagnostic, not an instruction.
    expect(q('shared-container-invite-modal-publication-error')).toBeNull();
    expect(
      q('shared-container-invite-modal-publication-state')?.textContent,
    ).not.toContain('not reachable from any remote');
  });

  it('retries a failed publication through the existing scope-save path', async () => {
    let resolveSave:
      | ((value: { fileScope: { includedPaths: string[] } }) => void)
      | undefined;
    saveFileScope.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    useSharedContainersStore.setState({
      publicationStates: {
        'p1:w1:org-1': {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          containerId: 'container-1',
          containerType: 'CODE_WORKTREE',
          status: 'error',
          errorReason: 'unpushed-head',
          updatedAt: '2026-08-30T12:00:00.000Z',
        },
      },
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();

    const retry = q('shared-container-invite-modal-publication-retry');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      includedPaths: [],
      excludedNoteIds: [],
      excludedPromptIds: [],
      runSharingDisabled: false,
      excludedRunScripts: [],
    });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(retry?.getAttribute('aria-busy')).toBe('true');
    expect(retry?.textContent).toContain('Retrying');

    await act(async () => {
      resolveSave?.({ fileScope: { includedPaths: ['src/a.ts'] } });
      await Promise.resolve();
    });
  });

  it('names the offending submodule paths in the refusal remedy', async () => {
    useSharedContainersStore.setState({
      publicationStates: {
        'p1:w1:org-1': {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          containerId: 'container-1',
          containerType: 'CODE_WORKTREE',
          status: 'error',
          error:
            'Repository \u201Capp\u201D contains unsupported submodules: vendor/a, vendor/b.',
          errorReason: 'submodule',
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
      },
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });

    // People with access, and its publish status, render once somebody
    // holds a grant.
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();

    const remedy = q('shared-container-invite-modal-publication-error-reason');
    expect(remedy?.textContent).toContain('vendor/a, vendor/b');
    expect(remedy?.textContent).toContain('cannot publish submodules yet');
    expect(q('shared-container-invite-modal-publication-error')).toBeNull();
  });

  // Legacy: in-repo symlinks publish now, and escaping ones are withheld, so
  // the publisher no longer raises this. States persisted before CAN-2727 can.
  it('still explains a symlink refusal persisted before in-repo support', async () => {
    useSharedContainersStore.setState({
      publicationStates: {
        'p1:w1:org-1': {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          containerId: 'container-1',
          containerType: 'CODE_WORKTREE',
          status: 'error',
          error: 'unsupported repository tree entry',
          errorReason: 'symlink',
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
      },
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });

    // People with access, and its publish status, render once somebody
    // holds a grant.
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();

    expect(
      q('shared-container-invite-modal-publication-error-reason')?.textContent,
    ).toContain('contains a committed symbolic link');
    expect(q('shared-container-invite-modal-publication-error')).toBeNull();
  });

  it('falls back to the publisher exception when the refusal is unclassified', async () => {
    useSharedContainersStore.setState({
      publicationStates: {
        'p1:w1:org-1': {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          containerId: 'container-1',
          containerType: 'CODE_WORKTREE',
          status: 'error',
          error: 'offline',
          updatedAt: '2026-08-30T12:00:00.000Z',
        },
      },
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });

    // People with access, and its publish status, render once somebody
    // holds a grant.
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();

    expect(
      q('shared-container-invite-modal-publication-error')?.textContent,
    ).toBe('offline');
    expect(
      q('shared-container-invite-modal-publication-error-reason'),
    ).toBeNull();
  });

  it('tells a code-worktree owner that publishing already happens', async () => {
    await renderModal();
    await expandScopeDetails();

    const disclosure =
      q('shared-container-invite-modal-disclosure')?.textContent ?? '';
    expect(disclosure).not.toContain('once publishing is available');
    expect(disclosure).toContain('encrypted, read-only copy');
    expect(
      q('shared-container-invite-modal-file-review')?.textContent,
    ).not.toContain('when publishing lands');
  });

  it('omits summary line items whose count is zero', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      chatCount: 0,
      planCount: 2,
      attachmentCount: 0,
      noteCount: 0,
      promptCount: 0,
      dirtyFileCount: 0,
      untrackedCandidates: [],
      untrackedCandidateCount: 0,
      defaultIncludedFilePaths: [],
      approvedFileScope: { includedPaths: [] },
    });

    await renderModal();
    await expandScopeDetails();

    // CAN-2551: the zero-suppression rule applies to the summary sentence.
    // Scoped to that element rather than the whole block, because the
    // expander's disclosure prose legitimately mentions "uncommitted changes"
    // while explaining what a share carries.
    const summary = q(
      'shared-container-invite-modal-scope-summary',
    )?.textContent;
    expect(summary).toContain('2 plans');
    // Nothing of these kinds exists, so naming them is pure noise.
    expect(summary).not.toContain('chats');
    expect(summary).not.toContain('attachments');
    expect(summary).not.toContain('notes');
    expect(summary).not.toContain('prompts');
    expect(summary).not.toContain('files');
    expect(summary).not.toContain('uncommitted changes');

    // The repository is the substance of the share and always shows inside
    // Advanced.
    expect(
      q('shared-container-invite-modal-file-review')?.textContent,
    ).toContain('Repository');
  });

  it('keeps a scope line whose every item the owner unticked', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      chatCount: 0,
      planCount: 0,
      attachmentCount: 0,
      noteCount: 2,
      promptCount: 0,
      notes: [
        { id: 'note-1', title: 'One' },
        { id: 'note-2', title: 'Two' },
      ],
      dirtyFileCount: 0,
      approvedFileScope: {
        includedPaths: [],
        excludedNoteIds: ['note-1', 'note-2'],
      },
    });

    await renderModal();
    await expandScopeDetails();

    const summary = q(
      'shared-container-invite-modal-scope-summary',
    )?.textContent;
    // Zero included of two available is the owner's decision, not an empty
    // row, so it stays.
    expect(summary).toContain('0 of 2 notes');
    expect(summary).not.toContain('prompts');
  });

  it('reduces to the repository alone when a share carries nothing else', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      chatCount: 0,
      planCount: 0,
      attachmentCount: 0,
      noteCount: 0,
      promptCount: 0,
      dirtyFileCount: 0,
      approvedFileScope: { includedPaths: [] },
    });

    await renderModal();
    await expandScopeDetails();

    const items = document.querySelectorAll(
      '[data-testid="shared-container-invite-modal-file-review"] ul li',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('Repository');
  });

  it('uses singular nouns for single-item counts', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      chatCount: 1,
      planCount: 1,
      attachmentCount: 1,
      noteCount: 1,
      promptCount: 0,
      dirtyFileCount: 1,
      approvedFileScope: { includedPaths: [] },
    });

    await renderModal();
    await expandScopeDetails();

    const summary = q(
      'shared-container-invite-modal-scope-summary',
    )?.textContent;
    expect(summary).toContain('1 chat');
    expect(summary).not.toContain('1 chats');
    expect(summary).toContain('1 plan,');
    expect(summary).not.toContain('1 plans');
    expect(summary).toContain('1 attachment');
    expect(summary).not.toContain('1 attachments');
    expect(summary).toContain('0 of 1 note');
    expect(summary).not.toContain('0 of 1 notes');
    expect(summary).toContain('1 of 1 file not in git,');
    expect(summary).not.toContain('files not in git');
    expect(summary).toContain('1 uncommitted change');
    expect(summary).not.toContain('1 uncommitted changes');
  });

  it('hides the per-revision artifact budget while it is within the limit', async () => {
    await renderModal();

    // A budget the owner cannot exceed is noise: the count only becomes
    // actionable once publishing would refuse.
    expect(q('shared-container-invite-modal-artifact-budget')).toBeNull();
  });

  it('exposes the artifact budget counts to automation while hiding the copy', async () => {
    await renderModal();

    const review = q('shared-container-invite-modal-file-review');
    expect(review?.getAttribute('data-artifact-budget-used')).toBe('12');
    expect(review?.getAttribute('data-artifact-budget-limit')).toBe('200');
    expect(review?.textContent).not.toContain('shareable items used');
  });

  it('keeps the artifact budget hidden at exactly the limit', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      artifactBudget: { used: 200, limit: 200 },
    });

    await renderModal();

    expect(q('shared-container-invite-modal-artifact-budget')).toBeNull();
  });

  it('tells the owner when changed files are withheld', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      withheldFileCount: 2,
      withheldFilePaths: ['.env.production', 'dist/oversized.bin'],
    });

    await renderModal();
    await expandScopeDetails();

    expect(
      q('shared-container-invite-modal-withheld-files')?.textContent,
    ).toContain('2 changed files will be withheld');
    expect(
      q('shared-container-invite-modal-withheld-file-paths')?.textContent,
    ).toContain('.env.production, dist/oversized.bin');
    // The expanded details (paths, remotes) are recorded in session replay,
    // as is the toggle above them.
    expect(
      q('shared-container-invite-modal-scope-details-body')?.closest(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      ),
    ).toBeNull();
    expect(
      q('shared-container-invite-modal-scope-details-toggle')?.closest(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      ),
    ).toBeNull();
  });

  it('notes the bundled capabilities once, between repositories and withheld files', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      withheldFileCount: 1,
      capabilityPackageCounts: {
        skills: 2,
        pipelines: 1,
        agents: 0,
        automations: 0,
        hooks: 0,
      },
    });

    await renderModal();
    await expandScopeDetails();

    const note = q('shared-container-invite-modal-capabilities');
    expect(note?.textContent).toBe(
      'This share also carries the 2 skills and 1 pipeline used here. They install only if a teammate makes a copy.',
    );
    expect(note?.querySelector('input, button')).toBeNull();
    const withheld = q('shared-container-invite-modal-withheld-files');
    expect(
      note !== null &&
        withheld !== null &&
        Boolean(
          note.compareDocumentPosition(withheld) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
    ).toBe(true);
  });

  it('adds no capability note when analysis is pending or the package is empty', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      capabilityPackageCounts: {
        skills: 0,
        pipelines: 0,
        agents: 0,
        automations: 0,
        hooks: 0,
      },
    });
    await renderModal();
    await expandScopeDetails();
    expect(q('shared-container-invite-modal-capabilities')).toBeNull();
  });

  it('names the escaping symlinks it withholds, owner-side', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      withheldFileCount: 2,
      withheldSymlinkPaths: ['api/link-out', 'web/vendor-link'],
    });

    await renderModal();
    await expandScopeDetails();

    const symlinks = q('shared-container-invite-modal-withheld-symlinks');
    expect(symlinks?.textContent).toContain('These symbolic links point');
    expect(symlinks?.textContent).toContain('api/link-out, web/vendor-link');
    // The aggregate line has to name the symlink case too, or the count and
    // the path list read as two unrelated warnings.
    expect(
      q('shared-container-invite-modal-withheld-files')?.textContent,
    ).toContain('link outside the repository');
  });

  it('says nothing about symlinks when none are withheld', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      withheldFileCount: 1,
    });

    await renderModal();
    await expandScopeDetails();

    expect(q('shared-container-invite-modal-withheld-files')).not.toBeNull();
    expect(q('shared-container-invite-modal-withheld-symlinks')).toBeNull();
  });

  it('warns when the approved scope exceeds the per-revision artifact budget', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      artifactBudget: { used: 205, limit: 200 },
    });

    await renderModal();

    const budget = q('shared-container-invite-modal-artifact-budget');
    expect(budget?.textContent).toContain('205 of 200 shareable items used.');
    expect(budget?.textContent).toContain('Publishing refuses over the limit');
    expect(budget?.getAttribute('role')).toBe('alert');
  });

  it('refreshes the artifact budget after a scope save when tracked changes cross the limit', async () => {
    const initialPreview = {
      ...PREVIEW,
      untrackedCandidates: ['new.txt'],
      untrackedCandidateCount: 1,
      defaultIncludedFilePaths: ['new.txt'],
      approvedFileScope: { includedPaths: [] },
      artifactBudget: { used: 200, limit: 200 },
    } satisfies SharedContainerSharePreview;
    // Unticking the file frees one item, but the owner's tracked changes grew
    // by two in the meantime, so the refreshed preview is over the limit.
    const refreshedPreview = {
      ...initialPreview,
      dirtyFileCount: 6,
      defaultIncludedFilePaths: [],
      approvedFileScope: { includedPaths: [], excludedPaths: ['new.txt'] },
      artifactBudget: { used: 201, limit: 200 },
    } satisfies SharedContainerSharePreview;
    preview
      .mockResolvedValueOnce(initialPreview)
      .mockResolvedValue(refreshedPreview);
    saveFileScope.mockResolvedValue({
      fileScope: { includedPaths: [], excludedPaths: ['new.txt'] },
    });

    await renderModal();
    await expandScopeDetails();
    const checkbox = q(
      'shared-container-invite-modal-file-review-new.txt',
    ) as HTMLInputElement;
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenCalledWith(
      expect.objectContaining({ excludedPaths: ['new.txt'] }),
    );
    expect(preview).toHaveBeenCalledTimes(2);
    const budget = q('shared-container-invite-modal-artifact-budget');
    expect(budget?.textContent).toContain('201 of 200 shareable items used.');
    expect(budget?.getAttribute('role')).toBe('alert');
  });

  it('hides stale scope controls when the post-save preview refresh fails', async () => {
    const initialPreview = {
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      dirtyFileCount: 0,
      approvedFileScope: { includedPaths: [], excludedPaths: [] },
      untrackedCandidates: ['first.txt', 'second.txt'],
      untrackedCandidateCount: 2,
      defaultIncludedFilePaths: ['first.txt'],
      artifactBudget: { used: 200, limit: 200 },
    } satisfies SharedContainerSharePreview;
    preview
      .mockResolvedValueOnce(initialPreview)
      .mockRejectedValue(new Error('refresh failed'));
    saveFileScope.mockResolvedValue({
      fileScope: { includedPaths: [], excludedPaths: ['first.txt'] },
    });

    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    const checkbox = q(
      'shared-container-invite-modal-file-review-first.txt',
    ) as HTMLInputElement;
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(preview).toHaveBeenCalledTimes(2);
    expect(
      q('shared-container-invite-modal-preview-unavailable')?.textContent,
    ).toBe('Could not check what will be shared. Inviting still works.');
    expect(q('shared-container-invite-modal-file-review-first.txt')).toBeNull();
  });

  it('discloses repositories excluded for want of a pushed remote', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      undisclosedRepositoryCount: 2,
    });

    await renderModal();

    const notice = q('shared-container-invite-modal-undisclosed-repositories');
    expect(notice?.textContent).toContain('2 repositories');
    // The publisher refuses the whole revision on an undisclosable repository,
    // so the modal must not imply the rest publishes without it.
    expect(notice?.textContent).toContain('nothing publishes until that is');
    expect(notice?.textContent).not.toContain('left out');
    expect(notice?.getAttribute('role')).toBe('alert');
  });

  it('omits the excluded-repository notice when every repo is disclosable', async () => {
    await renderModal();

    expect(
      q('shared-container-invite-modal-undisclosed-repositories'),
    ).toBeNull();
  });

  it('clears a hidden selection when the member search changes', async () => {
    await renderModal();
    const ada = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Ada'));
    await act(async () => {
      ada?.click();
      await Promise.resolve();
    });
    expect(
      (q('shared-container-invite-submit') as HTMLButtonElement).disabled,
    ).toBe(false);

    const input = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    await act(async () => {
      if (input) setNativeInputValue(input, 'Grace');
      await Promise.resolve();
    });

    expect(
      (q('shared-container-invite-submit') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('ticks a worktree file not in git by default and persists an untick as an exclusion', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      approvedFileScope: {
        includedPaths: ['legacy-approved.txt'],
        legacyAllowlist: true,
      },
      untrackedCandidates: ['new.txt'],
      untrackedCandidateCount: 1,
      defaultIncludedFilePaths: ['new.txt'],
    });
    await renderModal();
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = q(
      'shared-container-invite-modal-file-review-new.txt',
    ) as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
    expect(
      q('shared-container-invite-modal-file-scope-hint')?.textContent,
    ).toContain('These files are included.');
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
    });
    expect(saveFileScope).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      includedPaths: [],
      excludedPaths: ['new.txt'],
      excludedNoteIds: [],
      excludedPromptIds: [],
      // The scope is one unit: a file, note, or prompt change carries
      // the run-sharing decision through untouched (CAN-2831).
      runSharingDisabled: false,
      excludedRunScripts: [],
    });
  });

  it('includes worktree notes and prompts by default and persists unticks as exclusions', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      noteCount: 1,
      promptCount: 1,
      notes: [{ id: 'note-1', title: 'Release note' }],
      prompts: [{ id: 'prompt-1', title: 'Reviewer prompt' }],
    });
    saveFileScope.mockImplementation(
      (request: SaveSharedContainerFileScopeRequest) =>
        Promise.resolve({
          fileScope: {
            includedPaths: request.includedPaths,
            excludedNoteIds: request.excludedNoteIds,
            excludedPromptIds: request.excludedPromptIds,
          },
        }),
    );

    await renderModal();
    await expandScopeDetails();

    const workspaceItems = q('shared-container-invite-modal-workspace-items');
    expect(workspaceItems?.textContent).toContain(
      'Included unless you untick them.',
    );
    expect(
      (q('shared-container-invite-modal-note-scope-note-1') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (
        q(
          'shared-container-invite-modal-prompt-scope-prompt-1',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      q('shared-container-invite-modal-scope-summary')?.textContent,
    ).toContain('1 of 1 note, 1 of 1 prompt');
    await act(async () => {
      (
        q('shared-container-invite-modal-note-scope-note-1') as HTMLInputElement
      ).click();
      await Promise.resolve();
    });
    await act(async () => {
      (
        q(
          'shared-container-invite-modal-prompt-scope-prompt-1',
        ) as HTMLInputElement
      ).click();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenLastCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      includedPaths: [],
      excludedNoteIds: ['note-1'],
      excludedPromptIds: ['prompt-1'],
      // The scope is one unit: a file, note, or prompt change carries
      // the run-sharing decision through untouched (CAN-2831).
      runSharingDisabled: false,
      excludedRunScripts: [],
    });
  });

  it('labels a bounded untracked-file preview with its full count', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      untrackedCandidates: Array.from(
        { length: 200 },
        (_, index) => `new-${index}.txt`,
      ),
      untrackedCandidateCount: 205,
    });

    await renderModal();
    await expandScopeDetails();

    expect(
      q('shared-container-invite-modal-file-review')?.textContent,
    ).toContain('Showing the first 200 of 205 untracked files.');
  });

  it('upserts the invite response when recipient discovery wins the race', async () => {
    let resolveRecipients:
      | ((value: {
          recipients: ReturnType<typeof grant>[];
          nextCursor: null;
        }) => void)
      | undefined;
    let resolveInvite:
      | ((
          value: Awaited<ReturnType<typeof window.api.sharedContainers.invite>>,
        ) => void)
      | undefined;
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRecipients = resolve;
        }),
    );
    invite.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvite = resolve;
        }),
    );

    await renderModal();
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Ada'))
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (q('shared-container-invite-submit') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveRecipients?.({
        recipients: [grant('grant-a', 'user-a', 'Ada')],
        nextCursor: null,
      });
      await Promise.resolve();
    });
    await act(async () => {
      resolveInvite?.({
        invited: true,
        container: {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          title: 'Shared worktree',
          owner: { userId: 'me', name: 'Owner' },
          access: 'direct',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
        grant: grant('grant-a', 'user-a', 'Ada'),
        publicationState: {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          status: 'not-published',
          updatedAt: '',
        },
      });
      await Promise.resolve();
    });

    expect(
      document.querySelectorAll(
        '[data-testid="shared-container-invite-modal-revoke-user-a"]',
      ),
    ).toHaveLength(1);
  });

  it('keeps a successful invite when an older recipient listing resolves later', async () => {
    let resolveRecipients:
      | ((value: {
          recipients: ReturnType<typeof grant>[];
          nextCursor: null;
        }) => void)
      | undefined;
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRecipients = resolve;
        }),
    );

    await renderModal();
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Ada'))
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (q('shared-container-invite-submit') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(
      q('shared-container-invite-modal-recipients')?.textContent,
    ).toContain('Ada');

    await act(async () => {
      resolveRecipients?.({ recipients: [], nextCursor: null });
      await Promise.resolve();
    });

    expect(
      q('shared-container-invite-modal-recipients')?.textContent,
    ).toContain('Ada');
  });

  it('locks revocation while an invite is in flight', async () => {
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 1,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });
    invite.mockImplementation(() => new Promise(() => {}));

    await renderModal();
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Grace'))
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (q('shared-container-invite-submit') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(
      (q('shared-container-invite-modal-revoke-user-a') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('does not resurrect a revoked grant from an older recipient listing', async () => {
    let resolveRecipients:
      | ((value: {
          recipients: ReturnType<typeof grant>[];
          nextCursor: null;
        }) => void)
      | undefined;
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRecipients = resolve;
        }),
    );

    await renderModal();
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Ada'))
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (q('shared-container-invite-submit') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      (
        q('shared-container-invite-modal-revoke-user-a') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(
        q(
          'shared-container-invite-modal-revoke-confirmation',
        )?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      )
        .find((button) => button.textContent === 'Remove access')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveRecipients?.({
        recipients: [grant('grant-a', 'user-a', 'Ada')],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    expect(q('shared-container-invite-modal-revoke-user-a')).toBeNull();
  });

  it('lets a multi-org owner select which organization to invite from', async () => {
    useSharedContainersStore.setState({
      organizations: [
        ORG,
        { id: 'org-2', name: 'Globex', createdAt: '', updatedAt: '' },
      ],
    });
    await renderModal();

    const option = q('shared-container-invite-modal-organization-option-org-2');
    expect(option).not.toBeNull();
    await act(async () => {
      option?.click();
      await Promise.resolve();
    });
    expect(checkEligibility).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: 'org-2' }),
    );
  });

  it('defaults a multi-org invite to the selected organization context', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'organization', organizationId: secondOrg.id }, [
      ORG,
      secondOrg,
    ]);

    await renderModal();

    expect(checkEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: secondOrg.id }),
    );
  });

  it('requires an organization choice in Personal context when organizations exist', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'personal' }, [ORG, secondOrg]);

    await renderModal();

    expect(q('shared-container-invite-choose-organization')).not.toBeNull();
    expect(q('shared-container-invite-submit')?.hasAttribute('disabled')).toBe(
      true,
    );
    expect(checkEligibility).not.toHaveBeenCalled();
  });

  it('shows the selected organization name when there is only one choice', async () => {
    await renderModal();

    expect(
      q('shared-container-invite-modal-organization-name')?.textContent,
    ).toBe('Acme');
    expect(q('shared-container-invite-modal-organization')).toBeNull();
  });

  it('rebinds an open invite and names the new context', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'organization', organizationId: ORG.id }, [
      ORG,
      secondOrg,
    ]);
    await renderModal();

    await act(async () => {
      useWorkspaceContextStore.setState((current) => ({
        state: {
          ...current.state,
          context: { kind: 'organization', organizationId: secondOrg.id },
          revision: current.state.revision + 1,
        },
      }));
      await Promise.resolve();
    });

    expect(checkEligibility).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: secondOrg.id }),
    );
    expect(q('shared-container-invite-context-changed')?.textContent).toContain(
      'Switched to Globex.',
    );
  });

  it('keeps the context-change notice when the open invite remounts', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'personal' }, [ORG, secondOrg]);
    await renderModal();

    await act(async () => {
      useWorkspaceContextStore.setState((current) => ({
        state: {
          ...current.state,
          context: { kind: 'organization', organizationId: secondOrg.id },
          revision: current.state.revision + 1,
        },
      }));
      root.render(
        <InviteTeammateModal
          key="organization-remount"
          projectId="p1"
          worktreeId="w1"
          containerType="CODE_WORKTREE"
          containerName="feature/thing"
          previousContext={{ kind: 'personal' }}
          onClose={() => {}}
        />,
      );
      await Promise.resolve();
    });

    expect(q('shared-container-invite-context-changed')?.textContent).toContain(
      'Switched to Globex.',
    );
  });

  it('applies a context change after a failed invite settles', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'organization', organizationId: ORG.id }, [
      ORG,
      secondOrg,
    ]);
    let rejectInvite: ((reason?: unknown) => void) | undefined;
    invite.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectInvite = reject;
      }),
    );
    await renderModal();
    const ada = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Ada'));
    await act(async () => {
      ada?.click();
      await Promise.resolve();
      (q('shared-container-invite-submit') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    await act(async () => {
      useWorkspaceContextStore.setState((current) => ({
        state: {
          ...current.state,
          context: { kind: 'organization', organizationId: secondOrg.id },
          revision: current.state.revision + 1,
        },
      }));
      await Promise.resolve();
    });
    expect(q('shared-container-invite-context-changed')).toBeNull();

    await act(async () => {
      rejectInvite?.(new Error('invite failed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(checkEligibility).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: secondOrg.id }),
    );
    expect(q('shared-container-invite-context-changed')?.textContent).toContain(
      'Switched to Globex.',
    );
  });

  it('keeps a successful first invite bound when context changes in flight', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'organization', organizationId: ORG.id }, [
      ORG,
      secondOrg,
    ]);
    let resolveInvite:
      | ((value: Awaited<ReturnType<typeof invite>>) => void)
      | undefined;
    invite.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInvite = resolve;
      }),
    );
    await renderModal();
    const ada = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Ada'));
    await act(async () => {
      ada?.click();
      await Promise.resolve();
      (q('shared-container-invite-submit') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    await act(async () => {
      useWorkspaceContextStore.setState((current) => ({
        state: {
          ...current.state,
          context: { kind: 'organization', organizationId: secondOrg.id },
          revision: current.state.revision + 1,
        },
      }));
      await Promise.resolve();
    });

    await act(async () => {
      resolveInvite?.({
        invited: true,
        container: {
          id: 'container-1',
          organizationId: ORG.id,
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
        grant: grant('grant-a', 'user-a', 'Ada'),
        publicationState: {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: ORG.id,
          status: 'not-published',
          updatedAt: '',
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(checkEligibility).not.toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: secondOrg.id }),
    );
    expect(q('shared-container-invite-context-changed')).toBeNull();
  });

  it('treats a click on the already-selected organization as a no-op', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'organization', organizationId: ORG.id }, [
      ORG,
      secondOrg,
    ]);
    await renderModal();
    const probesBefore = checkEligibility.mock.calls.length;

    const selected = q(
      `shared-container-invite-modal-organization-option-${ORG.id}`,
    );
    expect(selected?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      selected?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Re-selecting must not reset eligibility: the probe only re-runs when
    // the id changes, so a reset would leave the modal on "Checking access…"
    // with no picker to recover from.
    expect(document.body.textContent).not.toContain('Checking access…');
    expect(q('shared-container-invite-modal-organization')).not.toBeNull();
    expect(checkEligibility.mock.calls.length).toBe(probesBefore);
  });

  it('filters the organization picker by name but keeps the selected organization listed', async () => {
    const organizations = [
      ORG,
      { id: 'org-2', name: 'Globex', createdAt: '', updatedAt: '' },
      { id: 'org-3', name: 'Initech', createdAt: '', updatedAt: '' },
    ];
    useSharedContainersStore.setState({ organizations });
    setScopingContext(
      { kind: 'organization', organizationId: ORG.id },
      organizations,
    );
    await renderModal();

    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="shared-container-invite-modal-organization"] input',
    );
    expect(search).not.toBeNull();
    await act(async () => {
      if (search) {
        setNativeInputValue(search, '  glob ');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await Promise.resolve();
    });

    expect(
      q('shared-container-invite-modal-organization-option-org-2'),
    ).not.toBeNull();
    expect(
      q('shared-container-invite-modal-organization-option-org-3'),
    ).toBeNull();
    // The current choice is shown only in the picker, so a query that does
    // not match it must not hide it.
    expect(
      q(
        `shared-container-invite-modal-organization-option-${ORG.id}`,
      )?.getAttribute('aria-pressed'),
    ).toBe('true');
    // The group is named by its visible "Organization" heading.
    const group = document.querySelector<HTMLElement>(
      '[role="group"][aria-labelledby]',
    );
    const labelId = group?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(labelId)?.textContent).toBe('Organization');
  });

  it('invalidates prior-organization discovery as soon as selection changes', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    let resolveFirstContainers:
      | ((value: Awaited<ReturnType<typeof listSharedByMe>>) => void)
      | undefined;
    let resolveSecondEligibility:
      | ((value: SharedContainerEligibilityResponse) => void)
      | undefined;
    checkEligibility
      .mockResolvedValueOnce({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondEligibility = resolve;
          }),
      );
    listSharedByMe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstContainers = resolve;
        }),
    );

    await renderModal();
    const option = q('shared-container-invite-modal-organization-option-org-2');
    expect(option).not.toBeNull();
    await act(async () => {
      option?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirstContainers?.({
        containers: [
          {
            id: 'container-org-1',
            organizationId: 'org-1',
            ownerUserId: 'me',
            worktreeId: 'server-wt-1',
            containerType: 'CODE_WORKTREE',
            revision: 0,
            createdAt: '',
            updatedAt: '',
            capabilities: ['VIEW'],
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    expect(listRecipients).not.toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
    );

    await act(async () => {
      resolveSecondEligibility?.({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-2',
      });
      await Promise.resolve();
    });
  });

  it('clears prior organization recipients when the selected org becomes ineligible', async () => {
    const secondOrg = {
      id: 'org-2',
      name: 'Globex',
      createdAt: '',
      updatedAt: '',
    };
    useSharedContainersStore.setState({ organizations: [ORG, secondOrg] });
    setScopingContext({ kind: 'organization', organizationId: ORG.id }, [
      ORG,
      secondOrg,
    ]);
    checkEligibility.mockImplementation(({ organizationId }) =>
      Promise.resolve({
        eligible: true,
        serverWorktreeExternalId:
          organizationId === 'org-1' ? 'server-wt-1' : 'server-wt-2',
      }),
    );
    listSharedByMe.mockImplementation(({ organizationId }) =>
      Promise.resolve({
        containers:
          organizationId === 'org-1'
            ? [
                {
                  id: 'container-1',
                  organizationId: 'org-1',
                  ownerUserId: 'me',
                  worktreeId: 'server-wt-1',
                  containerType: 'CODE_WORKTREE' as const,
                  revision: 0,
                  createdAt: '',
                  updatedAt: '',
                  capabilities: ['VIEW'] as const,
                },
              ]
            : [],
        nextCursor: null,
      }),
    );
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      q('shared-container-invite-modal-recipients')?.textContent,
    ).toContain('Ada');

    await act(async () => {
      useSharedContainersStore.setState({ organizations: [secondOrg] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(q('shared-container-invite-choose-organization')).not.toBeNull();
    expect(q('shared-container-invite-modal-revoke-user-a')).toBeNull();
  });

  it('keeps a POST-time role refusal inline and clears it on re-selection', async () => {
    invite.mockResolvedValueOnce({
      invited: false,
      reason: 'insufficient-role',
    });
    await renderModal();
    const memberButtons = (): HTMLButtonElement[] =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
    await act(async () => {
      memberButtons()
        .find((button) => button.textContent?.includes('Ada'))
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (q('shared-container-invite-submit') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    expect(q('shared-container-invite-blocked')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /permission/i,
    );

    await act(async () => {
      memberButtons()
        .find((button) => button.textContent?.includes('Grace'))
        ?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('never requests a revision or artifact upload during invite', async () => {
    await renderModal();
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    );
    await act(async () => {
      buttons.find((b) => b.textContent?.includes('Ada'))?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (q('shared-container-invite-submit') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    // Documents the CAN-2544 boundary: no revision POST and no artifact
    // upload endpoint exists, so the invite path must not reach for one.
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    const shared = api.sharedContainers as Record<string, unknown>;
    expect(Object.keys(shared)).not.toContain('publishRevision');
    expect(Object.keys(shared)).not.toContain('uploadArtifact');
  });

  it('confirms before revoking exactly one recipient', async () => {
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [
        grant('grant-a', 'user-a', 'Ada'),
        grant('grant-b', 'user-b', 'Grace'),
      ],
      nextCursor: null,
    });
    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });
    // People with access is always visible below the invite controls.
    const revoke = q('shared-container-invite-modal-revoke-user-a');
    expect(revoke).not.toBeNull();
    await act(async () => {
      (revoke as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(revokeRecipient).not.toHaveBeenCalled();
    const confirmation = q('shared-container-invite-modal-revoke-confirmation');
    expect(confirmation?.textContent).toContain('Ada');
    expect(
      q('shared-container-invite-modal-recipient-user-b')?.textContent,
    ).toContain('Grace');
    await act(async () => {
      Array.from(
        confirmation?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      )
        .find((button) => button.textContent === 'Remove access')
        ?.click();
      await Promise.resolve();
    });
    expect(revokeRecipient).toHaveBeenCalledTimes(1);
    expect(revokeRecipient).toHaveBeenCalledWith({
      containerId: 'container-1',
      // Always by grant id: an email recipient exposes no user id.
      grantId: 'grant-a',
      organizationId: 'org-1',
    });
    const list = q('shared-container-invite-modal-recipients');
    expect(list?.textContent).not.toContain('Ada');
    expect(list?.textContent).toContain('Grace');
  });

  it("blocks people's names, emails and avatars from session replay, not the rows or buttons", async () => {
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [
        grant('grant-a', 'user-a', 'Ada'),
        {
          id: 'grant-email',
          containerId: 'container-1',
          recipient: {
            kind: 'email',
            email: 'friend@example.com',
            status: 'invited',
          },
          capabilities: ['VIEW'],
          createdAt: '',
          updatedAt: '',
        },
      ],
      nextCursor: null,
    });
    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });

    /** The innermost element under `root` whose whole text is `text`. */
    function textElement(scope: HTMLElement | null, text: string): Element {
      const match = Array.from(scope?.querySelectorAll('*') ?? [])
        .reverse()
        .find((element) => element.textContent === text);
      if (match === undefined) throw new Error(`Missing ${text}`);
      return match;
    }
    function element(testId: string): HTMLElement {
      const found = q(testId);
      if (found === null) throw new Error(`Missing ${testId}`);
      return found;
    }

    // Member picker: the row button stays recorded; the name and initials don't.
    const option = element(
      'shared-container-invite-modal-member-picker-option-user-b',
    );
    expect(outermostReplayBlock(option)).toBeNull();
    expect(outermostReplayBlock(textElement(option, 'Grace'))).not.toBeNull();
    expect(outermostReplayBlock(textElement(option, 'GR'))).not.toBeNull();

    // People with access: the heading, row, pills and Remove stay recorded.
    const people = element('shared-container-invite-people');
    expect(outermostReplayBlock(people)).toBeNull();
    expect(
      outermostReplayBlock(textElement(people, 'People with access')),
    ).toBeNull();
    const member = element('shared-container-invite-modal-recipient-user-a');
    expect(outermostReplayBlock(member)).toBeNull();
    expect(outermostReplayBlock(textElement(member, 'Ada'))).not.toBeNull();
    expect(
      outermostReplayBlock(
        element('shared-container-invite-modal-revoke-user-a'),
      ),
    ).toBeNull();
    const invited = element(
      'shared-container-invite-modal-recipient-grant-email',
    );
    expect(outermostReplayBlock(invited)).toBeNull();
    expect(
      outermostReplayBlock(textElement(invited, 'friend@example.com')),
    ).not.toBeNull();
    expect(
      outermostReplayBlock(
        element('shared-container-invite-modal-invited-grant-email'),
      ),
    ).toBeNull();

    // The revoke confirmation keeps its question and buttons recorded.
    await act(async () => {
      element('shared-container-invite-modal-revoke-user-a').click();
      await Promise.resolve();
    });
    const confirmation = element(
      'shared-container-invite-modal-revoke-confirmation',
    );
    expect(outermostReplayBlock(confirmation)).toBeNull();
    expect(
      outermostReplayBlock(textElement(confirmation, 'Ada')),
    ).not.toBeNull();
    for (const button of Array.from(confirmation.querySelectorAll('button'))) {
      expect(outermostReplayBlock(button)).toBeNull();
    }
  });

  it('reveals an App Advisor revoke confirmation while new invites are blocked', async () => {
    checkEligibility.mockResolvedValue({
      eligible: false,
      reason: 'blocked-by-org-billing',
      blockedByOrganizationNames: ['Acme'],
      serverWorktreeExternalId: 'server-wt-1',
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });
    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });
    expect(q('shared-container-invite-blocked')).not.toBeNull();

    let opened = false;
    await act(async () => {
      opened = requestSharedContainerRevocationConfirmation({
        containerId: 'container-1',
        recipientId: 'user-a',
        organizationId: 'org-1',
      });
      await Promise.resolve();
    });

    expect(opened).toBe(true);
    expect(revokeRecipient).not.toHaveBeenCalled();
    expect(q('shared-container-invite-blocked')).toBeNull();
    expect(
      q('shared-container-invite-modal-revoke-confirmation')?.textContent,
    ).toContain('Ada');
  });

  it('looks up the exact worktree and follows recipient cursors', async () => {
    listSharedByMe.mockResolvedValueOnce({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients
      .mockResolvedValueOnce({
        recipients: [grant('grant-a', 'user-a', 'Ada')],
        nextCursor: 'recipients-page-2',
      })
      .mockResolvedValueOnce({
        recipients: [grant('grant-b', 'user-b', 'Grace')],
        nextCursor: null,
      });

    await renderModal();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listSharedByMe).toHaveBeenCalledTimes(1);
    expect(listSharedByMe).toHaveBeenCalledWith({
      organizationId: 'org-1',
      projectId: 'p1',
      worktreeId: 'w1',
    });
    expect(listRecipients).toHaveBeenNthCalledWith(2, {
      containerId: 'container-1',
      organizationId: 'org-1',
      cursor: 'recipients-page-2',
    });
    // People with access is always visible below the invite controls.
    const list = q('shared-container-invite-modal-recipients');
    expect(list?.textContent).toContain('Ada');
    expect(list?.textContent).toContain('Grace');
  });

  it('does not claim nobody has access when owner discovery fails', async () => {
    checkEligibility.mockResolvedValue({ eligible: true });
    listSharedByMe.mockRejectedValue(
      new Error('temporary owner lookup failure'),
    );

    await renderModal();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const list = q('shared-container-invite-modal-recipients');
    expect(list?.textContent).toContain('Could not load who has access.');
    expect(list?.textContent).not.toContain('No one has been invited yet.');
    expect(listSharedByMe).toHaveBeenCalledWith({
      organizationId: 'org-1',
      projectId: 'p1',
      worktreeId: 'w1',
    });
  });

  it('stops recipient pagination when the server repeats a cursor', async () => {
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: 'repeated-cursor',
    });

    await renderModal();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listRecipients).toHaveBeenCalledTimes(2);
    // People with access is always visible below the invite controls.
    expect(
      q('shared-container-invite-modal-recipients')?.textContent,
    ).toContain('Could not load the complete access list.');
  });

  it('ignores a stale member-search response after a newer query resolves', async () => {
    let resolveInitial:
      | ((value: { members: Array<{ userId: string; name: string }> }) => void)
      | undefined;
    let resolveLatest:
      | ((value: { members: Array<{ userId: string; name: string }> }) => void)
      | undefined;
    searchMembers
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLatest = resolve;
          }),
      );
    await renderModal();
    const input =
      document.querySelector<HTMLInputElement>('input[type=search]');
    await act(async () => {
      if (input) {
        setNativeInputValue(input, 'gr');
      }
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });
    await act(async () => {
      resolveLatest?.({ members: [{ userId: 'user-b', name: 'Grace' }] });
      await Promise.resolve();
      resolveInitial?.({ members: [{ userId: 'user-a', name: 'Ada' }] });
      await Promise.resolve();
    });
    const picker = q('shared-container-invite-modal-member-picker');
    expect(picker?.textContent).toContain('Grace');
    expect(picker?.textContent).not.toContain('Ada');
  });

  it('renders capability labels from the server response, not a hard-coded role', async () => {
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [
        {
          ...grant('grant-a', 'user-a', 'Ada'),
          // A capability beyond VIEW must render with no code change.
          capabilities: ['VIEW', 'COMMENT'],
        },
      ],
      nextCursor: null,
    });
    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });
    // People with access is always visible below the invite controls.
    // CAN-2551: one pill per capability with a friendly label, still driven by
    // the server's array rather than a hard-coded viewer role - an unknown
    // token must still render, title-cased, instead of being dropped.
    expect(q('shared-container-capability-pill-VIEW')?.textContent).toBe(
      'View',
    );
    expect(q('shared-container-capability-pill-COMMENT')?.textContent).toBe(
      'Comment',
    );
  });

  it('shows the setup CTA when metadata sync is off', async () => {
    checkEligibility.mockResolvedValue({
      eligible: false,
      reason: 'sync-disabled',
    });
    await renderModal();
    expect(q('shared-container-setup-cta')).not.toBeNull();
    expect(q('shared-container-setup-cta-open-settings')).not.toBeNull();
    expect(q('shared-container-invite-modal-member-picker')).toBeNull();
  });

  it('keeps organization work on the organization opt-in with external sharing off', async () => {
    // With external sharing off every share is organization-owned, and the
    // eligibility answer names no owner, so the picked organization stands.
    const org = { ...ORG, id: '11111111-1111-4111-8111-111111111111' };
    useSharedContainersStore.setState({ organizations: [org] });
    setScopingContext({ kind: 'organization', organizationId: org.id }, [org]);
    Object.assign(window.api, {
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        read: 'ok',
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: null,
        capabilities: [],
        enforcedSettings: [],
        account: {
          id: 'me',
          name: 'Me',
          email: 'me@example.test',
          role: 'DEVELOPER',
        },
        organizations: [{ id: org.id, name: org.name, role: 'MEMBER' }],
      }),
      loadPreferences: jest.fn().mockResolvedValue({
        ...makeTestPreferences(),
        telemetrySharing: {
          metadata: 'off',
          plans: 'off',
          summaries: 'off',
          transcripts: 'off',
        },
      }),
    });
    checkEligibility.mockResolvedValue({
      eligible: false,
      reason: 'sync-disabled',
    } satisfies SharedContainerEligibilityResponse);

    await renderModal();
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    const offer = q('data-sharing-opt-in-shared-projects');
    expect(offer?.dataset.optInState).toBe('offer');
    expect(offer?.dataset.optInAudience).toBeUndefined();
    expect(offer?.textContent).toContain(org.name);
  });

  describe('personal project with work stats Off', () => {
    const OFF_SHARING = {
      metadata: 'off',
      plans: 'off',
      summaries: 'off',
      transcripts: 'off',
    } as const;
    let enableDataSharingForFeature: jest.Mock;

    beforeEach(() => {
      // An account with no organization shares personal work externally.
      useSharedContainersStore.setState({ organizations: [] });
      setScopingContext({ kind: 'personal' }, []);
      const snapshot = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...snapshot,
          values: {
            ...snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]:
              true,
          },
        },
      });
      enableDataSharingForFeature = jest.fn().mockResolvedValue({
        status: 'saved',
        changedScopes: ['metadata'],
        skippedScopes: [],
      });
      Object.assign(window.api, {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          read: 'ok',
          hasApiKey: true,
          authMode: 'oauth',
          credentialSource: null,
          capabilities: [],
          account: {
            id: 'me',
            name: 'Me',
            email: 'me@example.test',
            role: 'DEVELOPER',
          },
          organizations: [],
        }),
        loadPreferences: jest.fn().mockResolvedValue({
          ...makeTestPreferences(),
          telemetrySharing: OFF_SHARING,
        }),
        enableDataSharingForFeature,
      });
      checkEligibility.mockResolvedValue({
        eligible: false,
        reason: 'sync-disabled',
      } satisfies SharedContainerEligibilityResponse);
    });

    async function flush(): Promise<void> {
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    }

    async function turnOnProjectSharing(): Promise<void> {
      const enable = q('data-sharing-opt-in-shared-projects-enable');
      expect(enable?.textContent).toBe('Turn on project data sharing');
      await act(async () => {
        enable?.click();
        await Promise.resolve();
      });
      await flush();
    }

    it('offers the personal opt-in in place of the settings detour', async () => {
      await renderModal();
      await flush();

      const offer = q('data-sharing-opt-in-shared-projects');
      expect(offer?.dataset.optInState).toBe('offer');
      expect(offer?.dataset.optInAudience).toBe('personal');
      expect(offer?.textContent).toContain('Only you can see them.');
      expect(q('shared-container-setup-cta-open-settings')).toBeNull();
      // The invite is blocked, so the recovery is never dismissible.
      expect(q('data-sharing-opt-in-shared-projects-dismiss')).toBeNull();
    });

    it('saves Just me and continues to Invite once registered', async () => {
      await renderModal();
      await flush();
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
        audiences: { team: false, organization: false, public: true },
      } satisfies SharedContainerEligibilityResponse);

      await turnOnProjectSharing();

      expect(enableDataSharingForFeature).toHaveBeenCalledWith({
        feature: 'shared-projects',
        organizationId: null,
      });
      expect(q('shared-container-setup-cta')).toBeNull();
      expect(q('shared-container-invite-modal-email-input')).not.toBeNull();
    });

    it('waits in the registration state, not a second offer, while the flush lands', async () => {
      await renderModal();
      await flush();
      checkEligibility.mockResolvedValue({
        eligible: false,
        reason: 'not-yet-synced',
      } satisfies SharedContainerEligibilityResponse);

      await turnOnProjectSharing();

      expect(enableDataSharingForFeature).toHaveBeenCalledTimes(1);
      expect(q('shared-container-invite-registration-pending')).not.toBeNull();
      expect(q('data-sharing-opt-in-shared-projects')).toBeNull();
      expect(q('shared-container-setup-cta')).toBeNull();
    });

    it('keeps a member sharing personal work Public on the personal opt-in', async () => {
      // An organization member with that organization picked still owns a
      // Public share personally: the eligibility answer carries no owner.
      useSharedContainersStore.setState({ organizations: [ORG] });
      setScopingContext({ kind: 'organization', organizationId: ORG.id }, [
        ORG,
      ]);
      checkEligibility.mockResolvedValue({
        eligible: false,
        reason: 'sync-disabled',
        ownerFixed: false,
        audiences: { team: false, organization: false, public: true },
      } satisfies SharedContainerEligibilityResponse);

      await renderModal();
      await flush();

      const offer = q('data-sharing-opt-in-shared-projects');
      expect(offer?.dataset.optInAudience).toBe('personal');
      await turnOnProjectSharing();
      expect(enableDataSharingForFeature).toHaveBeenCalledWith({
        feature: 'shared-projects',
        organizationId: null,
      });
    });
  });

  it('lets a sync-disabled owner remove existing access', async () => {
    checkEligibility.mockResolvedValue({
      eligible: false,
      reason: 'sync-disabled',
      serverWorktreeExternalId: 'server-wt-1',
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });
    const manage = q('shared-container-invite-modal-manage-existing');
    expect(manage).not.toBeNull();
    await act(async () => {
      (manage as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(
      q('shared-container-invite-modal-recipients')?.textContent,
    ).toContain('Ada');
    await act(async () => {
      (
        q('shared-container-invite-modal-revoke-user-a') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    await act(async () => {
      const confirmation = q(
        'shared-container-invite-modal-revoke-confirmation',
      );
      const remove = Array.from(
        confirmation?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      ).find((button) => button.textContent?.includes('Remove access'));
      remove?.click();
      await Promise.resolve();
    });
    expect(revokeRecipient).toHaveBeenCalledWith({
      containerId: 'container-1',
      grantId: 'grant-a',
      organizationId: 'org-1',
    });
  });

  it('names the org and offers no settings fix when org policy blocks sync', async () => {
    checkEligibility.mockResolvedValue({
      eligible: false,
      reason: 'sync-blocked-by-org',
      blockedByOrganizationNames: ['Acme'],
    });
    await renderModal();
    const cta = q('shared-container-setup-cta');
    expect(cta?.textContent).toContain('Acme');
    // Enforced by an admin: promising a settings fix here would be false.
    expect(q('shared-container-setup-cta-open-settings')).toBeNull();
  });

  it('replaces the body for an account-wide refusal', async () => {
    checkEligibility.mockResolvedValue({
      eligible: false,
      reason: 'blocked-by-org-billing',
      blockedByOrganizationNames: ['Acme'],
    });
    await renderModal();
    expect(q('shared-container-invite-blocked')?.textContent).toContain('Acme');
    expect(q('shared-container-invite-modal-member-picker')).toBeNull();
  });

  describe('project registration', () => {
    async function advance(ms: number): Promise<void> {
      await act(async () => {
        jest.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it('waits in place while the project registers, then continues to Invite', async () => {
      checkEligibility.mockResolvedValue({
        eligible: false,
        reason: 'not-yet-synced',
      } satisfies SharedContainerEligibilityResponse);
      await renderModal();

      const pending = q('shared-container-invite-registration-pending');
      expect(pending?.textContent).toContain(
        'Getting this project ready to share',
      );
      expect(pending?.textContent).toContain(
        'This usually takes a few seconds.',
      );
      expect(pending?.getAttribute('aria-busy')).toBe('true');
      // Nothing to press: the state re-checks on its own.
      expect(q('shared-container-invite-registration-retry')).toBeNull();
      expect(checkEligibility).toHaveBeenCalledTimes(1);

      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
      } satisfies SharedContainerEligibilityResponse);
      await advance(3000);
      await advance(400);

      expect(checkEligibility).toHaveBeenCalledTimes(2);
      expect(q('shared-container-invite-registration-pending')).toBeNull();
      expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    });

    it('stops re-checking after the cap and offers Try again', async () => {
      checkEligibility.mockResolvedValue({
        eligible: false,
        reason: 'not-yet-synced',
      } satisfies SharedContainerEligibilityResponse);
      await renderModal();

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await advance(3000);
      }
      expect(checkEligibility).toHaveBeenCalledTimes(5);
      expect(q('shared-container-invite-registration-pending')).toBeNull();
      const failed = q('shared-container-invite-registration-failed');
      expect(failed?.textContent).toContain("Couldn't get this project ready");

      // No further automatic checks once it has given up.
      await advance(10_000);
      expect(checkEligibility).toHaveBeenCalledTimes(5);
    });

    it('shows a registration failure with Try again that re-checks', async () => {
      checkEligibility.mockResolvedValue({
        eligible: false,
        reason: 'registration-failed',
      } satisfies SharedContainerEligibilityResponse);
      await renderModal();

      const failed = q('shared-container-invite-registration-failed');
      expect(failed?.textContent).toContain("Couldn't get this project ready");
      expect(failed?.textContent).toContain(
        'Check your connection, then try again.',
      );
      const retry = q('shared-container-invite-registration-retry');
      expect(retry?.textContent).toBe('Try again');

      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
      } satisfies SharedContainerEligibilityResponse);
      await act(async () => {
        retry?.click();
        await Promise.resolve();
      });
      await advance(400);

      expect(checkEligibility).toHaveBeenCalledTimes(2);
      expect(q('shared-container-invite-registration-failed')).toBeNull();
      expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    });
  });

  describe('sharing work GitHub does not have', () => {
    it('opens straight to Invite and names commits not on GitHub yet', async () => {
      preview.mockResolvedValue({
        ...PREVIEW,
        unpushedCommitCount: 3,
      } satisfies SharedContainerSharePreview);
      await renderModal();
      await expandScopeDetails();

      expect(q('shared-container-invite-blocked')).toBeNull();
      expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
      expect(
        q('shared-container-invite-modal-scope-summary')?.textContent,
      ).toContain('3 commits not on GitHub yet');
      // Informational only: no push is offered while the share fits.
      expect(
        q('shared-container-invite-modal-artifact-budget-push'),
      ).toBeNull();
    });

    it('says when code travels through the cloud instead of GitHub', async () => {
      preview.mockResolvedValue({
        ...PREVIEW,
        snapshotRepositoryCount: 1,
        snapshotBytes: 2048,
        snapshotRepositoryNames: ['local-only'],
      } satisfies SharedContainerSharePreview);
      await renderModal();
      // Informational, so it sits behind Advanced with the summary.
      expect(q('shared-container-invite-modal-snapshot-disclosure')).toBeNull();
      await expandScopeDetails();

      expect(
        q('shared-container-invite-modal-snapshot-disclosure')?.textContent,
      ).toBe(
        "Code for local-only is sent through Canopy Cloud because it isn't on GitHub.",
      );
      expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    });

    it('offers Push to GitHub only when an over-budget share has unpushed commits', async () => {
      preview
        .mockResolvedValueOnce({
          ...PREVIEW,
          unpushedCommitCount: 2,
          artifactBudget: { used: 240, limit: 200 },
        } satisfies SharedContainerSharePreview)
        .mockResolvedValue({
          ...PREVIEW,
          artifactBudget: { used: 12, limit: 200 },
        } satisfies SharedContainerSharePreview);
      await renderModal();

      expect(
        q('shared-container-invite-modal-artifact-budget')?.textContent,
      ).toContain('push to GitHub so less has to be sent');
      const push = q('shared-container-invite-modal-artifact-budget-push');
      expect(push?.textContent).toBe('Push to GitHub');

      await act(async () => {
        push?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(prepareGithub).toHaveBeenCalledWith({
        projectId: 'p1',
        worktreeId: 'w1',
        organizationId: 'org-1',
        containerType: 'CODE_WORKTREE',
      });
      // The preview re-reads against the moved base and the blocker clears,
      // without the modal leaving the Invite tab.
      expect(preview).toHaveBeenCalledTimes(2);
      expect(q('shared-container-invite-modal-artifact-budget')).toBeNull();
      expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    });

    it('reports a push the branch cannot take without leaving Invite', async () => {
      preview.mockResolvedValue({
        ...PREVIEW,
        unpushedCommitCount: 2,
        artifactBudget: { used: 240, limit: 200 },
      } satisfies SharedContainerSharePreview);
      prepareGithub.mockResolvedValue({
        status: 'blocked',
        readiness: { status: 'blocked', reason: 'diverged' },
      });
      await renderModal();

      await act(async () => {
        q('shared-container-invite-modal-artifact-budget-push')?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        q('shared-container-invite-modal-artifact-budget-push-error')
          ?.textContent,
      ).toBe(
        "Couldn't push this branch to GitHub. Untick some files under Advanced instead.",
      );
      expect(q('shared-container-invite-blocked')).toBeNull();
      expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    });
  });

  describe('GitHub recovery', () => {
    /** Resolve eligibility to the blocked GitHub state with one classification. */
    function blockOnGithub(
      readiness?: SharedContainerEligibilityResponse['githubReadiness'],
    ): void {
      checkEligibility.mockResolvedValue({
        eligible: false,
        reason: 'github-not-ready',
        ...(readiness ? { githubReadiness: readiness } : {}),
      } satisfies SharedContainerEligibilityResponse);
    }

    async function clickPush(): Promise<void> {
      await act(async () => {
        q('shared-container-invite-push-github')?.click();
        await Promise.resolve();
      });
    }

    it('offers a one-click push instead of a shell command', async () => {
      blockOnGithub({ status: 'push-required' });

      await renderModal();

      const refusal = q('shared-container-invite-blocked');
      expect(refusal?.textContent).toContain('Push to GitHub to continue');
      expect(refusal?.textContent).toContain(
        "This project's current branch needs to be on GitHub before you can share it.",
      );
      const push = q('shared-container-invite-push-github');
      expect(push?.textContent).toBe('Push to GitHub');
      expect(refusal?.querySelector('h3')?.textContent).toBe(
        'Push to GitHub to continue',
      );
      expect(
        Array.from(
          q('shared-container-invite-footer')?.querySelectorAll('button') ?? [],
        ).map((button) => button.textContent?.trim()),
      ).toEqual(['Push to GitHub']);
      // The dead end this replaced: a command the user had to run elsewhere.
      expect(q('shared-container-invite-blocked-command')).toBeNull();
      expect(refusal?.textContent).not.toContain('git push');
      expect(q('shared-container-invite-modal-member-picker')).toBeNull();
    });

    it('pushes once and continues into the member picker without reopening', async () => {
      blockOnGithub({ status: 'push-required' });
      await renderModal();

      // The push succeeds and the re-probe now answers eligible, which is what
      // lets the normal invite surface replace the blocker in place.
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
      } satisfies SharedContainerEligibilityResponse);
      await clickPush();
      await act(async () => {
        jest.advanceTimersByTime(400);
        await Promise.resolve();
      });

      expect(prepareGithub).toHaveBeenCalledTimes(1);
      expect(prepareGithub).toHaveBeenCalledWith({
        projectId: 'p1',
        worktreeId: 'w1',
        organizationId: 'org-1',
        containerType: 'CODE_WORKTREE',
      });
      expect(q('shared-container-invite-blocked')).toBeNull();
      expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    });

    it('shows the pushing label and refuses a second activation while in flight', async () => {
      blockOnGithub({ status: 'push-required' });
      let releasePush: (value: { status: 'ready' }) => void = () => {};
      prepareGithub.mockReturnValue(
        new Promise<{ status: 'ready' }>((resolve) => {
          releasePush = resolve;
        }),
      );
      await renderModal();

      await clickPush();

      const push = q('shared-container-invite-push-github');
      expect(push?.textContent).toBe('Pushing…');
      expect((push as HTMLButtonElement | null)?.disabled).toBe(true);
      expect(
        q('shared-container-invite-blocked')?.getAttribute('aria-busy'),
      ).toBe('true');

      // A repeat click while busy must not start a second push.
      await clickPush();
      expect(prepareGithub).toHaveBeenCalledTimes(1);

      await act(async () => {
        releasePush({ status: 'ready' });
        await Promise.resolve();
      });
    });

    it('announces a push failure in place and retries', async () => {
      blockOnGithub({ status: 'push-required' });
      prepareGithub.mockResolvedValue({ status: 'failed' });
      await renderModal();

      await clickPush();

      const alert = q('shared-container-invite-github-error');
      expect(alert?.getAttribute('role')).toBe('alert');
      expect(alert?.textContent).toBe(
        'Could not push to GitHub. Check your connection and repository access, then try again.',
      );
      // The modal stays open on the same state, with a retry on the button.
      expect(q('shared-container-invite-blocked')).not.toBeNull();
      expect(q('shared-container-invite-push-github')?.textContent).toBe(
        'Try again',
      );

      prepareGithub.mockResolvedValue({ status: 'ready' });
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
      } satisfies SharedContainerEligibilityResponse);
      await clickPush();
      await act(async () => {
        jest.advanceTimersByTime(400);
        await Promise.resolve();
      });

      expect(prepareGithub).toHaveBeenCalledTimes(2);
      expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    });

    it('replaces the state when the re-probe finds a blocker a push cannot fix', async () => {
      blockOnGithub({ status: 'push-required' });
      prepareGithub.mockResolvedValue({
        status: 'blocked',
        readiness: { status: 'blocked', reason: 'diverged' },
      });
      await renderModal();

      await clickPush();

      const refusal = q('shared-container-invite-blocked');
      expect(refusal?.textContent).toContain('Sync this branch with GitHub');
      expect(q('shared-container-invite-push-github')).toBeNull();
      expect(q('shared-container-invite-github-error')).toBeNull();
    });

    it.each([
      [
        'missing-origin' as const,
        'Connect this project to GitHub',
        'Add a GitHub origin to each repository before sharing this project.',
      ],
      [
        'non-github-origin' as const,
        'A GitHub repository is required',
        "Each repository's origin must point to GitHub before this project can be shared.",
      ],
      [
        'no-branch' as const,
        'Switch to a branch to continue',
        'This project needs a named branch with a commit before it can be shared.',
      ],
      [
        'no-head' as const,
        'Switch to a branch to continue',
        'This project needs a named branch with a commit before it can be shared.',
      ],
      [
        'diverged' as const,
        'Sync this branch with GitHub',
        'The local and GitHub branches have different commits. Resolve the branch history, then try again.',
      ],
      [
        'no-repositories' as const,
        'No Git repository found',
        'Add a Git repository to this project before sharing it.',
      ],
    ])(
      'offers guidance and no push button for %s',
      async (reason, title, description) => {
        blockOnGithub({ status: 'blocked', reason });

        await renderModal();

        const refusal = q('shared-container-invite-blocked');
        expect(refusal?.textContent).toContain(title);
        expect(refusal?.textContent).toContain(description);
        expect(q('shared-container-invite-push-github')).toBeNull();
        expect(prepareGithub).not.toHaveBeenCalled();
      },
    );

    it('offers a re-check, not a push, when the probe itself was inconclusive', async () => {
      blockOnGithub({ status: 'blocked', reason: 'unavailable' });
      await renderModal();

      const refusal = q('shared-container-invite-blocked');
      expect(refusal?.textContent).toContain('Could not check GitHub');
      expect(refusal?.textContent).toContain(
        'Check your connection and GitHub access, then try again.',
      );
      expect(q('shared-container-invite-push-github')).toBeNull();
      const recheck = q('shared-container-invite-recheck-github');
      expect(recheck?.textContent).toBe('Try again');

      checkEligibility.mockClear();
      await act(async () => {
        recheck?.click();
        await Promise.resolve();
      });
      // Re-checking re-probes; it never mutates the remote.
      expect(checkEligibility).toHaveBeenCalledTimes(1);
      expect(prepareGithub).not.toHaveBeenCalled();
    });

    it('fails safe to the inconclusive state when the response carries no classification', async () => {
      // A stale or older main process answers `github-not-ready` with no
      // detail. Inventing a push button here would offer a mutation nothing
      // established as safe.
      blockOnGithub();

      await renderModal();

      expect(q('shared-container-invite-blocked')?.textContent).toContain(
        'Could not check GitHub',
      );
      expect(q('shared-container-invite-push-github')).toBeNull();
    });

    it('re-probes when the invite itself is refused for GitHub, landing on the real classification', async () => {
      // The branch moved ahead of its remote between opening the modal and
      // submitting. The invite response names `github-not-ready` but carries
      // no classification, so the modal has to re-ask rather than render the
      // unclassified "could not check" state over a recoverable push.
      await renderModal();
      const ada = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent?.includes('Ada'));
      await act(async () => {
        ada?.click();
        await Promise.resolve();
      });

      invite.mockResolvedValue({
        invited: false,
        reason: 'github-not-ready',
      });
      blockOnGithub({ status: 'push-required' });
      await act(async () => {
        (q('shared-container-invite-submit') as HTMLButtonElement).click();
        await Promise.resolve();
      });

      expect(q('shared-container-invite-blocked')?.textContent).toContain(
        'Push to GitHub to continue',
      );
      expect(q('shared-container-invite-push-github')).not.toBeNull();
    });

    it('keeps Manage existing access available while GitHub blocks a new invite', async () => {
      blockOnGithub({ status: 'push-required' });
      listSharedByMe.mockResolvedValue({
        containers: [
          {
            id: 'container-1',
            organizationId: 'org-1',
            ownerUserId: 'me',
            worktreeId: 'server-wt-1',
            containerType: 'CODE_WORKTREE',
            revision: 1,
            createdAt: '',
            updatedAt: '',
            capabilities: ['VIEW'],
          },
        ],
        nextCursor: null,
      });

      await renderModal();

      expect(q('shared-container-invite-modal-manage-existing')).not.toBeNull();
      expect(q('shared-container-invite-push-github')).not.toBeNull();
    });

    it('disables Manage existing access while a push is in flight', async () => {
      // Leaving it clickable lets the user navigate to the recipients view
      // mid-push. That unmounts the surface `actionError` renders on, so a
      // subsequent failure is swallowed while the region is still aria-busy.
      blockOnGithub({ status: 'push-required' });
      listSharedByMe.mockResolvedValue({
        containers: [
          {
            id: 'container-1',
            organizationId: 'org-1',
            ownerUserId: 'me',
            worktreeId: 'server-wt-1',
            containerType: 'CODE_WORKTREE',
            revision: 1,
            createdAt: '',
            updatedAt: '',
            capabilities: ['VIEW'],
          },
        ],
        nextCursor: null,
      });
      let releasePush: (value: { status: 'failed' }) => void = () => {};
      prepareGithub.mockReturnValue(
        new Promise<{ status: 'failed' }>((resolve) => {
          releasePush = resolve;
        }),
      );

      await renderModal();

      const manage = q(
        'shared-container-invite-modal-manage-existing',
      ) as HTMLButtonElement | null;
      expect(manage).not.toBeNull();
      expect(manage?.disabled).toBe(false);

      await clickPush();
      expect(
        (
          q(
            'shared-container-invite-modal-manage-existing',
          ) as HTMLButtonElement | null
        )?.disabled,
      ).toBe(true);

      await act(async () => {
        releasePush({ status: 'failed' });
        await Promise.resolve();
      });

      // Once the push settles, the failure is announced on a surface that is
      // still mounted, and navigation is available again.
      expect(q('shared-container-invite-github-error')).not.toBeNull();
      expect(
        (
          q(
            'shared-container-invite-modal-manage-existing',
          ) as HTMLButtonElement | null
        )?.disabled,
      ).toBe(false);
    });
  });

  it('explains when another organization permanently owns the anchor', async () => {
    checkEligibility.mockResolvedValue({
      eligible: false,
      reason: 'anchored-to-other-organization',
      blockedByOrganizationNames: ['Org Two'],
    });

    await renderModal();

    const refusal = q('shared-container-invite-blocked');
    expect(refusal?.textContent).toContain('already shared through Org Two');
    expect(refusal?.textContent).not.toContain('Try again');
    expect(q('shared-container-invite-modal-member-picker')).toBeNull();
  });

  it('keeps the no-organization refusal after an empty account rehydration', async () => {
    useSharedContainersStore.setState({
      accountHydrated: true,
      accountHydrationFailed: false,
      accountKind: 'connected',
      organizations: [],
      orgBillingStates: [],
    });
    await renderModal();
    expect(q('shared-container-invite-blocked')?.textContent).toContain(
      'Join an organization',
    );
    const loadCanopyCloudAccount = window.api
      .loadCanopyCloudAccount as jest.MockedFunction<
      typeof window.api.loadCanopyCloudAccount
    >;
    loadCanopyCloudAccount.mockResolvedValue({
      read: 'ok',
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: [],
      account: {
        id: 'user-1',
        name: 'Owner',
        email: 'owner@example.test',
        role: 'DEVELOPER',
      },
      organizations: [],
      teams: [],
      storageAvailable: true,
    });

    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(q('shared-container-invite-blocked')?.textContent).toContain(
      'Join an organization',
    );
    expect(document.body.textContent).not.toContain('Checking access…');
  });

  it.each([
    ['guest', 'guest-account'],
    ['disconnected', 'no-cloud-account'],
  ] as const)(
    'routes an empty-org %s account to the cloud connect gate',
    async (accountKind, expectedReason) => {
      useSharedContainersStore.setState({
        accountKind,
        organizations: [],
        orgBillingStates: [],
      });
      const accountState: CanopyCloudAccountPublicState =
        accountKind === 'guest'
          ? {
              hasApiKey: true,
              authMode: 'guest',
              credentialSource: 'guest',
              capabilities: [],
              storageAvailable: true,
            }
          : {
              hasApiKey: false,
              authMode: null,
              credentialSource: null,
              capabilities: [],
              storageAvailable: true,
            };
      (
        window.api.loadCanopyCloudAccount as jest.MockedFunction<
          typeof window.api.loadCanopyCloudAccount
        >
      ).mockResolvedValue(accountState);
      await renderModal();
      expect(checkEligibility).not.toHaveBeenCalled();
      expect(useCloudConnectGateStore.getState().pending).not.toBeNull();
      expect(
        (
          useCloudConnectGateStore.getState().pending as unknown as {
            context?: { guestBenefits?: boolean };
          }
        )?.context?.guestBenefits,
      ).toBe(expectedReason === 'guest-account');
    },
  );

  it('retries an inconclusive account read when the modal opens', async () => {
    useSharedContainersStore.setState({
      accountHydrated: true,
      accountHydrationFailed: true,
      accountKind: 'unknown',
      organizations: [],
      orgBillingStates: [],
    });
    const loadCanopyCloudAccount = window.api
      .loadCanopyCloudAccount as jest.MockedFunction<
      typeof window.api.loadCanopyCloudAccount
    >;
    loadCanopyCloudAccount.mockResolvedValue({
      read: 'ok',
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: [],
      account: {
        id: 'user-1',
        name: 'Owner',
        email: 'owner@example.test',
        role: 'DEVELOPER',
      },
      organizations: [ORG],
      teams: [],
      storageAvailable: true,
    });

    await renderModal();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadCanopyCloudAccount).toHaveBeenCalled();
    expect(checkEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
    );
  });

  it('fails open when the eligibility probe throws', async () => {
    checkEligibility.mockRejectedValue(new Error('offline'));
    await renderModal();
    // A probe failure must never invent a lockout.
    expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    expect(q('shared-container-invite-blocked')).toBeNull();
  });

  it('calls a cowork share a project, and never claims it carries code', async () => {
    // Both container types are "this project" to the owner. "Work Entry" and
    // "worktree" are internal names for the two things that can be shared, and
    // an invite recipient should not have to learn either one. The summary
    // sentence still has to stay honest: a Cowork workspace is a plain folder
    // with no git behind it, so it must not lead with its code the way a code
    // worktree does.
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      dirtyFileCount: 0,
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    expect(q('shared-container-invite-modal-scope-summary')?.textContent).toBe(
      'Sharing this workspace: 3 chats, 2 attachments, 1 of 1 file.',
    );
    const disclosure = q('shared-container-invite-modal-disclosure');
    expect(disclosure?.textContent).toContain('this project');
    expect(disclosure?.textContent).not.toContain('Work Entry');
    expect(disclosure?.textContent).not.toContain('worktree');
  });

  it('includes cowork notes by default and persists an untick as an exclusion', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      dirtyFileCount: 0,
      noteCount: 2,
      promptCount: 1,
      notes: [
        { id: 'note-a', title: 'Kickoff' },
        { id: 'note-b', title: 'Scratch' },
      ],
      prompts: [{ id: 'prompt-a', title: 'Reviewer' }],
    });
    saveFileScope.mockResolvedValue({
      fileScope: { includedPaths: [], excludedNoteIds: ['note-a'] },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    const noteCheckbox = q(
      'shared-container-invite-modal-note-scope-note-a',
    ) as HTMLInputElement;
    expect(noteCheckbox).not.toBeNull();
    expect(noteCheckbox.checked).toBe(true);
    await act(async () => {
      noteCheckbox.click();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      includedPaths: [],
      excludedNoteIds: ['note-a'],
      excludedPromptIds: [],
      // The scope is one unit: a file, note, or prompt change carries
      // the run-sharing decision through untouched (CAN-2831).
      runSharingDisabled: false,
      excludedRunScripts: [],
    });
    expect(
      (q('shared-container-invite-modal-note-scope-note-a') as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (q('shared-container-invite-modal-note-scope-note-b') as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('hydrates unticked prompts from the persisted cowork scope', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      noteCount: 0,
      promptCount: 1,
      notes: [],
      prompts: [{ id: 'prompt-a', title: 'Reviewer' }],
      approvedFileScope: {
        includedPaths: [],
        // A legacy allowlist entry is no longer read; exclusions decide.
        includedPromptIds: ['prompt-a'],
        excludedPromptIds: ['prompt-a'],
      },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      (
        q(
          'shared-container-invite-modal-prompt-scope-prompt-a',
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it('lets an owner revoke an approved file that is no longer a preview candidate', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      approvedFileScope: { includedPaths: ['missing-evidence.txt'] },
      untrackedCandidates: [],
      untrackedCandidateCount: 0,
    });
    saveFileScope.mockResolvedValue({
      fileScope: { includedPaths: [] },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    const approvedOnlyCheckbox = q(
      'shared-container-invite-modal-file-review-missing-evidence.txt',
    ) as HTMLInputElement;
    expect(approvedOnlyCheckbox).not.toBeNull();
    expect(approvedOnlyCheckbox.checked).toBe(true);

    await act(async () => {
      approvedOnlyCheckbox.click();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      includedPaths: [],
      legacyAllowlist: true,
      excludedNoteIds: [],
      excludedPromptIds: [],
      // The scope is one unit: a file, note, or prompt change carries
      // the run-sharing decision through untouched (CAN-2831).
      runSharingDisabled: false,
      excludedRunScripts: [],
    });
  });

  // A deep repository path is longer than the modal is wide, and the owner is
  // deciding whether it leaves their machine. Clipping it to an ellipsis hides
  // the basename — the part that identifies the file — and letting it size the
  // flex row instead pushes a horizontal scrollbar onto the whole dialog body.
  // Both labels must wrap to the full path rather than truncate.
  it('wraps a long untracked path instead of truncating or overflowing', async () => {
    const deepPath =
      'apps/desktop-app/src/renderer/src/components/shared/loading/progress/CircularProgress.tsx';
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      approvedFileScope: { includedPaths: [] },
      untrackedCandidates: [deepPath],
      untrackedCandidateCount: 1,
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = q(
      `shared-container-invite-modal-file-review-${deepPath}`,
    ) as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    const label = checkbox.closest('label');
    const pathLabel = label?.querySelector('span');
    expect(pathLabel?.textContent).toBe(deepPath);
    expect(pathLabel?.className).not.toContain('truncate');
    expect(pathLabel?.className).toContain('break-all');
    // Without `min-w-0` the span refuses to shrink below its content width, so
    // the row — not the label — is what overflows the dialog.
    expect(pathLabel?.className).toContain('min-w-0');
    // The box stays a box and stays on the first line once the path wraps.
    expect(checkbox.className).toContain('shrink-0');
    expect(label?.className).toContain('items-start');
  });

  it('wraps a long folder-group label instead of truncating', async () => {
    const directory =
      'apps/desktop-app/src/renderer/src/components/shared/loading/progress';
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      approvedFileScope: { includedPaths: [] },
      untrackedCandidates: [
        `${directory}/CircularProgress.tsx`,
        `${directory}/LinearProgress.tsx`,
      ],
      untrackedCandidateCount: 2,
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    const folderCheckbox = q(
      `shared-container-invite-modal-file-scope-folder-${directory}`,
    ) as HTMLInputElement;
    expect(folderCheckbox).not.toBeNull();
    const label = folderCheckbox.closest('label');
    const folderLabel = label?.querySelector('span');
    expect(folderLabel?.className).not.toContain('truncate');
    expect(folderLabel?.className).toContain('break-all');
    expect(folderLabel?.className).toContain('min-w-0');
    expect(folderCheckbox.className).toContain('shrink-0');
    expect(label?.className).toContain('items-start');
  });

  it('expands an unticked folder to concrete exclusions', async () => {
    // A Cowork share carries the folder by default, so the folder affordance
    // now runs the other way: it starts ticked, and unticking it is how the
    // owner drops a subtree. It still expands to concrete paths rather than
    // saving the directory itself, so a file added there later is governed by
    // the default rather than by a decision made before it existed.
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      approvedFileScope: { includedPaths: [] },
      untrackedCandidates: ['docs/a.md', 'docs/b.md', 'top.md'],
      untrackedCandidateCount: 3,
      defaultIncludedFilePaths: ['docs/a.md', 'docs/b.md', 'top.md'],
    });
    saveFileScope.mockResolvedValue({
      fileScope: {
        includedPaths: [],
        excludedPaths: ['docs/a.md', 'docs/b.md'],
      },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    const folderCheckbox = q(
      'shared-container-invite-modal-file-scope-folder-docs',
    ) as HTMLInputElement;
    expect(folderCheckbox).not.toBeNull();
    expect(folderCheckbox.checked).toBe(true);
    // A single-file directory is not worth a folder affordance.
    expect(q('shared-container-invite-modal-file-scope-folder-top')).toBeNull();

    await act(async () => {
      folderCheckbox.click();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      includedPaths: [],
      excludedPaths: ['docs/a.md', 'docs/b.md'],
      excludedNoteIds: [],
      excludedPromptIds: [],
      // The scope is one unit: a file, note, or prompt change carries
      // the run-sharing decision through untouched (CAN-2831).
      runSharingDisabled: false,
      excludedRunScripts: [],
    });
  });

  it('expands a parent folder to files in every nested descendant', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      approvedFileScope: { includedPaths: [] },
      untrackedCandidates: [
        'evidence/summary.txt',
        'evidence/raw/a.txt',
        'evidence/raw/deeper/b.txt',
      ],
      untrackedCandidateCount: 3,
      defaultIncludedFilePaths: [
        'evidence/summary.txt',
        'evidence/raw/a.txt',
        'evidence/raw/deeper/b.txt',
      ],
    });
    saveFileScope.mockResolvedValue({
      fileScope: {
        includedPaths: [],
        excludedPaths: [
          'evidence/raw/a.txt',
          'evidence/raw/deeper/b.txt',
          'evidence/summary.txt',
        ],
      },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    const folderCheckbox = q(
      'shared-container-invite-modal-file-scope-folder-evidence',
    ) as HTMLInputElement;
    expect(folderCheckbox).not.toBeNull();
    await act(async () => {
      folderCheckbox.click();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      includedPaths: [],
      excludedPaths: [
        'evidence/raw/a.txt',
        'evidence/raw/deeper/b.txt',
        'evidence/summary.txt',
      ],
      excludedNoteIds: [],
      excludedPromptIds: [],
      // The scope is one unit: a file, note, or prompt change carries
      // the run-sharing decision through untouched (CAN-2831).
      runSharingDisabled: false,
      excludedRunScripts: [],
    });
  });

  it('ticks every cowork file by default and names them in the summary', async () => {
    // The reported bug, from the owner's side: a Cowork workspace with files
    // in it offered no file options at all, and the share carried none. Files
    // are the content of a Cowork share, so they must be in by default and the
    // one always-visible sentence has to say so without expanding anything.
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      dirtyFileCount: 0,
      approvedFileScope: { includedPaths: [] },
      untrackedCandidates: ['hello.md', 'notes/plan.md'],
      untrackedCandidateCount: 2,
      defaultIncludedFilePaths: ['hello.md', 'notes/plan.md'],
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    expect(q('shared-container-invite-modal-scope-summary')?.textContent).toBe(
      'Sharing this workspace: 3 chats, 2 attachments, 2 of 2 files.',
    );

    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      (
        q(
          'shared-container-invite-modal-file-review-hello.md',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      q('shared-container-invite-modal-file-scope')?.querySelector('legend')
        ?.textContent,
    ).toBe('Files in this workspace');
    expect(
      q('shared-container-invite-modal-file-scope-hint')?.textContent,
    ).toContain('Untick any');
  });

  it('records a cowork untick as an exclusion, not a withdrawn approval', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      dirtyFileCount: 0,
      approvedFileScope: { includedPaths: [] },
      untrackedCandidates: ['hello.md', 'secret-notes.md'],
      untrackedCandidateCount: 2,
      defaultIncludedFilePaths: ['hello.md', 'secret-notes.md'],
    });
    saveFileScope.mockResolvedValue({
      fileScope: { includedPaths: [], excludedPaths: ['secret-notes.md'] },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = q(
      'shared-container-invite-modal-file-review-secret-notes.md',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      includedPaths: [],
      excludedPaths: ['secret-notes.md'],
      excludedNoteIds: [],
      excludedPromptIds: [],
      runSharingDisabled: false,
      excludedRunScripts: [],
    });
    expect(q('shared-container-invite-modal-scope-summary')?.textContent).toBe(
      'Sharing this workspace: 3 chats, 2 attachments, 1 of 2 files.',
    );
  });

  it('keeps allowlist semantics for a cowork scope narrowed before the default changed', async () => {
    // `includedPaths` with no `excludedPaths` is a scope somebody deliberately
    // narrowed under the old rules. Reading it as "everything except nothing"
    // would widen their share behind their back, so the tick keeps meaning
    // "add this" until they say otherwise.
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      dirtyFileCount: 0,
      approvedFileScope: { includedPaths: ['hello.md'] },
      untrackedCandidates: ['hello.md', 'private.md'],
      untrackedCandidateCount: 2,
      defaultIncludedFilePaths: ['hello.md'],
    });
    saveFileScope.mockResolvedValue({
      fileScope: { includedPaths: ['hello.md', 'private.md'] },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    expect(q('shared-container-invite-modal-scope-summary')?.textContent).toBe(
      'Sharing this workspace: 3 chats, 2 attachments, 1 approved file.',
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(q('shared-container-invite-modal-file-scope-hint')).toBeNull();
    expect(
      (
        q(
          'shared-container-invite-modal-file-review-private.md',
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);

    await act(async () => {
      (
        q(
          'shared-container-invite-modal-file-review-private.md',
        ) as HTMLInputElement
      ).click();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
      includedPaths: ['hello.md', 'private.md'],
      excludedNoteIds: [],
      excludedPromptIds: [],
      runSharingDisabled: false,
      excludedRunScripts: [],
    });
  });

  it('preserves legacy allowlist semantics after its last Cowork file is unticked', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      dirtyFileCount: 0,
      approvedFileScope: { includedPaths: ['hello.md'] },
      untrackedCandidates: ['hello.md', 'private.md'],
      untrackedCandidateCount: 2,
      defaultIncludedFilePaths: ['hello.md'],
    });
    saveFileScope.mockResolvedValue({
      fileScope: {
        includedPaths: [],
        legacyAllowlist: true,
      },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();

    await act(async () => {
      (
        q(
          'shared-container-invite-modal-file-review-hello.md',
        ) as HTMLInputElement
      ).click();
      await Promise.resolve();
    });

    expect(saveFileScope).toHaveBeenCalledWith(
      expect.objectContaining({
        includedPaths: [],
        legacyAllowlist: true,
      }),
    );
  });

  it('leaves cowork files past the artifact budget unticked', async () => {
    // Auto-including a large folder must never turn a working share into a
    // refused one, so the default stops at the budget and the overflow is
    // offered rather than assumed. Ranked order decides which files make it.
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      dirtyFileCount: 0,
      approvedFileScope: { includedPaths: [] },
      untrackedCandidates: [
        'ranked-first.md',
        'overflow/a.md',
        'overflow/b.md',
      ],
      untrackedCandidateCount: 3,
      defaultIncludedFilePaths: ['ranked-first.md'],
      // 12 non-file artifacts against a limit of 13 leaves room for one file.
      artifactBudget: { used: 13, limit: 13 },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    expect(q('shared-container-invite-modal-scope-summary')?.textContent).toBe(
      'Sharing this workspace: 3 chats, 2 attachments, 1 of 3 files.',
    );
    // The default alone must not trip the refusal that disables Invite.
    expect(q('shared-container-invite-modal-artifact-budget')).toBeNull();

    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });
    const cappedFile = q(
      'shared-container-invite-modal-file-review-overflow/a.md',
    ) as HTMLInputElement;
    expect(cappedFile.checked).toBe(false);
    expect(cappedFile.disabled).toBe(true);
    expect(
      (
        q(
          'shared-container-invite-modal-file-scope-folder-overflow',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    // Quiet by design: the summary's "X of Y" is the only signal.
    expect(
      q('shared-container-invite-modal-file-scope-budget-note'),
    ).toBeNull();
  });

  it('leaves cowork files past the revision byte budget unticked', async () => {
    const candidatePaths = Array.from(
      { length: 20 },
      (_, index) => `file-${index}.bin`,
    );
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      dirtyFileCount: 0,
      approvedFileScope: { includedPaths: [], excludedPaths: [] },
      untrackedCandidates: candidatePaths,
      untrackedCandidateCount: candidatePaths.length,
      defaultIncludedFilePaths: candidatePaths.slice(0, 19),
      artifactBudget: { used: 20, limit: 200 },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    expect(q('shared-container-invite-modal-scope-summary')?.textContent).toBe(
      'Sharing this workspace: 3 chats, 2 attachments, 19 of 20 files.',
    );

    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });
    const cappedFile = q(
      'shared-container-invite-modal-file-review-file-19.bin',
    ) as HTMLInputElement;
    expect(cappedFile.checked).toBe(false);
    expect(cappedFile.disabled).toBe(true);
    // Quiet by design: the summary's "X of Y" is the only signal.
    expect(
      q('shared-container-invite-modal-file-scope-budget-note'),
    ).toBeNull();
  });

  it('says the check did not run rather than dropping the scope panel', async () => {
    // A rejected preview used to render as nothing at all, taking both
    // always-visible blockers off screen with it. That read as "this share has
    // nothing worth reviewing" — the failure mode that let a hard main-process
    // crash reach manual testing with no visible symptom.
    preview.mockRejectedValue(new Error('ENAMETOOLONG'));
    await renderModal('COWORK_WORK_ENTRY');
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      q('shared-container-invite-modal-preview-unavailable')?.textContent,
    ).toBe('Could not check what will be shared. Inviting still works.');
    // Failing open: the preview is not a gate, so the invite stays available.
    expect(q('shared-container-invite-submit')).not.toBeNull();
  });

  it('states that cowork notes and prompts are project-wide', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      noteCount: 1,
      promptCount: 0,
      notes: [{ id: 'note-a', title: 'Kickoff' }],
      prompts: [],
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      q('shared-container-invite-modal-workspace-items')?.textContent,
    ).toContain('belong to the whole Cowork project');
  });

  it('omits the plan line from the cowork share summary', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      containerType: 'COWORK_WORK_ENTRY',
      planCount: 0,
      noteCount: 2,
      promptCount: 3,
      notes: [
        { id: 'note-a', title: 'One' },
        { id: 'note-b', title: 'Two' },
      ],
      prompts: [
        { id: 'prompt-a', title: 'A' },
        { id: 'prompt-b', title: 'B' },
        { id: 'prompt-c', title: 'C' },
      ],
      approvedFileScope: {
        includedPaths: [],
        excludedPromptIds: ['prompt-b'],
      },
    });
    await renderModal('COWORK_WORK_ENTRY');
    await expandScopeDetails();

    const summary = q(
      'shared-container-invite-modal-scope-summary',
    )?.textContent;
    expect(summary).not.toContain('plans');
    expect(summary).toContain('2 of 2 notes, 2 of 3 prompts');
  });

  // ---------------------------------------------------------------------
  // CAN-2551: organization eligibility filtering, and its fail-open rule.
  // ---------------------------------------------------------------------

  const OTHER_ORG = {
    id: 'org-2',
    name: 'Globex',
    createdAt: '',
    updatedAt: '',
  };

  it('omits an organization whose plan no longer includes sharing', async () => {
    useSharedContainersStore.setState({
      organizations: [ORG, OTHER_ORG],
      orgBillingStates: [
        {
          organizationId: ORG.id,
          organizationName: ORG.name,
          teamsEntitled: false,
        },
        {
          organizationId: OTHER_ORG.id,
          organizationName: OTHER_ORG.name,
          teamsEntitled: true,
        },
      ],
    });

    await renderModal();

    // Only one organization survives the filter, so the picker collapses.
    expect(q('shared-container-invite-modal-organization')).toBeNull();
    // ...and the entitled organization is the one everything is scoped to.
    expect(checkEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: OTHER_ORG.id }),
    );
  });

  it('keeps an organization whose billing state is unknown (fails open)', async () => {
    useSharedContainersStore.setState({
      organizations: [ORG, OTHER_ORG],
      // Only one org has a billing entry at all. The other is unknown, which
      // must never be read as "lapsed" - a degraded account read has to keep
      // sharing visible to an entitled user.
      orgBillingStates: [
        {
          organizationId: OTHER_ORG.id,
          organizationName: OTHER_ORG.name,
          teamsEntitled: true,
        },
      ],
    });

    await renderModal();

    const picker = q('shared-container-invite-modal-organization');
    expect(picker).not.toBeNull();
    expect(
      Array.from(
        picker?.querySelectorAll<HTMLElement>(
          '[data-testid^="shared-container-invite-modal-organization-option-"]',
        ) ?? [],
      ).map((option) => option.dataset.testid),
    ).toEqual([
      `shared-container-invite-modal-organization-option-${ORG.id}`,
      `shared-container-invite-modal-organization-option-${OTHER_ORG.id}`,
    ]);
  });

  it('renders a single upgrade state when every organization has lapsed', async () => {
    useSharedContainersStore.setState({
      organizations: [ORG, OTHER_ORG],
      orgBillingStates: [
        {
          organizationId: ORG.id,
          organizationName: ORG.name,
          teamsEntitled: false,
        },
        {
          organizationId: OTHER_ORG.id,
          organizationName: OTHER_ORG.name,
          teamsEntitled: false,
        },
      ],
    });

    await renderModal();

    const blocked = q('shared-container-invite-orgs-ineligible');
    expect(blocked).not.toBeNull();
    // Names the orgs and points at who can fix it, per the ShareSetupCta
    // honesty rule - it must not promise an action this user can perform.
    expect(blocked?.textContent).toContain('Acme');
    expect(blocked?.textContent).toContain('Globex');
    expect(blocked?.textContent).toContain('organization admin');
    // No picker, no tabs, no search: none of them can lead anywhere.
    expect(q('shared-container-invite-modal-organization')).toBeNull();
    expect(q('shared-container-invite-modal-tab-invite')).toBeNull();
    expect(q('shared-container-invite-modal-tab-recipients')).toBeNull();
    expect(q('shared-container-invite-modal-member-picker')).toBeNull();
  });

  // ---------------------------------------------------------------------
  // CAN-2551: the three distinct "nobody to invite" states.
  // ---------------------------------------------------------------------

  it('says everyone already has access, and hides the search box', async () => {
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    // Every member already holds a grant, so nothing is selectable.
    listRecipients.mockResolvedValue({
      recipients: [
        grant('grant-a', 'user-a', 'Ada'),
        grant('grant-b', 'user-b', 'Grace'),
      ],
      nextCursor: null,
    });

    await renderModal();

    // The default member mock returns two members, well under the server's
    // page cap, so this page really is the whole organization and the claim
    // is safe to make.
    const empty = q('shared-container-invite-modal-empty-everyone-has-access');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('Everyone in Acme already has access');
    // The search box is what made this screen useless: a query cannot change
    // this outcome, so it is gone entirely.
    expect(q('shared-container-invite-modal-member-picker')).toBeNull();
    // The other two states must not also be claiming the screen.
    expect(q('shared-container-invite-modal-empty-only-member')).toBeNull();
    expect(q('shared-container-invite-modal-empty-no-match')).toBeNull();
  });

  it('says you are the only member, and offers the org members page', async () => {
    searchMembers.mockResolvedValue({ members: [] });
    const openAuthenticatedPortalPage = jest.fn().mockResolvedValue(true);
    Object.assign(window.api, { openAuthenticatedPortalPage });

    await renderModal();

    const empty = q('shared-container-invite-modal-empty-only-member');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("You're the only person in Acme");
    expect(q('shared-container-invite-modal-member-picker')).toBeNull();

    const cta = q('shared-container-invite-modal-manage-members');
    // Labeled for the page it opens, not a permission the desktop cannot know
    // this user holds.
    expect(cta?.textContent).toContain('Manage members in Acme');
    await act(async () => {
      cta?.click();
      await Promise.resolve();
    });
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      '/organization/org-1/members',
    );
  });

  it('keeps the members button and says so when the handoff fails', async () => {
    searchMembers.mockResolvedValue({ members: [] });
    // A failed magic-link mint must not strand the user on a dead click.
    const openAuthenticatedPortalPage = jest.fn().mockResolvedValue(false);
    Object.assign(window.api, { openAuthenticatedPortalPage });

    await renderModal();

    await act(async () => {
      q('shared-container-invite-modal-manage-members')?.click();
      await Promise.resolve();
    });

    expect(q('shared-container-invite-modal-manage-members')).not.toBeNull();
    expect(
      q('shared-container-invite-modal-empty-only-member')?.textContent,
    ).toContain('Could not open that page');
  });

  it('blames the query, not the organization, when a search finds nobody', async () => {
    await renderModal();

    searchMembers.mockResolvedValue({ members: [] });
    const search = document.querySelector(
      '[data-testid="shared-container-invite-modal-member-picker"] input',
    ) as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(search, 'zzz');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });

    expect(
      q('shared-container-invite-modal-empty-no-match')?.textContent,
    ).toContain('No teammates match');
    // The echoed query may be a person's name: only it is blocked from replay.
    const heading = q(
      'shared-container-invite-modal-empty-no-match',
    )?.querySelector('h3');
    expect(heading?.textContent).toBe('No teammates match \u201Czzz\u201D.');
    expect(outermostReplayBlock(heading)).toBeNull();
    expect(
      Array.from(
        heading?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? [],
        (block) => block.textContent,
      ),
    ).toEqual(['zzz']);
    // The search box stays: editing the query is exactly the way out of this
    // state, unlike the other two.
    expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    expect(q('shared-container-invite-modal-empty-only-member')).toBeNull();
  });

  it('keeps the search box when a capped page of members all hold grants', async () => {
    // A page returned at the server's ceiling says nothing about the members
    // it did not return. Claiming "everyone already has access" here - and
    // removing the search box with it - strands the owner with no way to
    // reach member 51 in an organization larger than one page.
    const cappedPage = Array.from(
      { length: MAX_SHARED_CONTAINER_MEMBER_SEARCH_LIMIT },
      (_unused, index) => ({
        userId: `user-${String(index)}`,
        name: `Member ${String(index)}`,
      }),
    );
    searchMembers.mockResolvedValue({ members: cappedPage });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    // Every member the page returned already holds a grant.
    listRecipients.mockResolvedValue({
      recipients: cappedPage.map((member, index) =>
        grant(`grant-${String(index)}`, member.userId, member.name),
      ),
      nextCursor: null,
    });

    await renderModal();

    expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    expect(
      q('shared-container-invite-modal-empty-everyone-has-access'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      'Everyone in Acme already has access',
    );
    // ...and the picker says why it is empty instead of sitting on a stale
    // "Loading teammates…" label.
    const cappedEmpty = q(
      'shared-container-invite-modal-empty-search-for-more',
    );
    expect(cappedEmpty?.textContent).toContain(
      'Everyone in this list already has access.',
    );
    expect(cappedEmpty?.textContent).toContain('Search by name');
    // The cap is only knowable because the renderer asks for it explicitly.
    expect(searchMembers).toHaveBeenCalledWith({
      organizationId: 'org-1',
      query: undefined,
      limit: MAX_SHARED_CONTAINER_MEMBER_SEARCH_LIMIT,
    });
  });

  // ---------------------------------------------------------------------
  // CAN-2551 follow-up: the scope panel only where it is actionable.
  // ---------------------------------------------------------------------

  it('drops the scope panel when everyone already has access', async () => {
    // Nothing on this screen can lead to a share, so a scope decision for it
    // is noise over the dead end.
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [
        grant('grant-a', 'user-a', 'Ada'),
        grant('grant-b', 'user-b', 'Grace'),
      ],
      nextCursor: null,
    });

    await renderModal();

    expect(
      q('shared-container-invite-modal-empty-everyone-has-access'),
    ).not.toBeNull();
    // The one scope panel moves below the recipient list instead of vanishing.
    expect(q('shared-container-invite-modal-file-review')).not.toBeNull();
    expect(
      q('shared-container-invite-modal-scope-details-toggle'),
    ).not.toBeNull();
  });

  it('drops the scope panel when you are the only member', async () => {
    searchMembers.mockResolvedValue({ members: [] });

    await renderModal();

    expect(q('shared-container-invite-modal-empty-only-member')).not.toBeNull();
    expect(q('shared-container-invite-modal-file-review')).toBeNull();
  });

  it('keeps the scope panel when a query is what found nobody', async () => {
    // The gate is "is there anybody to invite", not "is the list empty right
    // now". Clearing this query reaches invitable members again, so the scope
    // decision is still live and must not flicker away with the results.
    await renderModal();

    searchMembers.mockResolvedValue({ members: [] });
    const search = document.querySelector(
      '[data-testid="shared-container-invite-modal-member-picker"] input',
    ) as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(search, 'zzz');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });

    expect(q('shared-container-invite-modal-empty-no-match')).not.toBeNull();
    expect(q('shared-container-invite-modal-file-review')).not.toBeNull();
  });

  it('keeps the one scope panel with the picker while somebody remains invitable', async () => {
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 1,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();
    // People with access is always visible below the invite controls.

    const recipientsPane = q('shared-container-invite-modal-recipients');
    const panel = q('shared-container-invite-modal-file-review');
    expect(panel).not.toBeNull();
    expect(recipientsPane?.contains(panel)).toBe(false);
    expect(q('shared-container-invite-form')?.contains(panel)).toBe(true);
    // Same progressive-disclosure boundary as the invite pane.
    expect(q('shared-container-invite-modal-scope-details-body')).toBeNull();
    expect(q('shared-container-invite-modal-scope-summary')).toBeNull();
    await expandScopeDetails();
    expect(q('shared-container-invite-modal-scope-summary')?.textContent).toBe(
      "Sharing this project's code, 3 chats, 1 plan, 2 attachments, 1 of 1 file not in git, 4 uncommitted changes.",
    );
    expect(q('shared-container-invite-modal-disclosure')).not.toBeNull();
  });

  it('hides People with access until a container or recipient exists', async () => {
    await renderModal();
    // People with access is always visible below the invite controls.

    expect(q('shared-container-invite-people')).toBeNull();
  });

  it('paints the members handoff with a real foreground color', async () => {
    // The regression: `bg-fg-primary` + `text-base` rendered a solid black
    // slab with an invisible label. `text-base` is Tailwind's font-size
    // utility, not a color, so the label inherited `fg-primary` onto a
    // `fg-primary` background.
    searchMembers.mockResolvedValue({ members: [] });

    await renderModal();

    const cta = q('shared-container-invite-modal-manage-members');
    const className = cta?.className ?? '';
    expect(className).toContain('fg-emphasis');
    expect(className).not.toContain('text-base');
    expect(className).not.toContain('bg-fg-primary');
  });

  it('renders no empty paragraphs in the setup-CTA refusal', async () => {
    // The setup CTA supplies its own copy through `children`, so the blocked
    // state must not reserve a title/description slot it was never given.
    checkEligibility.mockResolvedValue({
      eligible: false,
      reason: 'sync-disabled',
    });
    await renderModal();

    const blocked = q('shared-container-invite-setup');
    expect(blocked).not.toBeNull();
    const emptyParagraphs = Array.from(
      blocked?.querySelectorAll('p') ?? [],
    ).filter((paragraph) => (paragraph.textContent ?? '').trim() === '');
    expect(emptyParagraphs).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // CAN-2551: progressive disclosure, and the blocker boundary.
  // ---------------------------------------------------------------------

  it('collapses the summary and every opt-out behind Advanced, with no card', async () => {
    await renderModal();

    const toggle = q('shared-container-invite-modal-scope-details-toggle');
    expect(toggle?.textContent).toBe('Advanced');
    // Low profile: a secondary text toggle, not a bordered card.
    expect(toggle?.className).toContain('text-xs');
    expect(toggle?.className).toContain('fg-secondary');
    expect(
      q('shared-container-invite-modal-file-review')?.className,
    ).not.toContain('border');
    expect(q('shared-container-invite-modal-scope-summary')).toBeNull();
    expect(q('shared-container-invite-modal-scope-details-body')).toBeNull();
    expect(q('shared-container-invite-modal-disclosure')).toBeNull();

    await expandScopeDetails();
    expect(toggle?.textContent).toBe('Advanced');
    const body = q('shared-container-invite-modal-scope-details-body');
    expect(body).not.toBeNull();
    // The summary opens the body, followed by the disclosure.
    expect(body?.firstElementChild?.getAttribute('data-testid')).toBe(
      'shared-container-invite-modal-scope-summary',
    );
    expect(q('shared-container-invite-modal-scope-summary')?.textContent).toBe(
      "Sharing this project's code, 3 chats, 1 plan, 2 attachments, 1 of 1 file not in git, 4 uncommitted changes.",
    );
    expect(
      q('shared-container-invite-modal-disclosure')?.textContent,
    ).toContain('files not in git, apart from any you untick below');
  });

  it('keeps a publish-blocking budget refusal outside the collapsed details', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      artifactBudget: { used: 240, limit: 200 },
    });

    await renderModal();

    // Still collapsed...
    expect(q('shared-container-invite-modal-scope-details-body')).toBeNull();
    // ...but the thing that stops the share is visible anyway. Hiding it would
    // let the owner click Invite believing the share will publish.
    const budget = q('shared-container-invite-modal-artifact-budget');
    expect(budget).not.toBeNull();
    expect(
      budget?.closest(
        '[data-testid="shared-container-invite-modal-scope-details-body"]',
      ),
    ).toBeNull();
  });

  it('reports withheld files informationally, never as a destructive error', async () => {
    preview.mockResolvedValue({ ...PREVIEW, withheldFileCount: 2 });

    await renderModal();
    await expandScopeDetails();

    const withheld = q('shared-container-invite-modal-withheld-files');
    // Withholding is Canopy working correctly, so it must not wear the color
    // reserved for states that actually stop the share.
    expect(withheld?.className).toContain('fg-secondary');
    expect(withheld?.className).not.toContain('fg-destructive');
    expect(withheld?.className).not.toContain('fg-warning');
    expect(withheld?.getAttribute('role')).toBe('status');
  });

  // ---------------------------------------------------------------------
  // CAN-2551: publish status precedence (the "Not yet published" bug).
  // ---------------------------------------------------------------------

  it('reports a server-published container with no local record as shared', async () => {
    // The regression: publish state is persisted only under the runtime-mode
    // split data dir, so a share published from another build has no local
    // record here. Absent local state is not evidence of anything.
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 3,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });

    // People with access, and its publish status, render once somebody
    // holds a grant.
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();

    const publishState = q('shared-container-invite-modal-publication-state');
    expect(publishState?.dataset.publishStatus).toBe('published');
    expect(publishState?.textContent).toContain('Up to date');
    expect(publishState?.textContent).not.toMatch(/not yet published/i);
    // The revision is a detail, not the headline.
    expect(publishState?.getAttribute('title')).toBe('Revision 3');
  });

  it('asserts nothing when neither the server nor a local record knows', async () => {
    // A container resolved from the anchor, but the listing carried no
    // revision the client can trust and there is no local record. Rendering
    // "Not yet published" here is the lie this replaced.
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: Number.NaN,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });

    await renderModal();
    // People with access is already rendered.

    expect(q('shared-container-invite-modal-publication-state')).toBeNull();
  });

  it('falls back to the account-level owner listing while its own lookup fails', async () => {
    // CAN-2551 §8: the org-wide owner listing hydrated for the sidebar badge
    // is the same server truth this modal reconciles against, so one listing
    // serves both. When this modal's own lookup cannot answer - offline, or
    // still in flight - the hydrated target is the only server record left,
    // and it is exactly the "published from another build" case.
    useSharedContainersStore.setState({
      sharedTargets: {
        [publicationStateKey('p1', 'w1', 'org-1')]: {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          containerId: 'container-1',
          revision: 5,
        },
      },
    });
    listSharedByMe.mockRejectedValue(new Error('offline'));

    await renderModal();
    // People with access is already rendered.

    const publishState = q('shared-container-invite-modal-publication-state');
    expect(publishState?.dataset.publishStatus).toBe('published');
    expect(publishState?.textContent).not.toMatch(/not yet published/i);
  });

  it('drops a stale hydrated target once the server says there is no container', async () => {
    // The badge index is a cache. A definite "no container in this
    // organization" retires it rather than letting it assert a publish state
    // for something the server says does not exist.
    useSharedContainersStore.setState({
      sharedTargets: {
        [publicationStateKey('p1', 'w1', 'org-1')]: {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          containerId: 'container-1',
          revision: 5,
        },
      },
    });
    listSharedByMe.mockResolvedValue({ containers: [], nextCursor: null });

    await renderModal();
    // People with access is already rendered.

    expect(q('shared-container-invite-modal-publication-state')).toBeNull();
  });

  it('lets a live local publish attempt outrank the last committed revision', async () => {
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 3,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    useSharedContainersStore.setState({
      publicationStates: {
        'p1:w1:org-1': {
          projectId: 'p1',
          worktreeId: 'w1',
          organizationId: 'org-1',
          status: 'publishing',
          updatedAt: '',
        },
      },
    });

    // People with access, and its publish status, render once somebody
    // holds a grant.
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();

    const publishState = q('shared-container-invite-modal-publication-state');
    // An attempt happening on this machine right now is newer than anything
    // the last committed revision can say.
    expect(publishState?.dataset.publishStatus).toBe('publishing');
    expect(publishState?.textContent).toContain('Publishing');
  });

  it('forgets the sidebar shared target when the last recipient is revoked', async () => {
    // CAN-2551: revoking the last grant removes the container's last grant, so
    // the server drops it from the owner listing immediately
    // (`listSharedByMe` filters on `grants: { some: {} }`). That listing is
    // only re-fanned at init and on account change, so the revoke itself has
    // to retire the cached entry or the sidebar's "shared with teammates"
    // badge outlives a full revoke until restart.
    useSharedContainersStore.getState().recordSharedTarget({
      projectId: 'p1',
      worktreeId: 'w1',
      organizationId: 'org-1',
      containerId: 'container-1',
      revision: 2,
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 2,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [grant('grant-a', 'user-a', 'Ada')],
      nextCursor: null,
    });

    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });
    // People with access is always visible below the invite controls.
    await act(async () => {
      (
        q('shared-container-invite-modal-revoke-user-a') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    await act(async () => {
      const confirmation = q(
        'shared-container-invite-modal-revoke-confirmation',
      );
      Array.from(
        confirmation?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      )
        .find((button) => button.textContent?.includes('Remove access'))
        ?.click();
      await Promise.resolve();
    });

    expect(revokeRecipient).toHaveBeenCalledTimes(1);
    const state = useSharedContainersStore.getState();
    expect(
      state.sharedWorktrees[sharedWorktreeKey('p1', 'w1')],
    ).toBeUndefined();
    expect(
      state.sharedTargets[publicationStateKey('p1', 'w1', 'org-1')],
    ).toBeUndefined();
  });

  it('keeps the sidebar shared target when other recipients remain', async () => {
    // Pins the guard itself, not just the happy path: the container still has
    // a grant, so the server still returns it and the badge is still true.
    useSharedContainersStore.getState().recordSharedTarget({
      projectId: 'p1',
      worktreeId: 'w1',
      organizationId: 'org-1',
      containerId: 'container-1',
      revision: 2,
    });
    listSharedByMe.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'me',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 2,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    listRecipients.mockResolvedValue({
      recipients: [
        grant('grant-a', 'user-a', 'Ada'),
        grant('grant-b', 'user-b', 'Grace'),
      ],
      nextCursor: null,
    });

    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });
    // People with access is always visible below the invite controls.
    await act(async () => {
      (
        q('shared-container-invite-modal-revoke-user-a') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    await act(async () => {
      const confirmation = q(
        'shared-container-invite-modal-revoke-confirmation',
      );
      Array.from(
        confirmation?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      )
        .find((button) => button.textContent?.includes('Remove access'))
        ?.click();
      await Promise.resolve();
    });

    expect(revokeRecipient).toHaveBeenCalledTimes(1);
    const state = useSharedContainersStore.getState();
    expect(
      state.sharedWorktrees[sharedWorktreeKey('p1', 'w1')]?.containerId,
    ).toBe('container-1');
    expect(
      state.sharedTargets[publicationStateKey('p1', 'w1', 'org-1')],
    ).toBeDefined();
  });

  it('retires the sidebar shared target when the server reports no container', async () => {
    // A container revoked from another device (or from the web) leaves this
    // cache asserting a share the server has already dropped. The modal's own
    // definite "no container here" is the same server truth the owner listing
    // would have reported, so it retires the entry rather than only hiding it
    // locally.
    useSharedContainersStore.getState().recordSharedTarget({
      projectId: 'p1',
      worktreeId: 'w1',
      organizationId: 'org-1',
      containerId: 'container-1',
      revision: 5,
    });
    listSharedByMe.mockResolvedValue({ containers: [], nextCursor: null });

    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });

    const state = useSharedContainersStore.getState();
    expect(
      state.sharedWorktrees[sharedWorktreeKey('p1', 'w1')],
    ).toBeUndefined();
    expect(
      state.sharedTargets[publicationStateKey('p1', 'w1', 'org-1')],
    ).toBeUndefined();
  });

  it('keeps the sidebar shared target when the container lookup fails', async () => {
    // A failed lookup is not evidence the share is gone. Clearing the badge on
    // a network blip would be a worse bug than the stale badge this retirement
    // path exists to prevent.
    useSharedContainersStore.getState().recordSharedTarget({
      projectId: 'p1',
      worktreeId: 'w1',
      organizationId: 'org-1',
      containerId: 'container-1',
      revision: 5,
    });
    listSharedByMe.mockRejectedValue(new Error('offline'));

    await renderModal();
    await act(async () => {
      await Promise.resolve();
    });

    const state = useSharedContainersStore.getState();
    expect(state.sharedWorktrees[sharedWorktreeKey('p1', 'w1')]).toEqual({
      projectId: 'p1',
      worktreeId: 'w1',
      organizationId: 'org-1',
      containerId: 'container-1',
      revision: 5,
    });
    expect(
      state.sharedTargets[publicationStateKey('p1', 'w1', 'org-1')],
    ).toBeDefined();
  });
  /**
   * Publisher-side run sharing (CAN-2831).
   *
   * The whole block is gated on the shared-containers flag AND macOS, because
   * that is where the recipient half works. There is no separate run flag:
   * running ships with the viewer. `window.platform` is undefined in jsdom,
   * which is why every other test in this file sees no run controls at all.
   */
  describe('run sharing', () => {
    const originalPlatform = window.platform;

    function enableRunSharing(): void {
      const snapshot = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...snapshot,
          values: {
            ...snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]: true,
          },
        },
      });
    }

    afterEach(() => {
      Object.defineProperty(window, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    function setPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(window, 'platform', {
        value: platform,
        configurable: true,
      });
    }

    it('hides run sharing on a platform the recipient half does not support', async () => {
      enableRunSharing();
      setPlatform('win32');

      await renderModal();
      await expandScopeDetails();

      expect(q('shared-container-invite-modal-run-scope')).toBeNull();
    });

    /** Echo a saved scope back the way main normalizes it. */
    function echoRunScope(): void {
      saveFileScope.mockImplementation(
        (request: SaveSharedContainerFileScopeRequest) =>
          Promise.resolve({
            fileScope: {
              includedPaths: request.includedPaths,
              ...(request.runSharingDisabled === true
                ? { runSharingDisabled: true }
                : {}),
              ...(request.excludedRunScripts &&
              request.excludedRunScripts.length > 0
                ? { excludedRunScripts: request.excludedRunScripts }
                : {}),
            },
          }),
      );
    }

    function runScriptCheckbox(name: string): HTMLInputElement {
      return q(
        `shared-container-invite-modal-run-scope-${name}`,
      ) as HTMLInputElement;
    }

    it('is on by default with every script ticked, and persists opting out', async () => {
      enableRunSharing();
      setPlatform('darwin');
      echoRunScope();

      await renderModal();
      await expandScopeDetails();

      const toggle = q(
        'shared-container-invite-modal-run-scope-toggle',
      ) as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      expect(runScriptCheckbox('setup').checked).toBe(true);
      expect(runScriptCheckbox('launch').checked).toBe(true);
      expect(runScriptCheckbox('Launch UD Mobile (Simulator)').checked).toBe(
        true,
      );
      expect(
        q('shared-container-invite-modal-run-scope')?.textContent,
      ).toContain('3 of 8 selected');

      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });

      expect(saveFileScope).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runSharingDisabled: true,
          excludedRunScripts: [],
        }),
      );
    });

    it('offers every resolved script, not just the lifecycle pair', async () => {
      enableRunSharing();
      setPlatform('darwin');

      await renderModal();
      await expandScopeDetails();

      // A custom `canopy.json` key, carried verbatim and shown through the
      // same display-name helper the Scripts panel uses.
      const custom = q(
        'shared-container-invite-modal-run-scope-Launch UD Mobile (Simulator)',
      );
      expect(custom).not.toBeNull();
      // Labelled through the same helper the Scripts panel uses, so the
      // publisher reads the same title in both places. The raw key stays the
      // wire name; only the label is prettified.
      expect(custom?.parentElement?.textContent).toContain(
        'Launch UD Mobile Simulator',
      );
      expect(q('shared-container-invite-modal-run-scope-setup')).not.toBeNull();
      expect(
        q('shared-container-invite-modal-run-scope-launch'),
      ).not.toBeNull();
    });

    it('says so when the project resolves no scripts at all', async () => {
      enableRunSharing();
      setPlatform('darwin');
      preview.mockResolvedValue({ ...PREVIEW, availableRunScripts: [] });

      await renderModal();
      await expandScopeDetails();

      expect(
        q('shared-container-invite-modal-run-scope-empty')?.textContent,
      ).toContain('no scripts to share yet');
    });

    it('ticks the first eight scripts, promotes the next on an untick, and keeps unticks while off', async () => {
      enableRunSharing();
      setPlatform('darwin');
      preview.mockResolvedValue({
        ...PREVIEW,
        // Lifecycle scripts lead, then the rest alphabetically: `g` is ninth.
        availableRunScripts: [
          'g',
          'f',
          'e',
          'd',
          'c',
          'b',
          'a',
          'launch',
          'setup',
        ],
      });
      echoRunScope();

      await renderModal();
      await expandScopeDetails();

      expect(runScriptCheckbox('setup').checked).toBe(true);
      expect(runScriptCheckbox('launch').checked).toBe(true);
      expect(runScriptCheckbox('f').checked).toBe(true);
      // The ninth is past the cap, so it stays unticked and disabled.
      expect(runScriptCheckbox('g').checked).toBe(false);
      expect(runScriptCheckbox('g').disabled).toBe(true);

      await act(async () => {
        runScriptCheckbox('launch').click();
        await Promise.resolve();
      });

      expect(saveFileScope).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runSharingDisabled: false,
          excludedRunScripts: ['launch'],
        }),
      );
      expect(runScriptCheckbox('launch').checked).toBe(false);
      // Unticking frees a slot, so the ninth script moves in.
      expect(runScriptCheckbox('g').checked).toBe(true);

      // Turning sharing off keeps the owner's unticks, so turning it back on
      // restores them rather than resetting to the default.
      await act(async () => {
        q('shared-container-invite-modal-run-scope-toggle')?.click();
        await Promise.resolve();
      });
      expect(saveFileScope).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runSharingDisabled: true,
          excludedRunScripts: ['launch'],
        }),
      );
      await act(async () => {
        q('shared-container-invite-modal-run-scope-toggle')?.click();
        await Promise.resolve();
      });
      expect(saveFileScope).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runSharingDisabled: false,
          excludedRunScripts: ['launch'],
        }),
      );
      expect(runScriptCheckbox('launch').checked).toBe(false);
    });

    it('renders every derived environment name verbatim, never a count', async () => {
      enableRunSharing();
      setPlatform('darwin');
      preview.mockResolvedValue({
        ...PREVIEW,
        approvedFileScope: { includedPaths: [] },
        run: {
          commands: [
            { name: 'launch', command: 'npm run dev', repoId: 'repo-1' },
          ],
          requiredEnv: ['ACME_INTERNAL_BILLING_TOKEN', 'DATABASE_URL'],
        },
      });

      await renderModal();
      await expandScopeDetails();

      const env = q('shared-container-invite-modal-run-env');
      // A name is itself information about the codebase, and the owner is
      // agreeing to send it. Summarizing as "2 variables" would ask for
      // consent to something they were never shown.
      expect(env?.textContent).toContain('ACME_INTERNAL_BILLING_TOKEN');
      expect(env?.textContent).toContain('DATABASE_URL');
      expect(env?.textContent).not.toContain('2 ');
    });

    it('says plainly when derivation found no names', async () => {
      enableRunSharing();
      setPlatform('darwin');
      preview.mockResolvedValue({
        ...PREVIEW,
        approvedFileScope: { includedPaths: [] },
        run: {
          commands: [
            { name: 'launch', command: 'go run ./cmd/api', repoId: 'repo-1' },
          ],
          requiredEnv: [],
        },
      });

      await renderModal();
      await expandScopeDetails();

      // Empty is a first-class outcome, not a promise that nothing is needed:
      // a Go or Python project configured from a YAML/TOML sample derives no
      // names at all, and the owner must not read that as "fully covered".
      expect(q('shared-container-invite-modal-run-env')?.textContent).toContain(
        'may still need to configure the app themselves',
      );
    });

    it('flags a ticked command the publisher has no script for', async () => {
      enableRunSharing();
      setPlatform('darwin');
      preview.mockResolvedValue({
        ...PREVIEW,
        approvedFileScope: { includedPaths: [] },
        run: {
          commands: [
            { name: 'launch', command: 'npm run dev', repoId: 'repo-1' },
          ],
          requiredEnv: [],
        },
      });

      await renderModal();
      await expandScopeDetails();

      // A ticked script that resolved to no command would otherwise publish
      // silently short, and the recipient would have no way to start the app.
      expect(
        q('shared-container-invite-modal-run-scope-unresolved-setup'),
      ).not.toBeNull();
      expect(
        q('shared-container-invite-modal-run-scope-unresolved-launch'),
      ).toBeNull();
    });
  });

  describe('external sharing', () => {
    function enableExternalSharing(): void {
      const snapshot = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...snapshot,
          values: {
            ...snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]:
              true,
          },
        },
      });
    }

    async function typeEmail(value: string): Promise<void> {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="shared-container-invite-modal-email-input"]',
      );
      expect(input).not.toBeNull();
      await act(async () => {
        // React tracks the input's value; set it through the prototype so the
        // change is seen as user input.
        Reflect.set(HTMLInputElement.prototype, 'value', value, input);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
    }

    async function clickTestId(testId: string): Promise<void> {
      await act(async () => {
        q(testId)?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    const TEAM = {
      id: 'team-1',
      name: 'Platform',
      organization: ORG,
      createdAt: '',
      updatedAt: '',
    };

    beforeEach(() => {
      enableExternalSharing();
    });

    it('selects Public on its own for an account with no organization, and invites by email', async () => {
      useSharedContainersStore.setState({ organizations: [] });
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
        audiences: { team: false, organization: false, public: true },
      } satisfies SharedContainerEligibilityResponse);
      invite.mockResolvedValue({
        invited: true,
        container: {
          id: 'container-1',
          ownerUserId: 'me',
          owner: { userId: 'me', name: 'Me' },
          access: 'organization',
          worktreeId: 'server-wt-1',
          containerType: 'CODE_WORKTREE',
          revision: 0,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
        },
        grant: {
          id: 'grant-email',
          containerId: 'container-1',
          recipient: {
            kind: 'email',
            email: 'friend@example.com',
            status: 'invited',
          },
          capabilities: ['VIEW'],
          createdAt: '',
          updatedAt: '',
        },
        publicationState: {
          projectId: 'p1',
          worktreeId: 'w1',
          status: 'not-published',
          updatedAt: '',
        },
      });

      await renderModal();

      // The probe runs without an organization instead of refusing locally.
      expect(checkEligibility).toHaveBeenCalledWith({
        projectId: 'p1',
        worktreeId: 'w1',
        audience: 'public',
        containerType: 'CODE_WORKTREE',
      });
      // Public is the only usable audience, so there is nothing to choose:
      // no legend, no pills, and no hint.
      expect(q('shared-container-invite-scope')).toBeNull();
      expect(q('shared-container-invite-scope-public')).toBeNull();
      expect(q('shared-container-invite-scope-team')).toBeNull();
      expect(q('shared-container-invite-scope-hint')).toBeNull();
      // The Email field carries what Public means, under its label.
      expect(
        q('shared-container-invite-modal-email-input-description')?.textContent,
      ).toBe("Choose who to share with, and we'll email them an invite.");
      expect(q('shared-container-invite-modal-member-picker')).toBeNull();
      expect(searchMembers).not.toHaveBeenCalled();
      // A personal share has no organization to warn about.
      expect(q('shared-container-invite-modal-external-notice')).toBeNull();

      const submit = q('shared-container-invite-submit');
      expect(submit?.hasAttribute('disabled')).toBe(true);
      await typeEmail('not-an-email');
      // Still typing: the half-finished address is not an error yet.
      expect(q('shared-container-invite-modal-email-input-error')).toBeNull();
      expect(submit?.hasAttribute('disabled')).toBe(true);
      await act(async () => {
        const input = q('shared-container-invite-modal-email-input');
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.blur();
        }
        await Promise.resolve();
      });
      expect(
        q('shared-container-invite-modal-email-input-error'),
      ).not.toBeNull();
      expect(submit?.hasAttribute('disabled')).toBe(true);

      await typeEmail('Friend@Example.com');
      expect(submit?.hasAttribute('disabled')).toBe(false);
      await clickTestId('shared-container-invite-submit');

      expect(invite).toHaveBeenCalledWith({
        projectId: 'p1',
        worktreeId: 'w1',
        containerType: 'CODE_WORKTREE',
        audience: 'public',
        recipient: { kind: 'email', email: 'Friend@Example.com' },
        capabilities: ['VIEW'],
      });
      const recipients = q('shared-container-invite-modal-recipients');
      expect(recipients?.textContent).toContain('friend@example.com');
      expect(
        q('shared-container-invite-modal-invited-grant-email')?.textContent,
      ).toBe('Invited');
      // People with access is ruled off from the invite form above it.
      expect(q('shared-container-invite-people-divider')).not.toBeNull();
      expect(useGitHubStore.getState().toasts.at(-1)?.message).toBe(
        'Invited friend@example.com',
      );
      expect(
        useGitHubStore.getState().toasts.at(-1)?.meta?.blockMessageFromReplay,
      ).toBe(true);
    });

    it('keeps a failed email invite in place so Share retries it', async () => {
      useSharedContainersStore.setState({ organizations: [] });
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
        audiences: { team: false, organization: false, public: true },
      } satisfies SharedContainerEligibilityResponse);
      invite.mockRejectedValueOnce(new Error('offline'));

      await renderModal();
      await typeEmail('friend@example.com');
      await clickTestId('shared-container-invite-submit');

      const input = q('shared-container-invite-modal-email-input');
      expect((input as HTMLInputElement).value).toBe('friend@example.com');
      expect(q('shared-container-invite-error')?.textContent).toContain(
        "Couldn't share the project. Try again.",
      );
      expect(q('shared-container-invite-modal')).not.toBeNull();
      expect(q('shared-container-invite-submit')?.textContent).toBe('Share');
    });

    it('offers a personal Public share when every organization has lapsed', async () => {
      useSharedContainersStore.setState({
        organizations: [ORG, OTHER_ORG],
        orgBillingStates: [
          {
            organizationId: ORG.id,
            organizationName: ORG.name,
            teamsEntitled: false,
          },
          {
            organizationId: OTHER_ORG.id,
            organizationName: OTHER_ORG.name,
            teamsEntitled: false,
          },
        ],
      });
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
        audiences: { team: false, organization: false, public: true },
        ownerFixed: false,
      } satisfies SharedContainerEligibilityResponse);

      await renderModal();

      expect(checkEligibility).toHaveBeenCalledWith({
        projectId: 'p1',
        worktreeId: 'w1',
        audience: 'public',
        containerType: 'CODE_WORKTREE',
      });
      expect(q('shared-container-invite-orgs-ineligible')).toBeNull();
      // Public is selected on its own; with one usable scope the selector
      // collapses and the Email field is the whole form.
      expect(q('shared-container-invite-scope')).toBeNull();
      expect(q('shared-container-invite-modal-email-input')).not.toBeNull();
    });

    it('disables Public with the admin hint when the organization keeps sharing inside', async () => {
      // Team and Organization both usable, so the selector still renders.
      useSharedContainersStore.setState({ teams: [TEAM] });
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
        audiences: { team: true, organization: true, public: false },
        publicBlockedReason: 'external-sharing-disabled',
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      } satisfies SharedContainerEligibilityResponse);

      await renderModal();

      expect(
        q('shared-container-invite-scope-public')?.hasAttribute('disabled'),
      ).toBe(true);
      expect(q('shared-container-invite-scope-hint')?.textContent).toContain(
        'An organization admin can allow sharing outside',
      );
      // The member audiences stay usable.
      expect(
        q('shared-container-invite-scope-organization')?.hasAttribute(
          'disabled',
        ),
      ).toBe(false);
      expect(
        q('shared-container-invite-scope-team')?.hasAttribute('disabled'),
      ).toBe(false);
    });

    it('hides the selector when the organization is the only usable audience', async () => {
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
        audiences: { team: true, organization: true, public: false },
        publicBlockedReason: 'external-sharing-disabled',
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      } satisfies SharedContainerEligibilityResponse);

      await renderModal();

      // No teams, and Public is off: only Organization is usable, so the
      // pills and the admin hint go and only its description remains.
      expect(q('shared-container-invite-scope-public')).toBeNull();
      expect(q('shared-container-invite-scope-hint')).toBeNull();
      expect(q('shared-container-invite-scope-description')?.textContent).toBe(
        'People in your organization.',
      );
      expect(q('shared-container-invite-modal-member-picker')).not.toBeNull();
    });

    it('keeps an org-owned share in its organization and warns that outsiders can view it', async () => {
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
        audiences: { team: false, organization: true, public: true },
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      } satisfies SharedContainerEligibilityResponse);

      await renderModal();
      await clickTestId('shared-container-invite-scope-public');

      expect(
        q('shared-container-invite-modal-external-notice')?.textContent,
      ).toContain('People outside Acme will be able to view this');
      await typeEmail('outside@example.com');
      await clickTestId('shared-container-invite-submit');

      expect(invite).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          audience: 'public',
          recipient: { kind: 'email', email: 'outside@example.com' },
        }),
      );
    });

    it('makes a Public share personal when nothing fixes the owner', async () => {
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
        audiences: { team: false, organization: true, public: true },
        ownerOrganizationId: 'org-1',
      } satisfies SharedContainerEligibilityResponse);
      await renderModal();
      await clickTestId('shared-container-invite-scope-public');
      await typeEmail('outside@example.com');
      await clickTestId('shared-container-invite-submit');

      expect(invite).toHaveBeenCalledWith({
        projectId: 'p1',
        worktreeId: 'w1',
        containerType: 'CODE_WORKTREE',
        audience: 'public',
        recipient: { kind: 'email', email: 'outside@example.com' },
        capabilities: ['VIEW'],
      });
    });

    it('requires an explicit team before searching the Team audience', async () => {
      useSharedContainersStore.setState({ teams: [TEAM] });
      checkEligibility.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-wt-1',
        audiences: { team: true, organization: true, public: true },
      } satisfies SharedContainerEligibilityResponse);

      await renderModal();

      expect(
        q('shared-container-invite-scope-team')?.getAttribute('aria-checked'),
      ).toBe('true');
      expect(q('shared-container-invite-modal-team')).not.toBeNull();
      expect(document.body.textContent).toContain('Choose a team.');
      expect(searchMembers).not.toHaveBeenCalled();

      await clickTestId('shared-container-invite-modal-team-option-team-1');
      await act(async () => {
        jest.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(searchMembers).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1', teamId: 'team-1' }),
      );
    });

    it('revokes an email recipient by grant id', async () => {
      listSharedByMe.mockResolvedValue({
        containers: [{ id: 'container-1', revision: 1 }],
        nextCursor: null,
      });
      listRecipients.mockResolvedValue({
        recipients: [
          {
            id: 'grant-email',
            containerId: 'container-1',
            recipient: {
              kind: 'email',
              email: 'friend@example.com',
              status: 'invited',
            },
            capabilities: ['VIEW'],
            createdAt: '',
            updatedAt: '',
          },
        ],
        nextCursor: null,
      });

      await renderModal();
      expect(q('shared-container-invite-modal-tab-recipients')).toBeNull();
      expect(
        q('shared-container-invite-modal-recipients')?.textContent,
      ).toContain('friend@example.com');
      await clickTestId('shared-container-invite-modal-revoke-grant-email');
      expect(
        q('shared-container-invite-modal-revoke-confirmation')?.textContent,
      ).toContain('Remove access for friend@example.com?');
      await act(async () => {
        const confirm = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[data-testid="shared-container-invite-modal-revoke-confirmation"] button',
          ),
        ).find((button) => button.textContent === 'Remove access');
        confirm?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(revokeRecipient).toHaveBeenCalledWith({
        containerId: 'container-1',
        grantId: 'grant-email',
        organizationId: 'org-1',
      });
    });

    describe('link sharing', () => {
      let getLink: jest.Mock;
      let setLink: jest.Mock;
      let resetLink: jest.Mock;
      const LINK_PATH = `/share/view/${'a'.repeat(42)}A`;

      function ownedContainer(): void {
        // The owner listing only returns containers somebody holds a grant to.
        listSharedByMe.mockResolvedValue({
          containers: [{ id: 'container-1', revision: 1 }],
          nextCursor: null,
        });
        listRecipients.mockResolvedValue({
          recipients: [grant('grant-a', 'user-a', 'Ada')],
          nextCursor: null,
        });
        checkEligibility.mockResolvedValue({
          eligible: true,
          serverWorktreeExternalId: 'server-wt-1',
          audiences: { team: false, organization: true, public: true },
          link: { anyone: true, organization: true },
          ownerOrganizationId: 'org-1',
          ownerFixed: true,
        } satisfies SharedContainerEligibilityResponse);
      }

      async function chooseLinkAudience(
        option: 'off' | 'organization' | 'anyone',
      ): Promise<void> {
        await clickTestId('shared-container-invite-link-audience');
        await clickTestId(`shared-container-invite-link-option-${option}`);
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
      }

      async function confirmLinkChange(): Promise<void> {
        await clickTestId('shared-container-invite-link-confirm-action');
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
      }

      beforeEach(() => {
        getLink = jest.fn().mockResolvedValue(null);
        setLink = jest.fn(
          ({ audience }: { audience: 'ANYONE' | 'ORGANIZATION' | null }) =>
            Promise.resolve({
              link: audience ? { audience, url: LINK_PATH } : null,
            }),
        );
        resetLink = jest.fn().mockResolvedValue({
          audience: 'ANYONE',
          url: `/share/view/${'b'.repeat(42)}A`,
        });
        Object.assign(window.api, {
          getCanopyCloudBaseUrl: jest
            .fn()
            .mockResolvedValue('https://cloud.example.test/'),
        });
        Object.assign(window.api.sharedContainers, {
          getLink,
          setLink,
          resetLink,
        });
      });

      it('renders on its own and creates the first container without an invite', async () => {
        checkEligibility.mockResolvedValue({
          eligible: true,
          serverWorktreeExternalId: 'server-wt-1',
          audiences: { team: false, organization: true, public: true },
          link: { anyone: true, organization: true },
          ownerOrganizationId: 'org-1',
          ownerFixed: true,
        } satisfies SharedContainerEligibilityResponse);

        await renderModal();

        expect(q('shared-container-invite-people')).toBeNull();
        expect(q('shared-container-invite-link')).not.toBeNull();
        expect(
          q('shared-container-invite-link-audience')?.hasAttribute('disabled'),
        ).toBe(false);
        expect(getLink).not.toHaveBeenCalled();

        setLink.mockResolvedValueOnce({
          link: { audience: 'ANYONE', url: LINK_PATH },
          container: { id: 'container-1', revision: 0 },
          publicationState: { status: 'not-published' },
        });
        getLink.mockResolvedValue({ audience: 'ANYONE', url: LINK_PATH });
        await chooseLinkAudience('anyone');

        expect(setLink).toHaveBeenCalledWith({
          projectId: 'p1',
          worktreeId: 'w1',
          containerType: 'CODE_WORKTREE',
          organizationId: 'org-1',
          containerId: null,
          audience: 'ANYONE',
        });
        expect(q('shared-container-invite-copy-link')).not.toBeNull();
      });

      it('shows a link-only share publishing and asks for no Share click', async () => {
        checkEligibility.mockResolvedValue({
          eligible: true,
          serverWorktreeExternalId: 'server-wt-1',
          audiences: { team: false, organization: true, public: true },
          link: { anyone: true, organization: true },
          ownerOrganizationId: 'org-1',
          ownerFixed: true,
        } satisfies SharedContainerEligibilityResponse);
        await renderModal();
        await clickTestId('shared-container-invite-scope-public');
        // Nothing to invite yet and no link: Share is the only way forward.
        expect(q('shared-container-invite-submit')).not.toBeNull();

        setLink.mockResolvedValueOnce({
          link: { audience: 'ANYONE', url: LINK_PATH },
          container: {
            id: 'container-1',
            organizationId: 'org-1',
            ownerUserId: 'me',
            worktreeId: 'server-wt-1',
            containerType: 'CODE_WORKTREE',
            revision: 0,
            createdAt: '',
            updatedAt: '',
            capabilities: ['VIEW'],
          },
          publicationState: {
            projectId: 'p1',
            worktreeId: 'w1',
            organizationId: 'org-1',
            containerId: 'container-1',
            containerType: 'CODE_WORKTREE',
            status: 'not-published',
            updatedAt: '',
          },
        });
        getLink.mockResolvedValue({ audience: 'ANYONE', url: LINK_PATH });
        await chooseLinkAudience('anyone');
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        // The link alone is the share: its contents are on their way, and
        // no disabled Share button suggests one more step.
        expect(q('shared-container-invite-copy-link')).not.toBeNull();
        // Nobody holds a grant, so there is no People with access list to
        // show; the publish status rides on Link sharing instead.
        expect(q('shared-container-invite-people')).toBeNull();
        const status = q('shared-container-invite-modal-publication-state');
        expect(
          q('shared-container-invite-link')?.contains(status as Node),
        ).toBe(true);
        expect(status?.getAttribute('data-publish-queued')).toBe('true');
        expect(status?.textContent).toContain('Publishing');
        expect(q('shared-container-invite-submit')).toBeNull();

        // Adding someone brings Share back for the invite.
        await typeEmail('outside@example.com');
        expect(q('shared-container-invite-submit')).not.toBeNull();
      });

      it('sits below People with access and turns the link on with Copy link', async () => {
        ownedContainer();
        await renderModal();

        const people = q('shared-container-invite-people');
        const linkSection = q('shared-container-invite-link');
        if (!people || !linkSection) {
          throw new Error('People and link sections should be visible');
        }
        expect(
          people.compareDocumentPosition(linkSection) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(getLink).toHaveBeenCalledWith({ containerId: 'container-1' });
        expect(
          q('shared-container-invite-link-audience')?.getAttribute(
            'data-value',
          ),
        ).toBe('off');
        expect(q('shared-container-invite-copy-link')).toBeNull();

        await chooseLinkAudience('anyone');

        expect(setLink).toHaveBeenCalledWith({
          containerId: 'container-1',
          audience: 'ANYONE',
        });
        expect(q('shared-container-invite-link-description')?.textContent).toBe(
          'Anyone signed in who has the link can view it, including people outside Acme',
        );
        expect(q('shared-container-invite-copy-link')).not.toBeNull();
        // Link copy never borrows the invite audience's "Public" name.
        expect(q('shared-container-invite-link')?.textContent).not.toMatch(
          /public/i,
        );
      });

      it('confirms before narrowing, resetting, and turning the link off', async () => {
        ownedContainer();
        getLink.mockResolvedValue({ audience: 'ANYONE', url: LINK_PATH });
        await renderModal();

        await chooseLinkAudience('organization');
        expect(setLink).not.toHaveBeenCalled();
        expect(
          q('shared-container-invite-link-confirm')?.textContent,
        ).toContain('Limit link to Acme?');
        await confirmLinkChange();
        expect(setLink).toHaveBeenLastCalledWith({
          containerId: 'container-1',
          audience: 'ORGANIZATION',
        });
        expect(q('shared-container-invite-link-confirm')).toBeNull();

        await clickTestId('shared-container-invite-link-more');
        // Reset keeps its red tone and leads with an icon in the slot.
        expect(
          q(
            'shared-container-invite-link-reset',
          )?.firstElementChild?.querySelector('svg'),
        ).not.toBeNull();
        await clickTestId('shared-container-invite-link-reset');
        expect(resetLink).not.toHaveBeenCalled();
        expect(
          q('shared-container-invite-link-confirm')?.textContent,
        ).toContain('Reset link?');
        await confirmLinkChange();
        expect(resetLink).toHaveBeenCalledWith({ containerId: 'container-1' });

        await chooseLinkAudience('off');
        expect(
          q('shared-container-invite-link-confirm')?.textContent,
        ).toContain('Turn off link?');
        await confirmLinkChange();
        expect(setLink).toHaveBeenLastCalledWith({
          containerId: 'container-1',
          audience: null,
        });
        expect(q('shared-container-invite-copy-link')).toBeNull();
      });

      it('widens without asking', async () => {
        ownedContainer();
        getLink.mockResolvedValue({ audience: 'ORGANIZATION', url: LINK_PATH });
        await renderModal();

        await chooseLinkAudience('anyone');

        expect(q('shared-container-invite-link-confirm')).toBeNull();
        expect(setLink).toHaveBeenCalledWith({
          containerId: 'container-1',
          audience: 'ANYONE',
        });
      });

      describe('Manage sharing policy', () => {
        function policyBlocked(): void {
          ownedContainer();
          checkEligibility.mockResolvedValue({
            eligible: true,
            serverWorktreeExternalId: 'server-wt-1',
            audiences: { team: false, organization: true, public: false },
            link: { anyone: false, organization: true },
            publicBlockedReason: 'external-sharing-disabled',
            ownerOrganizationId: 'org-1',
            ownerFixed: true,
          } satisfies SharedContainerEligibilityResponse);
        }

        async function renderAs(
          role: 'OWNER' | 'ADMIN' | 'MEMBER',
          onClose: () => void = () => {},
        ): Promise<void> {
          const organization = { ...ORG, role };
          jest.mocked(window.api.loadCanopyCloudAccount).mockResolvedValue({
            hasApiKey: true,
            organizations: [organization],
          } as Awaited<ReturnType<typeof window.api.loadCanopyCloudAccount>>);
          useSharedContainersStore.setState({ organizations: [organization] });
          await act(async () => {
            await Promise.resolve();
            root.render(
              <InviteTeammateModal
                projectId="p1"
                worktreeId="w1"
                containerType="CODE_WORKTREE"
                containerName="feature/thing"
                onClose={onClose}
              />,
            );
          });
          await act(async () => {
            jest.advanceTimersByTime(400);
            await Promise.resolve();
          });
        }

        beforeEach(() => mockOpenAccountOrganizationPage.mockReset());

        it.each([
          ['settings', 1],
          ['web', 0],
        ] as const)(
          'lets an owner open the organization policies (%s closes %p times)',
          async (result, closes) => {
            mockOpenAccountOrganizationPage.mockReturnValue(result);
            policyBlocked();
            const onClose = jest.fn();
            await renderAs('OWNER', onClose);
            await clickTestId('shared-container-invite-link-manage-policy');
            expect(mockOpenAccountOrganizationPage).toHaveBeenCalledWith({
              scope: 'organization',
              organizationId: 'org-1',
              page: 'settings',
              subtab: 'policies',
            });
            expect(onClose).toHaveBeenCalledTimes(closes);
          },
        );

        it('offers a member only the admin hint', async () => {
          policyBlocked();
          await renderAs('MEMBER');
          expect(q('shared-container-invite-link-hint')).not.toBeNull();
          expect(q('shared-container-invite-link-manage-policy')).toBeNull();
        });
      });

      it('disables Anyone with the link with the admin hint when policy keeps links inside', async () => {
        ownedContainer();
        checkEligibility.mockResolvedValue({
          eligible: true,
          serverWorktreeExternalId: 'server-wt-1',
          audiences: { team: false, organization: true, public: false },
          link: { anyone: false, organization: true },
          publicBlockedReason: 'external-sharing-disabled',
          ownerOrganizationId: 'org-1',
          ownerFixed: true,
        } satisfies SharedContainerEligibilityResponse);
        await renderModal();

        expect(q('shared-container-invite-link-hint')?.textContent).toBe(
          'Links for people outside Acme are off for this organization. An organization admin can turn them on.',
        );
        await clickTestId('shared-container-invite-link-audience');
        expect(
          q('shared-container-invite-link-option-anyone')?.hasAttribute(
            'disabled',
          ),
        ).toBe(true);
        expect(
          q('shared-container-invite-link-option-organization')?.hasAttribute(
            'disabled',
          ),
        ).toBe(false);
      });

      it('tags recipients who joined with the link', async () => {
        ownedContainer();
        listRecipients.mockResolvedValue({
          recipients: [
            { ...grant('grant-link', 'user-l', 'Lin'), via: 'link' },
            grant('grant-a', 'user-a', 'Ada'),
          ],
          nextCursor: null,
        });
        await renderModal();

        expect(
          q('shared-container-invite-modal-joined-with-link-user-l')
            ?.textContent,
        ).toBe('Joined with link');
        expect(
          q('shared-container-invite-modal-joined-with-link-user-a'),
        ).toBeNull();
        expect(q('shared-container-invite-modal-revoke-user-l')).not.toBeNull();
      });

      it('marks a recipient who removed the share as revoke-only', async () => {
        ownedContainer();
        listRecipients.mockResolvedValue({
          recipients: [
            {
              ...grant('grant-gone', 'user-g', 'Gus'),
              dismissedAt: '2026-10-01T00:00:00.000Z',
            },
            grant('grant-a', 'user-a', 'Ada'),
          ],
          nextCursor: null,
        });
        await renderModal();

        const removed = q('shared-container-invite-modal-recipient-user-g');
        expect(
          q('shared-container-invite-modal-removed-by-recipient-user-g')
            ?.textContent,
        ).toBe('Removed by recipient');
        // No capability on a row that is a snapshot, not live access.
        expect(removed?.textContent).toBe('GusRemoved by recipientRemove');
        expect(q('shared-container-invite-modal-revoke-user-g')).not.toBeNull();
        expect(
          q('shared-container-invite-modal-removed-by-recipient-user-a'),
        ).toBeNull();
      });

      it('is absent while external sharing is off', async () => {
        const snapshot = useFeatureFlagsStore.getState().snapshot;
        useFeatureFlagsStore.setState({
          snapshot: {
            ...snapshot,
            values: {
              ...snapshot.values,
              [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]:
                false,
            },
          },
        });
        ownedContainer();
        await renderModal();

        expect(q('shared-container-invite-people')).not.toBeNull();
        expect(q('shared-container-invite-link')).toBeNull();
        expect(getLink).not.toHaveBeenCalled();
      });
    });
  });
});

/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SharedContainerLinkClaimResult,
  SharedContainerLinkLanding,
} from '@canopy/protocol/shared-containers';
import { useNavigationStore } from '@/stores/navigationStore';
import { useSharedContainersStore } from '@/stores/sharedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { SharedContainerLinkLandingModal } from '../SharedContainerLinkLandingModal';
import { outermostReplayBlock } from '@/test-utils/replay';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

jest.mock('@/lib/dismissPageLikeViewers', () => ({
  dismissPageLikeViewers: jest.fn(),
}));

const TOKEN = `${'a'.repeat(42)}A`;

const READY: SharedContainerLinkLanding = {
  state: 'ready',
  audience: 'ANYONE',
  title: 'checkout-redesign',
  containerType: 'CODE_WORKTREE',
  owner: { userId: 'owner-1', name: 'Ada' },
  organizationName: 'Acme',
  lastPublishedAt: '2026-09-27T00:00:00.000Z',
  contents: {
    repositoryCount: 2,
    repositoryNames: ['web', 'api'],
    chatCount: 3,
    fileCount: 1,
  },
  eligible: true,
  alreadyHasAccess: false,
};

const REF: SharedContainerLinkClaimResult = {
  id: 'container-1',
  organizationId: 'org-1',
  ownerUserId: 'owner-1',
  owner: { userId: 'owner-1', name: 'Ada' },
  access: 'direct',
  containerType: 'CODE_WORKTREE',
};

describe('SharedContainerLinkLandingModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resolveLink: jest.Mock;
  let claimLink: jest.Mock;
  let acceptContainer: jest.Mock;
  let loadSharedWithMe: jest.Mock;
  let workspaceContextSet: jest.Mock;
  let onClose: jest.Mock;

  beforeEach(() => {
    resolveLink = jest.fn().mockResolvedValue(READY);
    claimLink = jest.fn().mockResolvedValue(REF);
    acceptContainer = jest
      .fn()
      .mockImplementation(
        (entry: {
          containerId: string;
          organizationId?: string;
          access: 'organization' | 'direct';
        }) => {
          useSharedContainerReplicasStore.setState((state) => ({
            acceptedIds: state.acceptedIds.includes(entry.containerId)
              ? state.acceptedIds
              : [...state.acceptedIds, entry.containerId],
            viewer: {
              ...entry,
              replica: {
                status: 'nothing-published',
                containerId: entry.containerId,
                ...(entry.organizationId
                  ? { organizationId: entry.organizationId }
                  : {}),
                access: entry.access,
                containerType: 'CODE_WORKTREE',
                updatedAt: '2026-09-29T00:00:00.000Z',
              },
              openError: null,
              loading: false,
            },
          }));
          return Promise.resolve();
        },
      );
    loadSharedWithMe = jest.fn().mockResolvedValue(undefined);
    workspaceContextSet = jest.fn().mockResolvedValue({
      context: { kind: 'personal' },
      revision: 2,
      organizations: [],
    });
    onClose = jest.fn();
    useSharedContainersStore.setState({
      accountKind: 'connected',
      accountHydrated: true,
    });
    useSharedContainerReplicasStore.setState({
      entries: [],
      acceptedIds: [],
      viewer: null,
      acceptContainer,
      loadSharedWithMe,
      // The open rereads the accepted list after a claim; this bridge has no
      // `listAccepted`, and the list is not what these tests are about.
      loadAccepted: jest.fn().mockResolvedValue(undefined),
    });
    const snapshot = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
      hydrated: false,
      accountEpoch: 0,
      appliedGeneration: 0,
    });
    Object.assign(window, {
      api: {
        startCanopyCloudOAuthLogin: jest.fn().mockResolvedValue({
          status: { authenticated: true, account: {}, missingCapabilities: [] },
        }),
        sharedContainers: { resolveLink, claimLink },
        workspaceContext: {
          set: workspaceContextSet,
        },
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function q(testId: string): HTMLElement | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  async function render(): Promise<void> {
    await act(async () => {
      root.render(
        <SharedContainerLinkLandingModal token={TOKEN} onClose={onClose} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function click(testId: string): Promise<void> {
    await act(async () => {
      q(testId)?.click();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
  }

  it('summarizes the share without running anything', async () => {
    await render();

    expect(resolveLink).toHaveBeenCalledWith({ token: TOKEN });
    expect(claimLink).not.toHaveBeenCalled();
    const modal = q('shared-container-link-landing');
    expect(modal?.textContent).toContain('checkout-redesign');
    expect(modal?.textContent).toContain('Shared by Ada · Acme');
    expect(q('shared-container-link-landing-contents')?.textContent).toContain(
      '2 repositories: web, api',
    );
    expect(q('shared-container-link-landing-consent')).not.toBeNull();
    expect(q('shared-container-link-landing-open')?.textContent).toBe(
      'Accept and open',
    );
    // One primary and no Cancel (CAN-3710): the X dismisses it.
    expect(q('shared-container-link-landing-cancel')).toBeNull();
    expect(q('shared-container-link-landing-close')).toBeNull();
    // The capability never renders.
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("blocks the owner's name from session replay, not the subtitle or organization", async () => {
    await render();

    const modal = q('shared-container-link-landing');
    const subtitle = Array.from(modal?.querySelectorAll('p') ?? []).find(
      (paragraph) => paragraph.textContent === 'Shared by Ada · Acme',
    );
    expect(subtitle).toBeDefined();
    expect(outermostReplayBlock(subtitle)).toBeNull();
    const blocks = Array.from(
      subtitle?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? [],
    );
    // Only the person's name: "Shared by" and the organization stay recorded.
    expect(blocks.map((block) => block.textContent)).toEqual(['Ada']);
    expect(
      outermostReplayBlock(q('shared-container-link-landing-open')),
    ).toBeNull();
  });

  it('claims, opens the viewer, and refreshes Shared with me on Open', async () => {
    const navigate = jest.spyOn(useNavigationStore.getState(), 'navigate');
    await render();
    await click('shared-container-link-landing-open');

    expect(claimLink).toHaveBeenCalledWith({ token: TOKEN });
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('main');
    expect(acceptContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: 'container-1',
        organizationId: 'org-1',
        access: 'direct',
      }),
    );
    // Listed before the viewer opens: the store keeps a viewer only while its
    // container is listed.
    expect(loadSharedWithMe.mock.invocationCallOrder[0]).toBeLessThan(
      acceptContainer.mock.invocationCallOrder[0] ?? 0,
    );
    navigate.mockRestore();
  });

  it('opens with the listed entry hints, as the sidebar row does', async () => {
    loadSharedWithMe.mockImplementation((): Promise<void> => {
      useSharedContainerReplicasStore.setState({
        entries: [
          {
            container: {
              ...REF,
              title: 'checkout-redesign',
              revision: 1,
              createdAt: '2026-09-27T00:00:00.000Z',
              updatedAt: '2026-09-29T00:00:00.000Z',
              capabilities: ['VIEW'],
            },
            access: 'direct',
          },
        ],
      });
      return Promise.resolve();
    });
    await render();
    await click('shared-container-link-landing-open');

    expect(acceptContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: 'container-1',
        access: 'direct',
      }),
    );
    useSharedContainerReplicasStore.setState({ entries: [] });
  });

  it('reads Open when the account already has access', async () => {
    resolveLink.mockResolvedValue({
      ...READY,
      alreadyHasAccess: true,
      existingAccess: REF,
    });
    await render();
    expect(q('shared-container-link-landing-open')?.textContent).toBe('Open');
    await click('shared-container-link-landing-open');
    expect(claimLink).not.toHaveBeenCalled();
    expect(acceptContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: 'container-1',
        organizationId: 'org-1',
        access: 'direct',
      }),
    );
  });

  it('keeps the modal open with a retry when the claim fails', async () => {
    claimLink.mockRejectedValue(new Error('nope'));
    await render();
    await click('shared-container-link-landing-open');

    expect(onClose).not.toHaveBeenCalled();
    expect(acceptContainer).not.toHaveBeenCalled();
    expect(q('shared-container-link-landing-error')?.textContent).toContain(
      "Couldn't open this. Try again.",
    );
  });

  it('keeps the modal open when accepting resolves without opening the viewer', async () => {
    acceptContainer.mockResolvedValue(undefined);
    await render();
    await click('shared-container-link-landing-open');

    expect(onClose).not.toHaveBeenCalled();
    expect(q('shared-container-link-landing-error')?.textContent).toContain(
      "Couldn't open this. Try again.",
    );
  });

  it('switches to the share owning context before opening', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        status: 'ready',
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: 'org-1' },
        revision: 1,
        organizations: [],
      },
    });

    await render();
    await click('shared-container-link-landing-open');

    expect(workspaceContextSet).toHaveBeenCalledWith({
      context: { kind: 'personal' },
      expectedRevision: 1,
    });
    expect(workspaceContextSet.mock.invocationCallOrder[0]).toBeLessThan(
      acceptContainer.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('keeps the landing open when the context switch fails', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        status: 'ready',
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: 'org-1' },
        revision: 1,
        organizations: [],
      },
    });
    workspaceContextSet.mockRejectedValue(new Error('switch failed'));

    await render();
    await click('shared-container-link-landing-open');

    expect(onClose).not.toHaveBeenCalled();
    expect(acceptContainer).not.toHaveBeenCalled();
    expect(q('shared-container-link-landing-error')).not.toBeNull();
  });

  it('abandons an open when the account epoch changes during refresh', async () => {
    loadSharedWithMe.mockImplementation((): Promise<void> => {
      useWorkspaceContextStore.setState((state) => ({
        accountEpoch: state.accountEpoch + 1,
      }));
      return Promise.resolve();
    });

    await render();
    await click('shared-container-link-landing-open');

    expect(onClose).not.toHaveBeenCalled();
    expect(acceptContainer).not.toHaveBeenCalled();
    expect(q('shared-container-link-landing-error')).not.toBeNull();
  });

  it('abandons an open when the workspace context changes during refresh', async () => {
    loadSharedWithMe.mockImplementation((): Promise<void> => {
      useWorkspaceContextStore.setState((current) => ({
        state: {
          ...current.state,
          context: { kind: 'organization', organizationId: 'org-2' },
          revision: current.state.revision + 1,
        },
        appliedGeneration: current.appliedGeneration + 1,
      }));
      return Promise.resolve();
    });

    await render();
    await click('shared-container-link-landing-open');

    expect(workspaceContextSet).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(acceptContainer).not.toHaveBeenCalled();
    expect(q('shared-container-link-landing-error')).not.toBeNull();
  });

  it('does not mount a stale viewer when context changes during acceptance', async () => {
    let finishAccept: (() => void) | undefined;
    const accepting = new Promise<void>((resolve) => {
      finishAccept = resolve;
    });
    acceptContainer.mockImplementation(
      async (entry: {
        containerId: string;
        organizationId?: string;
        access: 'organization' | 'direct';
        shouldOpen?: () => boolean;
      }): Promise<void> => {
        await accepting;
        if (entry.shouldOpen?.() === false) return;
        useSharedContainerReplicasStore.setState({
          viewer: {
            ...entry,
            replica: {
              status: 'nothing-published',
              containerId: entry.containerId,
              ...(entry.organizationId
                ? { organizationId: entry.organizationId }
                : {}),
              access: entry.access,
              containerType: 'CODE_WORKTREE',
              updatedAt: '2026-09-29T00:00:00.000Z',
            },
            openError: null,
            loading: false,
          },
        });
      },
    );

    await render();
    await click('shared-container-link-landing-open');
    expect(acceptContainer).toHaveBeenCalled();

    act(() => {
      useWorkspaceContextStore.setState((current) => ({
        state: {
          ...current.state,
          context: { kind: 'organization', organizationId: 'org-2' },
          revision: current.state.revision + 1,
        },
        appliedGeneration: current.appliedGeneration + 1,
      }));
    });
    await act(async () => {
      finishAccept?.();
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });

    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(q('shared-container-link-landing-error')).not.toBeNull();
  });

  it('shows no summary or organization for a link the account cannot use', async () => {
    resolveLink.mockResolvedValue({ state: 'not-eligible' });
    await render();

    expect(q('shared-container-link-landing-not-eligible')?.textContent).toBe(
      "You don't have access to this link. Ask the person who shared it to invite you.",
    );
    expect(q('shared-container-link-landing-summary')).toBeNull();
    expect(q('shared-container-link-landing-open')).toBeNull();
    expect(q('shared-container-link-landing')?.textContent).not.toContain(
      'Acme',
    );
    // A dead end keeps a single Close.
    expect(q('shared-container-link-landing-close')?.textContent).toBe('Close');
    await click('shared-container-link-landing-close');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers Sign in and resolves nothing while signed out', async () => {
    useSharedContainersStore.setState({ accountKind: 'disconnected' });
    await render();

    expect(resolveLink).not.toHaveBeenCalled();
    expect(q('shared-container-link-landing-sign-in')).not.toBeNull();
    await click('shared-container-link-landing-sign-in-action');
    expect(window.api.startCanopyCloudOAuthLogin).toHaveBeenCalled();
  });

  it('says the link no longer works when it cannot be resolved', async () => {
    resolveLink.mockRejectedValue(new Error('404'));
    await render();

    expect(q('shared-container-link-landing-unavailable')?.textContent).toBe(
      'This link no longer works. Ask the person who shared it for a new one.',
    );
    expect(q('shared-container-link-landing-open')).toBeNull();
  });

  it('reads the account before deciding between Sign in and the summary', async () => {
    const hydrateAccount = jest.fn((): Promise<void> => {
      useSharedContainersStore.setState({
        accountHydrated: true,
        accountKind: 'connected',
      });
      return Promise.resolve();
    });
    useSharedContainersStore.setState({
      accountHydrated: false,
      accountKind: 'unknown',
      hydrateAccount,
    });
    await render();

    expect(hydrateAccount).toHaveBeenCalled();
    expect(resolveLink).toHaveBeenCalledWith({ token: TOKEN });
  });
});

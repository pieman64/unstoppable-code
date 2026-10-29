/**
 * @jest-environment jsdom
 */
import type { SharedContainerOwnedTarget } from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '../featureFlagsStore';
import {
  hydrateSharedContainersAccount,
  initializeSharedContainersStore,
  publicationStateKey,
  sharedWorktreeKey,
  useSharedContainersStore,
} from '../sharedContainersStore';

/**
 * CAN-2551: the org-wide owner listing that hydrates the sidebar "shared"
 * badge and backs the invite modal's publish-status reconciliation.
 *
 * The posture under test is fail-soft in every direction: a missing bridge, a
 * failed organization, and a truncated page all have to resolve to "fewer
 * known targets", never to a throw that could take down app initialization or
 * block a sidebar render.
 */
const ORG_A = { id: 'org-a', name: 'Acme', createdAt: '', updatedAt: '' };
const ORG_B = { id: 'org-b', name: 'Globex', createdAt: '', updatedAt: '' };

function target(
  projectId: string,
  worktreeId: string,
  organizationId: string,
  revision: number,
): SharedContainerOwnedTarget {
  return {
    projectId,
    worktreeId,
    organizationId,
    containerId: `container-${projectId}-${worktreeId}`,
    revision,
  };
}

/**
 * `hydrateSharedContainersAccount` and the flag subscription are both
 * fire-and-forget, so tests have to let the whole chain settle rather than
 * awaiting a returned promise. A macrotask turn drains every pending
 * microtask, including the `Promise.allSettled` fan-out.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function setSharedContainersFlag(enabled: boolean): void {
  const snapshot = useFeatureFlagsStore.getState().snapshot;
  useFeatureFlagsStore.setState({
    snapshot: {
      ...snapshot,
      status: 'ready',
      values: {
        ...snapshot.values,
        [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]: enabled,
      },
    },
  });
}

describe('sharedContainersStore owned targets', () => {
  afterEach(() => {
    useSharedContainersStore.getState().reset();
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    Reflect.deleteProperty(window, 'api');
  });

  it('fans the listing over every organization and indexes both ways', async () => {
    const listOwnedTargets = jest
      .fn()
      .mockImplementation(({ organizationId }: { organizationId: string }) =>
        Promise.resolve(
          organizationId === ORG_A.id
            ? { targets: [target('p1', 'w1', ORG_A.id, 3)], truncated: false }
            : { targets: [target('p2', 'w2', ORG_B.id, 0)], truncated: false },
        ),
      );
    Object.assign(window, {
      api: { sharedContainers: { listOwnedTargets } },
    });
    useSharedContainersStore.setState({ organizations: [ORG_A, ORG_B] });

    await useSharedContainersStore.getState().hydrateSharedTargets();

    const state = useSharedContainersStore.getState();
    expect(listOwnedTargets).toHaveBeenCalledTimes(2);
    // Org-keyed, for the invite modal's per-organization reconciliation.
    expect(
      state.sharedTargets[publicationStateKey('p1', 'w1', ORG_A.id)],
    ).toEqual(target('p1', 'w1', ORG_A.id, 3));
    // Org-free, for the O(1) sidebar row lookup.
    expect(state.sharedWorktrees[sharedWorktreeKey('p2', 'w2')]).toEqual(
      target('p2', 'w2', ORG_B.id, 0),
    );
    // Every org answered in full, so both indexes hold exactly one entry per
    // returned target and nothing else.
    expect(Object.keys(state.sharedTargets)).toHaveLength(2);
    expect(Object.keys(state.sharedWorktrees)).toHaveLength(2);
  });

  it('keeps the organizations that did answer when one listing fails', async () => {
    const listOwnedTargets = jest
      .fn()
      .mockImplementation(({ organizationId }: { organizationId: string }) =>
        organizationId === ORG_A.id
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({
              targets: [target('p2', 'w2', ORG_B.id, 1)],
              truncated: false,
            }),
      );
    Object.assign(window, {
      api: { sharedContainers: { listOwnedTargets } },
    });
    useSharedContainersStore.setState({ organizations: [ORG_A, ORG_B] });

    // Must not reject: a listing failure can never block app init.
    await expect(
      useSharedContainersStore.getState().hydrateSharedTargets(),
    ).resolves.toBeUndefined();

    const state = useSharedContainersStore.getState();
    expect(state.sharedWorktrees[sharedWorktreeKey('p2', 'w2')]).toBeDefined();
    // The failed org contributes nothing rather than poisoning the answer:
    // its target is simply absent, which readers treat as "unknown", not
    // "not shared", so no badge renders for it.
    expect(
      state.sharedWorktrees[sharedWorktreeKey('p1', 'w1')],
    ).toBeUndefined();
    expect(
      state.sharedTargets[publicationStateKey('p1', 'w1', ORG_A.id)],
    ).toBeUndefined();
    expect(Object.keys(state.sharedWorktrees)).toEqual([
      sharedWorktreeKey('p2', 'w2'),
    ]);
  });

  it('keeps the page it did read when paging stopped early', async () => {
    Object.assign(window, {
      api: {
        sharedContainers: {
          listOwnedTargets: jest.fn().mockResolvedValue({
            targets: [target('p1', 'w1', ORG_A.id, 2)],
            truncated: true,
          }),
        },
      },
    });
    useSharedContainersStore.setState({ organizations: [ORG_A] });

    await useSharedContainersStore.getState().hydrateSharedTargets();

    // A bounded page is still a usable partial answer: what was read is
    // indexed, and the targets past the bound are absent rather than being
    // asserted as "not shared".
    const state = useSharedContainersStore.getState();
    expect(state.sharedWorktrees[sharedWorktreeKey('p1', 'w1')]).toEqual(
      target('p1', 'w1', ORG_A.id, 2),
    );
    expect(Object.keys(state.sharedWorktrees)).toHaveLength(1);
  });

  it('resolves to an empty answer without the bridge', async () => {
    Object.assign(window, { api: { sharedContainers: {} } });
    useSharedContainersStore.setState({
      organizations: [ORG_A],
      sharedTargets: {
        [publicationStateKey('p1', 'w1', ORG_A.id)]: target(
          'p1',
          'w1',
          ORG_A.id,
          1,
        ),
      },
      sharedWorktrees: {
        [sharedWorktreeKey('p1', 'w1')]: target('p1', 'w1', ORG_A.id, 1),
      },
    });

    // Must not reject on a preload that predates the listing.
    await expect(
      useSharedContainersStore.getState().hydrateSharedTargets(),
    ).resolves.toBeUndefined();

    const state = useSharedContainersStore.getState();
    expect(state.sharedTargets).toEqual({});
    expect(state.sharedWorktrees).toEqual({});
  });

  it('adds a personal owner listing for a connected account when external sharing is on', async () => {
    const personal: SharedContainerOwnedTarget = {
      projectId: 'p3',
      worktreeId: 'w3',
      containerId: 'container-personal',
      revision: 1,
    };
    const listOwnedTargets = jest
      .fn()
      .mockImplementation(({ organizationId }: { organizationId?: string }) =>
        Promise.resolve(
          organizationId === undefined
            ? { targets: [personal], truncated: false }
            : { targets: [target('p1', 'w1', ORG_A.id, 3)], truncated: false },
        ),
      );
    Object.assign(window, {
      api: { sharedContainers: { listOwnedTargets } },
    });
    useSharedContainersStore.setState({
      accountKind: 'connected',
      organizations: [ORG_A],
    });

    await useSharedContainersStore.getState().hydrateSharedTargets();

    expect(listOwnedTargets).toHaveBeenCalledWith({});
    const state = useSharedContainersStore.getState();
    // A personal container is keyed by the personal owner segment.
    expect(
      state.sharedTargets[publicationStateKey('p3', 'w3', undefined)],
    ).toEqual(personal);
    expect(state.sharedWorktrees[sharedWorktreeKey('p3', 'w3')]).toEqual(
      personal,
    );

    // With no organization at all the personal listing still runs.
    listOwnedTargets.mockClear();
    useSharedContainersStore.setState({ organizations: [] });
    await useSharedContainersStore.getState().hydrateSharedTargets();
    expect(listOwnedTargets).toHaveBeenCalledTimes(1);
    expect(listOwnedTargets).toHaveBeenCalledWith({});
  });

  it('records a container the renderer just created', () => {
    useSharedContainersStore
      .getState()
      .recordSharedTarget(target('p9', 'w9', ORG_A.id, 0));

    const state = useSharedContainersStore.getState();
    expect(state.sharedWorktrees[sharedWorktreeKey('p9', 'w9')]?.revision).toBe(
      0,
    );
    expect(
      state.sharedTargets[publicationStateKey('p9', 'w9', ORG_A.id)],
    ).toBeDefined();
  });

  it('drops every target on reset', async () => {
    Object.assign(window, {
      api: {
        sharedContainers: {
          listOwnedTargets: jest.fn().mockResolvedValue({
            targets: [target('p1', 'w1', ORG_A.id, 1)],
            truncated: false,
          }),
        },
      },
    });
    useSharedContainersStore.setState({ organizations: [ORG_A] });
    await useSharedContainersStore.getState().hydrateSharedTargets();

    useSharedContainersStore.getState().reset();

    const state = useSharedContainersStore.getState();
    expect(state.sharedTargets).toEqual({});
    expect(state.sharedWorktrees).toEqual({});
  });

  it('forgets a target whose last recipient was revoked', () => {
    useSharedContainersStore
      .getState()
      .recordSharedTarget(target('p9', 'w9', ORG_A.id, 0));

    useSharedContainersStore
      .getState()
      .removeSharedTarget('p9', 'w9', ORG_A.id);

    const state = useSharedContainersStore.getState();
    expect(
      state.sharedTargets[publicationStateKey('p9', 'w9', ORG_A.id)],
    ).toBeUndefined();
    expect(
      state.sharedWorktrees[sharedWorktreeKey('p9', 'w9')],
    ).toBeUndefined();
  });

  it("leaves another organization's worktree entry alone on removal", () => {
    useSharedContainersStore
      .getState()
      .recordSharedTarget(target('p9', 'w9', ORG_B.id, 2));

    // Same worktree, different org: the org-keyed entry goes, but the org-free
    // badge index still belongs to ORG_B and must not be clobbered.
    useSharedContainersStore
      .getState()
      .removeSharedTarget('p9', 'w9', ORG_A.id);

    const state = useSharedContainersStore.getState();
    expect(state.sharedWorktrees[sharedWorktreeKey('p9', 'w9')]).toEqual(
      target('p9', 'w9', ORG_B.id, 2),
    );
  });

  it('keeps the known targets when every organization fails', async () => {
    const listOwnedTargets = jest.fn().mockRejectedValue(new Error('offline'));
    Object.assign(window, {
      api: { sharedContainers: { listOwnedTargets } },
    });
    const known = target('p1', 'w1', ORG_A.id, 4);
    useSharedContainersStore.setState({
      organizations: [ORG_A, ORG_B],
      sharedTargets: { [publicationStateKey('p1', 'w1', ORG_A.id)]: known },
      sharedWorktrees: { [sharedWorktreeKey('p1', 'w1')]: known },
    });

    await expect(
      useSharedContainersStore.getState().hydrateSharedTargets(),
    ).resolves.toBeUndefined();

    // Nobody answered, so this attempt learned nothing. Overwriting the maps
    // with `{}` here would clear every badge on one transient outage, which
    // is strictly worse than keeping the last facts that were actually read.
    const state = useSharedContainersStore.getState();
    expect(state.sharedWorktrees[sharedWorktreeKey('p1', 'w1')]).toEqual(known);
    expect(
      state.sharedTargets[publicationStateKey('p1', 'w1', ORG_A.id)],
    ).toEqual(known);
  });

  it('still replaces the maps when only some organizations fail', async () => {
    const listOwnedTargets = jest
      .fn()
      .mockImplementation(({ organizationId }: { organizationId: string }) =>
        organizationId === ORG_A.id
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({ targets: [], truncated: false }),
      );
    Object.assign(window, {
      api: { sharedContainers: { listOwnedTargets } },
    });
    const stale = target('p1', 'w1', ORG_B.id, 4);
    useSharedContainersStore.setState({
      organizations: [ORG_A, ORG_B],
      sharedTargets: { [publicationStateKey('p1', 'w1', ORG_B.id)]: stale },
      sharedWorktrees: { [sharedWorktreeKey('p1', 'w1')]: stale },
    });

    await useSharedContainersStore.getState().hydrateSharedTargets();

    // ORG_B answered authoritatively that it owns nothing, so its removal has
    // to land. Only a *total* failure is information-free.
    const state = useSharedContainersStore.getState();
    expect(state.sharedWorktrees).toEqual({});
    expect(state.sharedTargets).toEqual({});
  });

  it('re-fans the listing over the organizations the account read produced', async () => {
    // Pins the `hydrateAccount` -> `hydrateSharedTargets` chain. Reading the
    // account on its own would repopulate `organizations` for the new account
    // while both target maps still held the previous account's entries.
    const listOwnedTargets = jest
      .fn()
      .mockImplementation(({ organizationId }: { organizationId: string }) =>
        Promise.resolve({
          targets:
            organizationId === ORG_B.id
              ? [target('p2', 'w2', ORG_B.id, 1)]
              : [],
          truncated: false,
        }),
      );
    Object.assign(window, {
      api: {
        loadCanopyCloudAccount: jest
          .fn()
          .mockResolvedValue({ hasApiKey: true, organizations: [ORG_B] }),
        sharedContainers: { listOwnedTargets },
      },
    });
    const previousAccountTarget = target('p1', 'w1', ORG_A.id, 3);
    useSharedContainersStore.setState({
      organizations: [ORG_A],
      sharedTargets: {
        [publicationStateKey('p1', 'w1', ORG_A.id)]: previousAccountTarget,
      },
      sharedWorktrees: {
        [sharedWorktreeKey('p1', 'w1')]: previousAccountTarget,
      },
    });

    hydrateSharedContainersAccount({ refreshAfterCurrent: true });
    await settle();

    const state = useSharedContainersStore.getState();
    // Fanned over the *new* account's organizations, not the stale ones.
    expect(listOwnedTargets).toHaveBeenCalledTimes(1);
    expect(listOwnedTargets).toHaveBeenCalledWith({
      organizationId: ORG_B.id,
    });
    expect(state.sharedWorktrees[sharedWorktreeKey('p2', 'w2')]).toEqual(
      target('p2', 'w2', ORG_B.id, 1),
    );
    // The previous account's entry is gone rather than outliving the switch.
    expect(
      state.sharedWorktrees[sharedWorktreeKey('p1', 'w1')],
    ).toBeUndefined();
    expect(
      state.sharedTargets[publicationStateKey('p1', 'w1', ORG_A.id)],
    ).toBeUndefined();
  });

  it('retries the owner listing when the rollout flag turns on mid-session', async () => {
    // With the flag off the main handler answers with a *complete* empty
    // listing, so the renderer caches `{}`. A mid-session flip (LaunchDarkly
    // connecting after a boot timeout, or a live rollout toggle) reveals the
    // invite entry points, and without a retry the sidebar badge would stay
    // silently absent for the rest of the session.
    let flagEnabled = false;
    const listOwnedTargets = jest.fn().mockImplementation(() =>
      Promise.resolve({
        targets: flagEnabled ? [target('p1', 'w1', ORG_A.id, 2)] : [],
        truncated: false,
      }),
    );
    Object.assign(window, {
      api: {
        loadCanopyCloudAccount: jest
          .fn()
          .mockResolvedValue({ hasApiKey: true, organizations: [ORG_A] }),
        sharedContainers: {
          listOwnedTargets,
          onPublicationChanged: jest.fn((): (() => void) => (): void => {}),
        },
      },
    });
    setSharedContainersFlag(false);

    const teardown = initializeSharedContainersStore();
    try {
      await settle();
      expect(listOwnedTargets).toHaveBeenCalledTimes(1);
      expect(useSharedContainersStore.getState().sharedWorktrees).toEqual({});

      flagEnabled = true;
      setSharedContainersFlag(true);
      await settle();

      expect(listOwnedTargets).toHaveBeenCalledTimes(2);
      expect(
        useSharedContainersStore.getState().sharedWorktrees[
          sharedWorktreeKey('p1', 'w1')
        ],
      ).toEqual(target('p1', 'w1', ORG_A.id, 2));

      // Edge-triggered: an unrelated flag delivery, and a redundant
      // re-delivery of the same value, must not re-fan the org-wide listing.
      const snapshot = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...snapshot,
          values: {
            ...snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: false,
          },
        },
      });
      setSharedContainersFlag(true);
      await settle();
      expect(listOwnedTargets).toHaveBeenCalledTimes(2);
    } finally {
      teardown();
    }
  });

  it('stops retrying on flag changes after teardown', async () => {
    const listOwnedTargets = jest
      .fn()
      .mockResolvedValue({ targets: [], truncated: false });
    Object.assign(window, {
      api: {
        loadCanopyCloudAccount: jest
          .fn()
          .mockResolvedValue({ hasApiKey: true, organizations: [ORG_A] }),
        sharedContainers: {
          listOwnedTargets,
          onPublicationChanged: jest.fn((): (() => void) => (): void => {}),
        },
      },
    });
    setSharedContainersFlag(false);

    initializeSharedContainersStore()();
    await settle();
    const callsAtTeardown = listOwnedTargets.mock.calls.length;

    setSharedContainersFlag(true);
    await settle();

    expect(listOwnedTargets).toHaveBeenCalledTimes(callsAtTeardown);
  });
});

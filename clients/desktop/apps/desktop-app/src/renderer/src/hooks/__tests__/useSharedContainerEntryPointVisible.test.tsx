/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type { CanopyOrgBillingState } from '@canopy/protocol/canopy-server';
import type { CanopyOrganizationSummary } from '@canopy/desktop-shared/types/pipeline';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useSharedContainersStore } from '@/stores/sharedContainersStore';
import { useSharedContainerEntryPointVisible } from '../useSharedContainerEntryPointVisible';

function org(id: string, name: string): CanopyOrganizationSummary {
  return { id, name, createdAt: '', updatedAt: '' };
}

function billing(
  organizationId: string,
  organizationName: string,
  teamsEntitled: boolean,
): CanopyOrgBillingState {
  return { organizationId, organizationName, teamsEntitled };
}

function setFlags(sharedContainers: boolean, externalSharing = false): void {
  const base = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.setState({
    snapshot: {
      ...base,
      status: 'ready',
      values: {
        ...base.values,
        [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]:
          sharedContainers,
        [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]:
          externalSharing,
      },
    },
  });
}

describe('useSharedContainerEntryPointVisible', () => {
  let container: HTMLDivElement;
  let root: Root;
  const probe: { current: boolean | null } = { current: null };

  function Probe(): JSX.Element {
    probe.current = useSharedContainerEntryPointVisible();
    return <div />;
  }

  beforeEach(() => {
    probe.current = null;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.assign(window, {
      api: { loadCanopyCloudAccount: jest.fn().mockResolvedValue(null) },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(state: {
    organizations: CanopyOrganizationSummary[];
    orgBillingStates: CanopyOrgBillingState[];
    accountHydrationFailed?: boolean;
    accountKind?: 'unknown' | 'disconnected' | 'guest' | 'connected';
  }): Promise<void> {
    useSharedContainersStore.setState({
      accountHydrated: true,
      // Always written, never defaulted by omission: the singleton store
      // survives between tests, so a test that sets this would otherwise latch
      // it into every test after it.
      accountHydrationFailed: state.accountHydrationFailed ?? false,
      accountKind: state.accountKind ?? 'connected',
      organizations: state.organizations,
      orgBillingStates: state.orgBillingStates,
      publicationStates: {},
    });
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
  }

  it('is hidden when the shared-containers rollout flag is off', async () => {
    setFlags(false);
    await render({
      organizations: [org('org-1', 'Acme')],
      orgBillingStates: [billing('org-1', 'Acme', true)],
    });
    expect(probe.current).toBe(false);
  });

  it('is hidden with the flag off even when an account read fails', async () => {
    // The account-read fail-open must not resurrect a feature the flag hides.
    setFlags(false);
    const loadCanopyCloudAccount = jest
      .fn()
      .mockRejectedValue(new Error('temporary preload failure'));
    Object.assign(window, { api: { loadCanopyCloudAccount } });
    useSharedContainersStore.getState().reset();

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(probe.current).toBe(false);
  });

  it('does not hydrate the account while the rollout flag is off', async () => {
    // Every sidebar row calls this hook; a hidden entry point must not cost an
    // account read per row.
    setFlags(false);
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      organizations: [org('org-1', 'Acme')],
    });
    Object.assign(window, { api: { loadCanopyCloudAccount } });
    useSharedContainersStore.getState().reset();

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadCanopyCloudAccount).not.toHaveBeenCalled();
    expect(probe.current).toBe(false);
  });

  it('is hidden for an account that belongs to no organization', async () => {
    setFlags(true);
    await render({ organizations: [], orgBillingStates: [] });
    expect(probe.current).toBe(false);
  });

  it('is shown for a connected account with no organization when external sharing is on', async () => {
    // Public (email) sharing needs no organization: the container is owned by
    // the person.
    setFlags(true, true);
    await render({ organizations: [], orgBillingStates: [] });
    expect(probe.current).toBe(true);
  });

  it('stays hidden for a guest with no organization even with external sharing on', async () => {
    setFlags(true, true);
    await render({
      organizations: [],
      orgBillingStates: [],
      accountKind: 'guest',
    });
    expect(probe.current).toBe(false);
  });

  it('stays visible when every organization the account belongs to is billing-lapsed', async () => {
    // CAN-2551 regression guard, and the invariant `9728d7bdea` established.
    // A lapse must NOT hide this entry point: it is the only surface left for
    // revoking access that was already granted. The server keeps
    // `listSharedByMe`, `listContainerRecipients`, and `revokeContainerGrant`
    // authorized on membership rather than entitlement precisely so a lapsed
    // owner can still inspect and remove existing grants, and
    // `InviteTeammateModal` renders a dedicated management path for the
    // `blocked-by-org-billing` refusal. Hiding this would strand a departed
    // teammate's access with no UI anywhere to revoke it.
    //
    // Suppressing the recipient-side "Shared with me" section is a separate
    // concern, handled by `sharedContainerReplicasStore`'s list status.
    setFlags(true);
    await render({
      organizations: [org('org-1', 'Acme')],
      orgBillingStates: [billing('org-1', 'Acme', false)],
    });
    expect(probe.current).toBe(true);
  });

  it('is shown when an inconclusive account read leaves every organization looking lapsed', async () => {
    // `accountHydrationFailed` fails open. A degraded secure-store read keeps a
    // stale snapshot, and a transient keychain failure must never hide a paid
    // feature from an org that is actually entitled.
    setFlags(true);
    await render({
      organizations: [org('org-1', 'Acme')],
      orgBillingStates: [billing('org-1', 'Acme', false)],
      accountHydrationFailed: true,
    });
    expect(probe.current).toBe(true);
  });

  it('is shown when a lapsed organization is joined by one with no billing entry at all', async () => {
    setFlags(true);
    await render({
      organizations: [org('org-1', 'Acme'), org('org-2', 'Globex')],
      orgBillingStates: [billing('org-1', 'Acme', false)],
    });
    expect(probe.current).toBe(true);
  });

  it('is SHOWN when an organization has no billing entry at all', async () => {
    setFlags(true);
    // Pins the fail-open direction: an org with no entry (older server, parse
    // failure, pre-CAN-2311 snapshot) is unknown, NOT lapsed. Inverting this to
    // hide the menu item would break every account on an older server.
    await render({
      organizations: [org('org-1', 'Acme')],
      orgBillingStates: [],
    });
    expect(probe.current).toBe(true);
  });

  it('is shown when at least one of several organizations qualifies', async () => {
    setFlags(true);
    await render({
      organizations: [org('org-1', 'Acme'), org('org-2', 'Globex')],
      orgBillingStates: [
        billing('org-1', 'Acme', false),
        billing('org-2', 'Globex', true),
      ],
    });
    expect(probe.current).toBe(true);
  });

  it('deduplicates concurrent hydration requests from multiple rows', async () => {
    setFlags(true);
    let resolveAccount: ((value: unknown) => void) | undefined;
    const loadCanopyCloudAccount = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveAccount = resolve;
        }),
    );
    Object.assign(window, { api: { loadCanopyCloudAccount } });
    useSharedContainersStore.getState().reset();

    function TwoRows(): JSX.Element {
      useSharedContainerEntryPointVisible();
      useSharedContainerEntryPointVisible();
      return <div />;
    }
    await act(async () => {
      root.render(<TwoRows />);
      await Promise.resolve();
    });
    expect(loadCanopyCloudAccount).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveAccount?.({ organizations: [org('org-1', 'Acme')] });
      await Promise.resolve();
    });
  });

  it('fails open after an account read error and permits a later retry', async () => {
    setFlags(true);
    const loadCanopyCloudAccount = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary preload failure'))
      .mockResolvedValueOnce({ organizations: [org('org-1', 'Acme')] });
    Object.assign(window, { api: { loadCanopyCloudAccount } });
    useSharedContainersStore.getState().reset();

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(probe.current).toBe(true);

    await act(async () => {
      await useSharedContainersStore.getState().hydrateAccount();
    });
    expect(loadCanopyCloudAccount).toHaveBeenCalledTimes(2);
    expect(probe.current).toBe(true);
  });

  it('treats a resolved degraded read as inconclusive and preserves last-known-good state', async () => {
    setFlags(true);
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      read: 'error',
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      organizations: [],
      teams: [],
      storageAvailable: true,
    });
    Object.assign(window, { api: { loadCanopyCloudAccount } });
    useSharedContainersStore.getState().reset();
    useSharedContainersStore.setState({
      accountKind: 'connected',
      organizations: [org('org-1', 'Acme')],
    });

    await act(async () => {
      await useSharedContainersStore.getState().hydrateAccount();
    });

    expect(useSharedContainersStore.getState()).toMatchObject({
      accountHydrationFailed: true,
      accountKind: 'connected',
      organizations: [org('org-1', 'Acme')],
    });
  });

  it('recognizes the authoritative public signed-out shape', async () => {
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      read: 'ok',
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      organizations: [],
      teams: [],
      storageAvailable: true,
    });
    Object.assign(window, { api: { loadCanopyCloudAccount } });
    useSharedContainersStore.getState().reset();

    await act(async () => {
      await useSharedContainersStore.getState().hydrateAccount();
    });

    expect(useSharedContainersStore.getState()).toMatchObject({
      accountHydrationFailed: false,
      accountKind: 'disconnected',
      organizations: [],
    });
  });

  it('queues one fresh account read when a change lands during hydration', async () => {
    setFlags(true);
    let resolveFirst: ((value: unknown) => void) | undefined;
    const loadCanopyCloudAccount = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ organizations: [org('org-new', 'New Org')] });
    Object.assign(window, { api: { loadCanopyCloudAccount } });
    useSharedContainersStore.getState().reset();

    const first = useSharedContainersStore.getState().hydrateAccount();
    const changed = useSharedContainersStore
      .getState()
      .hydrateAccount({ refreshAfterCurrent: true });
    resolveFirst?.({ organizations: [org('org-old', 'Old Org')] });
    await act(async () => {
      await Promise.all([first, changed]);
    });

    expect(loadCanopyCloudAccount).toHaveBeenCalledTimes(2);
    expect(useSharedContainersStore.getState().organizations).toEqual([
      org('org-new', 'New Org'),
    ]);
  });
});

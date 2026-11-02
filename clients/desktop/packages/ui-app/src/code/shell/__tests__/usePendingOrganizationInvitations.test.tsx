/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { IncomingTeamInvitation } from '@canopy/protocol/settings/organization';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import {
  INVITATION_UNAVAILABLE_COPY,
  usePendingOrganizationInvitations,
  type AcceptedInvitationFollowUp,
  type PendingOrganizationInvitationsOptions,
  type SidebarContextInvitations,
} from '../usePendingOrganizationInvitations';
import {
  createFakeSettingsClient,
  type FakeSettingsClient,
} from '../../../settings/__tests__/helpers/test-settings-host';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function invitation(
  id: string,
  overrides: Partial<IncomingTeamInvitation> = {},
): IncomingTeamInvitation {
  return {
    id,
    organizationId: `org-${id}`,
    organizationName: `Org ${id}`,
    organizationTeamName: null,
    role: 'MEMBER',
    invitedByName: 'Ada',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-11-01T00:00:00.000Z',
    enforcedSettings: [],
    ...overrides,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await Promise.resolve();
  });
}

function reads(client: FakeSettingsClient): number {
  return client.calls.filter(
    (call) => call.operation === 'organization.invitations.incoming',
  ).length;
}

function writes(client: FakeSettingsClient): unknown[] {
  return client.calls
    .filter((call) => call.operation === 'organization.invitations.respond')
    .map((call) => call.input);
}

describe('usePendingOrganizationInvitations', () => {
  let container: HTMLElement;
  let root: Root;
  let latest: SidebarContextInvitations | null;
  let onAccepted: jest.Mock<
    Promise<string | null>,
    [AcceptedInvitationFollowUp]
  >;
  let onReview: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
    onAccepted = jest
      .fn<Promise<string | null>, [AcceptedInvitationFollowUp]>()
      .mockResolvedValue(null);
    onReview = jest.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Probe(
    props: Pick<
      PendingOrganizationInvitationsOptions,
      'client' | 'accountKey' | 'refreshSignal'
    >,
  ): JSX.Element | null {
    latest = usePendingOrganizationInvitations({
      ...props,
      readMemberships: () => [
        { id: 'org-known', name: 'Known', role: 'MEMBER' },
      ],
      onAccepted,
      onReview,
    });
    return null;
  }

  async function render(
    client: AccountOrganizationSettingsClient | null,
    accountKey: string | null = 'acct-1',
    refreshSignal: unknown = 0,
  ): Promise<void> {
    act(() => {
      root.render(
        <Probe
          client={client}
          accountKey={accountKey}
          refreshSignal={refreshSignal}
        />,
      );
    });
    await flush();
  }

  function state(): SidebarContextInvitations {
    if (latest === null) throw new Error('not rendered');
    return latest;
  }

  it.each([
    ['no client', null, 'acct-1'],
    ['no account', 'client', null],
  ] as const)(
    'reads nothing with %s',
    async (_label, hasClient, accountKey) => {
      const client = createFakeSettingsClient({
        'organization.invitations.incoming': () => ({
          invitations: [invitation('a')],
        }),
      });
      await render(hasClient === null ? null : client, accountKey);
      expect(client.calls).toEqual([]);
      expect(state().items).toEqual([]);
    },
  );

  it('reads on activation, on refresh, and on each host refresh signal, even when empty', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    await render(client);
    expect(reads(client)).toBe(1);
    act(() => state().refresh());
    await flush();
    expect(reads(client)).toBe(2);
    // The same account, unchanged memberships: a new signal still re-reads.
    await render(client, 'acct-1', 1);
    expect(reads(client)).toBe(3);
    // A re-render with the same signal does not.
    await render(client, 'acct-1', 1);
    expect(reads(client)).toBe(3);
  });

  it('coalesces refreshes during a read into one trailing read', async () => {
    const pendingReads: Deferred<{ invitations: IncomingTeamInvitation[] }>[] =
      [];
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => {
        const next = deferred<{ invitations: IncomingTeamInvitation[] }>();
        pendingReads.push(next);
        return next.promise;
      },
    });
    await render(client);
    act(() => {
      state().refresh();
      state().refresh();
      state().refresh();
    });
    expect(reads(client)).toBe(1);
    await act(async () => {
      pendingReads[0]?.resolve({ invitations: [invitation('old')] });
      await Promise.resolve();
    });
    await flush();
    expect(reads(client)).toBe(2);
    await act(async () => {
      pendingReads[1]?.resolve({ invitations: [invitation('new')] });
      await Promise.resolve();
    });
    await flush();
    expect(state().items.map((item) => item.id)).toEqual(['new']);
  });

  it('keeps the last list when a read fails', async () => {
    let fail = false;
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => {
        if (fail) throw new Error('offline');
        return { invitations: [invitation('a')] };
      },
    });
    await render(client);
    fail = true;
    act(() => state().refresh());
    await flush();
    expect(state().items.map((item) => item.id)).toEqual(['a']);
    expect(state().error).toBeNull();
  });

  it('hides the old list at once when the account changes and drops its late read', async () => {
    const slow = deferred<{ invitations: IncomingTeamInvitation[] }>();
    let call = 0;
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => {
        call += 1;
        if (call === 1) return { invitations: [invitation('a')] };
        if (call === 2) return slow.promise;
        return { invitations: [] };
      },
    });
    await render(client);
    expect(state().items).toHaveLength(1);
    act(() => state().refresh());
    act(() => {
      root.render(
        <Probe client={client} accountKey="acct-2" refreshSignal={0} />,
      );
    });
    expect(state().items).toEqual([]);
    await act(async () => {
      slow.resolve({ invitations: [invitation('stale')] });
      await Promise.resolve();
    });
    await flush();
    expect(state().items).toEqual([]);
  });

  it('accepts once, removes the invitation, and runs the follow-up with the pre-write memberships', async () => {
    const write = deferred<{ ok: true }>();
    let listed = [invitation('a'), invitation('b')];
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({ invitations: listed }),
      'organization.invitations.respond': () => write.promise,
    });
    await render(client);
    const [first, second] = state().items;
    if (!first || !second) throw new Error('missing invitations');
    let firstResult: Promise<unknown> = Promise.resolve();
    let duplicate: Promise<unknown> = Promise.resolve();
    let other: Promise<unknown> = Promise.resolve();
    act(() => {
      firstResult = state().accept(first);
      duplicate = state().accept(first);
      other = state().decline(second);
    });
    expect(state().pending).toEqual({ inviteId: 'a', action: 'accept' });
    await expect(duplicate).resolves.toEqual({ kind: 'cancelled' });
    await expect(other).resolves.toEqual({ kind: 'cancelled' });
    listed = [invitation('b')];
    await act(async () => {
      write.resolve({ ok: true });
      await Promise.resolve();
    });
    await expect(firstResult).resolves.toEqual({ kind: 'accepted' });
    await flush();
    expect(writes(client)).toEqual([{ inviteId: 'a', action: 'accept' }]);
    expect(state().items.map((item) => item.id)).toEqual(['b']);
    expect(state().pending).toBeNull();
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted.mock.calls[0]?.[0]).toMatchObject({
      invitation: first,
      before: [{ id: 'org-known' }],
    });
  });

  it('never restores an answered invitation from a read that started before the write landed', async () => {
    const slow = deferred<{ invitations: IncomingTeamInvitation[] }>();
    let call = 0;
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => {
        call += 1;
        if (call === 2) return slow.promise;
        return { invitations: call === 1 ? [invitation('a')] : [] };
      },
      'organization.invitations.respond': () => ({ ok: true }),
    });
    await render(client);
    act(() => state().refresh());
    const [first] = state().items;
    if (!first) throw new Error('missing invitation');
    await act(async () => {
      await state().decline(first);
    });
    await act(async () => {
      slow.resolve({ invitations: [invitation('a')] });
      await Promise.resolve();
    });
    await flush();
    expect(state().items).toEqual([]);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('removes an unavailable invitation without treating it as accepted', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({
        invitations: [invitation('a')],
      }),
      'organization.invitations.respond': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 404,
          message: 'Invitation not found',
        });
      },
    });
    await render(client);
    const [first] = state().items;
    if (!first) throw new Error('missing invitation');
    let result: unknown;
    await act(async () => {
      result = await state().accept(first);
    });
    await flush();
    expect(result).toEqual({ kind: 'unavailable' });
    expect(state().items).toEqual([]);
    expect(state().error).toEqual({
      kind: 'action',
      message: INVITATION_UNAVAILABLE_COPY,
    });
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('keeps a failed invitation with action copy and reconciles before a retry', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({
        invitations: [invitation('a')],
      }),
      'organization.invitations.respond': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 500,
          message: 'boom',
        });
      },
    });
    await render(client);
    const [first] = state().items;
    if (!first) throw new Error('missing invitation');
    let result: unknown;
    await act(async () => {
      result = await state().decline(first);
    });
    await flush();
    expect(result).toEqual({
      kind: 'failed',
      message: "Couldn't decline the invitation. Try again.",
    });
    expect(state().items.map((item) => item.id)).toEqual(['a']);
    expect(writes(client)).toHaveLength(1);
    expect(reads(client)).toBe(2);
    act(() => state().dismissError());
    expect(state().error).toBeNull();
  });

  it('reports a failed follow-up without restoring the invitation', async () => {
    onAccepted.mockResolvedValue('Could not open it.');
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({
        invitations: [invitation('a')],
      }),
      'organization.invitations.respond': () => ({ ok: true }),
    });
    await render(client);
    const [first] = state().items;
    if (!first) throw new Error('missing invitation');
    await act(async () => {
      await state().accept(first);
    });
    expect(state().error).toEqual({
      kind: 'follow-up',
      message: 'Could not open it.',
    });
    expect(state().items).toEqual([]);
    expect(writes(client)).toHaveLength(1);
  });

  it('cancels a response that lands after sign-out and aborts its follow-up', async () => {
    const write = deferred<{ ok: true }>();
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({
        invitations: [invitation('a')],
      }),
      'organization.invitations.respond': () => write.promise,
    });
    await render(client);
    const [first] = state().items;
    if (!first) throw new Error('missing invitation');
    let result: Promise<unknown> = Promise.resolve();
    act(() => {
      result = state().accept(first);
    });
    await render(client, null);
    await act(async () => {
      write.resolve({ ok: true });
      await Promise.resolve();
    });
    await expect(result).resolves.toEqual({ kind: 'cancelled' });
    expect(onAccepted).not.toHaveBeenCalled();
    expect(state().pending).toBeNull();
    expect(state().items).toEqual([]);
  });

  it('routes review to the host without a response', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    await render(client);
    act(() => state().review());
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(writes(client)).toEqual([]);
  });

  it('keeps mutations single-flight until a failed write has reconciled', async () => {
    const reconciliation = deferred<{
      invitations: IncomingTeamInvitation[];
    }>();
    let count = 0;
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () =>
        ++count === 1
          ? { invitations: [invitation('a')] }
          : reconciliation.promise,
      'organization.invitations.respond': () => {
        throw new SettingsOperationError({ code: 'uncertain' });
      },
    });
    await render(client);
    let response: Promise<unknown> = Promise.resolve();
    act(() => {
      response = state().accept(invitation('a'));
    });
    await flush();
    expect(state().pending).toEqual({ inviteId: 'a', action: 'accept' });
    await expect(state().accept(invitation('a'))).resolves.toEqual({
      kind: 'cancelled',
    });
    await act(async () => {
      reconciliation.resolve({ invitations: [] });
      await response;
    });
    expect(writes(client)).toHaveLength(1);
    expect(state().items).toEqual([]);
  });

  it('preserves an uncertain HTTP write outcome instead of suggesting an immediate retry', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({
        invitations: [invitation('a')],
      }),
      'organization.invitations.respond': () => {
        throw new SettingsOperationError({ code: 'uncertain', status: 500 });
      },
    });
    await render(client);
    await act(async () => {
      await state().accept(invitation('a'));
    });
    expect(state().error?.message).toBe(
      "Couldn't confirm that finished. Refresh to check before trying again.",
    );
  });

  it('drops late reads after client replacement and aborts a follow-up on unmount', async () => {
    const slow = deferred<{ invitations: IncomingTeamInvitation[] }>();
    const first = createFakeSettingsClient({
      'organization.invitations.incoming': () => slow.promise,
    });
    const second = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({
        invitations: [invitation('b')],
      }),
      'organization.invitations.respond': () => ({ ok: true }),
    });
    await render(first);
    await render(second);
    await act(async () => {
      slow.resolve({ invitations: [invitation('a')] });
      await Promise.resolve();
    });
    expect(state().items.map((item) => item.id)).toEqual(['b']);
    onAccepted.mockImplementation(() => new Promise(() => {}));
    let response: Promise<unknown> = Promise.resolve();
    act(() => {
      response = state().accept(invitation('b'));
    });
    await flush();
    const signal = onAccepted.mock.calls[0]?.[0].signal;
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
    await expect(response).resolves.toEqual({ kind: 'cancelled' });
  });

  it('does not revive old state when availability returns with the same account and client', async () => {
    let available = true;
    const pendingRead = deferred<{ invitations: IncomingTeamInvitation[] }>();
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () =>
        available ? { invitations: [invitation('a')] } : pendingRead.promise,
    });
    await render(client);
    expect(state().items).toHaveLength(1);
    await render(null);
    available = false;
    await render(client);
    expect(state().items).toEqual([]);
    await act(async () => {
      pendingRead.resolve({ invitations: [] });
      await Promise.resolve();
    });
    expect(state().items).toEqual([]);
  });
});

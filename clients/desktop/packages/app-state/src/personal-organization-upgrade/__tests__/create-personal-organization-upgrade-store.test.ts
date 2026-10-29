import { OrganizationOperationFailure } from '@canopy/app-core';
import type {
  OrganizationInviteResult,
  PersonalOrganizationPromotionOutcome,
  PersonalProject,
  PersonalProjectOperation,
} from '@canopy/protocol/organizations';
import {
  createBrowserUpgradeRecovery,
  createPersonalOrganizationUpgradeStore,
  type PersonalOrganizationUpgradePort,
  type PersonalOrganizationUpgradeRecord,
  type PersonalOrganizationUpgradeRecovery,
  type PersonalOrganizationUpgradeStore,
} from '../create-personal-organization-upgrade-store';

const PERSONAL_ID = '11111111-1111-4111-8111-111111111111';
const REPLACEMENT_ID = '22222222-2222-4222-8222-222222222222';

const PROJECTS: PersonalProject[] = [
  { workspaceId: 'ws-a', name: 'Alpha', kind: 'single-repo' },
  { workspaceId: 'ws-b', name: 'Beta', kind: 'multi-repo' },
];

function promotionOutcome(
  operationId: string,
): PersonalOrganizationPromotionOutcome {
  return {
    promotion: {
      organizationId: PERSONAL_ID,
      name: 'Acme',
      personalOrganizationId: REPLACEMENT_ID,
      operationId,
      alreadyUpgraded: false,
      warnings: [],
    },
    contextSwitched: true,
    warnings: [],
  };
}

function operation(
  operationId: string,
  outcomes: Record<
    string,
    PersonalProjectOperation['projects'][number]['outcome']
  >,
): PersonalProjectOperation {
  const selection = Object.keys(outcomes);
  return {
    operationId,
    accountId: 'account-1',
    organizationId: PERSONAL_ID,
    selection,
    projects: selection.map((workspaceId) => ({
      workspaceId,
      stage: outcomes[workspaceId] === 'pending' ? 'queued' : 'complete',
      outcome: outcomes[workspaceId] ?? 'pending',
    })),
    updatedAt: '2026-10-09T00:00:00.000Z',
  };
}

function memoryRecovery(): PersonalOrganizationUpgradeRecovery & {
  value: PersonalOrganizationUpgradeRecord | null;
} {
  const recovery = {
    value: null as PersonalOrganizationUpgradeRecord | null,
    read: (): PersonalOrganizationUpgradeRecord | null => recovery.value,
    write: (record: PersonalOrganizationUpgradeRecord | null): void => {
      recovery.value = record;
    },
  };
  return recovery;
}

function makePort(
  overrides: Partial<PersonalOrganizationUpgradePort> = {},
): jest.Mocked<PersonalOrganizationUpgradePort> {
  return {
    canPromote: true,
    canInvite: true,
    canBringProjects: true,
    promote: jest.fn((request) =>
      Promise.resolve(promotionOutcome(request.operationId)),
    ),
    invite: jest.fn(() =>
      Promise.resolve({
        status: 'sent' as const,
        inviteId: '33333333-3333-4333-8333-333333333333',
      }),
    ),
    listProjects: jest.fn(() => Promise.resolve(PROJECTS)),
    convert: jest.fn((request) =>
      Promise.resolve(
        operation(
          request.operationId,
          Object.fromEntries(request.workspaceIds.map((id) => [id, 'moved'])),
        ),
      ),
    ),
    status: jest.fn(() => Promise.resolve(null)),
    ...overrides,
  } as jest.Mocked<PersonalOrganizationUpgradePort>;
}

let ids = 0;
function makeStore(
  port: PersonalOrganizationUpgradePort,
  extra: Partial<
    Parameters<typeof createPersonalOrganizationUpgradeStore>[0]
  > = {},
): PersonalOrganizationUpgradeStore {
  return createPersonalOrganizationUpgradeStore({
    port,
    accountKey: 'account-1',
    personalOrganizationId: PERSONAL_ID,
    createId: () => {
      ids += 1;
      return `0000000${String(ids)}-0000-4000-8000-000000000000`.slice(-36);
    },
    schedule: () => (): void => {},
    ...extra,
  });
}

describe('createPersonalOrganizationUpgradeStore', () => {
  it.each([true, false])(
    'retains a never-sent invitation after disposal during conversion (canInvite=%s)',
    async (canInvite) => {
      const recovery = memoryRecovery();
      let complete: (value: PersonalProjectOperation) => void = () => {};
      const port = makePort({
        convert: jest.fn(
          () =>
            new Promise<PersonalProjectOperation>((resolve) => {
              complete = resolve;
            }),
        ),
      });
      const first = makeStore(port, { recovery });
      await first.getState().loadProjects();
      first.getState().setName('Acme');
      first.getState().setInviteEmail('person@example.com');
      const submitting = first.getState().submit();
      await Promise.resolve();
      expect(first.getState().phase).toBe('converting');
      first.getState().dispose();
      const finished = operation(recovery.value?.conversionOperationId ?? '', {
        'ws-a': 'moved',
        'ws-b': 'moved',
      });
      complete(finished);
      await submitting;
      expect(port.invite).not.toHaveBeenCalled();

      const reopenedPort = makePort({ canInvite });
      reopenedPort.status.mockResolvedValue(finished);
      const reopened = makeStore(reopenedPort, {
        recovery,
        personalOrganizationId: REPLACEMENT_ID,
      });
      await Promise.all([
        reopened.getState().restore(),
        reopened.getState().restore(),
      ]);
      expect(reopenedPort.promote).not.toHaveBeenCalled();
      expect(reopenedPort.convert).not.toHaveBeenCalled();
      expect(reopenedPort.invite).toHaveBeenCalledTimes(canInvite ? 1 : 0);
      expect(reopened.getState().phase).toBe(
        canInvite ? 'finished' : 'partial',
      );
      reopened.getState().acknowledge();
      if (canInvite) {
        expect(reopenedPort.invite).toHaveBeenCalledWith(PERSONAL_ID, {
          email: 'person@example.com',
        });
        expect(recovery.value).toBeNull();
      } else {
        expect(recovery.value?.inviteEmail).toBe('person@example.com');
      }
      reopened.getState().dispose();
    },
  );
  it('keeps an in-flight recovered invitation durable across another restore', async () => {
    const recovery = memoryRecovery();
    recovery.value = {
      accountKey: 'account-1',
      personalOrganizationId: PERSONAL_ID,
      promotionOperationId: 'promotion-1',
      conversionOperationId: 'conversion-1',
      name: 'Acme',
      selection: [],
      inviteEmail: 'person@example.com',
      promotion: promotionOutcome('promotion-1'),
      invite: null,
    };
    let complete: (result: OrganizationInviteResult) => void = () => {};
    const port = makePort({
      canBringProjects: false,
      invite: jest.fn(
        () =>
          new Promise<OrganizationInviteResult>((resolve) => {
            complete = resolve;
          }),
      ),
    });
    const store = makeStore(port, {
      recovery,
      personalOrganizationId: REPLACEMENT_ID,
    });
    const restoring = store.getState().restore();
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    expect(port.invite).toHaveBeenCalledTimes(1);
    expect(recovery.value?.invitePending).toBe(true);
    await store.getState().restore();
    store.getState().acknowledge();
    expect(recovery.value).not.toBeNull();
    expect(port.invite).toHaveBeenCalledTimes(1);
    complete({
      status: 'sent',
      inviteId: '33333333-3333-4333-8333-333333333333',
    });
    await restoring;
    expect(store.getState().invite.status).toBe('done');
    store.getState().acknowledge();
    expect(recovery.value).toBeNull();
    store.getState().dispose();
  });
  it.each(['promotion', 'existing-team'])(
    'restores a definite invite refusal for %s without resending',
    async (target) => {
      const entries = new Map<string, string>();
      const recovery = createBrowserUpgradeRecovery('account-1', {
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value): void => {
          entries.set(key, value);
        },
        removeItem: (key): void => {
          entries.delete(key);
        },
      });
      recovery.write(null);
      const port = makePort({ canBringProjects: false });
      port.invite.mockRejectedValueOnce(
        new OrganizationOperationFailure(
          'Invites unavailable',
          'invites_disabled',
          403,
        ),
      );
      const store = makeStore(port, { recovery });
      store.getState().setName('Acme');
      store.getState().setInviteEmail('person@example.com');
      if (target === 'promotion') await store.getState().submit();
      else await store.getState().inviteExisting(PERSONAL_ID);
      store.getState().dispose();
      const reopened = makeStore(port, { recovery });
      await reopened.getState().restore();
      expect(reopened.getState().invite).toMatchObject({
        status: 'failed',
        failure: { code: 'invites_disabled' },
      });
      expect(reopened.getState().phase).toBe('partial');
      expect(port.invite).toHaveBeenCalledTimes(1);
      await reopened.getState().retryInvite();
      expect(port.invite).toHaveBeenCalledTimes(2);
      reopened.getState().acknowledge();
      expect(recovery.read()).toBeNull();
    },
  );
  it('uses a new operation for an edited name after a definite refusal', async () => {
    const port = makePort();
    port.promote.mockRejectedValueOnce(
      new OrganizationOperationFailure('Invalid', 'invalid_request', 400),
    );
    const store = makeStore(port);
    store.getState().setName('Old name');
    await store.getState().submit();
    store.getState().setName('Corrected name');
    await store.getState().submit();
    expect(port.promote.mock.calls[0]?.[0].operationId).not.toBe(
      port.promote.mock.calls[1]?.[0].operationId,
    );
  });
  it('reconciles a lost promotion reply with the original payload even after editing', async () => {
    const port = makePort();
    port.promote.mockRejectedValueOnce(new Error('timeout'));
    const store = makeStore(port);
    store.getState().setName('Original');
    await store.getState().submit();
    store.getState().setName('Edited');
    await store.getState().submit();
    expect(port.promote.mock.calls[1]?.[0]).toEqual(
      port.promote.mock.calls[0]?.[0],
    );
  });
  it('does not invite after disposal during a status reconciliation', async () => {
    const port = makePort();
    const store = makeStore(port);
    store.getState().setInviteEmail('invalid');
    await store.getState().inviteExisting(PERSONAL_ID);
    expect(port.invite).not.toHaveBeenCalled();
  });
  it('does not forget project refusals when the dialog closes', async () => {
    const recovery = memoryRecovery();
    const port = makePort({
      convert: jest.fn((request) =>
        Promise.resolve(
          operation(request.operationId, { 'ws-a': 'limit-reached' }),
        ),
      ),
    });
    const store = makeStore(port, { recovery });
    store.getState().setName('Acme');
    await store.getState().loadProjects();
    await store.getState().submit();
    store.getState().acknowledge();
    expect(recovery.value).not.toBeNull();
  });
  it('selects every listed project once and never adds newly discovered ones', async () => {
    const port = makePort();
    const store = makeStore(port);
    await store.getState().loadProjects();
    expect(store.getState().selection).toEqual(['ws-a', 'ws-b']);

    store.getState().setProjectSelected('ws-b', false);
    port.listProjects.mockResolvedValueOnce([
      ...PROJECTS,
      { workspaceId: 'ws-c', name: 'Gamma', kind: 'single-repo' },
    ]);
    await store.getState().loadProjects();
    expect(store.getState().selection).toEqual(['ws-a']);
    expect(store.getState().projects.items).toHaveLength(3);
  });

  it('keeps the list and selection when a refresh fails', async () => {
    const port = makePort();
    const store = makeStore(port);
    await store.getState().loadProjects();
    port.listProjects.mockRejectedValueOnce(new Error('offline'));
    await store.getState().loadProjects();
    expect(store.getState().projects).toEqual({
      status: 'error',
      items: PROJECTS,
    });
    expect(store.getState().selection).toEqual(['ws-a', 'ws-b']);
  });

  it('promotes, brings only the selection, then invites, in that order', async () => {
    const order: string[] = [];
    const port = makePort();
    port.promote.mockImplementation((request) => {
      order.push('promote');
      return Promise.resolve(promotionOutcome(request.operationId));
    });
    port.convert.mockImplementation((request) => {
      order.push(`convert:${request.workspaceIds.join(',')}`);
      return Promise.resolve(
        operation(request.operationId, { 'ws-a': 'moved' }),
      );
    });
    port.invite.mockImplementation(() => {
      order.push('invite');
      return Promise.resolve({
        status: 'deferred-for-payment',
        inviteId: '33333333-3333-4333-8333-333333333333',
      });
    });
    const store = makeStore(port);
    await store.getState().loadProjects();
    store.getState().setProjectSelected('ws-b', false);
    store.getState().setName('  Acme  ');
    store.getState().setInviteEmail('teammate@example.com');
    await store.getState().submit();

    expect(order).toEqual(['promote', 'convert:ws-a', 'invite']);
    expect(port.promote).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: PERSONAL_ID, name: 'Acme' }),
    );
    expect(store.getState().phase).toBe('finished');
    expect(store.getState().invite.result?.status).toBe('deferred-for-payment');
  });

  it('retries a refused promotion with the same operation id and never twice after success', async () => {
    const port = makePort();
    port.promote.mockRejectedValueOnce(
      new OrganizationOperationFailure('Busy', 'rate_limited', 429),
    );
    const store = makeStore(port, { port });
    store.getState().setName('Acme');
    await store.getState().submit();
    expect(store.getState().phase).toBe('editing');
    expect(store.getState().promotionFailure).toEqual({
      code: 'rate_limited',
      message: 'Busy',
    });
    await store.getState().submit();
    await store.getState().submit();
    expect(port.promote).toHaveBeenCalledTimes(2);
    const [first, second] = port.promote.mock.calls;
    expect(first?.[0].operationId).toBe(second?.[0].operationId);
  });

  it('ignores a double submit while promotion is in flight', async () => {
    let resolve: (
      value: PersonalOrganizationPromotionOutcome,
    ) => void = () => {};
    const port = makePort({
      canBringProjects: false,
      promote: jest.fn(
        () =>
          new Promise<PersonalOrganizationPromotionOutcome>((done) => {
            resolve = done;
          }),
      ),
    });
    const store = makeStore(port);
    store.getState().setName('Acme');
    const first = store.getState().submit();
    void store.getState().submit();
    resolve(promotionOutcome('op'));
    await first;
    expect(port.promote).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed promotion when projects and the invite fail', async () => {
    const port = makePort({
      convert: jest.fn(() => Promise.reject(new Error('desktop offline'))),
      invite: jest.fn(() =>
        Promise.reject(
          new OrganizationOperationFailure('No', 'invite_refused', 409),
        ),
      ),
    });
    const store = makeStore(port);
    await store.getState().loadProjects();
    store.getState().setName('Acme');
    store.getState().setInviteEmail('teammate@example.com');
    await store.getState().submit();
    const state = store.getState();
    expect(state.promotion?.promotion.organizationId).toBe(PERSONAL_ID);
    expect(state.conversionFailure?.message).toBe('desktop offline');
    expect(state.invite.status).toBe('failed');
    expect(state.phase).toBe('partial');
    // The failed request may have started work: its durable status is read.
    expect(port.status).toHaveBeenCalled();
  });

  it('retries only the chosen projects through the same operation', async () => {
    const port = makePort();
    port.convert.mockResolvedValueOnce(
      operation('op', { 'ws-a': 'converted-private', 'ws-b': 'moved' }),
    );
    const store = makeStore(port);
    await store.getState().loadProjects();
    store.getState().setName('Acme');
    await store.getState().submit();
    await store.getState().retryProjects(['ws-a']);
    const [first, retry] = port.convert.mock.calls;
    expect(retry?.[0]).toEqual({
      operationId: first?.[0].operationId,
      organizationId: PERSONAL_ID,
      workspaceIds: ['ws-a', 'ws-b'],
      retryWorkspaceIds: ['ws-a'],
    });
  });

  it('polls durable status while projects are pending', async () => {
    const callbacks: Array<() => void> = [];
    const port = makePort();
    port.convert.mockResolvedValueOnce(operation('op', { 'ws-a': 'pending' }));
    port.status.mockResolvedValueOnce(operation('op', { 'ws-a': 'moved' }));
    const store = makeStore(port, {
      schedule: (callback) => {
        callbacks.push(callback);
        return (): void => {};
      },
    });
    await store.getState().loadProjects();
    store.getState().setProjectSelected('ws-b', false);
    store.getState().setName('Acme');
    await store.getState().submit();
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().operation?.projects[0]?.outcome).toBe('moved');
  });

  it('ignores replies that arrive after dispose', async () => {
    let resolve: (
      value: PersonalOrganizationPromotionOutcome,
    ) => void = () => {};
    const port = makePort({
      promote: jest.fn(
        () =>
          new Promise<PersonalOrganizationPromotionOutcome>((done) => {
            resolve = done;
          }),
      ),
    });
    const store = makeStore(port);
    store.getState().setName('Acme');
    const pending = store.getState().submit();
    store.getState().dispose();
    resolve(promotionOutcome('op'));
    await pending;
    expect(store.getState().promotion).toBeNull();
    expect(port.convert).not.toHaveBeenCalled();
  });

  it('restores a recorded run from the replacement Personal and reuses its ids', async () => {
    const recovery = memoryRecovery();
    const port = makePort();
    port.convert.mockResolvedValueOnce(
      operation('op', { 'ws-a': 'failed', 'ws-b': 'moved' }),
    );
    const first = makeStore(port, { recovery });
    await first.getState().loadProjects();
    first.getState().setName('Acme');
    await first.getState().submit();
    first.getState().acknowledge();
    expect(recovery.value).not.toBeNull();

    port.status.mockResolvedValueOnce(
      operation('op', { 'ws-a': 'failed', 'ws-b': 'moved' }),
    );
    const reopened = makeStore(port, {
      recovery,
      personalOrganizationId: REPLACEMENT_ID,
    });
    await reopened.getState().restore();
    expect(reopened.getState().phase).toBe('partial');
    expect(reopened.getState().promotion?.promotion.organizationId).toBe(
      PERSONAL_ID,
    );
    expect(port.status).toHaveBeenLastCalledWith(
      recovery.value?.conversionOperationId,
    );
  });

  it('recovers a disposed promotion from replacement Personal with its original payload and selection', async () => {
    const recovery = memoryRecovery();
    let complete: (
      value: PersonalOrganizationPromotionOutcome,
    ) => void = () => {};
    const firstPort = makePort({
      promote: jest.fn(
        () =>
          new Promise<PersonalOrganizationPromotionOutcome>((resolve) => {
            complete = resolve;
          }),
      ),
    });
    const first = makeStore(firstPort, { recovery });
    await first.getState().loadProjects();
    first.getState().setProjectSelected('ws-b', false);
    first.getState().setName('Acme');
    const pending = first.getState().submit();
    const originalRequest = firstPort.promote.mock.calls[0]?.[0];
    first.getState().dispose();
    complete(promotionOutcome(originalRequest?.operationId ?? 'missing'));
    await pending;
    expect(recovery.value?.promotion).toBeNull();
    expect(firstPort.convert).not.toHaveBeenCalled();

    const reopenedPort = makePort();
    const reopened = makeStore(reopenedPort, {
      recovery,
      personalOrganizationId: REPLACEMENT_ID,
    });
    await reopened.getState().restore();
    expect(reopened.getState().name).toBe('Acme');
    expect(reopened.getState().selection).toEqual(['ws-a']);
    await reopened.getState().submit();
    expect(reopenedPort.promote).toHaveBeenCalledWith(originalRequest);
    expect(reopenedPort.convert.mock.calls[0]?.[0].workspaceIds).toEqual([
      'ws-a',
    ]);
    expect(reopened.getState().promotion?.promotion.organizationId).toBe(
      PERSONAL_ID,
    );
    reopened.getState().dispose();
  });

  it('forgets the record once nothing needs attention', async () => {
    const recovery = memoryRecovery();
    const store = makeStore(makePort(), { recovery });
    await store.getState().loadProjects();
    store.getState().setName('Acme');
    await store.getState().submit();
    store.getState().acknowledge();
    expect(recovery.value).toBeNull();
  });

  it('reopens an ambiguous existing-team invitation with a read, without resending', async () => {
    const recovery = memoryRecovery();
    const port = makePort({
      invite: jest.fn().mockRejectedValue(new Error('reply lost')),
      reconcileInvite: jest
        .fn()
        .mockResolvedValueOnce({ status: 'pending', inviteId: 'invite-1' })
        .mockResolvedValue({ status: 'sent', inviteId: 'invite-1' }),
    });
    const first = makeStore(port, { recovery });
    first.getState().setInviteEmail('pat@example.com');
    await first.getState().inviteExisting(PERSONAL_ID);
    expect(first.getState().invite.status).toBe('pending');
    first.getState().dispose();
    const reopened = makeStore(port, { recovery });
    await reopened.getState().restore();
    expect(port.reconcileInvite).toHaveBeenCalledWith(
      PERSONAL_ID,
      'pat@example.com',
    );
    expect(port.invite).toHaveBeenCalledTimes(1);
    expect(reopened.getState().invite.status).toBe('done');
    reopened.getState().dispose();
  });

  it('recovers a lost suppressed-email reply without sending another invitation', async () => {
    const port = makePort({
      invite: jest.fn().mockRejectedValue(new Error('reply lost')),
      reconcileInvite: jest.fn().mockResolvedValue({
        status: 'email-suppressed',
        inviteId: '33333333-3333-4333-8333-333333333333',
      }),
    });
    const store = makeStore(port);
    store.getState().setInviteEmail('pat@example.com');
    await store.getState().inviteExisting(PERSONAL_ID);
    expect(store.getState().invite.result?.status).toBe('email-suppressed');
    expect(store.getState().invite.status).toBe('done');
    expect(port.invite).toHaveBeenCalledTimes(1);
    store.getState().dispose();
  });

  it('persists a terminal reconciliation refusal and only resends after an explicit retry', async () => {
    const recovery = memoryRecovery();
    const port = makePort({
      invite: jest
        .fn()
        .mockRejectedValueOnce(new Error('reply lost'))
        .mockResolvedValue({ status: 'sent', inviteId: PERSONAL_ID }),
      reconcileInvite: jest
        .fn()
        .mockRejectedValue(
          new OrganizationOperationFailure(
            'Seat payment failed',
            'invite_refused',
            409,
          ),
        ),
    });
    const first = makeStore(port, { recovery });
    first.getState().setInviteEmail('pat@example.com');
    await first.getState().inviteExisting(PERSONAL_ID);
    expect(first.getState().invite).toMatchObject({
      status: 'failed',
      failure: { code: 'invite_refused' },
    });
    first.getState().dispose();
    const reopened = makeStore(port, { recovery });
    await reopened.getState().restore();
    expect(reopened.getState().invite.status).toBe('failed');
    expect(port.invite).toHaveBeenCalledTimes(1);
    expect(port.reconcileInvite).toHaveBeenCalledTimes(1);
    await reopened.getState().retryInvite();
    expect(port.invite).toHaveBeenCalledTimes(2);
    expect(reopened.getState().invite.status).toBe('done');
    reopened.getState().dispose();
  });

  it.each([503, 429])(
    'retains an ambiguous reconciliation error %s without resending',
    async (status) => {
      const port = makePort({
        invite: jest.fn().mockRejectedValue(new Error('reply lost')),
        reconcileInvite: jest
          .fn()
          .mockRejectedValue(
            new OrganizationOperationFailure(
              'Unavailable',
              status === 429 ? 'rate_limited' : 'failed',
              status,
            ),
          ),
      });
      const store = makeStore(port);
      store.getState().setInviteEmail('pat@example.com');
      await store.getState().inviteExisting(PERSONAL_ID);
      expect(store.getState().invite.status).toBe('pending');
      expect(port.invite).toHaveBeenCalledTimes(1);
      store.getState().dispose();
    },
  );

  it('invites into an existing team without promoting', async () => {
    const port = makePort();
    const store = makeStore(port);
    store.getState().setInviteEmail('teammate@example.com');
    await store
      .getState()
      .inviteExisting('44444444-4444-4444-8444-444444444444');
    expect(port.promote).not.toHaveBeenCalled();
    expect(port.invite).toHaveBeenCalledWith(
      '44444444-4444-4444-8444-444444444444',
      { email: 'teammate@example.com' },
    );
    expect(store.getState().invite.status).toBe('done');
  });

  it('invites more people only once the team exists, one row per address', async () => {
    const port = makePort({ canBringProjects: false });
    const store = makeStore(port);
    expect(await store.getState().inviteAnother('sam@example.com')).toBe(false);
    expect(port.invite).not.toHaveBeenCalled();

    store.getState().setName('Acme');
    await store.getState().submit();
    expect(await store.getState().inviteAnother('not an email')).toBe(false);
    expect(await store.getState().inviteAnother(' sam@example.com ')).toBe(
      true,
    );
    expect(await store.getState().inviteAnother('lee@example.com')).toBe(true);
    // The same address again resends on its existing row.
    expect(await store.getState().inviteAnother('SAM@example.com')).toBe(true);

    expect(port.invite).toHaveBeenNthCalledWith(1, PERSONAL_ID, {
      email: 'sam@example.com',
    });
    expect(port.invite).toHaveBeenNthCalledWith(2, PERSONAL_ID, {
      email: 'lee@example.com',
    });
    expect(port.invite).toHaveBeenCalledTimes(3);
    expect(
      store
        .getState()
        .additionalInvites.map((entry) => [entry.email, entry.status]),
    ).toEqual([
      ['sam@example.com', 'done'],
      ['lee@example.com', 'done'],
    ]);
  });

  it('keeps a refused additional invite on its row and retries only that one', async () => {
    const port = makePort({ canBringProjects: false });
    const store = makeStore(port);
    store.getState().setName('Acme');
    await store.getState().submit();
    port.invite.mockRejectedValueOnce(
      new OrganizationOperationFailure('Slow down', 'rate_limited', 429),
    );
    await store.getState().inviteAnother('sam@example.com');
    const [failed] = store.getState().additionalInvites;
    expect(failed?.status).toBe('failed');
    expect(failed?.failure?.code).toBe('rate_limited');

    await store.getState().retryAnother(failed?.id ?? '');
    expect(port.invite).toHaveBeenCalledTimes(2);
    expect(store.getState().additionalInvites[0]?.status).toBe('done');
    expect(store.getState().promotion).not.toBeNull();
    expect(port.promote).toHaveBeenCalledTimes(1);
  });

  it('reads an unknown additional invite outcome instead of resending', async () => {
    const port = makePort({
      canBringProjects: false,
      reconcileInvite: jest.fn(() =>
        Promise.resolve({
          status: 'sent' as const,
          inviteId: '33333333-3333-4333-8333-333333333333',
        }),
      ),
    });
    const store = makeStore(port);
    store.getState().setName('Acme');
    await store.getState().submit();
    port.invite.mockRejectedValueOnce(new Error('socket hang up'));
    await store.getState().inviteAnother('sam@example.com');
    expect(port.reconcileInvite).toHaveBeenCalledWith(
      PERSONAL_ID,
      'sam@example.com',
    );
    expect(port.invite).toHaveBeenCalledTimes(1);
    expect(store.getState().additionalInvites[0]?.status).toBe('done');
  });
});

describe('createBrowserUpgradeRecovery', () => {
  it('scopes records to the account and drops unreadable ones', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => data.get(key) ?? null,
      setItem: (key: string, value: string): void => void data.set(key, value),
      removeItem: (key: string): void => void data.delete(key),
    };
    const mine = createBrowserUpgradeRecovery('a', storage);
    const theirs = createBrowserUpgradeRecovery('b', storage);
    const record: PersonalOrganizationUpgradeRecord = {
      accountKey: 'a',
      personalOrganizationId: PERSONAL_ID,
      promotionOperationId: 'p',
      conversionOperationId: 'c',
      name: 'Acme',
      selection: [],
      inviteEmail: '',
      promotion: null,
      invite: null,
    };
    mine.write(record);
    expect(mine.read()).toEqual(record);
    expect(theirs.read()).toBeNull();
    data.set('canopy.personal-organization-upgrade.v1:b', '{not json');
    expect(theirs.read()).toBeNull();
    mine.write(null);
    expect(mine.read()).toBeNull();
  });
});

it('keeps a restored selection pending when its first status response has no result', async () => {
  const recovery = memoryRecovery();
  const first = makeStore(
    makePort({
      convert: jest.fn().mockRejectedValue(new Error('Disconnected')),
    }),
    { recovery },
  );
  await first.getState().loadProjects();
  first.getState().setName('Acme');
  await first.getState().submit();
  first.getState().dispose();
  const recorded = recovery.read();
  if (!recorded) throw new Error('Missing test recovery');
  // Legacy records had no conversion failure proof. Null status stays pending.
  recovery.write({
    accountKey: recorded.accountKey,
    personalOrganizationId: recorded.personalOrganizationId,
    promotionOperationId: recorded.promotionOperationId,
    conversionOperationId: recorded.conversionOperationId,
    name: recorded.name,
    selection: recorded.selection,
    inviteEmail: recorded.inviteEmail,
    promotion: recorded.promotion,
    invite: recorded.invite,
  });
  const schedule = jest.fn(() => (): void => {});
  const port = makePort();
  const reopened = makeStore(port, {
    personalOrganizationId: REPLACEMENT_ID,
    recovery,
    schedule,
  });
  await reopened.getState().restore();
  expect(reopened.getState().phase).toBe('pending');
  expect(reopened.getState().operation?.selection).toEqual(
    PROJECTS.map((project) => project.workspaceId),
  );
  expect(
    reopened
      .getState()
      .operation?.projects.every((project) => project.outcome === 'pending'),
  ).toBe(true);
  expect(schedule).toHaveBeenCalled();
  expect(port.convert).not.toHaveBeenCalled();
  reopened.getState().dispose();
});

it.each([false, true])(
  'restores a conversion failure and retries after a confirmed absent journal (initial status failure: %s)',
  async (statusFails) => {
    const values = new Map<string, string>();
    const recovery = createBrowserUpgradeRecovery('account-1', {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    });
    const first = makeStore(
      makePort({
        convert: jest
          .fn()
          .mockRejectedValue(new Error('Destination unavailable')),
      }),
      { recovery },
    );
    await first.getState().loadProjects();
    first.getState().setProjectSelected('ws-b', false);
    first.getState().setName('Acme');
    await first.getState().submit();
    const originalIds = recovery.read();
    first.getState().dispose();
    const port = makePort();
    if (statusFails)
      port.status.mockRejectedValueOnce(new Error('Disconnected'));
    const reopened = makeStore(port, {
      recovery,
      personalOrganizationId: REPLACEMENT_ID,
    });
    await reopened.getState().restore();
    expect(reopened.getState().conversionFailure?.message).toBe(
      'Destination unavailable',
    );
    if (statusFails) {
      expect(reopened.getState().phase).toBe('pending');
      expect(reopened.getState().operation?.projects[0]?.outcome).toBe(
        'pending',
      );
      expect(port.convert).not.toHaveBeenCalled();
      await reopened.getState().refreshOperation();
    }
    expect(reopened.getState().phase).toBe('partial');
    expect(reopened.getState().operation).toBeNull();
    expect(port.convert).not.toHaveBeenCalled();
    await reopened.getState().retryProjects(['ws-a']);
    expect(port.convert).toHaveBeenCalledWith({
      organizationId: PERSONAL_ID,
      operationId: originalIds?.conversionOperationId,
      workspaceIds: ['ws-a'],
      retryWorkspaceIds: ['ws-a'],
    });
    expect(port.promote).not.toHaveBeenCalled();
    expect(reopened.getState().phase).toBe('finished');
    reopened.getState().dispose();
  },
);

it('persists a conversion failure before waiting for its journal read', async () => {
  const recovery = memoryRecovery();
  let complete: (value: PersonalProjectOperation | null) => void = () => {};
  const port = makePort({
    convert: jest.fn().mockRejectedValue(new Error('Destination unavailable')),
    status: jest.fn(
      () =>
        new Promise<PersonalProjectOperation | null>((resolve) => {
          complete = resolve;
        }),
    ),
  });
  const first = makeStore(port, { recovery });
  await first.getState().loadProjects();
  first.getState().setName('Acme');
  const submitting = first.getState().submit();
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
  expect(port.status).toHaveBeenCalledTimes(1);
  const saved = recovery.read();
  first.getState().dispose();
  complete(null);
  await submitting;
  expect(saved?.conversionFailure?.message).toBe('Destination unavailable');
});

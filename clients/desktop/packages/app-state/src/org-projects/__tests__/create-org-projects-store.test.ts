import type {
  OrgProjectCatalogSnapshot,
  OrgProjectSetupProgress,
  OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
} from '../../create-client-store';
import {
  accountChange,
  deferred,
  createFakeClient,
} from '../../__tests__/fake-org-projects-client';
import {
  computeOrgProjectListed,
  createOrgProjectsStore,
  selectCatalogError,
  selectCatalogLoading,
  selectListedProjects,
  selectPlaceholderRows,
  selectSetupProgress,
} from '../create-org-projects-store';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG: WorkspaceContext = { kind: 'organization', organizationId: ORG_ID };
const PERSONAL: WorkspaceContext = { kind: 'personal' };

function project(
  overrides: Partial<OrgProjectSummary> & Pick<OrgProjectSummary, 'id'>,
): OrgProjectSummary {
  return {
    organizationId: ORG_ID,
    name: overrides.id,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: null,
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
    ...overrides,
  };
}

function snapshot(
  context: string,
  projects: OrgProjectSummary[],
  revision = 'r1',
): OrgProjectCatalogSnapshot {
  return { context, revision, projects, fetchedAt: '2026-09-10T00:00:00.000Z' };
}

describe('computeOrgProjectListed', () => {
  it('applies use AND (ADDED OR (FOLLOW_DEFAULTS AND defaultListed))', () => {
    const usable = {
      capabilities: { administer: true, manageCloud: false, use: true },
      defaultListed: false,
    };
    expect(computeOrgProjectListed(usable, 'ADDED')).toBe(true);
    expect(computeOrgProjectListed(usable, 'FOLLOW_DEFAULTS')).toBe(false);
    expect(
      computeOrgProjectListed(
        { ...usable, defaultListed: true },
        'FOLLOW_DEFAULTS',
      ),
    ).toBe(true);
    expect(
      computeOrgProjectListed({ ...usable, defaultListed: true }, 'DISMISSED'),
    ).toBe(false);
    // ADMINISTER never implies USE.
    const adminOnly = {
      capabilities: { administer: true, manageCloud: false, use: false },
      defaultListed: true,
    };
    expect(computeOrgProjectListed(adminOnly, 'ADDED')).toBe(false);
  });
});

describe('createOrgProjectsStore', () => {
  it('sets and clears setup requests, including on account change', (): void => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    store[CLIENT_STORE_ACTIVATE]?.();
    expect(store.getState().setupRequest).toBeNull();
    store.getState().requestSetup(ORG_ID, 'catalog');
    expect(store.getState().setupRequest).toEqual({
      organizationId: ORG_ID,
      projectId: 'catalog',
    });
    store.getState().clearSetupRequest();
    expect(store.getState().setupRequest).toBeNull();
    store.getState().requestSetup(ORG_ID, 'catalog');
    fake.emit('workspace-context.changed', accountChange());
    expect(store.getState().setupRequest).toBeNull();
    store[CLIENT_STORE_DISPOSE]?.();
  });

  it.each(['departed', 'organizations'])(
    'removes departed organization caches and ignores late replies on %s',
    async (reason): Promise<void> => {
      const fake = createFakeClient();
      const store = createOrgProjectsStore(fake.client);
      store[CLIENT_STORE_ACTIVATE]?.();
      const orgB: WorkspaceContext = {
        kind: 'organization',
        organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      };
      const keyB = `org:${orgB.organizationId}`;
      const a = snapshot(`org:${ORG_ID}`, [project({ id: 'a' })]);
      const b = snapshot(keyB, [
        project({ id: 'b', organizationId: orgB.organizationId }),
      ]);
      store.getState().applySnapshot(a);
      store.getState().applySnapshot(b);
      const progressA: OrgProjectSetupProgress = {
        projectId: 'a',
        instanceId: null,
        state: 'claiming',
        message: null,
        percent: null,
        updatedAt: '2026-09-10T00:00:00.000Z',
      };
      const progressB = { ...progressA, projectId: 'b' };
      store.getState().applySetupProgress(progressA);
      store.getState().applySetupProgress(progressB);
      const reply = deferred<OrgProjectCatalogSnapshot>();
      fake.query.mockReturnValueOnce(reply.promise);
      const pending = store.getState().load(orgB);
      fake.emit('workspace-context.changed', {
        ...accountChange(),
        reason: reason === 'departed' ? 'departed' : 'organizations',
        state: {
          context: ORG,
          revision: 2,
          organizations: [{ id: ORG_ID, name: 'A', role: 'MEMBER' }],
        },
      });
      expect(store.getState().snapshots).toEqual({ [`org:${ORG_ID}`]: a });
      expect(store.getState().setupProgress).toEqual({ a: progressA });
      expect(store.getState().loading).toEqual({});
      reply.resolve(b);
      await pending;
      expect(store.getState().snapshots).toEqual({ [`org:${ORG_ID}`]: a });
      expect(store.getState().snapshots[`org:${ORG_ID}`]).toBe(a);
      expect(store.getState().setupProgress).toEqual({ a: progressA });
    },
  );

  it.each([true, false])(
    'clears account caches and drops old replies (check immediately: %s)',
    async (immediate) => {
      const fake = createFakeClient();
      const store = createOrgProjectsStore(fake.client);
      store[CLIENT_STORE_ACTIVATE]?.();
      const old = snapshot('personal', [project({ id: 'old' })]);
      store.getState().applySnapshot(old);
      fake.query.mockRejectedValueOnce(new Error('offline'));
      await store.getState().load(ORG);
      const progress: OrgProjectSetupProgress = {
        projectId: 'old',
        instanceId: null,
        state: 'claiming',
        message: null,
        percent: null,
        updatedAt: '2026-09-10T00:00:00.000Z',
      };
      store.getState().applySetupProgress(progress);
      const setupReply = deferred<OrgProjectSetupProgress>();
      const preferenceReply = deferred<void>();
      fake.command
        .mockReturnValueOnce(setupReply.promise)
        .mockReturnValueOnce(preferenceReply.promise);
      const setup = store.getState().startSetup('old', '/chosen');
      const preference = store
        .getState()
        .setPreference(PERSONAL, 'old', 'DISMISSED');
      const rejected = expect(preference).rejects.toThrow('forbidden');
      const reply = deferred<OrgProjectCatalogSnapshot>();
      fake.query.mockReturnValueOnce(reply.promise);
      const pending = store.getState().load(PERSONAL);
      fake.emit('workspace-context.changed', accountChange());
      if (immediate) {
        expect(store.getState().snapshots).toEqual({});
        expect(store.getState().loading).toEqual({});
        expect(store.getState().errors).toEqual({});
        expect(store.getState().setupProgress).toEqual({});
      }
      const nextReply = deferred<OrgProjectCatalogSnapshot>();
      fake.query.mockReturnValueOnce(nextReply.promise);
      const nextLoad = store.getState().load(PERSONAL);
      expect(fake.query).toHaveBeenCalledTimes(3);
      reply.resolve(old);
      setupReply.resolve(progress);
      preferenceReply.reject(new Error('forbidden'));
      await Promise.all([pending, setup, rejected]);
      expect(store.getState().snapshots).toEqual({});
      expect(store.getState().setupProgress).toEqual({});
      expect(store.getState().errors).toEqual({});
      expect(selectCatalogLoading(store.getState(), PERSONAL)).toBe(true);
      nextReply.resolve(snapshot('personal', [project({ id: 'new' })]));
      await nextLoad;
      expect(
        selectListedProjects(store.getState(), PERSONAL).map((row) => row.id),
      ).toEqual(['new']);
    },
  );

  it.each([true, false])(
    'only the newest refresh publishes and clears loading (older first: %s)',
    async (olderFirst) => {
      const fake = createFakeClient();
      const store = createOrgProjectsStore(fake.client);
      const older = deferred<OrgProjectCatalogSnapshot>();
      const newer = deferred<OrgProjectCatalogSnapshot>();
      fake.query
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise);
      const first = store.getState().load(PERSONAL);
      const second = store.getState().load(PERSONAL, { refresh: true });
      const latest = snapshot('personal', [project({ id: 'new' })], 'r2');
      if (olderFirst) {
        older.resolve(snapshot('personal', []));
        await first;
        expect(selectCatalogLoading(store.getState(), PERSONAL)).toBe(true);
        expect(store.getState().load(PERSONAL)).toBe(second);
      }
      newer.resolve(latest);
      await second;
      expect(selectCatalogLoading(store.getState(), PERSONAL)).toBe(false);
      if (!olderFirst) {
        older.resolve(snapshot('personal', []));
        await first;
      }
      expect(store.getState().snapshots.personal).toEqual(latest);
    },
  );

  it('preserves refreshed rows when an earlier preference mutation fails', async (): Promise<void> => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    store
      .getState()
      .applySnapshot(
        snapshot('personal', [project({ id: 'a' }), project({ id: 'b' })]),
      );
    const reply = deferred<void>();
    fake.command
      .mockReturnValueOnce(reply.promise)
      .mockResolvedValueOnce(undefined);
    const pending = store.getState().setPreference(PERSONAL, 'a', 'DISMISSED');
    const rejected = expect(pending).rejects.toThrow('forbidden');
    expect(store.getState().snapshots.personal?.projects[0]).toMatchObject({
      preference: 'DISMISSED',
      listed: false,
    });
    await store.getState().setPreference(PERSONAL, 'b', 'DISMISSED');
    const refreshed = snapshot(
      'personal',
      [
        project({
          id: 'a',
          name: 'Refreshed A',
          preference: 'DISMISSED',
          listed: false,
        }),
        project({ id: 'b', preference: 'DISMISSED', listed: false }),
        project({ id: 'c' }),
      ],
      'r2',
    );
    fake.query.mockResolvedValueOnce(refreshed);
    await store.getState().load(PERSONAL, { refresh: true });
    reply.reject(new Error('forbidden'));
    await rejected;
    expect(store.getState().snapshots.personal).toEqual(refreshed);
  });

  it.each([true, false])(
    'restores the confirmed preference when overlapping mutations both fail (older first: %s)',
    async (olderFirst): Promise<void> => {
      const fake = createFakeClient();
      const store = createOrgProjectsStore(fake.client);
      store
        .getState()
        .applySnapshot(snapshot('personal', [project({ id: 'a' })]));
      const older = deferred<void>();
      const newer = deferred<void>();
      fake.command
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise);
      const first = store.getState().setPreference(PERSONAL, 'a', 'DISMISSED');
      const firstRejected = expect(first).rejects.toThrow('older failed');
      const second = store.getState().setPreference(PERSONAL, 'a', 'ADDED');
      const secondRejected = expect(second).rejects.toThrow('newer failed');
      if (olderFirst) {
        older.reject(new Error('older failed'));
        await firstRejected;
        expect(
          store.getState().snapshots.personal?.projects[0]?.preference,
        ).toBe('ADDED');
      }
      newer.reject(new Error('newer failed'));
      await secondRejected;
      if (!olderFirst) {
        older.reject(new Error('older failed'));
        await firstRejected;
      }
      expect(store.getState().snapshots.personal?.projects[0]).toMatchObject({
        preference: 'FOLLOW_DEFAULTS',
        listed: true,
      });
    },
  );

  it.each([true, false])(
    'retains a successful overlapping preference after the newer mutation fails (success first: %s)',
    async (successFirst): Promise<void> => {
      const fake = createFakeClient();
      const store = createOrgProjectsStore(fake.client);
      store
        .getState()
        .applySnapshot(snapshot('personal', [project({ id: 'a' })]));
      const older = deferred<void>();
      const newer = deferred<void>();
      fake.command
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise);
      const first = store.getState().setPreference(PERSONAL, 'a', 'DISMISSED');
      const second = store.getState().setPreference(PERSONAL, 'a', 'ADDED');
      const rejected = expect(second).rejects.toThrow('failed');
      if (successFirst) {
        older.resolve(undefined);
        await first;
        expect(
          store.getState().snapshots.personal?.projects[0]?.preference,
        ).toBe('ADDED');
      }
      newer.reject(new Error('failed'));
      await rejected;
      if (!successFirst) {
        older.resolve(undefined);
        await first;
      }
      expect(store.getState().snapshots.personal?.projects[0]).toMatchObject({
        preference: 'DISMISSED',
        listed: false,
      });
    },
  );

  it('asks the host to re-read repositories only when told to (CAN-3489)', async (): Promise<void> => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    fake.query.mockResolvedValue(snapshot('personal', []));

    await store
      .getState()
      .load(PERSONAL, { refresh: true, repositories: true });
    await store.getState().load(PERSONAL, { refresh: true });

    expect(fake.query.mock.calls).toEqual([
      [
        'orgProjects.catalog',
        { context: PERSONAL, refresh: true, repositories: true },
      ],
      ['orgProjects.catalog', { context: PERSONAL, refresh: true }],
    ]);
  });

  it('refreshes the context after failure when the confirmed preference is unknown', async (): Promise<void> => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    const refreshed = snapshot('personal', [project({ id: 'a' })]);
    fake.query.mockResolvedValueOnce(refreshed);
    fake.command.mockRejectedValueOnce(new Error('failed'));
    await expect(
      store.getState().setPreference(PERSONAL, 'a', 'DISMISSED'),
    ).rejects.toThrow('failed');
    expect(fake.query).toHaveBeenCalledWith('orgProjects.catalog', {
      context: PERSONAL,
      refresh: true,
    });
    expect(store.getState().snapshots.personal).toEqual(refreshed);
  });

  it('does not roll back a newer preference mutation on the same row', async () => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    store
      .getState()
      .applySnapshot(snapshot('personal', [project({ id: 'a' })]));
    const reply = deferred<void>();
    fake.command
      .mockReturnValueOnce(reply.promise)
      .mockResolvedValueOnce(undefined);
    const pending = store.getState().setPreference(PERSONAL, 'a', 'DISMISSED');
    const rejected = expect(pending).rejects.toThrow('forbidden');
    await store.getState().setPreference(PERSONAL, 'a', 'ADDED');
    reply.reject(new Error('forbidden'));
    await rejected;
    expect(store.getState().snapshots.personal?.projects[0]?.preference).toBe(
      'ADDED',
    );
  });

  it('loads a context, coalesces concurrent loads, and exposes listed and placeholder rows', async () => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    fake.query.mockResolvedValue(
      snapshot(`org:${ORG_ID}`, [
        project({ id: 'ready', instance: { id: 'i1', state: 'READY' } }),
        project({ id: 'claimed', instance: { id: 'i2', state: 'CLAIMED' } }),
        project({ id: 'dismissed', preference: 'DISMISSED', listed: false }),
        project({ id: 'archived', state: 'ARCHIVED' }),
      ]),
    );

    const first = store.getState().load(ORG);
    expect(selectCatalogLoading(store.getState(), ORG)).toBe(true);
    const second = store.getState().load(ORG);
    await Promise.all([first, second]);

    expect(fake.query).toHaveBeenCalledTimes(1);
    expect(fake.query).toHaveBeenCalledWith('orgProjects.catalog', {
      context: ORG,
    });
    expect(selectCatalogLoading(store.getState(), ORG)).toBe(false);
    expect(
      selectListedProjects(store.getState(), ORG).map((p) => p.id),
    ).toEqual(['ready', 'claimed']);
    expect(
      selectPlaceholderRows(store.getState(), ORG).map((p) => p.id),
    ).toEqual(['claimed']);
    expect(selectListedProjects(store.getState(), PERSONAL)).toEqual([]);
  });

  it('records a load failure per context and clears it on the next success', async () => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    fake.query.mockRejectedValueOnce(new Error('offline'));
    await store.getState().load(PERSONAL);
    expect(selectCatalogError(store.getState(), PERSONAL)).toBe('offline');

    fake.query.mockResolvedValueOnce(snapshot('personal', []));
    await store.getState().load(PERSONAL);
    expect(selectCatalogError(store.getState(), PERSONAL)).toBeNull();
  });

  it('applies a preference optimistically and rolls back when the host refuses', async () => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    store
      .getState()
      .applySnapshot(
        snapshot(`org:${ORG_ID}`, [
          project({ id: 'p', defaultListed: false, listed: false }),
        ]),
      );

    fake.command.mockResolvedValueOnce(undefined);
    await store.getState().setPreference(ORG, 'p', 'ADDED');
    expect(fake.command).toHaveBeenCalledWith('orgProjects.setPreference', {
      projectId: 'p',
      preference: 'ADDED',
    });
    expect(
      selectListedProjects(store.getState(), ORG).map((p) => p.id),
    ).toEqual(['p']);

    fake.command.mockRejectedValueOnce(new Error('forbidden'));
    await expect(
      store.getState().setPreference(ORG, 'p', 'DISMISSED'),
    ).rejects.toThrow('forbidden');
    const row = selectListedProjects(store.getState(), ORG)[0];
    expect(row?.preference).toBe('ADDED');
    expect(row?.listed).toBe(true);
  });

  it('starts a setup and tracks progress from the command and later events', async () => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    fake.command.mockResolvedValueOnce({
      projectId: 'p',
      instanceId: null,
      state: 'claiming',
      message: null,
      percent: null,
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    await store.getState().startSetup('p', '/chosen');
    expect(fake.command).toHaveBeenCalledWith('orgProjects.setupStart', {
      projectId: 'p',
      destinationRoot: '/chosen',
    });
    expect(selectSetupProgress(store.getState(), 'p')?.state).toBe('claiming');

    store[CLIENT_STORE_ACTIVATE]?.();
    fake.emit('org-projects.setup-progress', {
      occurredAt: '2026-09-10T00:00:01.000Z',
      progress: {
        projectId: 'p',
        instanceId: 'i1',
        state: 'materializing',
        message: 'Cloning',
        percent: 40,
        updatedAt: '2026-09-10T00:00:01.000Z',
      },
    });
    expect(selectSetupProgress(store.getState(), 'p')?.percent).toBe(40);

    fake.command.mockResolvedValueOnce(undefined);
    await store.getState().cancelSetup('p');
    expect(fake.command).toHaveBeenLastCalledWith('orgProjects.setupCancel', {
      projectId: 'p',
    });
  });

  it('re-queries only contexts it already holds when org-projects.changed fires, and unsubscribes on dispose', async () => {
    const fake = createFakeClient();
    const store = createOrgProjectsStore(fake.client);
    fake.query.mockResolvedValue(
      snapshot(`org:${ORG_ID}`, [project({ id: 'p' })]),
    );
    await store.getState().load(ORG);
    store[CLIENT_STORE_ACTIVATE]?.();
    expect(fake.subscribed).toEqual([
      'workspace-context.changed',
      'org-projects.changed',
      'org-projects.setup-progress',
    ]);

    fake.emit('org-projects.changed', {
      occurredAt: '2026-09-10T00:00:00.000Z',
      context: PERSONAL,
      reason: 'catalog',
    });
    fake.emit('org-projects.changed', {
      occurredAt: '2026-09-10T00:00:00.000Z',
      context: ORG,
      reason: 'instance',
    });
    await Promise.resolve();
    expect(fake.query).toHaveBeenCalledTimes(2);
    expect(fake.query).toHaveBeenLastCalledWith('orgProjects.catalog', {
      context: ORG,
      refresh: true,
    });

    store[CLIENT_STORE_DISPOSE]?.();
    expect(fake.unsubscribed).toEqual([
      'workspace-context.changed',
      'org-projects.changed',
      'org-projects.setup-progress',
    ]);
  });
});

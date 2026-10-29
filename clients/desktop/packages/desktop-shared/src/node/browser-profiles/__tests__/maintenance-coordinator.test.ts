import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import type * as NativeFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type BrowserProfileRecord } from '@canopy/protocol/browser-profiles';
import { BrowserDataJobs } from '../data-jobs';
import {
  BrowserMaintenanceCoordinator,
  type BrowserMaintenanceAdapter,
} from '../maintenance-coordinator';
import type { BrowserDataActor } from '@canopy/protocol/browser-profiles';
const user: BrowserDataActor = { kind: 'user' };
const agent: BrowserDataActor = {
  kind: 'agent',
  taskScope: { kind: 'worktree', projectId: 'project', worktreeId: 'task' },
  taskIncarnationId: randomUUID(),
};
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function fixture(
  action: (state: {
    profile: BrowserProfileRecord;
    jobs: BrowserDataJobs;
    coordinator: BrowserMaintenanceCoordinator;
    adapter: BrowserMaintenanceAdapter;
    events: string[];
    root: string;
    advance: () => void;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'browser-maintenance-test-'));
  const events: string[] = [];
  const profile: BrowserProfileRecord = {
    schemaVersion: 1,
    profileId: randomUUID(),
    kind: 'named',
    owner: { kind: 'user', localPrincipalId: 'local' },
    displayName: 'Account',
    agentPermissions: { allowEnable: false, allowClear: true },
    lifecycle: 'active',
    storageGeneration: 1,
    metadataRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  let now = 1000;
  const jobs = new BrowserDataJobs(join(root, 'jobs'), () => now);
  const adapter: BrowserMaintenanceAdapter = {
    profile: () => Promise.resolve(structuredClone(profile)),
    authorize: (record, actor) => {
      if (actor.kind === 'agent' && !record.agentPermissions.allowClear)
        return Promise.reject(
          new BrowserProfileError(
            'agent_clear_denied',
            'Clear permission was revoked.',
          ),
        );
      return Promise.resolve();
    },
    usage: () => Promise.resolve({ tabs: [], defaults: [] }),
    scope: () =>
      Promise.resolve({
        dataClasses: ['cookies', 'localStorage'],
        cookieDomains: ['example.test'],
        contexts: [
          {
            origin: 'https://example.test',
            topLevelOrigin: 'https://example.test',
          },
        ],
      }),
    fence: () => {
      events.push('fence');
    },
    unfence: () => {
      events.push('unfence');
    },
    drainCreations: () => {
      return Promise.resolve();
    },
    quiesce: () => {
      events.push('quiesce');
      return Promise.resolve();
    },
    verifySupported: () => {
      events.push('preflight');
      return Promise.resolve();
    },
    invoke: async (_preview, actor, _id, intent) => {
      await adapter.authorize(profile, actor);
      await intent();
      events.push('invoke');
      return {
        completion: Promise.resolve({
          storageGeneration: profile.storageGeneration,
          cleanupPending: false,
        }),
      };
    },
    recover: () => {
      events.push('recover');
      return Promise.resolve({
        storageGeneration: profile.storageGeneration,
        cleanupPending: false,
      });
    },
    verifyCleared: () => {
      events.push('verify');
      return Promise.resolve();
    },
    rebind: () => {
      events.push('rebind');
      return Promise.resolve();
    },
    release: () => {
      events.push('release');
      return Promise.resolve();
    },
    resume: () => {
      events.push('resume');
      return Promise.resolve();
    },
  };
  const coordinator = new BrowserMaintenanceCoordinator(
    root,
    jobs,
    adapter,
    () => now,
  );
  try {
    await action({
      profile,
      jobs,
      coordinator,
      adapter,
      events,
      root,
      advance: () => {
        now += 300001;
      },
    });
  } finally {
    await coordinator.settled();
    await rm(root, { recursive: true, force: true });
  }
}
describe('browser maintenance coordinator boundaries', () => {
  it('exhausts a pre-running receipt rename denial before native work and releases the admission fence', async () =>
    fixture(async ({ coordinator, profile, jobs, events, root }) => {
      const preview = await coordinator.preview(user, profile.profileId, 1, 1, {
        kind: 'reset',
      });
      const id = randomUUID();
      const target = join(root, 'jobs', 'records', `${id}.json`);
      const nativeFs = jest.requireActual<typeof NativeFs>('node:fs/promises');
      const rename = nativeFs.rename;
      const denied: string[] = [];
      const renameSpy = jest
        .spyOn(nativeFs, 'rename')
        .mockImplementation(async (source, destination) => {
          const next =
            destination === target
              ? (JSON.parse(await readFile(source, 'utf8')) as {
                  job: { status: string };
                })
              : null;
          if (next?.job.status === 'running') {
            expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({
              job: { status: 'queued' },
            });
            denied.push(String(source));
            throw Object.assign(
              new Error('Injected persistent queued-to-running rename denial'),
              { code: 'EPERM' },
            );
          }
          await rename(source, destination);
        });
      try {
        await coordinator.commit(user, id, preview.token);
        await coordinator.settled();
        expect(await jobs.get(id, user)).toMatchObject({
          jobId: id,
          status: 'failed',
          retryable: false,
          cancellable: false,
          storageGeneration: 1,
        });
        expect((await jobs.getForExecution(id))?.irreversible).toBe(false);
        expect(events).toEqual(['fence', 'unfence']);
        expect(await readdir(join(root, 'jobs', 'records'))).toEqual([
          `${id}.json`,
        ]);
        // A separate operation must be admitted once this pre-native failure settles.
        const next = await coordinator.preview(user, profile.profileId, 1, 1, {
          kind: 'reset',
        });
        const nextId = randomUUID();
        await coordinator.commit(user, nextId, next.token);
        await coordinator.settled();
        expect((await jobs.get(nextId, user)).status).toBe('complete');
        expect(denied).toHaveLength(6);
        expect(new Set(denied).size).toBe(1);
      } finally {
        renameSpy.mockRestore();
      }
    }));

  it('keeps maintenance serialized until completed views finish resuming', async () =>
    fixture(async ({ coordinator, profile, adapter }) => {
      const entered = deferred(),
        release = deferred();
      adapter.resume = (): Promise<void> => {
        entered.resolve();
        return release.promise;
      };
      const first = await coordinator.preview(user, profile.profileId, 1, 1, {
        kind: 'cache',
      });
      await coordinator.commit(user, randomUUID(), first.token);
      await entered.promise;
      try {
        await expect(
          (async (): ReturnType<BrowserMaintenanceCoordinator['commit']> => {
            const next = await coordinator.preview(
              user,
              profile.profileId,
              1,
              1,
              {
                kind: 'cache',
              },
            );
            return coordinator.commit(user, randomUUID(), next.token);
          })(),
        ).rejects.toMatchObject({ code: 'operation_conflict' });
      } finally {
        release.resolve();
      }
    }));

  it('records completion before resuming and replays the response without a second clear', async () =>
    fixture(
      async ({
        coordinator,
        profile,
        jobs,
        adapter,
        events,
        advance,
        root,
      }) => {
        const preview = await coordinator.preview(
          user,
          profile.profileId,
          1,
          1,
          { kind: 'site', origin: 'https://example.test' },
        );
        const id = randomUUID();
        adapter.resume = async (): ReturnType<
          BrowserMaintenanceAdapter['resume']
        > => {
          expect((await jobs.get(id, user)).status).toBe('complete');
          events.push('resume');
        };
        await coordinator.commit(user, id, preview.token);
        await coordinator.settled();
        expect(events.filter((event) => event === 'invoke')).toHaveLength(1);
        expect((await jobs.get(id, user)).status).toBe('complete');
        advance();
        await rm(join(root, 'previews', `${preview.token}.json`));
        expect((await coordinator.commit(user, id, preview.token)).status).toBe(
          'complete',
        );
        expect(events.filter((event) => event === 'invoke')).toHaveLength(1);
      },
    ));
  it('rejects permission denial, expiration and changed bindings before closing a view', async () =>
    fixture(async ({ coordinator, profile, adapter, events, advance }) => {
      const preview = await coordinator.preview(
        agent,
        profile.profileId,
        1,
        1,
        { kind: 'cache' },
      );
      profile.agentPermissions.allowClear = false;
      await expect(
        coordinator.commit(agent, randomUUID(), preview.token),
      ).rejects.toMatchObject({ code: 'agent_clear_denied' });
      profile.agentPermissions.allowClear = true;
      adapter.usage = (): ReturnType<BrowserMaintenanceAdapter['usage']> =>
        Promise.resolve({
          tabs: [
            {
              browserId: randomUUID(),
              projectId: 'project',
              worktreeId: 'task',
              runtimeGeneration: 1,
              taskIncarnationId: randomUUID(),
            },
          ],
          defaults: [],
        });
      await expect(
        coordinator.commit(agent, randomUUID(), preview.token),
      ).rejects.toMatchObject({ code: 'stale_revision' });
      advance();
      await expect(
        coordinator.commit(agent, randomUUID(), preview.token),
      ).rejects.toMatchObject({ code: 'operation_expired' });
      expect(events).toEqual([]);
    }));
  it('revocation during quiescence prevents invocation and resumes unchanged stores', async () =>
    fixture(async ({ coordinator, profile, jobs, adapter, events }) => {
      const preview = await coordinator.preview(
        agent,
        profile.profileId,
        1,
        1,
        { kind: 'site', origin: 'https://example.test' },
      );
      adapter.quiesce = (): ReturnType<
        BrowserMaintenanceAdapter['quiesce']
      > => {
        events.push('quiesce');
        profile.agentPermissions.allowClear = false;
        return Promise.resolve();
      };
      const id = randomUUID();
      await coordinator.commit(agent, id, preview.token);
      await coordinator.settled();
      expect(events).not.toContain('invoke');
      expect(events).toContain('resume');
      expect((await jobs.get(id, agent)).status).toBe('failed');
      expect((await jobs.getForExecution(id))?.irreversible).toBe(false);
    }));
  it('a denial at the final repository boundary cannot authorize replay on restart', async () =>
    fixture(async ({ coordinator, profile, jobs, adapter, events, root }) => {
      const preview = await coordinator.preview(
        agent,
        profile.profileId,
        1,
        1,
        { kind: 'cache' },
      );
      adapter.invoke = (): ReturnType<BrowserMaintenanceAdapter['invoke']> => {
        return Promise.reject(
          new BrowserProfileError(
            'agent_clear_denied',
            'Clear permission was revoked.',
          ),
        );
      };
      const id = randomUUID();
      await coordinator.commit(agent, id, preview.token);
      await coordinator.settled();
      expect((await jobs.getForExecution(id))?.irreversible).toBe(false);
      await new BrowserMaintenanceCoordinator(root, jobs, adapter).recover();
      expect(events).not.toContain('recover');
      expect(events).not.toContain('invoke');
    }));
  it('cancels while quiescing and never invokes destructive work', async () =>
    fixture(async ({ coordinator, profile, jobs, adapter, events }) => {
      const ready = deferred(),
        resume = deferred();
      adapter.quiesce = async (): ReturnType<
        BrowserMaintenanceAdapter['quiesce']
      > => {
        events.push('quiesce');
        ready.resolve();
        await resume.promise;
      };
      const preview = await coordinator.preview(user, profile.profileId, 1, 1, {
          kind: 'cache',
        }),
        id = randomUUID();
      await coordinator.commit(user, id, preview.token);
      await ready.promise;
      await jobs.cancel(id, user);
      resume.resolve();
      await coordinator.settled();
      expect(events).not.toContain('invoke');
      expect(events).toContain('resume');
      expect((await jobs.get(id, user)).status).toBe('cancelled');
    }));
  it('holds the profile after failed verification and recovers the exact intent before resuming', async () =>
    fixture(async ({ coordinator, profile, jobs, adapter, events, root }) => {
      const preview = await coordinator.preview(user, profile.profileId, 1, 1, {
          kind: 'site',
          origin: 'https://example.test',
        }),
        id = randomUUID();
      adapter.verifyCleared = (): ReturnType<
        BrowserMaintenanceAdapter['verifyCleared']
      > => {
        return Promise.reject(new Error('retained data'));
      };
      await coordinator.commit(user, id, preview.token);
      await coordinator.settled();
      expect((await jobs.get(id, user)).status).toBe('failed');
      expect((await jobs.getForExecution(id))?.irreversible).toBe(true);
      expect(events).not.toContain('unfence');
      expect(events).not.toContain('resume');
      adapter.verifyCleared = (): ReturnType<
        BrowserMaintenanceAdapter['verifyCleared']
      > => {
        events.push('verify');
        return Promise.resolve();
      };
      await new BrowserMaintenanceCoordinator(root, jobs, adapter).recover();
      expect(events).toContain('recover');
      expect(events).toContain('resume');
      expect((await jobs.get(id, user)).status).toBe('complete');
    }));
  it('fails unsupported native scopes before creating an irreversible intent', async () =>
    fixture(async ({ coordinator, profile, jobs, adapter, events }) => {
      const preview = await coordinator.preview(user, profile.profileId, 1, 1, {
          kind: 'site',
          origin: 'https://example.test',
        }),
        id = randomUUID();
      adapter.verifySupported = (): ReturnType<
        BrowserMaintenanceAdapter['verifySupported']
      > => {
        return Promise.reject(
          new BrowserProfileError(
            'unsupported_scope',
            'Unsupported storage partition.',
          ),
        );
      };
      await coordinator.commit(user, id, preview.token);
      await coordinator.settled();
      expect((await jobs.getForExecution(id))?.irreversible).toBe(false);
      expect(events).not.toContain('invoke');
      expect(events).toContain('resume');
    }));
  it('finishes a committed job through durable retirement without restoring the retired identity', async () =>
    fixture(async ({ coordinator, profile, jobs, adapter, events, root }) => {
      const preview = await coordinator.preview(user, profile.profileId, 1, 1, {
        kind: 'site',
        origin: 'https://example.test',
      });
      const id = randomUUID();
      adapter.verifyCleared = (): Promise<void> =>
        Promise.reject(new Error('verification interrupted'));
      await coordinator.commit(user, id, preview.token);
      await coordinator.settled();
      expect((await jobs.get(id, user)).retryable).toBe(true);
      adapter.retirement = (): Promise<{
        retired: boolean;
        cleanupPending: boolean;
      }> => Promise.resolve({ retired: true, cleanupPending: true });
      events.length = 0;
      await new BrowserMaintenanceCoordinator(root, jobs, adapter).recover();
      expect(await jobs.get(id, user)).toMatchObject({
        status: 'complete',
        cleanupPending: true,
      });
      expect(events).not.toContain('quiesce');
      expect(events).not.toContain('recover');
      expect(events).not.toContain('rebind');
      expect(events).not.toContain('resume');
    }));
});

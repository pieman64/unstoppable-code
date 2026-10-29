import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BrowserProfileRepository } from '../repository';
import type { BrowserTaskScope } from '@canopy/protocol/browser-profiles';

const scope: BrowserTaskScope = {
  kind: 'worktree',
  projectId: 'project-a',
  worktreeId: 'task-a',
};
const ownerCreatedAt = '2026-09-11T00:00:00.000Z';

describe('browser profile repository', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-repository-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists an unused catalog without allocating tasks or native storage', async () => {
    const repository = new BrowserProfileRepository(root);
    expect(await repository.list()).toEqual([]);
    expect(await repository.getTask(scope)).toBeNull();
    expect(await readdir(root)).not.toContain('task-slots');
  });

  it('never steals a live PID lease regardless of its age, then reclaims it after that process exits', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await once(child.stdout, 'data');
      const bytes = JSON.stringify({
        pid: child.pid,
        token: 'foreign-owner',
        createdAt: 0,
      });
      await writeFile(join(root, 'writer.lock'), bytes);
      const repository = new BrowserProfileRepository(root);
      await expect(
        repository.ensureTask(scope, ownerCreatedAt, randomUUID()),
      ).rejects.toMatchObject({ code: 'storage_unavailable' });
      expect(await readFile(join(root, 'writer.lock'), 'utf8')).toBe(bytes);
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      expect(
        await repository.ensureTask(scope, ownerCreatedAt, randomUUID()),
      ).toMatchObject({ kind: 'task' });
    } finally {
      child.kill();
    }
  });

  it('preserves malformed lock ownership instead of guessing that the writer is dead', async () => {
    await writeFile(
      join(root, 'writer.lock'),
      JSON.stringify({ pid: -1, token: 'unknown' }),
    );
    await expect(
      new BrowserProfileRepository(root).list(),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await readdir(root)).toContain('writer.lock');
  });

  it('serializes concurrent first use across repository instances and persists one incarnation', async () => {
    const first = new BrowserProfileRepository(root);
    const second = new BrowserProfileRepository(root);
    const profiles = await Promise.all([
      first.ensureTask(scope, ownerCreatedAt, randomUUID()),
      second.ensureTask(scope, ownerCreatedAt, randomUUID()),
    ]);
    expect(profiles[0]).toEqual(profiles[1]);
    expect(profiles[0].agentPermissions).toEqual({
      allowEnable: true,
      allowClear: false,
    });
    expect(await new BrowserProfileRepository(root).list()).toHaveLength(1);
    expect(await second.getTask(scope)).toMatchObject({
      taskProfileId: profiles[0].profileId,
      lifecycle: 'active',
    });
  });

  it('uses tagged owner identities, including tuples that collide in the legacy partition', async () => {
    const repository = new BrowserProfileRepository(root);
    const scopes: BrowserTaskScope[] = [
      { kind: 'worktree', projectId: 'a-b', worktreeId: 'c' },
      { kind: 'worktree', projectId: 'a', worktreeId: 'b-c' },
      { kind: 'cowork_work_entry', workspaceId: 'a', workEntryId: 'b-c' },
      { kind: 'app_advisor_work_entry', workEntryId: 'b-c' },
    ];
    const records = await Promise.all(
      scopes.map((owner) =>
        repository.ensureTask(owner, ownerCreatedAt, randomUUID()),
      ),
    );
    expect(new Set(records.map((record) => record.profileId)).size).toBe(4);
    const partitions = await Promise.all(
      records.map((record) =>
        repository.getNativePartition(
          record.profileId,
          record.storageGeneration,
        ),
      ),
    );
    expect(new Set(partitions).size).toBe(4);
  });

  it('W1 retains unresolved original legacy ownership across metadata-only creation and abort', async () => {
    const repository = new BrowserProfileRepository(root);
    const slot = await repository.ensureSlot(
      scope,
      ownerCreatedAt,
      randomUUID(),
    );
    expect(slot).toMatchObject({ legacyOwnershipResolved: false });
    const operationId = randomUUID();
    await repository.prepareRetirement(
      scope,
      ownerCreatedAt,
      operationId,
      'persist:canopy-browser-project-a-task-a',
    );
    await repository.abortRetirement(operationId);
    expect(await repository.getTask(scope)).toMatchObject({
      legacyOwnershipResolved: false,
    });
    const adopted = await repository.ensureTask(
      scope,
      ownerCreatedAt,
      randomUUID(),
      'persist:canopy-browser-project-a-task-a',
    );
    expect(
      await repository.getNativePartition(
        adopted.profileId,
        adopted.storageGeneration,
      ),
    ).toBe('persist:canopy-browser-project-a-task-a');
    expect(await repository.getTask(scope)).toMatchObject({
      legacyOwnershipResolved: true,
    });
  });

  it('W1 never accepts a legacy locator for a replacement incarnation after metadata-only restoration', async () => {
    const repository = new BrowserProfileRepository(root);
    const partition = 'persist:canopy-browser-project-a-task-a';
    await repository.ensureSlot(scope, ownerCreatedAt, randomUUID());
    const operationId = randomUUID();
    await repository.prepareRetirement(
      scope,
      ownerCreatedAt,
      operationId,
      partition,
    );
    await repository.commitRetirement(operationId, {
      kind: 'owner_removed',
      ownerOperationId: operationId,
    });
    const restoredAt = '2026-09-12T00:00:00.000Z';
    const restored = await repository.ensureSlot(
      scope,
      restoredAt,
      randomUUID(),
    );
    const profile = await repository.ensureTask(
      scope,
      restoredAt,
      randomUUID(),
      partition,
    );
    expect(
      await repository.getNativePartition(
        profile.profileId,
        profile.storageGeneration,
      ),
    ).not.toBe(partition);
    expect(restored).toMatchObject({ legacyOwnershipResolved: true });
  });

  it('W1 distinguishes old-format unresolved metadata from old-format restored metadata using retirement history', async () => {
    const repository = new BrowserProfileRepository(root);
    await repository.ensureSlot(scope, ownerCreatedAt, randomUUID());
    const [name] = await readdir(join(root, 'task-slots'));
    const slotPath = join(root, 'task-slots', name);
    const omitResolution = async (): Promise<void> => {
      const slot = JSON.parse(await readFile(slotPath, 'utf8')) as Record<
        string,
        unknown
      >;
      delete slot.legacyOwnershipResolved;
      await writeFile(slotPath, JSON.stringify(slot));
    };
    await omitResolution();
    expect(await repository.getTask(scope)).toMatchObject({
      legacyOwnershipResolved: false,
    });
    const id = randomUUID();
    await repository.prepareRetirement(scope, ownerCreatedAt, id);
    await repository.commitRetirement(id, {
      kind: 'owner_removed',
      ownerOperationId: id,
    });
    await repository.ensureSlot(scope, 'restored', randomUUID());
    await omitResolution();
    expect(await repository.getTask(scope)).toMatchObject({
      legacyOwnershipResolved: true,
    });
  });

  it('W1 fails closed when an indexed retired slot is missing instead of re-creating a legacy owner', async () => {
    const repository = new BrowserProfileRepository(root);
    await repository.ensureSlot(scope, ownerCreatedAt, randomUUID());
    const id = randomUUID();
    await repository.prepareRetirement(
      scope,
      ownerCreatedAt,
      id,
      'persist:canopy-browser-project-a-task-a',
    );
    await repository.commitRetirement(id, {
      kind: 'owner_removed',
      ownerOperationId: id,
    });
    const [name] = await readdir(join(root, 'task-slots'));
    await rm(join(root, 'task-slots', name));
    const before = await readFile(join(root, 'catalog.json'), 'utf8');
    await expect(
      repository.ensureSlot(scope, 'restored', randomUUID()),
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(await readFile(join(root, 'catalog.json'), 'utf8')).toBe(before);
  });

  it('replays matching operation IDs but rejects a changed payload', async () => {
    const repository = new BrowserProfileRepository(root);
    const operationId = randomUUID();
    const result = await repository.ensureTask(
      scope,
      ownerCreatedAt,
      operationId,
    );
    expect(
      await repository.ensureTask(scope, ownerCreatedAt, operationId),
    ).toEqual(result);
    await expect(
      repository.ensureTask(scope, 'new-owner', operationId),
    ).rejects.toMatchObject({ code: 'operation_conflict' });
  });

  it('fences prepared retirement without purging and can abort before owner commit', async () => {
    const repository = new BrowserProfileRepository(root);
    const profile = await repository.ensureTask(
      scope,
      ownerCreatedAt,
      randomUUID(),
    );
    const operationId = randomUUID();
    await repository.prepareRetirement(scope, ownerCreatedAt, operationId);
    expect(await repository.getCleanupJobs()).toEqual([]);
    await expect(
      repository.ensureTask(scope, ownerCreatedAt, randomUUID()),
    ).rejects.toMatchObject({ code: 'scope_retired' });
    await repository.abortRetirement(operationId);
    expect(
      await repository.ensureTask(scope, ownerCreatedAt, randomUUID()),
    ).toEqual(profile);
  });

  it('commits exact-generation cleanup and never reconnects a restored owner to retired storage', async () => {
    const repository = new BrowserProfileRepository(root);
    const original = await repository.ensureTask(
      scope,
      ownerCreatedAt,
      randomUUID(),
    );
    const oldPartition = await repository.getNativePartition(
      original.profileId,
      original.storageGeneration,
    );
    const operationId = randomUUID();
    await repository.prepareRetirement(scope, ownerCreatedAt, operationId);
    await repository.commitRetirement(operationId, {
      kind: 'owner_removed',
      ownerOperationId: 'archive-1',
    });
    await expect(repository.abortRetirement(operationId)).rejects.toMatchObject(
      { code: 'scope_retired' },
    );
    await expect(
      repository.ensureTask(scope, ownerCreatedAt, randomUUID()),
    ).rejects.toMatchObject({ code: 'scope_retired' });
    const restored = await repository.ensureTask(
      scope,
      '2026-09-12T00:00:00.000Z',
      randomUUID(),
    );
    expect(restored.profileId).not.toBe(original.profileId);
    expect(
      await repository.getNativePartition(
        restored.profileId,
        restored.storageGeneration,
      ),
    ).not.toBe(oldPartition);
    const [job] = await repository.getCleanupJobs();
    expect(job).toMatchObject({
      profileId: original.profileId,
      storageGeneration: original.storageGeneration,
      partition: oldPartition,
    });
    await expect(
      repository.retirementStatus(
        original.profileId,
        original.storageGeneration,
      ),
    ).resolves.toEqual({ retired: true, cleanupPending: true });
    await expect(
      repository.retirementStatus(
        restored.profileId,
        restored.storageGeneration,
      ),
    ).resolves.toEqual({ retired: false, cleanupPending: false });
    await expect(
      repository.retirementStatus(
        original.profileId,
        original.storageGeneration + 1,
      ),
    ).rejects.toMatchObject({ code: 'profile_unavailable' });
    await expect(
      repository.retirementStatus(randomUUID(), 1),
    ).rejects.toMatchObject({ code: 'profile_unavailable' });
    await expect(repository.get(original.profileId)).rejects.toMatchObject({
      code: 'profile_unavailable',
    });
    await repository.completeCleanup(job.jobId);
    await expect(
      repository.retirementStatus(
        original.profileId,
        original.storageGeneration,
      ),
    ).resolves.toEqual({ retired: true, cleanupPending: false });
    expect(
      await repository.ensureTask(
        scope,
        '2026-09-12T00:00:00.000Z',
        randomUUID(),
      ),
    ).toEqual(restored);
  });

  it('preserves unknown catalog versions and corrupt bytes', async () => {
    const repository = new BrowserProfileRepository(root);
    for (const bytes of [
      '{bad',
      JSON.stringify({ schemaVersion: 99, profiles: [] }),
    ]) {
      await writeFile(join(root, 'catalog.json'), bytes);
      await expect(
        repository.ensureTask(scope, ownerCreatedAt, randomUUID()),
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(await readFile(join(root, 'catalog.json'), 'utf8')).toBe(bytes);
    }
  });

  it('fails closed when two profiles claim the same native partition', async () => {
    const repository = new BrowserProfileRepository(root);
    const first = await repository.createNamed(randomUUID(), {
      displayName: 'First',
    });
    const second = await repository.createNamed(randomUUID(), {
      displayName: 'Second',
    });
    const catalog = JSON.parse(
      await readFile(join(root, 'catalog.json'), 'utf8'),
    ) as {
      profiles: Record<string, { partition: string }>;
    };
    catalog.profiles[second.profileId].partition =
      catalog.profiles[first.profileId].partition;
    await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog));

    await expect(repository.list()).rejects.toMatchObject({
      code: 'recovery_required',
    });
  });

  it.each(['journal', 'task', 'catalog', 'outcome'] as const)(
    'recovers a crash after the %s write without allocating a second profile',
    async (stage) => {
      let failed = false;
      const operationId = randomUUID();
      const repository = new BrowserProfileRepository(root, {
        checkpoint: (point): void => {
          if (point === stage && !failed) {
            failed = true;
            throw new Error('injected crash');
          }
        },
      });
      await expect(
        repository.ensureTask(scope, ownerCreatedAt, operationId),
      ).rejects.toThrow('injected crash');
      const recovered = new BrowserProfileRepository(root);
      const result = await recovered.ensureTask(
        scope,
        ownerCreatedAt,
        operationId,
      );
      expect(await recovered.list()).toEqual([result]);
      expect((await recovered.getTask(scope))?.taskProfileId).toBe(
        result.profileId,
      );
    },
  );

  it('does not grant permission or create a new native generation when replaying an expired operation', async () => {
    let now = 1_000;
    const repository = new BrowserProfileRepository(root, {
      now: (): number => now,
    });
    const operationId = randomUUID();
    await repository.ensureTask(scope, ownerCreatedAt, operationId);
    now += 8 * 24 * 60 * 60 * 1_000;
    await expect(
      repository.ensureTask(scope, ownerCreatedAt, operationId),
    ).rejects.toMatchObject({ code: 'operation_expired' });
    expect(await repository.list()).toHaveLength(1);
  });
});

describe('browser profile reset', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-reset-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resets a named profile into one fresh generation while preserving its identity and independent permissions', async () => {
    const repository = new BrowserProfileRepository(root);
    const original = await repository.createNamed(randomUUID(), {
      displayName: 'Work',
      color: '#123456',
      allowEnable: false,
      allowClear: true,
    });
    const oldPartition = await repository.getNativePartition(
      original.profileId,
      1,
    );
    await repository.recordNativePath(original.profileId, 1, '/owned/original');
    const request = {
      profileId: original.profileId,
      storageGeneration: 1,
      metadataRevision: original.metadataRevision,
    };
    const operationId = randomUUID();
    const result = await repository.resetProfile(operationId, request);
    expect(result.profile).toMatchObject({
      ...original,
      storageGeneration: 2,
      metadataRevision: original.metadataRevision + 1,
      updatedAt: expect.any(Number) as number,
    });
    expect(await repository.getNativePartition(original.profileId, 2)).not.toBe(
      oldPartition,
    );
    await expect(
      repository.getNativePartition(original.profileId, 1),
    ).rejects.toMatchObject({ code: 'profile_unavailable' });
    expect(await repository.getCleanupJobs()).toEqual([
      expect.objectContaining({
        jobId: result.cleanupJobId,
        profileId: original.profileId,
        storageGeneration: 1,
        partition: oldPartition,
        nativePath: '/owned/original',
      }),
    ]);
    expect(
      await new BrowserProfileRepository(root).resetProfile(
        operationId,
        request,
      ),
    ).toEqual(result);
    await repository.completeCleanup(result.cleanupJobId);
    expect(await repository.get(original.profileId)).toEqual(result.profile);
  });

  it('preserves the Task incarnation, default, and clear authority across reset', async () => {
    const repository = new BrowserProfileRepository(root);
    const task = await repository.ensureTask(
      scope,
      ownerCreatedAt,
      randomUUID(),
    );
    const permitted = await repository.updateProfile(
      randomUUID(),
      task.profileId,
      task.metadataRevision,
      { allowClear: true },
    );
    const named = await repository.createNamed(randomUUID(), {
      displayName: 'Default',
    });
    const slot = await repository.getTask(scope);
    if (!slot) throw new Error('Missing task slot');
    const saved = await repository.setDefault(
      randomUUID(),
      scope,
      slot.incarnationId,
      slot.metadataRevision,
      { kind: 'named', profileId: named.profileId },
    );
    const result = await repository.resetProfile(randomUUID(), {
      profileId: task.profileId,
      storageGeneration: task.storageGeneration,
      metadataRevision: permitted.metadataRevision,
    });
    expect(result.profile.agentPermissions).toEqual({
      allowEnable: true,
      allowClear: true,
    });
    expect(await repository.getTask(scope)).toMatchObject({
      incarnationId: saved.incarnationId,
      defaultSelection: saved.defaultSelection,
      taskProfileId: task.profileId,
      agentClearAllowed: true,
      lifecycle: 'active',
    });
    expect(
      (await repository.getTask(scope))?.nextStorageGeneration,
    ).toBeGreaterThan(result.profile.storageGeneration);
  });

  it('denies reset after clear revocation without allocating cleanup or changing storage', async () => {
    const repository = new BrowserProfileRepository(root);
    const slot = await repository.ensureSlot(
      scope,
      ownerCreatedAt,
      randomUUID(),
    );
    const original = await repository.createNamed(randomUUID(), {
      displayName: 'Work',
      allowClear: true,
    });
    const revoked = await repository.updateProfile(
      randomUUID(),
      original.profileId,
      original.metadataRevision,
      { allowClear: false },
    );
    await expect(
      repository.resetProfile(randomUUID(), {
        profileId: revoked.profileId,
        storageGeneration: revoked.storageGeneration,
        metadataRevision: revoked.metadataRevision,
        actor: { kind: 'agent', scope, incarnationId: slot.incarnationId },
      }),
    ).rejects.toMatchObject({ code: 'agent_clear_denied' });
    expect(await repository.get(revoked.profileId)).toEqual(revoked);
    expect(await repository.getCleanupJobs()).toEqual([]);
  });

  it.each(['journal', 'task', 'catalog', 'outcome'] as const)(
    'recovers reset after the %s write without resetting the new generation twice',
    async (stage) => {
      const repository = new BrowserProfileRepository(root);
      const profile = await repository.ensureTask(
        scope,
        ownerCreatedAt,
        randomUUID(),
      );
      const request = {
        profileId: profile.profileId,
        metadataRevision: profile.metadataRevision,
        storageGeneration: profile.storageGeneration,
      };
      const operationId = randomUUID();
      const failing = new BrowserProfileRepository(root, {
        checkpoint: (point): void => {
          if (point === stage) throw new Error('reset crash');
        },
      });
      await expect(failing.resetProfile(operationId, request)).rejects.toThrow(
        'reset crash',
      );
      const recovered = new BrowserProfileRepository(root);
      const result = await recovered.resetProfile(operationId, request);
      expect(result.profile.storageGeneration).toBe(
        profile.storageGeneration + 1,
      );
      expect(await recovered.getCleanupJobs()).toHaveLength(1);
      expect(await recovered.get(profile.profileId)).toEqual(result.profile);
      await expect(
        recovered.resetProfile(operationId, {
          ...request,
          storageGeneration: 2,
        }),
      ).rejects.toMatchObject({ code: 'operation_conflict' });
    },
  );

  it('records authorization only after the final permission check and retains newer settings during exact-generation recovery', async () => {
    const repository = new BrowserProfileRepository(root);
    const slot = await repository.ensureSlot(
      scope,
      ownerCreatedAt,
      randomUUID(),
    );
    const original = await repository.createNamed(randomUUID(), {
      displayName: 'Work',
      allowClear: true,
    });
    const request = {
      profileId: original.profileId,
      storageGeneration: 1,
      metadataRevision: original.metadataRevision,
      actor: {
        kind: 'agent' as const,
        scope,
        incarnationId: slot.incarnationId,
      },
    };
    const id = randomUUID();
    let authorized = false;
    await expect(
      repository.resetProfile(id, request, {
        beforeCommit: () => {
          authorized = true;
          return Promise.reject(
            new Error('process stopped after durable authorization'),
          );
        },
      }),
    ).rejects.toThrow('process stopped');
    expect(authorized).toBe(true);
    expect((await repository.get(original.profileId)).storageGeneration).toBe(
      1,
    );
    const revoked = await repository.updateProfile(
      randomUUID(),
      original.profileId,
      original.metadataRevision,
      { allowClear: false, color: '#223344' },
    );
    authorized = false;
    await expect(
      repository.resetProfile(
        randomUUID(),
        { ...request, metadataRevision: revoked.metadataRevision },
        {
          beforeCommit: () => {
            authorized = true;
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'agent_clear_denied' });
    expect(authorized).toBe(false);
    const recovered = await repository.resetProfile(id, request, {
      authorizedRecovery: true,
    });
    expect(recovered.profile).toMatchObject({
      storageGeneration: 2,
      color: '#223344',
      agentPermissions: { allowEnable: false, allowClear: false },
    });
    expect(await repository.getCleanupJobs()).toHaveLength(1);
    expect(
      await repository.resetProfile(id, request, { authorizedRecovery: true }),
    ).toEqual(recovered);
  });

  it('fences measurement publication by generation while allowing unrelated permission revisions', async () => {
    const repository = new BrowserProfileRepository(root);
    const original = await repository.createNamed(randomUUID(), {
      displayName: 'Measured',
    });
    await repository.updateProfile(
      randomUUID(),
      original.profileId,
      original.metadataRevision,
      { allowEnable: true },
    );
    expect(
      await repository.withActiveGeneration(original.profileId, 1, () =>
        Promise.resolve('published'),
      ),
    ).toBe('published');
    await repository.resetProfile(randomUUID(), {
      profileId: original.profileId,
      storageGeneration: 1,
      metadataRevision: (await repository.get(original.profileId))
        .metadataRevision,
    });
    let published = false;
    await expect(
      repository.withActiveGeneration(original.profileId, 1, () => {
        published = true;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: 'profile_unavailable' });
    expect(published).toBe(false);
  });
});

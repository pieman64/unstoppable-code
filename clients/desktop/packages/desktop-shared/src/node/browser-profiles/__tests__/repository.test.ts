import type * as NativeFs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BrowserProfileRepository } from '../repository';
import type {
  BrowserProfileRecord,
  BrowserTaskScope,
  BrowserTaskSlot,
} from '@canopy/protocol/browser-profiles';

// Match storage.test.ts: fault injection must not affect other suites' writers.
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof NativeFs>('node:fs/promises'),
}));
const nativeFs = jest.requireActual<typeof NativeFs>('node:fs/promises');
const profileFs = jest.requireMock<typeof NativeFs>('node:fs/promises');

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

  describe('recovery integrity', () => {
    interface TaskJournalFixture {
      schemaVersion: number;
      operationId: string;
      expectedRevision: number;
      catalog: {
        revision: number;
        taskKeys: string[];
        profiles: Record<string, { record: BrowserProfileRecord }>;
      };
      task: { key: string; slot: BrowserTaskSlot & { taskProfileId: string } };
      outcome: { digest: string; result?: unknown };
    }
    async function taskJournal(): Promise<TaskJournalFixture> {
      return JSON.parse(
        await readFile(join(root, 'transaction.json'), 'utf8'),
      ) as TaskJournalFixture;
    }

    async function stageTask(): Promise<string> {
      const id = randomUUID();
      const interrupted = new BrowserProfileRepository(root, {
        checkpoint: (point): void => {
          if (point === 'journal') throw new Error('staged');
        },
      });
      await expect(
        interrupted.ensureTask(scope, ownerCreatedAt, id),
      ).rejects.toThrow('staged');
      return id;
    }

    async function image(): Promise<Record<string, string>> {
      const files: Record<string, string> = {};
      async function visit(directory: string): Promise<void> {
        for (const entry of await nativeFs.readdir(join(root, directory), {
          withFileTypes: true,
        })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await visit(path);
          else files[path] = await nativeFs.readFile(join(root, path), 'utf8');
        }
      }
      await visit('');
      return files;
    }

    it.each([
      'long operation ID',
      'unsupported journal',
      'revision mismatch',
      'unindexed task',
      'mismatched task owner',
      'mismatched task lifecycle',
      'mismatched task permission',
      'missing profile',
      'invalid digest',
      'missing result',
      'missing indexed slot',
      'conflicting installed catalog',
      'conflicting receipt',
    ])('preserves every file when refusing %s', async (damage) => {
      await new BrowserProfileRepository(root).createNamed(randomUUID(), {
        displayName: 'Existing',
      });
      const id = await stageTask();
      const journalPath = join(root, 'transaction.json');
      const journal = await taskJournal();
      if (damage === 'long operation ID') journal.operationId = 'x'.repeat(201);
      if (damage === 'unsupported journal') journal.schemaVersion = 99;
      if (damage === 'revision mismatch') {
        journal.expectedRevision += 10;
        journal.catalog.revision += 10;
      }
      if (damage === 'unindexed task') journal.catalog.taskKeys = [];
      if (damage === 'mismatched task owner')
        journal.task.slot.incarnationId = 'wrong-incarnation';
      if (damage === 'mismatched task lifecycle')
        journal.catalog.profiles[
          journal.task.slot.taskProfileId
        ].record.lifecycle = 'retired';
      if (damage === 'mismatched task permission')
        journal.task.slot.agentClearAllowed = true;
      if (damage === 'missing profile')
        delete journal.catalog.profiles[journal.task.slot.taskProfileId];
      if (damage === 'invalid digest') journal.outcome.digest = 'not-a-digest';
      if (damage === 'missing result') delete journal.outcome.result;
      if (damage === 'missing indexed slot')
        journal.catalog.taskKeys.push('f'.repeat(64));
      if (damage === 'conflicting installed catalog') {
        const installed = structuredClone(journal.catalog);
        installed.profiles = {};
        await writeFile(join(root, 'catalog.json'), JSON.stringify(installed));
      }
      if (damage === 'conflicting receipt')
        await writeFile(
          join(root, 'operations', `${id}.json`),
          JSON.stringify({ ...journal.outcome, digest: 'a'.repeat(64) }),
        );
      await writeFile(journalPath, JSON.stringify(journal));
      const before = await image();
      const failure = await new BrowserProfileRepository(root).list().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(await image()).toEqual(before);
      expect(failure).toMatchObject({ code: 'recovery_required' });
    });

    it.each(['lifecycle', 'permission'])(
      'refuses an inconsistent unchanged slot %s before publishing a different task',
      async (damage) => {
        const otherScope: BrowserTaskScope = { ...scope, worktreeId: 'other' };
        const other = await new BrowserProfileRepository(root).ensureTask(
          otherScope,
          ownerCreatedAt,
          randomUUID(),
        );
        await stageTask();
        const path = join(root, 'transaction.json');
        const journal = await taskJournal();
        const record = journal.catalog.profiles[other.profileId].record;
        if (damage === 'lifecycle') record.lifecycle = 'cleanup_pending';
        else record.agentPermissions.allowClear = true;
        await writeFile(path, JSON.stringify(journal));
        const before = await image();
        const failure = await new BrowserProfileRepository(root)
          .list()
          .catch((error: unknown) => error);
        expect(await image()).toEqual(before);
        expect(failure).toMatchObject({ code: 'recovery_required' });
      },
    );

    it.each([
      'active',
      'reset',
      'prepared',
      'aborted',
      'committed',
      'cleaned',
      'replacement',
      'metadata-only',
    ])(
      'recovers with an unchanged %s slot and historical records',
      async (state) => {
        const repository = new BrowserProfileRepository(root);
        if (state === 'metadata-only') {
          await repository.ensureSlot(scope, ownerCreatedAt, randomUUID());
        } else {
          const profile = await repository.ensureTask(
            scope,
            ownerCreatedAt,
            randomUUID(),
          );
          if (state === 'reset')
            await repository.resetProfile(randomUUID(), profile);
          if (!['active', 'reset'].includes(state)) {
            const id = randomUUID();
            await repository.prepareRetirement(scope, ownerCreatedAt, id);
            if (state === 'aborted') await repository.abortRetirement(id);
            else if (state !== 'prepared') {
              await repository.commitRetirement(id, {
                kind: 'owner_removed',
                ownerOperationId: id,
              });
              if (state === 'cleaned') {
                for (const job of await repository.getCleanupJobs())
                  await repository.completeCleanup(job.jobId);
              }
              if (state === 'replacement')
                await repository.ensureTask(
                  scope,
                  'replacement-owner',
                  randomUUID(),
                );
            }
          }
        }
        const slot = await repository.getTask(scope);
        const profiles = await repository.list();
        const id = randomUUID();
        await expect(
          new BrowserProfileRepository(root, {
            checkpoint: (stage): void => {
              if (stage === 'journal') throw new Error('staged');
            },
          }).createNamed(id, { displayName: 'Unrelated' }),
        ).rejects.toThrow('staged');
        const recovered = new BrowserProfileRepository(root);
        const named = await recovered.createNamed(id, {
          displayName: 'Unrelated',
        });
        expect(await recovered.getTask(scope)).toEqual(slot);
        expect(await recovered.list()).toEqual([...profiles, named]);
        expect(await readdir(root)).not.toContain('transaction.json');
      },
    );

    it.each(['operations', 'task-slots'])(
      'preserves initial recovery evidence when %s enumeration is denied',
      async (directory) => {
        const id = await stageTask();
        const journal = await taskJournal();
        // An initial decision may already have installed its slot and receipt.
        await mkdir(join(root, 'operations'));
        await mkdir(join(root, 'task-slots'));
        await writeFile(
          join(root, 'operations', `${id}.json`),
          JSON.stringify(journal.outcome),
        );
        await writeFile(
          join(root, 'task-slots', `${journal.task.key}.json`),
          JSON.stringify(journal.task.slot),
        );
        const before = await image();
        const deniedPath = join(root, directory);
        const readdirSpy = jest
          .spyOn(profileFs, 'readdir')
          .mockImplementation(async (...args) => {
            if (args[0] === deniedPath)
              throw Object.assign(
                new Error('Injected namespace access denial'),
                { code: 'EACCES' },
              );
            return nativeFs.readdir(...args);
          });
        try {
          await expect(
            new BrowserProfileRepository(root).list(),
          ).rejects.toMatchObject({ code: 'recovery_required' });
          expect(readdirSpy).toHaveBeenCalledWith(deniedPath);
          expect(await image()).toEqual(before);
        } finally {
          readdirSpy.mockRestore();
        }
        const recovered = new BrowserProfileRepository(root);
        const profile = await recovered.ensureTask(scope, ownerCreatedAt, id);
        expect(await recovered.list()).toEqual([profile]);
        expect(await recovered.getTask(scope)).toEqual(journal.task.slot);
        expect(
          await readFile(join(root, 'operations', `${id}.json`), 'utf8'),
        ).toBe(`${JSON.stringify(journal.outcome)}\n`);
        expect(await readdir(root)).not.toContain('transaction.json');
      },
    );

    it.each(['EACCES', 'EPERM'])(
      'preserves the complete image when an indexed sidecar read fails with %s',
      async (code) => {
        const otherScope: BrowserTaskScope = {
          ...scope,
          worktreeId: 'other-task',
        };
        const original = await new BrowserProfileRepository(root).ensureTask(
          otherScope,
          ownerCreatedAt,
          randomUUID(),
        );
        const [slotName] = await readdir(join(root, 'task-slots'));
        const deniedPath = join(root, 'task-slots', slotName);
        const id = await stageTask();
        const before = await image();
        const readSpy = jest
          .spyOn(profileFs, 'readFile')
          .mockImplementation(async (...args) => {
            if (args[0] === deniedPath)
              throw Object.assign(
                new Error('Injected indexed sidecar access denial'),
                { code },
              );
            return nativeFs.readFile(...args);
          });
        try {
          await expect(
            new BrowserProfileRepository(root).ensureTask(
              scope,
              ownerCreatedAt,
              id,
            ),
          ).rejects.toMatchObject({ code: 'recovery_required' });
          expect(readSpy).toHaveBeenCalledWith(deniedPath, 'utf8');
          expect(await image()).toEqual(before);
        } finally {
          readSpy.mockRestore();
        }
        const recovered = new BrowserProfileRepository(root);
        const profile = await recovered.ensureTask(scope, ownerCreatedAt, id);
        expect(await recovered.list()).toEqual([original, profile]);
        expect((await recovered.getTask(scope))?.taskProfileId).toBe(
          profile.profileId,
        );
        expect(await readFile(deniedPath, 'utf8')).toBe(
          before[join('task-slots', slotName)],
        );
        expect(await readdir(root)).not.toContain('transaction.json');
      },
    );

    it('allows first use with empty sidecar directories', async () => {
      await mkdir(join(root, 'operations'));
      await mkdir(join(root, 'task-slots'));
      expect(await new BrowserProfileRepository(root).list()).toEqual([]);
      await expect(
        new BrowserProfileRepository(root).ensureTask(
          scope,
          ownerCreatedAt,
          randomUUID(),
        ),
      ).resolves.toMatchObject({ kind: 'task' });
    });

    it.each(['operations', 'task-slots'])(
      'preserves a non-directory %s when the catalog is absent',
      async (directory) => {
        await writeFile(join(root, directory), 'damaged directory');
        const before = await image();
        await expect(
          new BrowserProfileRepository(root).list(),
        ).rejects.toMatchObject({ code: 'recovery_required' });
        expect(await image()).toEqual(before);
      },
    );

    it('refuses a noninitial journal when the prior catalog is missing', async () => {
      await new BrowserProfileRepository(root).createNamed(randomUUID(), {
        displayName: 'Existing',
      });
      await stageTask();
      await rm(join(root, 'catalog.json'));
      const before = await image();
      await expect(
        new BrowserProfileRepository(root).list(),
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(await image()).toEqual(before);
    });

    it.each(
      ['receipt', 'task slot', 'expired receipt'].flatMap((evidence) =>
        ['read', 'replay', 'new write'].map((action) => ({ evidence, action })),
      ),
    )(
      'refuses $action after catalog loss with a surviving $evidence',
      async ({ evidence, action }) => {
        const id = randomUUID();
        const repository = new BrowserProfileRepository(root, {
          now: (): number => 1_000,
        });
        await repository.ensureTask(scope, ownerCreatedAt, id);
        await rm(join(root, 'catalog.json'));
        if (evidence === 'task slot')
          await rm(join(root, 'operations'), { recursive: true });
        else await rm(join(root, 'task-slots'), { recursive: true });
        const before = await image();
        const recovered = new BrowserProfileRepository(root, {
          now: (): number =>
            evidence === 'expired receipt' ? 9 * 24 * 60 * 60 * 1_000 : 1_000,
        });
        const result =
          action === 'read'
            ? recovered.list()
            : recovered.ensureTask(
                scope,
                ownerCreatedAt,
                action === 'replay' ? id : randomUUID(),
              );
        const failure = await result.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(await image()).toEqual(before);
        expect(failure).toMatchObject({ code: 'recovery_required' });
      },
    );

    it('refuses initial-journal recovery over unrelated surviving receipts', async () => {
      await new BrowserProfileRepository(root).createNamed(randomUUID(), {
        displayName: 'Old',
      });
      const old = await image();
      await rm(root, { recursive: true });
      await stageTask();
      const receipt = Object.keys(old).find(
        (path) => dirname(path) === 'operations',
      );
      if (!receipt) throw new Error('Expected an existing receipt');
      await mkdir(join(root, 'operations'));
      await writeFile(join(root, receipt), old[receipt]);
      const before = await image();
      await expect(
        new BrowserProfileRepository(root).list(),
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(await image()).toEqual(before);
    });

    // Termination between an atomic write's temporary file and its rename:
    // neither the rename nor the writer's cleanup runs.
    async function abandonSlotWrite(
      run: () => Promise<unknown>,
    ): Promise<void> {
      const slots = join(root, 'task-slots');
      const abandoned = (path: unknown): boolean =>
        typeof path === 'string' &&
        dirname(path) === slots &&
        path.endsWith('.tmp');
      const renameSpy = jest
        .spyOn(profileFs, 'rename')
        .mockImplementation(async (...args) => {
          if (abandoned(args[0]))
            throw Object.assign(new Error('Injected termination'), {
              code: 'EIO',
            });
          return nativeFs.rename(...args);
        });
      const rmSpy = jest
        .spyOn(profileFs, 'rm')
        .mockImplementation(async (...args) => {
          if (abandoned(args[0])) throw new Error('Injected termination');
          return nativeFs.rm(...args);
        });
      // The repository's durable writer cleans up with unlink.
      const unlinkSpy = jest
        .spyOn(profileFs, 'unlink')
        .mockImplementation(async (...args) => {
          if (abandoned(args[0])) throw new Error('Injected termination');
          return nativeFs.unlink(...args);
        });
      try {
        await expect(run()).rejects.toThrow('Injected termination');
      } finally {
        renameSpy.mockRestore();
        rmSpy.mockRestore();
        unlinkSpy.mockRestore();
      }
    }

    it.each(['first use', 'initial recovery', 'installed slot'])(
      'recovers an initial journal after %s left an unpublished slot write',
      async (interrupted) => {
        let id: string = randomUUID();
        const repository = new BrowserProfileRepository(root);
        if (interrupted === 'initial recovery') {
          id = await stageTask();
          await abandonSlotWrite(() => repository.list());
        } else
          await abandonSlotWrite(() =>
            repository.ensureTask(scope, ownerCreatedAt, id),
          );
        const journal = await taskJournal();
        const temporary: unknown = expect.stringMatching(
          new RegExp(
            `^\\.${journal.task.key}\\.json\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`,
          ),
        );
        if (interrupted === 'installed slot')
          await expect(
            new BrowserProfileRepository(root, {
              checkpoint: (point): void => {
                if (point === 'task') throw new Error('staged');
              },
            }).list(),
          ).rejects.toThrow('staged');
        expect(journal.expectedRevision).toBe(0);
        expect(await readdir(root)).not.toContain('catalog.json');
        expect((await readdir(join(root, 'task-slots'))).sort()).toEqual(
          interrupted === 'installed slot'
            ? [temporary, `${journal.task.key}.json`]
            : [temporary],
        );
        const recovered = new BrowserProfileRepository(root);
        const profile = await recovered.ensureTask(scope, ownerCreatedAt, id);
        expect(await recovered.list()).toEqual([profile]);
        expect(await recovered.getTask(scope)).toEqual(journal.task.slot);
        expect(await readdir(root)).not.toContain('transaction.json');
      },
    );

    it.each(['another task', 'no journal', 'near-miss name', 'own receipt'])(
      'refuses an unpublished write for %s when the catalog is absent',
      async (evidence) => {
        const id = await stageTask();
        const journal = await taskJournal();
        const writerSuffix = `.${process.pid}.${randomUUID()}.tmp`;
        // Receipts are written only after the catalog, so no initial
        // recovery can leave one unrenamed.
        const [directory, name] =
          evidence === 'own receipt'
            ? ['operations', `${id}.json${writerSuffix}`]
            : evidence === 'another task'
              ? ['task-slots', `${'f'.repeat(64)}.json${writerSuffix}`]
              : evidence === 'near-miss name'
                ? ['task-slots', `${journal.task.key}.json.tmp`]
                : ['task-slots', `${journal.task.key}.json${writerSuffix}`];
        if (evidence === 'no journal') await rm(join(root, 'transaction.json'));
        await mkdir(join(root, directory));
        await writeFile(
          join(root, directory, name),
          JSON.stringify(journal.task.slot),
        );
        const before = await image();
        await expect(
          new BrowserProfileRepository(root).list(),
        ).rejects.toMatchObject({ code: 'recovery_required' });
        expect(await image()).toEqual(before);
      },
    );

    it.each(['task', 'catalog', 'outcome'] as const)(
      'resumes after interruption during recovery at %s without changing the decision',
      async (stage) => {
        const id = await stageTask();
        const journal = await readFile(join(root, 'transaction.json'), 'utf8');
        const interrupted = new BrowserProfileRepository(root, {
          checkpoint: (point): void => {
            if (point === stage) throw new Error('recovery interrupted');
          },
        });
        await expect(interrupted.list()).rejects.toThrow(
          'recovery interrupted',
        );
        expect(await readFile(join(root, 'transaction.json'), 'utf8')).toBe(
          journal,
        );
        const recovered = new BrowserProfileRepository(root);
        const result = await recovered.ensureTask(scope, ownerCreatedAt, id);
        expect(await recovered.list()).toEqual([result]);
        expect((await recovered.getTask(scope))?.taskProfileId).toBe(
          result.profileId,
        );
        expect(await readdir(root)).not.toContain('transaction.json');
        expect(await readdir(join(root, 'operations'))).toEqual([`${id}.json`]);
      },
    );

    it('recovers and replays the maximum-length operation ID', async () => {
      const id = 'x'.repeat(200);
      const interrupted = new BrowserProfileRepository(root, {
        checkpoint: (): never => {
          throw new Error('staged');
        },
      });
      await expect(
        interrupted.ensureTask(scope, ownerCreatedAt, id),
      ).rejects.toThrow('staged');
      const recovered = new BrowserProfileRepository(root);
      const result = await recovered.ensureTask(scope, ownerCreatedAt, id);
      expect(await recovered.ensureTask(scope, ownerCreatedAt, id)).toEqual(
        result,
      );
      expect(await recovered.list()).toEqual([result]);
    });
  });

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

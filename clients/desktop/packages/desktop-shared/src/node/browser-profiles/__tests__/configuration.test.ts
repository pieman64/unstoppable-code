import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserTaskScope } from '@canopy/protocol/browser-profiles';
import { BrowserProfileRepository } from '../repository';

const scope: BrowserTaskScope = {
  kind: 'cowork_work_entry',
  workspaceId: 'workspace',
  workEntryId: 'entry',
};
const createdAt = '2026-09-11T00:00:00.000Z';

describe('named profile configuration', () => {
  let root: string;
  let repository: BrowserProfileRepository;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'named-profiles-'));
    repository = new BrowserProfileRepository(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates an empty named profile without allocating a Task or native store', async () => {
    const profile = await repository.createNamed(randomUUID(), {
      displayName: 'Work',
    });
    expect(profile).toMatchObject({
      kind: 'named',
      displayName: 'Work',
      storageGeneration: 1,
      agentPermissions: { allowEnable: false, allowClear: false },
    });
    expect(await repository.listTaskSlots()).toEqual([]);
    expect(await readdir(root)).not.toContain('Partitions');
    expect(
      await new BrowserProfileRepository(root).get(profile.profileId),
    ).toEqual(profile);
  });

  it('persists independent permissions and fences stale metadata revisions', async () => {
    const profile = await repository.createNamed(randomUUID(), {
      displayName: 'Personal',
    });
    const operationId = randomUUID();
    const updated = await repository.updateProfile(
      operationId,
      profile.profileId,
      profile.metadataRevision,
      { displayName: 'Work', allowEnable: true, allowClear: false },
    );
    expect(updated.metadataRevision).toBe(profile.metadataRevision + 1);
    expect(updated.agentPermissions).toEqual({
      allowEnable: true,
      allowClear: false,
    });
    expect(
      await repository.updateProfile(
        operationId,
        profile.profileId,
        profile.metadataRevision,
        { displayName: 'Work', allowEnable: true, allowClear: false },
      ),
    ).toEqual(updated);
    await expect(
      repository.updateProfile(
        randomUUID(),
        profile.profileId,
        profile.metadataRevision,
        { allowClear: true },
      ),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(
      await new BrowserProfileRepository(root).get(profile.profileId),
    ).toEqual(updated);
  });

  it('keeps Task enable fixed on and atomically projects its slot clear permission', async () => {
    const profile = await repository.ensureTask(scope, createdAt, randomUUID());
    await expect(
      repository.updateProfile(
        randomUUID(),
        profile.profileId,
        profile.metadataRevision,
        { allowEnable: false },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const updated = await repository.updateProfile(
      randomUUID(),
      profile.profileId,
      profile.metadataRevision,
      { allowClear: true },
    );
    expect(updated.agentPermissions).toEqual({
      allowEnable: true,
      allowClear: true,
    });
    expect(await repository.getTask(scope)).toMatchObject({
      agentClearAllowed: true,
    });
    expect(
      await new BrowserProfileRepository(root).get(profile.profileId),
    ).toEqual(updated);
  });

  it('changes the task default without allocating a Task profile or changing enable permission', async () => {
    const named = await repository.createNamed(randomUUID(), {
      displayName: 'Work',
    });
    const slot = await repository.ensureSlot(scope, createdAt, randomUUID());
    const next = await repository.setDefault(
      randomUUID(),
      scope,
      slot.incarnationId,
      slot.metadataRevision,
      { kind: 'named', profileId: named.profileId },
    );
    expect(next.taskProfileId).toBeUndefined();
    expect(next.defaultSelection).toEqual({
      kind: 'named',
      profileId: named.profileId,
    });
    expect(
      (await repository.get(named.profileId)).agentPermissions.allowEnable,
    ).toBe(false);
    await expect(
      repository.setDefault(
        randomUUID(),
        scope,
        'stale-incarnation',
        next.metadataRevision,
        { kind: 'task' },
      ),
    ).rejects.toMatchObject({ code: 'scope_retired' });
  });

  it('tombstones only the selected named profile and keeps its defaults explicitly unavailable', async () => {
    const named = await repository.createNamed(randomUUID(), {
      displayName: 'Work',
    });
    const task = await repository.ensureTask(scope, createdAt, randomUUID());
    const slot = await repository.getTask(scope);
    if (!slot) throw new Error('Missing Task slot');
    await repository.setDefault(
      randomUUID(),
      scope,
      slot.incarnationId,
      slot.metadataRevision,
      { kind: 'named', profileId: named.profileId },
    );
    await repository.deleteNamed(
      randomUUID(),
      named.profileId,
      named.metadataRevision,
    );
    await expect(repository.get(named.profileId)).rejects.toMatchObject({
      code: 'profile_unavailable',
    });
    expect(await repository.get(task.profileId)).toEqual(task);
    expect((await repository.getTask(scope))?.defaultSelection).toEqual({
      kind: 'named',
      profileId: named.profileId,
    });
    expect(await repository.getCleanupJobs()).toEqual([
      expect.objectContaining({
        profileId: named.profileId,
        storageGeneration: 1,
      }),
    ]);
    await expect(
      repository.deleteNamed(
        randomUUID(),
        task.profileId,
        task.metadataRevision,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects prototype keys as unavailable profiles without interpreting inherited object properties', async () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      await expect(repository.get(key)).rejects.toMatchObject({
        code: 'profile_unavailable',
      });
    }
  });
});

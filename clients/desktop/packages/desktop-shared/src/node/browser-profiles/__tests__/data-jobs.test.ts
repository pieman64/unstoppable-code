import type * as NativeFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserDataJobs } from '../data-jobs';
import type { BrowserDataActor } from '@canopy/protocol/browser-profiles';
const user: BrowserDataActor = { kind: 'user' };
const agent: BrowserDataActor = {
  kind: 'agent',
  taskScope: { kind: 'worktree', projectId: 'project', worktreeId: 'task' },
  taskIncarnationId: randomUUID(),
};
const input = (): {
  kind: 'site';
  profileId: string;
  storageGeneration: number;
} => ({
  kind: 'site' as const,
  profileId: randomUUID(),
  storageGeneration: 1,
});
async function fixture(
  action: (jobs: BrowserDataJobs, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'browser-data-jobs-test-'));
  try {
    await action(new BrowserDataJobs(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
describe('browser durable data jobs', () => {
  it('publishes queued to running after one rename denial without replacing captured identity or intent', async () =>
    fixture(async (_jobs, root) => {
      const jobs = new BrowserDataJobs(root, () => 1000);
      const id = randomUUID();
      const value = { ...input(), kind: 'reset' as const };
      const intent = { token: randomUUID(), operation: { kind: 'reset' } };
      const queued = await jobs.create(id, value, agent, intent);
      const target = join(root, 'records', `${id}.json`);
      const before = await readFile(target, 'utf8');
      const captured = await jobs.getForExecution(id);
      const nativeFs = jest.requireActual<typeof NativeFs>('node:fs/promises');
      const rename = nativeFs.rename;
      const attempts: { source: string; contents: string }[] = [];
      const renameSpy = jest
        .spyOn(nativeFs, 'rename')
        .mockImplementation(async (source, destination) => {
          if (destination === target) {
            const contents = await readFile(source, 'utf8');
            expect(JSON.parse(contents)).toMatchObject({
              job: { ...queued, status: 'running' },
            });
            expect(await readFile(target, 'utf8')).toBe(before);
            attempts.push({ source: String(source), contents });
            if (attempts.length === 1)
              throw Object.assign(
                new Error('Injected queued-to-running rename denial'),
                { code: 'EPERM' },
              );
          }
          await rename(source, destination);
        });
      try {
        await expect(
          jobs.update(id, ['queued'], { status: 'running' }),
        ).resolves.toMatchObject({
          ...queued,
          status: 'running',
        });
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toEqual(attempts[0]);
        expect(await jobs.getForExecution(id)).toEqual({
          ...captured,
          job: { ...queued, status: 'running' },
        });
        const restarted = new BrowserDataJobs(root, () => 1000);
        expect(await restarted.create(id, value, agent, intent)).toMatchObject({
          jobId: id,
          status: 'running',
        });
        expect(await readdir(join(root, 'records'))).toEqual([`${id}.json`]);
      } finally {
        renameSpy.mockRestore();
      }
    }));

  it('replays exact IDs without leaking internal intents and rejects a changed operation', async () =>
    fixture(async (jobs) => {
      const id = randomUUID(),
        value = input();
      const job = await jobs.create(id, value, agent, {
        token: 'private-intent',
        operation: { b: 2, a: 1 },
      });
      expect(
        await jobs.create(id, value, agent, {
          operation: { a: 1, b: 2 },
          token: 'private-intent',
        }),
      ).toEqual(job);
      expect(JSON.stringify(await jobs.get(id, agent))).not.toContain(
        'private-intent',
      );
      await expect(jobs.create(id, value, user, {})).rejects.toMatchObject({
        code: 'operation_conflict',
      });
    }));
  it('requires the original captured task incarnation even after current focus changes', async () =>
    fixture(async (jobs) => {
      const id = randomUUID();
      await jobs.create(id, input(), agent, {});
      const other = {
        ...agent,
        taskIncarnationId: randomUUID(),
      } as BrowserDataActor;
      await expect(jobs.get(id, other)).rejects.toMatchObject({
        code: 'scope_unresolved',
      });
      await expect(jobs.cancel(id, other)).rejects.toMatchObject({
        code: 'scope_unresolved',
      });
      expect((await jobs.list(other)).jobs).toEqual([]);
      expect((await jobs.get(id, user)).jobId).toBe(id);
    }));
  it('serializes cancellation against the irreversible boundary across instances', async () =>
    fixture(async (jobs, root) => {
      const id = randomUUID();
      await jobs.create(id, input(), agent, {});
      const other = new BrowserDataJobs(root);
      await jobs.update(id, ['queued'], {
        status: 'irreversible',
        cancellable: false,
      });
      await expect(other.cancel(id, user)).rejects.toMatchObject({
        code: 'operation_conflict',
      });
      await expect(
        other.update(id, ['irreversible'], {
          status: 'running',
          cancellable: true,
        }),
      ).rejects.toMatchObject({ code: 'operation_conflict' });
      expect((await jobs.get(id, agent)).status).toBe('irreversible');
      await jobs.update(id, ['irreversible'], { status: 'failed' });
      await expect(
        other.update(id, ['failed'], { status: 'running', cancellable: true }),
      ).rejects.toMatchObject({ code: 'operation_conflict' });
    }));
  it('does not hide an intent across restart or revive a completed receipt', async () =>
    fixture(async (jobs, root) => {
      const id = randomUUID(),
        value = input();
      await jobs.create(id, value, agent, { origin: 'https://example.test' });
      await jobs.update(id, ['queued'], {
        status: 'irreversible',
        cancellable: false,
      });
      const restarted = new BrowserDataJobs(root);
      expect(await restarted.recoveryRecords()).toEqual([
        expect.objectContaining({ intent: { origin: 'https://example.test' } }),
      ]);
      await restarted.update(id, ['irreversible'], { status: 'complete' });
      expect(await restarted.recoveryRecords()).toEqual([]);
      expect(
        (
          await restarted.create(id, value, agent, {
            origin: 'https://example.test',
          })
        ).status,
      ).toBe('complete');
    }));
  it('recovers an index reservation interrupted before its record write without duplicating the ID', async () =>
    fixture(async (jobs, root) => {
      const id = randomUUID();
      await writeFile(
        join(root, 'index.json'),
        JSON.stringify({ schemaVersion: 1, ids: [id] }),
      );
      await jobs.create(id, input(), user, {});
      expect((await jobs.list(user)).jobs).toHaveLength(1);
      expect(
        (
          JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as {
            ids: string[];
          }
        ).ids,
      ).toEqual([id]);
    }));
  it('preserves future/corrupt records and never returns them as empty', async () =>
    fixture(async (jobs, root) => {
      const id = randomUUID();
      await jobs.create(id, input(), user, {});
      const path = join(root, 'records', `${id}.json`),
        raw = '{"schemaVersion":999,"retained":"evidence"}';
      await writeFile(path, raw);
      await expect(jobs.get(id, user)).rejects.toMatchObject({
        code: 'recovery_required',
      });
      await expect(jobs.recoveryRecords()).rejects.toMatchObject({
        code: 'recovery_required',
      });
      expect(await readFile(path, 'utf8')).toBe(raw);
    }));
  it('compacts expired results without reusing IDs or losing a completed inventory attestation', async () =>
    fixture(async (_jobs, root) => {
      let now = 1000;
      const jobs = new BrowserDataJobs(root, () => now);
      const id = randomUUID(),
        value = { ...input(), kind: 'inventory' as const };
      const intent = { privateScope: 'https://synthetic.test' };
      await jobs.create(id, value, user, intent);
      await jobs.update(id, ['queued'], {
        status: 'complete',
        cancellable: false,
      });
      now += 7 * 86400_000 + 1;
      await jobs.compact();
      expect(
        await readFile(join(root, 'records', `${id}.json`), 'utf8'),
      ).not.toContain('synthetic.test');
      expect((await jobs.list(user)).jobs).toEqual([]);
      await expect(jobs.create(id, value, user, intent)).rejects.toMatchObject({
        code: 'operation_expired',
      });
      await expect(jobs.get(id, user)).rejects.toThrow('expired');
      expect(await jobs.completed(id, value.profileId, 1)).toBe(true);
      expect(await jobs.completed(id, value.profileId, 2)).toBe(false);
    }));
  it('never expires an irreversible failure awaiting recovery', async () =>
    fixture(async (_jobs, root) => {
      let now = 1000;
      const jobs = new BrowserDataJobs(root, () => now),
        id = randomUUID();
      await jobs.create(id, input(), agent, { recovery: 'required' });
      await jobs.update(id, ['queued'], {
        status: 'irreversible',
        cancellable: false,
      });
      await jobs.update(id, ['irreversible'], {
        status: 'failed',
        retryable: true,
      });
      now += 30 * 86400_000;
      await jobs.compact();
      expect(await jobs.recoveryRecords()).toEqual([
        expect.objectContaining({ intent: { recovery: 'required' } }),
      ]);
    }));
});

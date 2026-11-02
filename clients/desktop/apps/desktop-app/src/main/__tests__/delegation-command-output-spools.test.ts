import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCommandOutputSpools,
  createDefaultCommandOutputSpools,
  type CommandSpoolOperation,
  type DelegationCommandSpools,
} from '../agents/delegation/command-output-spools';
import { FieldSpool } from '../lib/chat-transcript-field-spool';
import * as paths from '../lib/paths';

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {
    throw new Error('Gate not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('delegation command output spool owner', () => {
  let root: string;
  let owners: DelegationCommandSpools[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'delegation-command-spools-'));
    owners = [];
  });
  afterEach(async () => {
    await Promise.allSettled(owners.map((owner) => owner.close()));
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  function owner(
    before?: (operation: CommandSpoolOperation, key: string) => Promise<void>,
  ): DelegationCommandSpools {
    const result = createCommandOutputSpools({
      root: () => root,
      ...(before ? { faults: { before } } : {}),
    });
    owners.push(result);
    return result;
  }

  it.each([
    ['ASCII', ['first', '\nsecond']],
    ['multibyte', ['界 café ', '🌲']],
    ['split surrogate pair', ['prefix \uD83D', '', '\uDE00 suffix']],
    ['final lone surrogate', ['prefix', '\uD800']],
    ['empty body', []],
  ])('round trips exact %s and reads only once', async (_label, chunks) => {
    const strings = jest.spyOn(FieldSpool.prototype, 'strings');
    const finish = jest.spyOn(FieldSpool.prototype, 'finish');
    const spools = owner();
    const spool = await spools.acquire('opaque');
    for (const chunk of chunks) await spool.append(chunk);
    expect(await spool.read()).toBe(chunks.join(''));
    expect(await spool.read()).toBe(chunks.join(''));
    expect(strings).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    await expect(spool.append('late')).rejects.toThrow();
    await spools.close();
    expect(await readdir(root)).toEqual([]);
  });

  it('round trips more than 1 MiB in ordered 4 KiB appends', async () => {
    const spool = await owner().acquire('large');
    const body = 'x界🌲\n'.repeat(230_000);
    expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);
    const appends: Promise<void>[] = [];
    for (let start = 0; start < body.length; start += 4096)
      appends.push(spool.append(body.slice(start, start + 4096)));
    await Promise.all(appends);
    expect(await spool.read()).toBe(body);
  });

  it('creates lazily, reuses live keys and never uses opaque keys in paths', async () => {
    const first = owner();
    expect(await readdir(root)).toEqual([]);
    const key = '../../untrusted/\u0000:key';
    const [a, b] = await Promise.all([first.acquire(key), first.acquire(key)]);
    expect(a).toBe(b);
    const directories = await readdir(root);
    expect(directories).toHaveLength(1);
    expect(directories[0]).toMatch(/^[a-f\d-]{36}$/);
    const files = await readdir(join(root, directories[0]));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\.[a-f\d-]{36}\.tmp$/);
  });

  it('isolates owners and discard removes only its own file, allowing replacement', async () => {
    const first = owner();
    const second = owner();
    const a = await first.acquire('same');
    const b = await first.acquire('other');
    const c = await second.acquire('same');
    await Promise.all([a.append('a'), b.append('b'), c.append('c')]);
    const paths = await readdir(root);
    expect(paths).toHaveLength(2);
    await a.discard();
    await a.discard();
    await expect(a.read()).rejects.toThrow();
    expect(
      (
        await Promise.all(paths.map((path) => readdir(join(root, path))))
      ).flat(),
    ).toHaveLength(2);
    const replacement = await first.acquire('same');
    expect(replacement).not.toBe(a);
    await replacement.append('replacement');
    expect(await replacement.read()).toBe('replacement');
    expect(await b.read()).toBe('b');
    await first.close();
    expect(await readdir(root)).toHaveLength(1);
    expect(await c.read()).toBe('c');
    await second.close();
    expect(await readdir(root)).toEqual([]);
  });

  it('shares concurrent close work, drains append and closes sequentially before removal', async () => {
    const appendEntered = gate();
    const appendGate = gate();
    const closeEntered = gate();
    const closeGate = gate();
    const events: string[] = [];
    const close = jest.spyOn(FieldSpool.prototype, 'close');
    const first = owner(async (operation, key) => {
      events.push(`${operation}:${key}`);
      if (operation === 'append') {
        appendEntered.release();
        await appendGate.promise;
      }
      if (operation === 'close' && key === 'one') {
        closeEntered.release();
        await closeGate.promise;
      }
      if (operation === 'remove') expect(close).toHaveBeenCalledTimes(2);
    });
    const a = await first.acquire('one');
    await first.acquire('two');
    const append = a.append('pending');
    await appendEntered.promise;
    const closing = first.close();
    expect(first.close()).toBe(closing);
    await expect(a.read()).rejects.toThrow();
    await expect(a.append('late')).rejects.toThrow();
    await expect(a.discard()).rejects.toThrow();
    await expect(first.acquire('late')).rejects.toThrow();
    expect(events).not.toContain('close:one');
    appendGate.release();
    await append;
    await closeEntered.promise;
    expect(close).not.toHaveBeenCalled();
    expect(events).not.toContain('close:two');
    expect(await readdir(root)).toHaveLength(1);
    closeGate.release();
    await closing;
    await first.close();
    expect(close).toHaveBeenCalledTimes(2);
    expect(events.slice(-3)).toEqual(['close:one', 'close:two', 'remove:']);
    expect(await readdir(root)).toEqual([]);
  });

  it('shares an in-flight read and drains it before owner close', async () => {
    const entered = gate();
    const blocked = gate();
    const close = jest.spyOn(FieldSpool.prototype, 'close');
    const strings = jest.spyOn(FieldSpool.prototype, 'strings');
    const first = owner(async (operation) => {
      if (operation === 'read') {
        entered.release();
        await blocked.promise;
      }
    });
    const spool = await first.acquire('one');
    await spool.append('exact body');
    const reading = spool.read();
    expect(spool.read()).toBe(reading);
    await entered.promise;
    const closing = first.close();
    expect(close).not.toHaveBeenCalled();
    expect(strings).not.toHaveBeenCalled();
    blocked.release();
    expect(await reading).toBe('exact body');
    await closing;
    expect(strings).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('closes an unused owner without resolving or creating the root', async () => {
    const resolver = jest.fn(() => join(root, 'absent'));
    const first = createCommandOutputSpools({ root: resolver });
    await first.close();
    expect(resolver).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it.each<CommandSpoolOperation>([
    'create',
    'append',
    'finish',
    'read',
    'close',
    'remove',
  ])(
    'preserves a %s hook failure, releases handles and still closes other spools',
    async (fault) => {
      const error = new Error(`injected ${fault}`);
      const close = jest.spyOn(FieldSpool.prototype, 'close');
      const events: string[] = [];
      let injected = false;
      const first = owner((operation, key) => {
        events.push(`${operation}:${key}`);
        if (operation === fault && key !== 'healthy' && !injected) {
          injected = true;
          return Promise.reject(error);
        }
        return Promise.resolve();
      });
      const healthy = await first.acquire('healthy');
      await healthy.append('healthy');
      if (fault === 'create') {
        await expect(first.acquire('broken')).rejects.toBe(error);
      } else {
        const broken = await first.acquire('broken');
        if (fault === 'append')
          await expect(broken.append('bad')).rejects.toBe(error);
        if (fault === 'finish' || fault === 'read')
          await expect(broken.read()).rejects.toBe(error);
        if (fault === 'remove')
          await expect(broken.discard()).rejects.toBe(error);
        if (fault === 'close') await expect(first.close()).rejects.toBe(error);
        if (fault !== 'close')
          expect(close).toHaveBeenCalledTimes(fault === 'remove' ? 1 : 0);
      }
      if (fault !== 'close') await first.close();
      else await expect(first.close()).rejects.toBe(error);
      expect(close).toHaveBeenCalledTimes(fault === 'create' ? 1 : 2);
      expect(events).toContain('close:healthy');
      expect(await readdir(root)).toEqual([]);
    },
  );

  it.each<CommandSpoolOperation>(['append', 'finish', 'read'])(
    'delivers %s failure to the caller before any close, then closes failed and healthy handles',
    async (fault) => {
      const original = new Error(`required ${fault}`);
      const events: string[] = [];
      const close = jest.spyOn(FieldSpool.prototype, 'close');
      const first = owner((operation, key) => {
        events.push(`${operation}:${key}`);
        return operation === fault && key === 'broken'
          ? Promise.reject(original)
          : Promise.resolve();
      });
      const broken = await first.acquire('broken');
      await first.acquire('healthy');
      await expect(
        fault === 'append' ? broken.append('bad') : broken.read(),
      ).rejects.toBe(original);
      events.push('caller-latched');
      expect(events.some((event) => event.startsWith('close:'))).toBe(false);
      expect(close).not.toHaveBeenCalled();
      const afterFailure = events.slice();
      await expect(broken.append('later')).rejects.toThrow();
      await expect(broken.read()).rejects.toThrow();
      expect(events).toEqual(afterFailure);
      await first.close();
      expect(events.slice(-4)).toEqual([
        'caller-latched',
        'close:broken',
        'close:healthy',
        'remove:',
      ]);
      expect(close).toHaveBeenCalledTimes(2);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('allows explicit discard to close a failed spool before owner cleanup', async () => {
    const original = new Error('append');
    const close = jest.spyOn(FieldSpool.prototype, 'close');
    const first = owner((operation) =>
      operation === 'append' ? Promise.reject(original) : Promise.resolve(),
    );
    const broken = await first.acquire('broken');
    await expect(broken.append('bad')).rejects.toBe(original);
    expect(close).not.toHaveBeenCalled();
    await broken.discard();
    expect(close).toHaveBeenCalledTimes(1);
    const directories = await readdir(root);
    expect(await readdir(join(root, directories[0]))).toEqual([]);
    await first.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('retains a directory-removal failure after all handles close', async () => {
    const error = new Error('directory removal');
    const close = jest.spyOn(FieldSpool.prototype, 'close');
    const first = owner((operation) =>
      operation === 'remove' ? Promise.reject(error) : Promise.resolve(),
    );
    await first.acquire('one');
    await first.acquire('two');
    await expect(first.close()).rejects.toBe(error);
    await expect(first.close()).rejects.toBe(error);
    expect(close).toHaveBeenCalledTimes(2);
    expect(await readdir(root)).toHaveLength(1);
  });

  it('uses the canonical root in the lazy default factory', async () => {
    expect(paths.getDelegationTranscriptSpoolRootDir()).toBe(
      join(paths.getDataDir(), 'delegation-transcript-spools'),
    );
    const resolver = jest
      .spyOn(paths, 'getDelegationTranscriptSpoolRootDir')
      .mockReturnValue(join(root, 'default'));
    const first = createDefaultCommandOutputSpools();
    owners.push(first);
    expect(resolver).not.toHaveBeenCalled();
    const spool = await first.acquire('one');
    await spool.append('default');
    expect(await spool.read()).toBe('default');
    expect(resolver).toHaveBeenCalledTimes(1);
    await first.close();
    expect(await readdir(join(root, 'default'))).toEqual([]);
  });

  it('attempts every remaining close and removal after the first close fails', async () => {
    const error = new Error('first close');
    const removeError = new Error('directory remove');
    const events: string[] = [];
    const close = jest.spyOn(FieldSpool.prototype, 'close');
    const first = owner((operation, key) => {
      events.push(`${operation}:${key}`);
      if (operation === 'close' && key === 'first')
        return Promise.reject(error);
      if (operation === 'remove') return Promise.reject(removeError);
      return Promise.resolve();
    });
    await first.acquire('first');
    await first.acquire('second');
    await first.acquire('third');
    await expect(first.close()).rejects.toBe(error);
    expect(close).toHaveBeenCalledTimes(3);
    expect(events.slice(-4)).toEqual([
      'close:first',
      'close:second',
      'close:third',
      'remove:',
    ]);
    // Actual closes ran despite injected hook failures; cleanup can remove the directory.
    await rm(root, { recursive: true, force: true });
  });

  it.each(['append', 'finish', 'read'])(
    'closes the actual FieldSpool after a native %s failure without masking it',
    async (operation) => {
      const error = new Error(`native ${operation}`);
      if (operation === 'append')
        jest.spyOn(FieldSpool.prototype, 'append').mockRejectedValueOnce(error);
      if (operation === 'finish')
        jest.spyOn(FieldSpool.prototype, 'finish').mockRejectedValueOnce(error);
      if (operation === 'read')
        jest
          .spyOn(FieldSpool.prototype, 'strings')
          .mockImplementationOnce(async function* () {
            yield await Promise.resolve('partial');
            throw error;
          });
      const close = jest.spyOn(FieldSpool.prototype, 'close');
      const first = owner();
      const spool = await first.acquire('broken');
      await expect(
        operation === 'append' ? spool.append('bad') : spool.read(),
      ).rejects.toBe(error);
      expect(close).not.toHaveBeenCalled();
      await expect(spool.append('later')).rejects.toThrow();
      await expect(spool.read()).rejects.toThrow();
      await first.close();
      expect(close).toHaveBeenCalledTimes(1);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('surfaces an append error before explicit cleanup and keeps cleanup errors separate', async () => {
    const original = new Error('append failed');
    const cleanup = new Error('close hook failed');
    const close = jest.spyOn(FieldSpool.prototype, 'close');
    const events: string[] = [];
    const first = owner((operation) => {
      events.push(operation);
      if (operation === 'append') return Promise.reject(original);
      if (operation === 'close') return Promise.reject(cleanup);
      return Promise.resolve();
    });
    const spool = await first.acquire('broken');
    await expect(spool.append('bad')).rejects.toBe(original);
    events.push('caller-latched');
    expect(close).not.toHaveBeenCalled();
    expect(events).toEqual(['create', 'append', 'caller-latched']);
    await expect(spool.append('later')).rejects.toThrow();
    await expect(spool.read()).rejects.toThrow();
    await expect(first.close()).rejects.toBe(cleanup);
    expect(events).toEqual([
      'create',
      'append',
      'caller-latched',
      'close',
      'remove',
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  });
});

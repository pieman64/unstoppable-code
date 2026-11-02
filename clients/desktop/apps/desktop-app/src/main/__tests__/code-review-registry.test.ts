import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as PathsModule from '../lib/paths';
import { isRecord } from '../lib/type-guards';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof fs>('node:fs/promises'),
  __esModule: true,
}));

const tempDir = mkdtempSync(join(tmpdir(), 'code-review-registry-'));
let defaultRegistryPath: string;
let registryPathResolver = (): string => defaultRegistryPath;

jest.mock('../lib/paths', () => {
  const actual = jest.requireActual<typeof PathsModule>('../lib/paths');
  return {
    ...actual,
    getCodeReviewRegistryFilePath: (): string => registryPathResolver(),
  };
});

import {
  getCodeReviewTarget,
  getCodeReviewTargetSync,
  registerCodeReviewTarget,
  removeCodeReviewTarget,
  listCodeReviewTargets,
} from '../lib/code-review-registry';

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('code-review registry', () => {
  beforeEach(() => {
    defaultRegistryPath = join(
      mkdtempSync(join(tempDir, 'case-')),
      'registry.json',
    );
    registryPathResolver = (): string => defaultRegistryPath;
    // A missing file resets the compatibility cache, even before the fix.
    expect(getCodeReviewTargetSync('missing')).toBeNull();
  });

  it('returns null for unknown scopes', async () => {
    expect(await getCodeReviewTarget('missing-scope')).toBeNull();
    expect(getCodeReviewTargetSync('missing-scope')).toBeNull();
  });

  it('registers and resolves a target by scope key, async and sync', async () => {
    await registerCodeReviewTarget('proj-1--wt-1', {
      projectId: 'proj-1',
      worktreeId: 'wt-1',
    });
    expect(await getCodeReviewTarget('proj-1--wt-1')).toEqual({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
    });
    expect(getCodeReviewTargetSync('proj-1--wt-1')).toEqual({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
    });
  });

  it('keys two projects sharing a worktree name separately', async () => {
    await registerCodeReviewTarget('proj-a--main', {
      projectId: 'proj-a',
      worktreeId: 'main',
    });
    await registerCodeReviewTarget('proj-b--main', {
      projectId: 'proj-b',
      worktreeId: 'main',
    });
    expect(getCodeReviewTargetSync('proj-a--main')).toEqual({
      projectId: 'proj-a',
      worktreeId: 'main',
    });
    expect(getCodeReviewTargetSync('proj-b--main')).toEqual({
      projectId: 'proj-b',
      worktreeId: 'main',
    });
  });

  it('overwrites an existing registration', async () => {
    await registerCodeReviewTarget('proj-1--wt-1', {
      projectId: 'original',
      worktreeId: 'wt-1',
    });
    await registerCodeReviewTarget('proj-1--wt-1', {
      projectId: 'proj-2',
      worktreeId: 'wt-1',
    });
    expect(getCodeReviewTargetSync('proj-1--wt-1')).toEqual({
      projectId: 'proj-2',
      worktreeId: 'wt-1',
    });
  });

  it('recreates the same registry parent when it disappears after the read', async () => {
    await registerCodeReviewTarget('remove-me', ownerA);
    const read = fs.readFile;
    jest.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
      const raw = await read(...args);
      rmSync(dirname(defaultRegistryPath), { recursive: true });
      return raw;
    });
    await removeCodeReviewTarget('remove-me');
    expect(JSON.parse(readFileSync(defaultRegistryPath, 'utf8'))).toEqual({
      version: 1,
      targets: {},
    });
  });
});

const ownerA = { projectId: 'a', worktreeId: 'main' };
const ownerB = { projectId: 'b', worktreeId: 'main' };

function seed(value: unknown): void {
  writeFileSync(defaultRegistryPath, JSON.stringify(value));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('authoritative registry mutations', () => {
  beforeEach(() => {
    defaultRegistryPath = join(
      mkdtempSync(join(tempDir, 'case-')),
      'registry.json',
    );
    registryPathResolver = (): string => defaultRegistryPath;
    // A missing file resets the compatibility cache, even before the fix.
    expect(getCodeReviewTargetSync('missing')).toBeNull();
  });

  const schedules = [
    {
      name: 'register/register',
      first: (): Promise<void> => registerCodeReviewTarget('a', ownerB),
      second: (): Promise<void> => registerCodeReviewTarget('b', ownerA),
      targets: { old: ownerA, a: ownerB, b: ownerA },
    },
    {
      name: 'register/remove',
      first: (): Promise<void> => registerCodeReviewTarget('a', ownerB),
      second: (): Promise<void> => removeCodeReviewTarget('b'),
      targets: { old: ownerA, a: ownerB },
    },
    {
      name: 'remove/register',
      first: (): Promise<void> => removeCodeReviewTarget('a'),
      second: (): Promise<void> => registerCodeReviewTarget('b', ownerB),
      targets: { old: ownerA, b: ownerB },
    },
    {
      name: 'remove/remove',
      first: (): Promise<void> => removeCodeReviewTarget('a'),
      second: (): Promise<void> => removeCodeReviewTarget('b'),
      targets: { old: ownerA },
    },
    {
      name: 'same-key register/remove',
      first: (): Promise<void> => registerCodeReviewTarget('a', ownerB),
      second: (): Promise<void> => removeCodeReviewTarget('a'),
      targets: { old: ownerA, b: ownerB },
    },
    {
      name: 'same-key remove/register',
      first: (): Promise<void> => removeCodeReviewTarget('a'),
      second: (): Promise<void> => registerCodeReviewTarget('a', ownerB),
      targets: { old: ownerA, a: ownerB, b: ownerB },
    },
    {
      name: 'same-key replacement',
      first: (): Promise<void> => registerCodeReviewTarget('a', ownerB),
      second: (): Promise<void> => registerCodeReviewTarget('a', ownerA),
      targets: { old: ownerA, a: ownerA, b: ownerB },
    },
  ];
  it.each(schedules)(
    'serializes $name in invocation order',
    async ({ first, second, targets }) => {
      seed({ version: 1, targets: { old: ownerA, a: ownerA, b: ownerB } });
      const entered = deferred();
      const release = deferred();
      const read = fs.readFile;
      const reads = jest
        .spyOn(fs, 'readFile')
        .mockImplementationOnce(async (...args) => {
          const raw = await read(...args);
          entered.resolve();
          await release.promise;
          return raw;
        });
      const firstOperation = first();
      await entered.promise;
      const secondOperation = second();
      try {
        // Drain a turn while the first read is blocked, without a timing sleep.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(reads).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await Promise.all([firstOperation, secondOperation]);
      }
      expect(await listCodeReviewTargets()).toEqual(targets);
    },
  );

  const invalidStates = [
    ['invalid JSON', '{'],
    ['empty input', ''],
    ['null', 'null'],
    ['missing targets', '{"version":1}'],
    ['array targets', '{"version":1,"targets":[]}'],
    ['malformed row', '{"version":1,"targets":{"old":{"projectId":"a"}}}'],
    [
      'future version',
      '{"version":2,"targets":{"old":{"projectId":"a","worktreeId":"main"}},"futureOnly":"keep"}',
    ],
  ];
  it.each(invalidStates)(
    'rejects %s without replacing any bytes',
    async (_name, raw) => {
      writeFileSync(defaultRegistryPath, raw);
      await expect(registerCodeReviewTarget('new', ownerA)).rejects.toThrow();
      await expect(removeCodeReviewTarget('old')).rejects.toThrow();
      await expect(removeCodeReviewTarget('toString')).rejects.toThrow();
      await expect(
        registerCodeReviewTarget('__proto__', ownerA),
      ).rejects.toThrow();
      await expect(listCodeReviewTargets()).rejects.toThrow();
      expect(readFileSync(defaultRegistryPath, 'utf8')).toBe(raw);
      expect(await getCodeReviewTarget('old')).toBeNull();
      expect(getCodeReviewTargetSync('old')).toBeNull();
    },
  );

  it('rejects non-absence read errors rather than initializing', async () => {
    seed({ version: 1, targets: { old: ownerA } });
    const original = readFileSync(defaultRegistryPath, 'utf8');
    const failure = Object.assign(new Error('read denied'), { code: 'EACCES' });
    jest.spyOn(fs, 'readFile').mockRejectedValue(failure);
    await expect(registerCodeReviewTarget('a', ownerA)).rejects.toBe(failure);
    await expect(removeCodeReviewTarget('missing')).rejects.toBe(failure);
    await expect(listCodeReviewTargets()).rejects.toBe(failure);
    expect(readFileSync(defaultRegistryPath, 'utf8')).toBe(original);
    jest.restoreAllMocks();
    await registerCodeReviewTarget('b', ownerB);
    expect(await listCodeReviewTargets()).toEqual({ old: ownerA, b: ownerB });
  });

  it('initializes only absent files and leaves absent-key removal untouched', async () => {
    expect(await listCodeReviewTargets()).toEqual({});
    await removeCodeReviewTarget('missing');
    expect(readdirSync(dirname(defaultRegistryPath))).toEqual([]);
    await registerCodeReviewTarget('a', ownerA);
    const original = readFileSync(defaultRegistryPath, 'utf8');
    await removeCodeReviewTarget('missing');
    expect(readFileSync(defaultRegistryPath, 'utf8')).toBe(original);
  });

  it.each(['', 'toString', 'constructor', '__proto__'])(
    'treats %s only as an own key',
    async (key) => {
      seed({ version: 1, targets: {} });
      expect(await getCodeReviewTarget(key)).toBeNull();
      expect(getCodeReviewTargetSync(key)).toBeNull();
      await removeCodeReviewTarget(key);
      await registerCodeReviewTarget(key, ownerA);
      expect(await getCodeReviewTarget(key)).toEqual(ownerA);
      expect(getCodeReviewTargetSync(key)).toEqual(ownerA);
      await registerCodeReviewTarget('unrelated', ownerB);
      expect(await getCodeReviewTarget(key)).toEqual(ownerA);
      await registerCodeReviewTarget(key, ownerB);
      expect(getCodeReviewTargetSync(key)).toEqual(ownerB);
      await removeCodeReviewTarget(key);
      expect(getCodeReviewTargetSync(key)).toBeNull();
    },
  );

  it('retains accepted envelope and unrelated row extensions', async () => {
    const envelope: unknown = JSON.parse(
      '{"version":1,"targets":{"old":{"projectId":"a","worktreeId":"main","annotation":{"keep":true}}},"__proto__":{"keep":true},"extension":["keep"]}',
    );
    seed(envelope);
    await registerCodeReviewTarget('a', ownerA);
    await removeCodeReviewTarget('a');
    expect(JSON.parse(readFileSync(defaultRegistryPath, 'utf8'))).toEqual(
      envelope,
    );
  });

  it('preserves own __proto__ extension data and unrelated ownership through both mutations', async () => {
    const original =
      '{"version":1,"__proto__":{"keep":"envelope"},"targets":{"__proto__":{"projectId":"a","worktreeId":"main","__proto__":{"keep":"row"}}}}';
    writeFileSync(defaultRegistryPath, original);
    await registerCodeReviewTarget('new', ownerB);
    const registered: unknown = JSON.parse(
      readFileSync(defaultRegistryPath, 'utf8'),
    );
    if (!isRecord(registered)) throw new Error('Expected a registry object');
    const expectedRow: unknown = JSON.parse(
      '{"projectId":"a","worktreeId":"main","__proto__":{"keep":"row"}}',
    );
    expect(Object.prototype.hasOwnProperty.call(registered, '__proto__')).toBe(
      true,
    );
    expect(
      Object.prototype.hasOwnProperty.call(registered.targets, '__proto__'),
    ).toBe(true);
    expect(await getCodeReviewTarget('__proto__')).toEqual(expectedRow);
    await removeCodeReviewTarget('new');
    expect(getCodeReviewTargetSync('__proto__')).toEqual(expectedRow);
    expect(JSON.parse(readFileSync(defaultRegistryPath, 'utf8'))).toEqual(
      JSON.parse(original),
    );
  });

  it('keeps synchronous lookup on persisted state while an installation is blocked', async () => {
    seed({ version: 1, targets: { a: ownerA } });
    expect(getCodeReviewTargetSync('a')).toEqual(ownerA);
    const entered = deferred();
    const release = deferred();
    const rename = fs.rename;
    jest.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await rename(...args);
    });
    const operation = registerCodeReviewTarget('a', ownerB);
    await entered.promise;
    try {
      expect(getCodeReviewTargetSync('a')).toEqual(ownerA);
      expect(await getCodeReviewTarget('a')).toEqual(ownerA);
    } finally {
      release.resolve();
      await operation;
    }
    expect(getCodeReviewTargetSync('a')).toEqual(ownerB);
  });

  it.each(['open', 'write', 'rename'] as const)(
    'preserves the complete destination on pre-install %s failure and recovers the queue',
    async (method) => {
      seed({ version: 1, targets: { old: ownerA } });
      const original = readFileSync(defaultRegistryPath, 'utf8');
      const failure = Object.assign(new Error('injected I/O failure'), {
        code: 'EIO',
      });
      const open = fs.open;
      if (method === 'write') {
        jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
          const handle = await open(...args);
          jest.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
          return handle;
        });
      } else {
        jest.spyOn(fs, method).mockRejectedValueOnce(failure);
      }
      await expect(registerCodeReviewTarget('a', ownerA)).rejects.toBe(failure);
      expect(readFileSync(defaultRegistryPath, 'utf8')).toBe(original);
      expect(readdirSync(dirname(defaultRegistryPath))).toEqual([
        'registry.json',
      ]);
      jest.restoreAllMocks();
      await registerCodeReviewTarget('b', ownerB);
      expect(await listCodeReviewTargets()).toEqual({ old: ownerA, b: ownerB });
    },
  );

  it('requests durable file sync before install and directory sync where supported', async () => {
    const events: string[] = [];
    const open = fs.open;
    const rename = fs.rename;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      jest.spyOn(handle, 'sync').mockImplementation(async () => {
        events.push(
          args[0] === dirname(defaultRegistryPath) ? 'directory' : 'file',
        );
        await sync();
      });
      return handle;
    });
    jest.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      events.push('install');
      await rename(...args);
    });
    await registerCodeReviewTarget('a', ownerA);
    expect(events).toEqual(
      process.platform === 'win32'
        ? ['file', 'install']
        : ['file', 'install', 'directory'],
    );
  });

  it('invalidates cache on uncertain post-install failure without claiming rollback', async () => {
    seed({ version: 1, targets: { a: ownerA } });
    const time = new Date('2020-01-01T00:00:00Z');
    utimesSync(defaultRegistryPath, time, time);
    expect(getCodeReviewTargetSync('a')).toEqual(ownerA);
    const rename = fs.rename;
    const failure = new Error('uncertain install acknowledgement');
    jest.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      await rename(...args);
      utimesSync(defaultRegistryPath, time, time);
      throw failure;
    });
    await expect(registerCodeReviewTarget('a', ownerB)).rejects.toBe(failure);
    expect(getCodeReviewTargetSync('a')).toEqual(ownerB);
    jest.restoreAllMocks();
    await removeCodeReviewTarget('a');
    expect(getCodeReviewTargetSync('a')).toBeNull();
  });

  it('invalidates synchronous cache after mutations even with equal timestamps', async () => {
    seed({ version: 1, targets: { a: ownerA } });
    const time = new Date('2020-01-01T00:00:00Z');
    utimesSync(defaultRegistryPath, time, time);
    expect(getCodeReviewTargetSync('a')).toEqual(ownerA);
    await registerCodeReviewTarget('a', ownerB);
    utimesSync(defaultRegistryPath, time, time);
    expect(getCodeReviewTargetSync('a')).toEqual(ownerB);
    await removeCodeReviewTarget('a');
    utimesSync(defaultRegistryPath, time, time);
    expect(getCodeReviewTargetSync('a')).toBeNull();
  });

  it('does not share equal-mtime cache entries between roots', () => {
    const other = join(dirname(defaultRegistryPath), 'other.json');
    seed({ version: 1, targets: { a: ownerA } });
    writeFileSync(
      other,
      JSON.stringify({ version: 1, targets: { a: ownerB } }),
    );
    const time = new Date('2020-01-01T00:00:00Z');
    utimesSync(defaultRegistryPath, time, time);
    utimesSync(other, time, time);
    expect(getCodeReviewTargetSync('a')).toEqual(ownerA);
    registryPathResolver = (): string => other;
    expect(getCodeReviewTargetSync('a')).toEqual(ownerB);
  });

  it.each(['register', 'remove'])(
    'captures one path at %s invocation, including queued work',
    async (kind) => {
      seed({ version: 1, targets: { a: ownerA } });
      const other = join(
        dirname(defaultRegistryPath),
        'other-root',
        'registry.json',
      );
      mkdirSync(dirname(other), { recursive: true });
      writeFileSync(
        other,
        JSON.stringify({ version: 1, targets: { b: ownerB } }),
      );
      const resolver = jest.fn(() => defaultRegistryPath);
      registryPathResolver = resolver;
      const operation =
        kind === 'register'
          ? registerCodeReviewTarget('new', ownerB)
          : removeCodeReviewTarget('a');
      resolver.mockImplementation(() => other);
      await operation;
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(other, 'utf8'))).toEqual({
        version: 1,
        targets: { b: ownerB },
      });
      expect(JSON.parse(readFileSync(defaultRegistryPath, 'utf8'))).toEqual({
        version: 1,
        targets: kind === 'register' ? { a: ownerA, new: ownerB } : {},
      });
    },
  );
});

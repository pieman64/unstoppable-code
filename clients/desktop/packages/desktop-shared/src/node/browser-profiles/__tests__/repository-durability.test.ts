import type * as NativeFs from 'node:fs/promises';
import type * as DirectoryFlush from '@canopy/core-platform/directory-flush';
import { DirectoryFlushError } from '@canopy/core-platform/directory-flush';
import { StorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import type {
  BrowserProfileRecord,
  BrowserTaskScope,
} from '@canopy/protocol/browser-profiles';
import { BrowserProfileRepository } from '../repository';
import { writeProfileJson } from '../storage';

// Match repository.test.ts: fault injection must not affect other suites' writers.
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof NativeFs>('node:fs/promises'),
}));
const nativeFs = jest.requireActual<typeof NativeFs>('node:fs/promises');
const profileFs = jest.requireMock<typeof NativeFs>('node:fs/promises');

const actualFlush = jest.requireActual<typeof DirectoryFlush>(
  '@canopy/core-platform/directory-flush',
).flushDirectory;
const mockFlush = jest.fn<Promise<'flushed'>, [string]>();
jest.mock('@canopy/core-platform/directory-flush', () => ({
  ...jest.requireActual<typeof DirectoryFlush>(
    '@canopy/core-platform/directory-flush',
  ),
  flushDirectory: (path: string): Promise<'flushed'> => mockFlush(path),
}));

const scope: BrowserTaskScope = {
  kind: 'worktree',
  projectId: 'project-a',
  worktreeId: 'task-a',
};
const ownerCreatedAt = '2026-09-11T00:00:00.000Z';
const FIXTURE = join(__dirname, 'repository-writer.fixture.ts');

let dataRoot = '';
let root = '';
/** File syncs, renames, directory flushes and removals, in call order. */
let events: string[] = [];
/** Index in `events` of the sync or flush that rejects with `fault.error`. */
let fault: { at: number; error: unknown } | null = null;

const label = (path: string): string =>
  relative(root, path).split(sep).join('/') || '.';
function record(event: string): void {
  events.push(event);
  if (fault?.at !== events.length - 1) return;
  const { error } = fault;
  fault = null;
  throw error;
}

beforeEach(async () => {
  dataRoot = await nativeFs.mkdtemp(join(tmpdir(), 'profile-durability-'));
  root = join(dataRoot, 'browser-profiles');
  events = [];
  fault = null;
  mockFlush.mockReset().mockImplementation(async (path) => {
    record(`flush ${label(path)}`);
    return actualFlush(path);
  });
  jest.spyOn(profileFs, 'open').mockImplementation(async (...args) => {
    const handle = await nativeFs.open(...args);
    // Only a writer's exclusive temporary; directory flushes open with 'r'.
    if (args[1] !== 'wx') return handle;
    const directory = dirname(String(args[0]));
    const sync = handle.sync.bind(handle);
    handle.sync = async (): Promise<void> => {
      record(`sync ${label(directory)}`);
      return sync();
    };
    return handle;
  });
  jest.spyOn(profileFs, 'rename').mockImplementation(async (...args) => {
    await nativeFs.rename(...args);
    events.push(`rename ${label(String(args[1]))}`);
  });
  jest.spyOn(profileFs, 'rm').mockImplementation(async (...args) => {
    await nativeFs.rm(...args);
    if (String(args[0]).endsWith('transaction.json'))
      events.push(`rm ${label(String(args[0]))}`);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await nativeFs.rm(dataRoot, { recursive: true, force: true });
});

async function names(directory: string): Promise<string[]> {
  return nativeFs.readdir(join(root, directory)).catch(() => []);
}

/** Every file under the root, so leftover temporaries are visible. */
async function image(directory = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await nativeFs.readdir(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await image(path)));
    else files.push(path);
  }
  return files.sort();
}

/** Each install is synced before its rename and its folder flushed after. */
function expectDurablePublication(log: readonly string[]): void {
  log.forEach((event, index) => {
    const [kind, path] = event.split(' ');
    if (kind === 'rename') {
      expect([log[index - 1], event, log[index + 1]]).toEqual([
        `sync ${posix.dirname(path)}`,
        event,
        `flush ${posix.dirname(path)}`,
      ]);
    }
    if (kind === 'rm')
      expect([event, log[index + 1]]).toEqual([event, 'flush .']);
  });
}

async function journalResult(): Promise<unknown> {
  const journal: unknown = JSON.parse(
    await nativeFs.readFile(join(root, 'transaction.json'), 'utf8'),
  );
  if (
    typeof journal !== 'object' ||
    journal === null ||
    !('outcome' in journal) ||
    typeof journal.outcome !== 'object' ||
    journal.outcome === null ||
    !('result' in journal.outcome)
  )
    throw new Error('Expected a journal with an outcome');
  return journal.outcome.result;
}

async function expectRecoveredOnce(
  operationId: string,
  expected?: unknown,
): Promise<BrowserProfileRecord> {
  const recovered = new BrowserProfileRepository(root);
  const profile = await recovered.ensureTask(
    scope,
    ownerCreatedAt,
    operationId,
  );
  if (expected !== undefined) expect(profile).toEqual(expected);
  expect(await recovered.list()).toEqual([profile]);
  expect((await recovered.getTask(scope))?.taskProfileId).toBe(
    profile.profileId,
  );
  expect(await names('')).not.toContain('transaction.json');
  expect(await names('operations')).toEqual([`${operationId}.json`]);
  expect((await image()).filter((path) => path.endsWith('.tmp'))).toEqual([]);
  return profile;
}

describe('browser profile repository durable publication', () => {
  /** A first Task profile: journal, new slot folder, catalog, new receipt folder. */
  function firstTaskEvents(key: string, operationId: string): string[] {
    return [
      'flush ..',
      `flush ${label(dirname(dataRoot))}`,
      'sync .',
      'rename transaction.json',
      'flush .',
      'flush .',
      'sync task-slots',
      `rename task-slots/${key}.json`,
      'flush task-slots',
      'sync .',
      'rename catalog.json',
      'flush .',
      'flush .',
      'sync operations',
      `rename operations/${operationId}.json`,
      'flush operations',
      'rm transaction.json',
      'flush .',
    ];
  }

  it('syncs each file, flushes new folders and each install, then durably removes the journal', async () => {
    const id = randomUUID();
    await new BrowserProfileRepository(root).ensureTask(
      scope,
      ownerCreatedAt,
      id,
    );
    const [slot] = await names('task-slots');
    expect(events).toEqual(firstTaskEvents(slot.slice(0, -5), id));
  });

  it('keeps restrictive modes on published files and created folders', async () => {
    if (process.platform === 'win32') return;
    await new BrowserProfileRepository(root).ensureTask(
      scope,
      ownerCreatedAt,
      randomUUID(),
    );
    for (const directory of ['', 'task-slots', 'operations'])
      expect((await nativeFs.stat(join(root, directory))).mode & 0o777).toBe(
        0o700,
      );
    for (const file of await image())
      expect((await nativeFs.stat(join(root, file))).mode & 0o777).toBe(0o600);
  });

  it('publishes every repository write durably across the profile lifecycle', async () => {
    let now = 1_000;
    const repository = new BrowserProfileRepository(root, {
      now: (): number => now,
    });
    const first = randomUUID();
    const task = await repository.ensureTask(scope, ownerCreatedAt, first);
    const named = await repository.createNamed(randomUUID(), {
      displayName: 'Named',
    });
    const updated = await repository.updateProfile(
      randomUUID(),
      named.profileId,
      named.metadataRevision,
      { displayName: 'Renamed' },
    );
    const slot = await repository.getTask(scope);
    if (!slot) throw new Error('Expected a task slot');
    await repository.setDefault(
      randomUUID(),
      scope,
      slot.incarnationId,
      slot.metadataRevision,
      { kind: 'named', profileId: named.profileId },
    );
    await repository.resetProfile(randomUUID(), task);
    await repository.deleteNamed(
      randomUUID(),
      named.profileId,
      updated.metadataRevision,
    );
    const retirement = randomUUID();
    await repository.prepareRetirement(scope, ownerCreatedAt, retirement);
    await repository.commitRetirement(retirement, {
      kind: 'owner_removed',
      ownerOperationId: retirement,
    });
    const jobs = await repository.getCleanupJobs();
    expect(jobs).toHaveLength(3);
    for (const job of jobs) await repository.completeCleanup(job.jobId);
    now += 8 * 24 * 60 * 60 * 1_000;
    const stripped = events.length;
    await expect(
      repository.ensureTask(scope, ownerCreatedAt, first),
    ).rejects.toMatchObject({ code: 'operation_expired' });
    expect(events.slice(stripped)).toEqual([
      'sync operations',
      `rename operations/${first}.json`,
      'flush operations',
    ]);
    // Eight mutations and three cleanup completions.
    expect(
      events.filter((event) => event === 'rm transaction.json'),
    ).toHaveLength(11);
    expectDurablePublication(events);
  });

  it('leaves the guarantees of other writeProfileJson consumers unchanged', async () => {
    await writeProfileJson(join(root, 'jobs', 'index.json'), { jobs: [] });
    expect(events).toEqual(['rename jobs/index.json']);
    expect(mockFlush).not.toHaveBeenCalled();
  });

  describe('fault at each publication boundary', () => {
    const injected = Object.assign(new Error('injected I/O failure'), {
      code: 'EIO',
    });
    // Positions in firstTaskEvents: 0-1 make the root durable, 2-4 publish the
    // journal, 5 adds the slot folder, 6-8 the slot, 9-11 the catalog, 12 the
    // receipt folder, 13-15 the receipt and 16-17 remove the journal.
    const boundaries: Array<{
      at: number;
      boundary: string;
      error: 'raw' | 'outcome_unknown';
      published: 'nothing' | 'journal' | 'complete';
    }> = [
      {
        at: 0,
        boundary: 'root folder entry',
        error: 'raw',
        published: 'nothing',
      },
      {
        at: 1,
        boundary: 'data root anchor',
        error: 'raw',
        published: 'nothing',
      },
      { at: 2, boundary: 'journal sync', error: 'raw', published: 'nothing' },
      {
        at: 4,
        boundary: 'journal install flush',
        error: 'outcome_unknown',
        published: 'journal',
      },
      {
        at: 5,
        boundary: 'slot folder entry',
        error: 'raw',
        published: 'journal',
      },
      { at: 6, boundary: 'slot sync', error: 'raw', published: 'journal' },
      {
        at: 8,
        boundary: 'slot install flush',
        error: 'outcome_unknown',
        published: 'journal',
      },
      { at: 9, boundary: 'catalog sync', error: 'raw', published: 'journal' },
      {
        at: 11,
        boundary: 'catalog install flush',
        error: 'outcome_unknown',
        published: 'journal',
      },
      {
        at: 12,
        boundary: 'receipt folder entry',
        error: 'raw',
        published: 'journal',
      },
      { at: 13, boundary: 'receipt sync', error: 'raw', published: 'journal' },
      {
        at: 15,
        boundary: 'receipt install flush',
        error: 'outcome_unknown',
        published: 'journal',
      },
      {
        at: 17,
        boundary: 'journal removal flush',
        error: 'outcome_unknown',
        published: 'complete',
      },
    ];

    it.each(boundaries)(
      'fails at the $boundary and recovers one decision',
      async ({ at, error, published }) => {
        const id = randomUUID();
        fault = { at, error: injected };
        const failure = new BrowserProfileRepository(root)
          .ensureTask(scope, ownerCreatedAt, id)
          .then(
            () => undefined,
            (cause: unknown) => cause,
          );
        const cause = await failure;
        expect(fault).toBeNull();
        if (error === 'outcome_unknown') {
          expect(cause).toBeInstanceOf(StorageOutcomeUnknownError);
          expect(cause).toMatchObject({
            stage: 'directory_flush',
            cause: injected,
          });
        } else expect(cause).toBe(injected);
        // Nothing after the failed boundary ran.
        expect(events).toHaveLength(at + 1);
        expect((await image()).filter((path) => path.endsWith('.tmp'))).toEqual(
          [],
        );
        const files = await names('');
        let expected: unknown;
        if (published === 'nothing') {
          expect(files).not.toContain('transaction.json');
          expect(files).not.toContain('catalog.json');
        } else if (published === 'journal') {
          expected = await journalResult();
        } else {
          expect(files).not.toContain('transaction.json');
          expect(files).toContain('catalog.json');
        }
        const recovering = events.length;
        await expectRecoveredOnce(id, expected);
        expectDurablePublication(events.slice(recovering));
      },
    );

    // With task-slots/ and operations/ already confirmed, no folder creation
    // flushes the root ahead of recovery's first install.
    it.each([
      { at: 2, boundary: 'journal install flush' },
      { at: 5, boundary: 'slot install flush' },
    ])(
      'makes a surviving journal durable before recovery republishes after a $boundary failure',
      async ({ at }) => {
        await new BrowserProfileRepository(root).ensureTask(
          { ...scope, worktreeId: 'task-b' },
          ownerCreatedAt,
          randomUUID(),
        );
        const id = randomUUID();
        events = [];
        fault = { at, error: injected };
        await expect(
          new BrowserProfileRepository(root).ensureTask(
            scope,
            ownerCreatedAt,
            id,
          ),
        ).rejects.toBeInstanceOf(StorageOutcomeUnknownError);
        const expected = await journalResult();
        const recovering = events.length;
        const recovered = new BrowserProfileRepository(root);
        await recovered.list();
        const log = events.slice(recovering);
        expect(log.slice(0, 3)).toEqual([
          'sync .',
          'rename transaction.json',
          'flush .',
        ]);
        expectDurablePublication(log);
        expect(await recovered.ensureTask(scope, ownerCreatedAt, id)).toEqual(
          expected,
        );
      },
    );

    it('fails closed when the data root anchor refuses its flush handle', async () => {
      fault = {
        at: 1,
        error: new DirectoryFlushError(
          'open',
          Object.assign(new Error('EPERM: open'), { code: 'EPERM' }),
        ),
      };
      await expect(
        new BrowserProfileRepository(root).createNamed(randomUUID(), {
          displayName: 'Refused',
        }),
      ).rejects.toMatchObject({ name: 'DirectoryFlushError', stage: 'open' });
      expect(await image()).toEqual([]);
    });
  });

  describe('unrenamed temporaries of the durable writer', () => {
    async function stageJournal(): Promise<{ id: string; key: string }> {
      const id = randomUUID();
      await expect(
        new BrowserProfileRepository(root, {
          checkpoint: (point): void => {
            if (point === 'journal') throw new Error('staged');
          },
        }).ensureTask(scope, ownerCreatedAt, id),
      ).rejects.toThrow('staged');
      const journal: unknown = JSON.parse(
        await nativeFs.readFile(join(root, 'transaction.json'), 'utf8'),
      );
      if (
        typeof journal !== 'object' ||
        journal === null ||
        !('task' in journal) ||
        typeof journal.task !== 'object' ||
        journal.task === null ||
        !('key' in journal.task) ||
        typeof journal.task.key !== 'string'
      )
        throw new Error('Expected a task journal');
      return { id, key: journal.task.key };
    }

    it.each([
      [
        'durable writer',
        (key: string): string =>
          `.${key}.json.${process.pid}.${randomUUID()}.tmp`,
      ],
      [
        'earlier writer',
        (key: string): string =>
          `${key}.json.${process.pid}.${randomUUID()}.tmp`,
      ],
    ])(
      'recovers an initial journal beside its own slot temporary from the %s',
      async (_writer, temporary) => {
        const { id, key } = await stageJournal();
        await nativeFs.mkdir(join(root, 'task-slots'));
        await nativeFs.writeFile(join(root, 'task-slots', temporary(key)), '{');
        const recovered = new BrowserProfileRepository(root);
        await recovered.ensureTask(scope, ownerCreatedAt, id);
        expect(await recovered.list()).toHaveLength(1);
      },
    );

    it.each(['another task', 'own receipt'])(
      'refuses a durable-writer temporary for %s when the catalog is absent',
      async (evidence) => {
        const { id } = await stageJournal();
        const [directory, name] =
          evidence === 'own receipt'
            ? ['operations', `.${id}.json.${process.pid}.${randomUUID()}.tmp`]
            : [
                'task-slots',
                `.${'f'.repeat(64)}.json.${process.pid}.${randomUUID()}.tmp`,
              ];
        await nativeFs.mkdir(join(root, directory));
        await nativeFs.writeFile(join(root, directory, name), '{}');
        const before = await image();
        await expect(
          new BrowserProfileRepository(root).list(),
        ).rejects.toMatchObject({ code: 'recovery_required' });
        expect(await image()).toEqual(before);
      },
    );
  });
});

describe('browser profile writer termination', () => {
  function runWriter(...args: string[]): ReturnType<typeof spawnSync> {
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', FIXTURE, root, ...args],
      { encoding: 'utf8', timeout: 60_000 },
    );
  }

  function expectKilled(result: ReturnType<typeof spawnSync>): void {
    // Windows terminates the process with exit status 1 and no signal.
    expect({
      signal: result.signal,
      status: result.status,
      stderr: String(result.stderr),
    }).toEqual(
      process.platform === 'win32'
        ? { signal: null, status: 1, stderr: '' }
        : { signal: 'SIGKILL', status: null, stderr: '' },
    );
  }

  it.each(['journal', 'task', 'catalog', 'outcome'])(
    'recovers one decision after the writer is killed once its %s is published',
    async (stage) => {
      const id = randomUUID();
      expectKilled(runWriter('mutate', stage, id));
      // The killed writer released nothing.
      expect(await names('')).toEqual(
        expect.arrayContaining(['transaction.json', 'writer.lock']),
      );
      const expected = await journalResult();
      await expectRecoveredOnce(id, expected);
      expect(await names('')).not.toContain('writer.lock');
    },
    60_000,
  );

  it.each(['task', 'catalog', 'outcome'])(
    'resumes after a recovering writer is killed at %s',
    async (stage) => {
      const id = randomUUID();
      expectKilled(runWriter('mutate', 'journal', id));
      const journal = await nativeFs.readFile(
        join(root, 'transaction.json'),
        'utf8',
      );
      expectKilled(runWriter('recover', stage));
      expect(
        await nativeFs.readFile(join(root, 'transaction.json'), 'utf8'),
      ).toBe(journal);
      await expectRecoveredOnce(id, await journalResult());
    },
    60_000,
  );

  it('replays the receipt of a writer that finished', async () => {
    const id = randomUUID();
    expect(runWriter('mutate', 'none', id).status).toBe(0);
    const receipt: unknown = JSON.parse(
      await nativeFs.readFile(join(root, 'operations', `${id}.json`), 'utf8'),
    );
    if (
      typeof receipt !== 'object' ||
      receipt === null ||
      !('result' in receipt)
    )
      throw new Error('Expected a receipt');
    await expectRecoveredOnce(id, receipt.result);
  }, 60_000);
});

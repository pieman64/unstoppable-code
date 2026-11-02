import type { AgentDelegationWorkspaceObservation } from '@canopy/protocol/delegation';
import type { Dir, Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  encodeManagedMessageReceiptV2,
  type ManagedMessageReceiptV2,
} from '../managed-message-receipt-v2';
import {
  AgentDelegationBroker,
  delegationContentVersion,
  type StoredDelegation,
} from '../broker';
import {
  FileDelegationStorage,
  FileManagedDelegationMessageStorage,
} from '../storage';
import {
  DELEGATION_CAPABILITY_GRANT_LIMITS,
  type DelegationCapabilityGrant,
} from '../capability-grant';
import { AgentRunnerRegistry } from '../runner-registry';
import { FakeRunner, routeFixture } from './fixtures';

jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    opendir: jest.fn(actual.opendir),
    open: jest.fn(actual.open),
  };
});

const mockedOpendir = jest.mocked(fs.opendir);
const mockedOpen = jest.mocked(fs.open);
const realOpendir =
  jest.requireActual<typeof FsPromises>('node:fs/promises').opendir;

async function repeatedDirectoryEntries(
  directoryPath: string,
  entryName: string,
  count: number,
): Promise<{ handle: Dir; yielded: () => number }> {
  const source = await fs.opendir(directoryPath);
  let entry: Dirent | null = await source.read();
  while (entry && entry.name !== entryName) entry = await source.read();
  await source.close();
  if (!entry) throw new Error(`Expected ${entryName} in test directory`);
  const repeatedEntry = entry;

  const handle = await fs.opendir(directoryPath);
  let yielded = 0;
  Object.defineProperty(handle, Symbol.asyncIterator, {
    configurable: true,
    value: async function* (): AsyncGenerator<Dirent> {
      await Promise.resolve();
      for (let index = 0; index < count; index += 1) {
        yielded += 1;
        yield repeatedEntry;
      }
    },
  });
  return { handle, yielded: () => yielded };
}

describe('private durable delegation registry', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-storage-'));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  // Fall back to the shipped reader to pin its write-producing behavior in red.
  async function readOnly(storage: FileDelegationStorage): Promise<unknown> {
    const read = Reflect.get(storage, 'loadReadOnly');
    return typeof read === 'function'
      ? read.call(storage)
      : { records: await storage.load(), missing: false };
  }

  it('observes a missing dormant registry without creating it', async () => {
    const target = path.join(directory, 'absent', 'runs');
    const result = await readOnly(new FileDelegationStorage(target));
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result).toEqual({ records: [], missing: true });
  });

  it('fails a read-only count rather than silently undercounting a corrupt record', async () => {
    const target = path.join(directory, 'corrupt');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(path.join(target, 'bad.json'), '{', { mode: 0o600 });
    await expect(readOnly(new FileDelegationStorage(target))).rejects.toThrow();
  });

  async function populate(): Promise<FileDelegationStorage> {
    const storage = new FileDelegationStorage(path.join(directory, 'records'));
    const registry = new AgentRunnerRegistry();
    registry.register({
      apiVersion: 1,
      registrationId: 'third-local',
      adapter: new FakeRunner('local-sdk'),
    });
    const broker = new AgentDelegationBroker({
      storage,
      registry,
      cwd: directory,
      observeWorkspace: (): Promise<AgentDelegationWorkspaceObservation> =>
        Promise.resolve({
          consistency: 'live_shared_worktree',
          headRevision: 'a'.repeat(40),
          dirty: true,
          observedAt: 100,
        }),
      resolveRoute: (): Promise<{
        ok: true;
        value: ReturnType<typeof routeFixture>;
      }> => Promise.resolve({ ok: true, value: routeFixture() }),
      authorize: (): Promise<{ ok: true; value: undefined }> =>
        Promise.resolve({ ok: true, value: undefined }),
    });
    await broker.initialize();
    try {
      const spawned = await broker.spawn(
        {
          harnessId: 'claude',
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          sessionKey: 'p/w/c',
          turnId: 't',
          toolCallId: 'call',
          depth: 0,
          runtimeGeneration: 1,
        },
        {
          modelId: 'logical-review-model',
          description: 'Inspect the architecture',
          prompt: 'Read the entry point and describe its dependencies.',
        },
      );
      expect(spawned.ok).toBe(true);
    } finally {
      await broker.close();
    }
    return storage;
  }

  async function expectInvalidStoredGrant(
    storage: FileDelegationStorage,
    value: unknown,
  ): Promise<void> {
    // @ts-expect-error Exercise runtime validation with malformed stored data.
    await expect(storage.commit(value)).rejects.toThrow();
  }

  it('retains nested lineage and the spawning run generation across storage reload', async () => {
    const storage = await populate();
    const [record] = await storage.load();
    const nested = {
      ...record,
      depth: 2,
      parentDelegationId: 'ancestor',
      parentRunGeneration: 3,
      parentDescription: 'Review errors',
      inheritedCwd: '/isolated/ancestor',
      isolationBaseCwd: '/isolated/parent',
      parent: {
        ...record.parent,
        depth: 1,
        parentDelegationId: 'ancestor',
        parentRunGeneration: 3,
        parentDescription: 'Review errors',
      },
    };
    await storage.commit(nested);
    expect(
      await new FileDelegationStorage(path.join(directory, 'records')).load(),
    ).toEqual([nested]);
  });

  it('loads records in delegation id order whatever order the directory lists them', async () => {
    const storage = await populate();
    const [record] = await storage.load();
    const delegationId = '00000000-0000-4000-8000-000000000000';
    const earlier = {
      ...record,
      state: { ...record.state, delegationId },
      launch: { ...record.launch, delegationId },
    };
    await storage.commit(earlier);
    const target = path.join(directory, 'records');
    const names = (await fs.readdir(target))
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(names).toHaveLength(2);
    // Linux lists entries in hash order; reverse the sorted listing to model it.
    const handle = await realOpendir(target);
    const entries: Dirent[] = [];
    for await (const entry of handle) entries.push(entry);
    const reversed = entries
      .filter((entry) => entry.name.endsWith('.json'))
      .sort((left, right) => right.name.localeCompare(left.name));
    const listing = await realOpendir(target);
    Object.defineProperty(listing, Symbol.asyncIterator, {
      configurable: true,
      value: async function* (): AsyncGenerator<Dirent> {
        await Promise.resolve();
        yield* reversed;
      },
    });
    mockedOpendir.mockResolvedValueOnce(listing);
    expect(
      (await storage.load()).map(
        (loaded) => `${loaded.state.delegationId}.json`,
      ),
    ).toEqual(names);
  });

  it('loads one record by its delegation id', async () => {
    const storage = await populate();
    const [record] = await storage.load();
    if (!record) throw new Error('Expected retained record');
    expect(await storage.loadOne(record.state.delegationId)).toEqual(record);
    expect(
      await storage.loadOne('00000000-0000-4000-8000-000000000000'),
    ).toBeUndefined();
    expect(await storage.loadOne('../records/x')).toBeUndefined();
  });

  it('roundtrips permanent provider authority revocation', async () => {
    const storage = await populate();
    const [record] = await storage.load();
    if (!record) throw new Error('Expected retained record');
    const revoked = { ...record, authorityRevoked: true };
    await storage.commit(revoked);
    expect(
      await new FileDelegationStorage(path.join(directory, 'records')).load(),
    ).toEqual([revoked]);
  });

  it('roundtrips a queued admission marker', async () => {
    const storage = await populate();
    const [record] = await storage.load();
    if (!record) throw new Error('Expected retained record');
    const waiting = {
      ...record,
      admission: {
        runGeneration: record.state.runGeneration,
        state: 'waiting' as const,
        queuedAt: 1_700_000_000_000,
      },
    };
    await storage.commit(waiting);
    expect(
      await new FileDelegationStorage(path.join(directory, 'records')).load(),
    ).toEqual([waiting]);

    const granted = {
      ...waiting,
      admission: {
        ...waiting.admission,
        state: 'granted' as const,
        grantedAt: 1_700_000_000_500,
      },
    };
    await storage.commit(granted);
    expect(
      await new FileDelegationStorage(path.join(directory, 'records')).load(),
    ).toEqual([granted]);
  });

  it('roundtrips a version-two private Agent artifact reference', async () => {
    const storage = await populate();
    const [record] = await storage.load();
    if (!record || record.version === 3 || !record.route)
      throw new Error('Expected retained legacy record with route');
    const hash = 'a'.repeat(64);
    const withOverlay = {
      ...record,
      route: {
        ...record.route,
        agentOverlay: {
          agentDefinitionId: 'agent_model_reviewer',
          agentDefinitionRevision: '2026-09-23T00:00:00.000Z',
          agentDefinitionHash: hash,
          pluginProjectionHash: hash,
          systemPromptAppend: 'Retained private instructions',
          artifact: {
            artifactId: hash,
            manifestHash: hash,
            formatVersion: 2 as const,
          },
        },
      },
    };
    await storage.commit(withOverlay);
    expect(
      await new FileDelegationStorage(path.join(directory, 'records')).load(),
    ).toEqual([withOverlay]);
  });

  it('roundtrips capability grants and v3 route refs', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    if (!record.route) throw new Error('Expected retained route');
    const hash = 'a'.repeat(64);
    const id = `deferred:v1:${'B'.repeat(43)}`;
    const capabilityGrant: DelegationCapabilityGrant = {
      inherit: true,
      explicit: [id],
      discovery: false,
      loaded: [`deferred:v1:${'C'.repeat(43)}`],
      skipped: [
        { id: `deferred:v1:${'D'.repeat(43)}`, reason: 'missing_selection' },
      ],
      overlayHash: hash,
      summary: {
        inherit: true,
        discovery: false,
        items: [{ kind: 'skill', name: 'Review', source: 'explicit' }],
        skipped: [],
      },
    };
    const withCapabilities = {
      ...record,
      route: {
        ...record.route,
        capabilityOverlay: {
          capabilityProjectionHash: hash,
          artifact: {
            artifactId: hash,
            formatVersion: 3 as const,
            manifestHash: hash,
          },
        },
      },
      capabilityGrant,
    };
    await storage.commit(withCapabilities);
    expect(
      await new FileDelegationStorage(path.join(directory, 'records')).load(),
    ).toEqual([withCapabilities]);
  });

  it('rejects invalid capability IDs, skip reasons and bounds', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    const hash = 'a'.repeat(64);
    const id = `deferred:v1:${'B'.repeat(43)}`;
    const validGrant: DelegationCapabilityGrant = {
      inherit: true,
      explicit: [id],
      discovery: false,
      loaded: [],
      skipped: [],
      overlayHash: hash,
      summary: { inherit: true, discovery: false, items: [], skipped: [] },
    };
    await expectInvalidStoredGrant(storage, {
      ...record,
      capabilityGrant: { ...validGrant, explicit: ['invalid-id'] },
    });
    await expectInvalidStoredGrant(storage, {
      ...record,
      capabilityGrant: {
        ...validGrant,
        skipped: [{ id, reason: 'unknown_reason' }],
      },
    });
    await expectInvalidStoredGrant(storage, {
      ...record,
      capabilityGrant: {
        ...validGrant,
        explicit: Array.from(
          { length: DELEGATION_CAPABILITY_GRANT_LIMITS.explicit + 1 },
          () => id,
        ),
      },
    });
  });

  it('loads records without capability fields', async () => {
    const storage = await populate();
    const records = await storage.load();
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty('capabilityGrant');
    expect(records[0]?.route?.capabilityOverlay).toBeUndefined();
  });

  it('reloads synced execution and delivery records with private permissions', async () => {
    const storage = await populate();
    const records = await storage.load();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceObservation: {
        consistency: 'live_shared_worktree',
        headRevision: 'a'.repeat(40),
        dirty: true,
        observedAt: 100,
      },
      state: {
        status: 'cancelled',
        stopReason: 'shutdown',
        cancelledByUser: false,
      },
      launch: { phase: 'settled' },
      delivery: { status: 'suppressed' },
      route: { authAccountKey: 'private-account@example.test' },
    });
    if (process.platform !== 'win32') {
      const files = await fs.readdir(path.join(directory, 'records'));
      expect(
        (await fs.stat(path.join(directory, 'records', files[0] ?? ''))).mode &
          0o777,
      ).toBe(0o600);
    }
  });

  it('skips extra-field and inconsistent persisted identities', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    const file = path.join(
      directory,
      'records',
      `${record.state.delegationId}.json`,
    );
    for (const changed of [
      { ...record, extraAuthority: true },
      { ...record, callKey: '0'.repeat(64) },
      { ...record, task: { ...record.task, contextPolicy: 'fork_parent' } },
    ]) {
      await fs.writeFile(file, JSON.stringify(changed));
      await expect(storage.load()).resolves.toEqual([]);
    }
  });

  it('skips corrupt records while retaining valid delegation state', async () => {
    const storage = await populate();
    const recordsDirectory = path.join(directory, 'records');
    const malformed = path.join(recordsDirectory, 'malformed.json');
    const invalid = path.join(recordsDirectory, 'invalid.json');
    await fs.writeFile(malformed, '{');
    await fs.writeFile(invalid, JSON.stringify({ version: 1 }));
    const invalidV3 = path.join(recordsDirectory, 'invalid-v3.json');
    await fs.writeFile(invalidV3, JSON.stringify({ version: 3 }));
    if (process.platform !== 'win32') {
      await fs.chmod(malformed, 0o600);
      await fs.chmod(invalid, 0o600);
      await fs.chmod(invalidV3, 0o600);
    }

    await expect(storage.load()).resolves.toHaveLength(1);
  });

  it('bounds the files an apply records as applied', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    const applied = (count: number): StoredDelegation['appliedFiles'] =>
      Array.from({ length: count }, (_, index) => ({
        path: `src/file-${index}.ts`,
        delegate: 'a'.repeat(64),
      }));
    await expect(
      storage.commit({ ...record, appliedFiles: applied(2048) }),
    ).resolves.toBeUndefined();
    await expect(
      storage.commit({ ...record, appliedFiles: applied(2049) }),
    ).rejects.toThrow();
  });

  it('migrates retained file text to applied-file receipts and drops it', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    const id = record.state.delegationId;
    const uuid = (index: number): string =>
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const change = (
      changeId: string,
      file: string,
      after: string | null,
    ): Record<string, unknown> => ({
      id: changeId,
      path: file,
      before: 'x'.repeat(65_536),
      after,
      status: 'applied',
    });
    const legacyJournal = {
      operationId: uuid(1),
      root: directory,
      files: [{ path: 'src/a.ts', before: 'base', after: 'child' }],
    };
    const file = path.join(directory, 'records', `${id}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({
        ...record,
        // The first run's src/a.ts edit and the current run's later one were
        // applied; src/b.ts never was.
        appliedChangeIds: [uuid(2), uuid(4)],
        applyJournal: legacyJournal,
        history: [
          {
            delegationId: id,
            runGeneration: 1,
            sequence: 3,
            parentHarnessId: 'claude',
            parentTurnId: 'turn',
            parentToolCallId: 'call',
            createdAt: 1,
            task: {
              description: 'First run',
              prompt: 'Edit the source',
              executionMode: 'background',
            },
            snapshot: {
              delegationId: id,
              status: 'failed',
              requestedModelId: 'review-model',
              outputTruncated: false,
              fileChanges: [
                change(uuid(2), 'src/a.ts', 'first'),
                change(uuid(3), 'src/b.ts', 'unapplied'),
              ],
            },
            transcript: [],
          },
        ],
        state: {
          ...record.state,
          fileChanges: [change(uuid(4), 'src/a.ts', 'second')],
        },
      }),
    );
    if (process.platform !== 'win32') await fs.chmod(file, 0o600);

    const [loaded] = await storage.load();
    if (loaded?.version === 3) throw new Error('Expected a legacy record');
    expect(loaded?.state.delegationId).toBe(id);
    expect(loaded?.applyJournal).toEqual(legacyJournal);
    expect(loaded?.appliedFiles).toEqual([
      { path: 'src/a.ts', delegate: delegationContentVersion('second') },
    ]);
    expect(loaded && 'appliedChangeIds' in loaded).toBe(false);
    expect(loaded && 'fileChanges' in loaded.state).toBe(false);
    expect(loaded?.history?.[0]?.snapshot).not.toHaveProperty('fileChanges');
    // A commit never writes the text back.
    if (!loaded) throw new Error('Expected migrated record');
    await storage.commit(loaded);
    expect(await fs.readFile(file, 'utf8')).not.toContain('x'.repeat(1024));
  });

  it('persists bounded cancellation receipts for stable call retries', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record || record.version === 3)
      throw new Error('Expected retained legacy record');
    const stopRequest = {
      operationId: '00000000-0000-4000-8000-000000000001',
      key: 'a'.repeat(64),
      runGeneration: 1,
      status: 'completed' as const,
    };

    await storage.commit({ ...record, stopRequests: [stopRequest] });

    await expect(storage.load()).resolves.toEqual([
      expect.objectContaining({ stopRequests: [stopRequest] }),
    ]);
  });

  it('rejects hard-linked records and round-trips complete large transcripts', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    const file = path.join(
      directory,
      'records',
      `${record.state.delegationId}.json`,
    );
    await fs.link(file, path.join(directory, 'linked-record'));
    await expect(storage.load()).rejects.toThrow(
      'Invalid private delegation record',
    );
    await fs.unlink(path.join(directory, 'linked-record'));
    const finalText = 'retained finding '.repeat(150_000);
    await storage.commit({ ...record, state: { ...record.state, finalText } });
    expect((await storage.load())[0]?.state.finalText).toBe(finalText);
  });

  it('rereads a record that a commit replaced after it was opened', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    const replacement = {
      ...record,
      state: { ...record.state, finalText: 'replaced' },
    };
    const realOpen =
      jest.requireActual<typeof FsPromises>('node:fs/promises').open;
    mockedOpen.mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      // The commit renames its new file over the one just opened.
      await storage.commit(replacement);
      return handle;
    });
    const loaded = await storage.loadOne(record.state.delegationId);
    expect(loaded?.state.finalText).toBe('replaced');
  });

  it('rejects a retained record that exceeds the hard storage byte quota', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    await expect(
      storage.commit({
        ...record,
        state: { ...record.state, finalText: 'x'.repeat(34 * 1024 * 1024) },
      }),
    ).rejects.toThrow(/byte bound|too big/i);
  });

  it('loads more retained records than the former 512 product limit', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    const recordsDirectory = path.join(directory, 'records');
    const entryName = `${record.state.delegationId}.json`;
    const repeated = await repeatedDirectoryEntries(
      recordsDirectory,
      entryName,
      513,
    );
    mockedOpendir.mockResolvedValue(repeated.handle);
    const read = jest.spyOn(storage, 'read');
    read.mockImplementation(
      <T>(
        name: string,
        parse: (text: string, name: string) => T | undefined,
      ): Promise<T | undefined> => {
        const text = JSON.stringify(record);
        if (typeof text !== 'string') throw new Error('Expected JSON record');
        return Promise.resolve(parse(text, name));
      },
    );
    try {
      expect(await storage.load()).toHaveLength(513);
      expect(repeated.yielded()).toBe(513);
    } finally {
      mockedOpendir.mockImplementation(realOpendir);
      read.mockRestore();
      await repeated.handle.close();
    }
  });

  it('loads more than the former 1,024 directory-entry limit', async () => {
    const storage = await populate();
    const recordsDirectory = path.join(directory, 'records');
    await fs.writeFile(path.join(recordsDirectory, 'ignored.data'), 'x');
    const repeated = await repeatedDirectoryEntries(
      recordsDirectory,
      'ignored.data',
      1_025,
    );
    mockedOpendir.mockResolvedValue(repeated.handle);
    try {
      expect(await storage.load()).toEqual([]);
      expect(repeated.yielded()).toBe(1_025);
    } finally {
      mockedOpendir.mockImplementation(realOpendir);
      await repeated.handle.close();
    }
  });

  it('retains the defensive record ceiling at 65,536 decoded records', async () => {
    const storage = await populate();
    const record = (await storage.load())[0];
    if (!record) throw new Error('Expected retained record');
    const recordsDirectory = path.join(directory, 'records');
    const entryName = `${record.state.delegationId}.json`;
    const repeated = await repeatedDirectoryEntries(
      recordsDirectory,
      entryName,
      65_537,
    );
    mockedOpendir.mockResolvedValue(repeated.handle);
    const read = jest.spyOn(storage, 'read');
    read.mockImplementation(
      <T>(
        name: string,
        parse: (text: string, name: string) => T | undefined,
      ): Promise<T | undefined> => {
        const text = JSON.stringify(record);
        if (typeof text !== 'string') throw new Error('Expected JSON record');
        return Promise.resolve(parse(text, name));
      },
    );
    try {
      await expect(storage.load()).rejects.toThrow(
        'Delegation storage exceeds its record bound',
      );
      expect(repeated.yielded()).toBe(65_537);
    } finally {
      mockedOpendir.mockImplementation(realOpendir);
      read.mockRestore();
      await repeated.handle.close();
    }
    // 65,537 decoded records take a few seconds locally but over 30 s on CI runners.
  }, 120_000);

  it('retains the defensive directory-entry ceiling at 131,072 entries', async () => {
    const storage = await populate();
    const recordsDirectory = path.join(directory, 'records');
    await fs.writeFile(path.join(recordsDirectory, 'ignored.data'), 'x');
    const repeated = await repeatedDirectoryEntries(
      recordsDirectory,
      'ignored.data',
      131_073,
    );
    mockedOpendir.mockResolvedValue(repeated.handle);
    try {
      await expect(storage.load()).rejects.toThrow(
        'Delegation storage exceeds its entry bound',
      );
      expect(repeated.yielded()).toBe(131_073);
    } finally {
      mockedOpendir.mockImplementation(realOpendir);
      await repeated.handle.close();
    }
  });
});

describe('private delegation message receipts', () => {
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  const requestHash = 'a'.repeat(64);
  const versionedPendingReceipt: ManagedMessageReceiptV2 = {
    version: 2,
    codec: 'stream',
    operationId,
    requestHash,
    status: 'pending',
  };
  let directory: string;
  let receipts: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'delegation-receipts-'),
    );
    receipts = path.join(directory, 'user-messages');
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function receiptFile(): Promise<string> {
    const [name] = (await fs.readdir(receipts)).filter((entry) =>
      entry.endsWith('.json'),
    );
    if (!name) throw new Error('Expected a receipt file');
    return path.join(receipts, name);
  }

  it('round-trips a pending receipt and its completed result', async () => {
    const storage = new FileManagedDelegationMessageStorage(receipts);
    await expect(storage.load(operationId)).resolves.toBeUndefined();

    await storage.commit({ operationId, requestHash, status: 'pending' });
    await expect(storage.load(operationId)).resolves.toEqual({
      operationId,
      requestHash,
      status: 'pending',
    });
    expect(await fs.readFile(await receiptFile(), 'utf8')).toBe(
      JSON.stringify({ operationId, requestHash, status: 'pending' }),
    );

    const result = {
      ok: false,
      code: 'busy',
      error: 'The delegate already has a command pending.',
    } as const;
    await storage.commit({
      operationId,
      requestHash,
      status: 'complete',
      result,
    });
    await expect(storage.load(operationId)).resolves.toEqual({
      operationId,
      requestHash,
      status: 'complete',
      result,
    });
    expect(await fs.readFile(await receiptFile(), 'utf8')).toBe(
      JSON.stringify({ operationId, requestHash, status: 'complete', result }),
    );
    expect(await fs.readdir(receipts)).toHaveLength(1);
  });

  it('loads versioned receipts through the v2 decoder', async () => {
    const storage = new FileManagedDelegationMessageStorage(receipts);
    await storage.commit({ operationId, requestHash, status: 'pending' });
    const file = await receiptFile();
    await fs.writeFile(
      file,
      encodeManagedMessageReceiptV2(versionedPendingReceipt),
    );

    await expect(storage.load(operationId)).resolves.toEqual(
      versionedPendingReceipt,
    );
  });

  it('encodes versioned commits through the v2 encoder', async () => {
    const storage = new FileManagedDelegationMessageStorage(receipts);

    await expect(
      storage.commit(versionedPendingReceipt),
    ).resolves.toBeUndefined();
    expect(await fs.readFile(await receiptFile(), 'utf8')).toBe(
      encodeManagedMessageReceiptV2(versionedPendingReceipt),
    );
    await expect(storage.load(operationId)).resolves.toEqual(
      versionedPendingReceipt,
    );
  });

  it('fails closed on a corrupt or misfiled receipt', async () => {
    const storage = new FileManagedDelegationMessageStorage(receipts);
    await storage.commit({ operationId, requestHash, status: 'pending' });
    const file = await receiptFile();

    await fs.writeFile(file, '{');
    await expect(storage.load(operationId)).rejects.toThrow(
      'Invalid private delegation message receipt',
    );

    await fs.writeFile(
      file,
      JSON.stringify({
        operationId: '123e4567-e89b-42d3-a456-426614174001',
        requestHash,
        status: 'pending',
      }),
    );
    await expect(storage.load(operationId)).rejects.toThrow(
      'Invalid private delegation message receipt',
    );
  });

  it('fails closed on unsupported or malformed versioned receipts', async () => {
    const storage = new FileManagedDelegationMessageStorage(receipts);
    await storage.commit({ operationId, requestHash, status: 'pending' });
    const file = await receiptFile();

    await fs.writeFile(
      file,
      JSON.stringify({ ...versionedPendingReceipt, version: 3 }),
    );
    await expect(storage.load(operationId)).rejects.toThrow(
      'Unsupported managed message receipt version',
    );

    await fs.writeFile(
      file,
      JSON.stringify({ ...versionedPendingReceipt, extra: true }),
    );
    await expect(storage.load(operationId)).rejects.toThrow(
      'Invalid managed message receipt',
    );
  });

  it('rejects a hard-linked receipt', async () => {
    const storage = new FileManagedDelegationMessageStorage(receipts);
    await storage.commit({ operationId, requestHash, status: 'pending' });
    await fs.link(await receiptFile(), path.join(directory, 'linked-receipt'));

    await expect(storage.load(operationId)).rejects.toThrow(
      'Invalid private delegation record',
    );
  });
});

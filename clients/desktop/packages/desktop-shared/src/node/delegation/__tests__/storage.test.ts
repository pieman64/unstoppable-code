import type { AgentDelegationWorkspaceObservation } from '@canopy/protocol/delegation';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

describe('private durable delegation registry', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-storage-'));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
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
    if (!record) throw new Error('Expected retained record');
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
    if (process.platform !== 'win32') {
      await fs.chmod(malformed, 0o600);
      await fs.chmod(invalid, 0o600);
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
    if (!record) throw new Error('Expected retained record');
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
});

describe('private delegation message receipts', () => {
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  const requestHash = 'a'.repeat(64);
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
    expect(await fs.readdir(receipts)).toHaveLength(1);
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

  it('rejects a hard-linked receipt', async () => {
    const storage = new FileManagedDelegationMessageStorage(receipts);
    await storage.commit({ operationId, requestHash, status: 'pending' });
    await fs.link(await receiptFile(), path.join(directory, 'linked-receipt'));

    await expect(storage.load(operationId)).rejects.toThrow(
      'Invalid private delegation record',
    );
  });
});

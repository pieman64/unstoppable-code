import { createHash } from 'node:crypto';
import { canonicalDelegationJson } from '@canopy/desktop-shared/node/delegation/settlement-identity';
import type * as FsPromises from 'node:fs/promises';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationRegistryJournalEffect } from '../lib/chat-delta-journal/delegation-registry-api';
import {
  registryOwner,
  registryOwnerDirectory,
  registryOwnerKey,
} from '../lib/chat-delta-journal/delegation-registry-owner';
import {
  DelegationRegistryStore,
  scanDelegationRegistryAnswerReferences,
} from '../lib/chat-delta-journal/delegation-registry-store';

const mockSegments = new Set<string>();
const mockWork = { segments: 0, bytes: 0, pointBuffers: 0, pointBytes: 0 };
jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    readFile: new Proxy(actual.readFile, {
      apply(target, thisArg, args: unknown[]): unknown {
        const result: unknown = Reflect.apply(target, thisArg, args);
        return Promise.resolve(result).then((value: unknown): unknown => {
          if (typeof args[0] === 'string' && args[0].includes('/segments/')) {
            mockWork.segments += 1;
            mockSegments.add(args[0]);
            if (Buffer.isBuffer(value)) mockWork.bytes += value.length;
          }
          return value;
        });
      },
    }),
    open: async (
      ...args: Parameters<typeof actual.open>
    ): ReturnType<typeof actual.open> => {
      const handle = await actual.open(...args);
      const segment =
        typeof args[0] === 'string' && args[0].includes('/segments/');
      handle.read = new Proxy(handle.read.bind(handle), {
        apply(target, thisArg, readArgs: unknown[]): unknown {
          if (segment && Buffer.isBuffer(readArgs[0])) {
            mockWork.segments += 1;
            if (typeof args[0] === 'string') mockSegments.add(args[0]);
            mockWork.pointBuffers += 1;
            mockWork.pointBytes += readArgs[0].length;
            mockWork.bytes += readArgs[0].length;
          }
          return Reflect.apply(target, thisArg, readArgs);
        },
      });
      return handle;
    },
  };
});
function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('object expected');
  return Object.fromEntries(
    Object.entries(value).map(
      ([key, entry]: [string, unknown]): [string, unknown] => [key, entry],
    ),
  );
}
function resetWork(): void {
  mockSegments.clear();
  mockWork.segments = 0;
  mockWork.bytes = 0;
  mockWork.pointBuffers = 0;
  mockWork.pointBytes = 0;
}

const chatId = 'receipt-chat';
const receipt: Extract<
  DelegationRegistryJournalEffect,
  { kind: 'delegation-receipt' }
> = {
  kind: 'delegation-receipt',
  owner: { kind: 'chat_receipts', chatId },
  entry: {
    version: 1,
    kind: 'receipt',
    chatId,
    receiptKind: 'stop',
    key: 'a'.repeat(64),
    delegationId: 'child',
    runGeneration: 1,
    operationId: '12345678-1234-4234-8234-123456789abc',
    requestHash: 'b'.repeat(64),
    operation: 'stop',
    admittedAt: 10,
    reply: { kind: 'stop', ackStatus: 'accepted', runGeneration: 1 },
  },
};

describe('registry receipt owners', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'registry-receipts-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('finds a receipt after checkpoint and reopen', async () => {
    const store = new DelegationRegistryStore(root);
    await store.append(chatId, [receipt]);
    await store.checkpoint(await store.highWater(receipt.owner));
    await expect(
      new DelegationRegistryStore(root).receipt({
        chatId,
        receiptKind: receipt.entry.receiptKind,
        key: receipt.entry.key,
      }),
    ).resolves.toEqual(receipt.entry);
  });
  it('forgets the raw-chat replay load when a chat is recreated', async () => {
    let reads = 0;
    const store = new DelegationRegistryStore(root, {
      pendingEffects: function* (): Iterable<DelegationRegistryJournalEffect> {
        reads += 1;
        yield* [];
      },
    });
    const identity = { chatId, delegationId: 'child' };
    await store.highWater(identity);
    store.forgetChat(chatId);
    await store.highWater(identity);
    expect(reads).toBe(2);
  });
  const receiptIdentity = {
    chatId,
    receiptKind: receipt.entry.receiptKind,
    key: receipt.entry.key,
  };
  const ownerDirectory = (base: string): string =>
    join(
      base,
      'delegations',
      chatId,
      'registry',
      registryOwnerDirectory(receipt.owner),
    );
  const charge = async (base: string): Promise<unknown[]> => {
    const entries: unknown[] = [];
    for await (const entry of scanDelegationRegistryAnswerReferences(
      base,
      chatId,
    ))
      entries.push(entry);
    return entries;
  };
  it('keeps the concrete cross-form key collision disjoint and legacy heads unchanged', async () => {
    const legacy = { chatId: 'chat_receipts', delegationId: chatId };
    expect(registryOwnerKey(legacy)).toBe(
      JSON.stringify(['chat_receipts', chatId]),
    );
    expect(registryOwnerKey(registryOwner(legacy))).toBe(
      registryOwnerKey(legacy),
    );
    expect(registryOwnerKey(receipt.owner)).toBe(
      JSON.stringify(['#owner', 'chat_receipts', chatId]),
    );
    expect(registryOwnerDirectory(receipt.owner)).not.toBe(
      registryOwnerDirectory(legacy),
    );
    const effect: DelegationRegistryJournalEffect = {
      kind: 'delegation-generation',
      identity: legacy,
      entry: {
        version: 1,
        kind: 'generation',
        ...legacy,
        runGeneration: 1,
        createdAt: 0,
        store: 'stream',
        origin: { kind: 'launch' },
        executionMode: 'background',
      },
    };
    const store = new DelegationRegistryStore(root);
    await store.append(legacy.chatId, [effect]);
    await store.append(chatId, [receipt]);
    await store.checkpoint(await store.highWater(legacy));
    await store.checkpoint(await store.highWater(receipt.owner));
    const head: unknown = JSON.parse(
      await readFile(
        join(
          root,
          'delegations',
          legacy.chatId,
          'registry',
          registryOwnerDirectory(legacy),
          'head.json',
        ),
        'utf8',
      ),
    );
    expect(head).toMatchObject({ identity: legacy });
    expect(head).not.toHaveProperty('owner');
    const legacyDirectory = join(
      root,
      'delegations',
      legacy.chatId,
      'registry',
      registryOwnerDirectory(legacy),
    );
    const legacySegment = await readFile(
      join(legacyDirectory, 'segments', 'segment-00000000.jsonl'),
    );
    const emptyDigest = createHash('sha256')
      .update(Buffer.alloc(0))
      .digest('hex');
    const legacyDigest = createHash('sha256')
      .update(`${emptyDigest}\n${canonicalDelegationJson(effect)}`)
      .digest('hex');
    expect(await readFile(join(legacyDirectory, 'head.json'), 'utf8')).toBe(
      `${JSON.stringify({ version: 1, identity: legacy, highWater: 1, entriesSha256: legacyDigest, resultCount: 0, generationCount: 1, admissionCount: 0, currentSegmentBytes: legacySegment.length })}\n`,
    );

    const receiptHead: unknown = JSON.parse(
      await readFile(join(ownerDirectory(root), 'head.json'), 'utf8'),
    );
    expect(receiptHead).toMatchObject({ owner: receipt.owner });
    expect(receiptHead).not.toHaveProperty('identity');
    const reopened = new DelegationRegistryStore(root);
    await expect(
      reopened.generation({ ...legacy, runGeneration: 1 }),
    ).resolves.toEqual({ entry: effect.entry, result: null, stream: null });
    await expect(reopened.receipt(receiptIdentity)).resolves.toEqual(
      receipt.entry,
    );
  });
  it('replays identical receipts and conflicts for the same chat namespace across delegations', async () => {
    const store = new DelegationRegistryStore(root);
    await store.append(chatId, [receipt, receipt]);
    expect((await store.highWater(receipt.owner)).highWater).toBe(1);
    await store.checkpoint(await store.highWater(receipt.owner));
    const reopened = new DelegationRegistryStore(root);
    await reopened.append(chatId, [receipt]);
    expect((await reopened.highWater(receipt.owner)).highWater).toBe(1);
    await expect(
      reopened.append(chatId, [
        { ...receipt, entry: { ...receipt.entry, delegationId: 'other' } },
      ]),
    ).rejects.toMatchObject({ failure: { code: 'conflict' } });
  });
  it('forgets warm receipt heads and overlays on delete and recreate', async () => {
    const store = new DelegationRegistryStore(root);
    await store.append(chatId, [receipt]);
    await store.checkpoint(await store.highWater(receipt.owner));
    await store.receipt(receiptIdentity);
    await rm(join(root, 'delegations', chatId), { recursive: true });
    store.forgetChat(chatId);
    await expect(store.receipt(receiptIdentity)).resolves.toBeUndefined();
    const replacement = {
      ...receipt,
      entry: { ...receipt.entry, admittedAt: 11 },
    };
    await store.append(chatId, [replacement]);
    await store.checkpoint(await store.highWater(receipt.owner));
    await expect(
      new DelegationRegistryStore(root).receipt(receiptIdentity),
    ).resolves.toEqual(replacement.entry);
  });
  it('charges every receipt-only record without a descriptor and survives copying after source removal', async () => {
    const store = new DelegationRegistryStore(root);
    await store.append(chatId, [receipt]);
    await store.checkpoint(await store.highWater(receipt.owner));
    expect(await charge(root)).toEqual([null]);
    const copy = join(root, 'retained-copy');
    await mkdir(copy);
    await cp(join(root, 'delegations'), join(copy, 'delegations'), {
      recursive: true,
    });
    await rm(join(root, 'delegations'), { recursive: true });
    await expect(
      new DelegationRegistryStore(copy).receipt(receiptIdentity),
    ).resolves.toEqual(receipt.entry);
    expect(await charge(copy)).toEqual([null]);
  });
  it('rejects misplaced heads, effects and corrupt receipt-only segments', async () => {
    const store = new DelegationRegistryStore(root);
    await store.append(chatId, [receipt]);
    await store.checkpoint(await store.highWater(receipt.owner));
    const headPath = join(ownerDirectory(root), 'head.json');
    const headBytes = await readFile(headPath);
    const head: unknown = JSON.parse(headBytes.toString('utf8'));
    await writeFile(
      headPath,
      JSON.stringify({
        ...objectRecord(head),
        owner: { ...receipt.owner, chatId: 'other' },
      }),
    );
    await expect(charge(root)).rejects.toMatchObject({
      failure: { code: 'corruption' },
    });
    await writeFile(
      headPath,
      JSON.stringify({ ...objectRecord(head), generationCount: 1 }),
    );
    await expect(charge(root)).rejects.toMatchObject({
      failure: { code: 'corruption' },
    });
    await writeFile(headPath, headBytes);
    const segmentPath = join(
      ownerDirectory(root),
      'segments',
      'segment-00000000.jsonl',
    );
    const bytes = await readFile(segmentPath);
    await writeFile(segmentPath, Buffer.from('corrupt\n'));
    await expect(charge(root)).rejects.toMatchObject({
      failure: { code: 'corruption' },
    });
    await writeFile(segmentPath, bytes);
    // A self-consistent hash chain is still invalid under the wrong owner.
    const original = objectRecord(JSON.parse(bytes.toString('utf8')));
    const wrongEffect: DelegationRegistryJournalEffect = {
      kind: 'delegation-generation',
      identity: { chatId, delegationId: 'misplaced' },
      entry: {
        version: 1,
        kind: 'generation',
        chatId,
        delegationId: 'misplaced',
        runGeneration: 1,
        createdAt: 0,
        store: 'stream',
        origin: { kind: 'launch' },
        executionMode: 'background',
      },
    };
    const digest = createHash('sha256')
      .update(
        `${String(original.previousDigest)}\n${canonicalDelegationJson(wrongEffect)}`,
      )
      .digest('hex');
    await writeFile(
      segmentPath,
      `${canonicalDelegationJson({ ...original, effect: wrongEffect, entriesSha256: digest })}\n`,
    );
    await writeFile(
      headPath,
      JSON.stringify({ ...objectRecord(head), entriesSha256: digest }),
    );
    await expect(charge(root)).rejects.toMatchObject({
      failure: { code: 'corruption' },
    });
    await writeFile(segmentPath, bytes);
    await writeFile(headPath, headBytes);
    const wrongDirectory = join(
      root,
      'delegations',
      chatId,
      'registry',
      'a'.repeat(64),
    );
    await cp(ownerDirectory(root), wrongDirectory, { recursive: true });
    await expect(charge(root)).rejects.toMatchObject({
      failure: { code: 'corruption' },
    });
  });
  it('rejects malformed whole effects before mutation', async () => {
    const store = new DelegationRegistryStore(root);
    const wrong = { ...receipt, owner: { ...receipt.owner, chatId: 'other' } };
    await expect(store.append(chatId, [wrong])).rejects.toMatchObject({
      failure: { code: 'invalid_request' },
    });
    expect((await store.highWater(receipt.owner)).highWater).toBe(0);
  });

  it('measures receipt lookup work at N=1,000 and 2N (first miss is deferred debt)', async () => {
    const measured: unknown[] = [];
    for (const count of [1000, 2000]) {
      const base = join(root, String(count));
      const store = new DelegationRegistryStore(base);
      const effects = Array.from({ length: count }, (_, index) => ({
        ...receipt,
        entry: { ...receipt.entry, key: index.toString(16).padStart(64, '0') },
      }));
      await store.append(chatId, effects);
      await store.checkpoint(await store.highWater(receipt.owner));
      const hit = { ...receiptIdentity, key: effects[count - 1].entry.key };
      const absent = { ...receiptIdentity, key: 'f'.repeat(64) };
      let reader = new DelegationRegistryStore(base);
      resetWork();
      await reader.receipt(hit);
      const hot = { ...mockWork, distinctSegments: mockSegments.size };
      expect(hot.segments).toBe(1);
      expect(hot.pointBuffers).toBe(1);
      resetWork();
      await expect(reader.receipt(absent)).resolves.toBeUndefined();
      const firstMiss = { ...mockWork, distinctSegments: mockSegments.size };
      expect(firstMiss.segments).toBe(Math.ceil(count / 64));
      resetWork();
      await reader.receipt(absent);
      const warmMiss = { ...mockWork, distinctSegments: mockSegments.size };
      expect(warmMiss.segments).toBe(0);
      await rm(join(ownerDirectory(base), 'index', 'receipt'), {
        recursive: true,
      });
      reader = new DelegationRegistryStore(base);
      resetWork();
      await expect(reader.receipt(hit)).resolves.toEqual(
        effects[count - 1].entry,
      );
      const recovery = { ...mockWork, distinctSegments: mockSegments.size };
      expect(recovery.segments).toBe(Math.ceil(count / 64) + 1);
      for (let index = 0; index < 65; index += 1)
        await reader.highWater({
          kind: 'chat_receipts',
          chatId: `evict-${index}`,
        });
      // Evict the ephemeral index too: every owner incurs its own first miss.
      for (let index = 0; index < 65; index += 1)
        await reader.receipt({ ...absent, chatId: `evict-${index}` });
      resetWork();
      await reader.receipt(absent);
      const evictedMiss = { ...mockWork, distinctSegments: mockSegments.size };
      expect(evictedMiss.segments).toBe(Math.ceil(count / 64));
      reader = new DelegationRegistryStore(base);
      resetWork();
      await reader.append(chatId, [
        { ...receipt, entry: { ...receipt.entry, key: 'e'.repeat(64) } },
      ]);
      await reader.checkpoint(await reader.highWater(receipt.owner));
      const coldAdmission = {
        ...mockWork,
        distinctSegments: mockSegments.size,
      };
      expect(coldAdmission.segments).toBe(Math.ceil(count / 64));
      const delegationIdentity = { chatId, delegationId: 'scale-child' };
      const generationEffects: DelegationRegistryJournalEffect[] = Array.from(
        { length: count },
        (_, index) => ({
          kind: 'delegation-generation',
          identity: delegationIdentity,
          entry: {
            version: 1,
            kind: 'generation',
            ...delegationIdentity,
            runGeneration: index + 1,
            createdAt: 0,
            store: 'stream',
            origin: { kind: 'launch' },
            executionMode: 'background',
          },
        }),
      );
      await store.append(chatId, generationEffects);
      await store.checkpoint(await store.highWater(delegationIdentity));
      resetWork();
      await expect(
        new DelegationRegistryStore(base).resultBySettlementKey({
          ...delegationIdentity,
          settlementKey: 'absent',
        }),
      ).resolves.toBeUndefined();
      const coldSettlementAbsence = {
        ...mockWork,
        distinctSegments: mockSegments.size,
      };
      expect(coldSettlementAbsence.segments).toBe(Math.ceil(count / 64));
      resetWork();
      await expect(
        new DelegationRegistryStore(base).generationEntry({
          ...delegationIdentity,
          runGeneration: count + 1,
        }),
      ).resolves.toBeUndefined();
      const coldGenerationAbsence = {
        ...mockWork,
        distinctSegments: mockSegments.size,
      };
      expect(coldGenerationAbsence.segments).toBe(Math.ceil(count / 64));
      // Rebuild allocates one locator map with one locator object per retained
      // receipt; point hits allocate one bounded buffer and no rebuild map.
      measured.push({
        count,
        hot,
        firstMiss,
        recovery,
        warmMiss,
        evictedMiss,
        coldAdmission,
        coldSettlementAbsence,
        coldGenerationAbsence,
        rebuildMaps: 1,
        rebuildLocators: count,
      });
    }
    process.stdout.write(`S2_RECEIPT_WORK ${JSON.stringify(measured)}\n`);
  }, 120_000);
});

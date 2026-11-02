import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encodeStreamRegistry,
  parseStreamRegistry,
  streamRegistryPaths,
  createEmptyStreamDescriptor,
  applyStreamDescriptorUpdate,
  validateStreamClosure,
  validateStreamTarget,
  UnknownTranscriptStreamError,
  loadStreamRegistry,
  loadStreamCatalog,
  parseStreamDescriptor,
} from '../lib/chat-delta-journal/stream-registry';
import {
  ChatDeltaJournalIntegrityError,
  ChatStorageNewerFormatError,
} from '../lib/chat-delta-journal/format';
import { delegationStreamKey } from '../lib/transcript-stream-paths';

describe('checkpointed stream registry authority', () => {
  const target = {
    kind: 'delegation' as const,
    chatId: 'chat-1',
    delegationId: 'd-1',
    runGeneration: 0,
  };
  const streamKey = delegationStreamKey(target);
  const entry = {
    type: 'stream' as const,
    version: 1 as const,
    target,
    streamKey,
    registeredAtRevision: 2,
  };
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-registry-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('binds exact JSONL lines, rejects interior corruption and duplicates', () => {
    const bytes = encodeStreamRegistry('chat-1', 2, [entry]);
    expect(parseStreamRegistry(bytes, 'chat-1').entries).toEqual([entry]);
    expect(() =>
      parseStreamRegistry(
        Buffer.from(bytes.toString().replace('d-1', 'd-2')),
        'chat-1',
      ),
    ).toThrow(ChatDeltaJournalIntegrityError);
    expect(() =>
      parseStreamRegistry(bytes.subarray(0, bytes.length - 1), 'chat-1'),
    ).toThrow(ChatDeltaJournalIntegrityError);
    expect(() => encodeStreamRegistry('chat-1', 2, [entry, entry])).toThrow(
      ChatDeltaJournalIntegrityError,
    );
    expect(() =>
      parseStreamRegistry(
        Buffer.concat([bytes, Buffer.from([0xff])]),
        'chat-1',
      ),
    ).toThrow(ChatDeltaJournalIntegrityError);
    const entryBytes = bytes.subarray(bytes.indexOf(10) + 1);
    const header = {
      type: 'stream-registry',
      version: 1,
      parentChatId: 'chat-1',
      checkpointRevision: 2,
      entryCount: 2,
      entriesSha256: createHash('sha256').update(entryBytes).digest('hex'),
    };
    expect(() =>
      parseStreamRegistry(
        Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), entryBytes]),
        'chat-1',
      ),
    ).toThrow('count');
    const invalidUtf8 = Buffer.from(entryBytes);
    invalidUtf8[10] = 0xff;
    const utf8Header = {
      ...header,
      entryCount: 1,
      entriesSha256: createHash('sha256').update(invalidUtf8).digest('hex'),
    };
    expect(() =>
      parseStreamRegistry(
        Buffer.concat([
          Buffer.from(`${JSON.stringify(utf8Header)}\n`),
          invalidUtf8,
        ]),
        'chat-1',
      ),
    ).toThrow('UTF-8');
  });

  it('checks descriptor and log against catalog and rebuilds a stale derived index', async () => {
    const paths = streamRegistryPaths(root, 'chat-1', streamKey);
    const bytes = encodeStreamRegistry('chat-1', 2, [entry]);
    await mkdir(paths.streamDirectory, { recursive: true });
    await writeFile(paths.registry, bytes);
    await writeFile(
      paths.descriptor,
      JSON.stringify(createEmptyStreamDescriptor(entry, 2)),
    );
    await writeFile(paths.log, '');
    await writeFile(paths.index, '{}');
    const catalog = {
      version: 1 as const,
      checkpointRevision: 2,
      parents: {
        'chat-1': {
          entryCount: 1,
          registrySha256: createHash('sha256').update(bytes).digest('hex'),
          registryBytes: bytes.length,
        },
      },
    };
    await validateStreamClosure(root, catalog, { readOnly: true });
    expect(await readFile(paths.index, 'utf8')).toBe('{}');
    await validateStreamClosure(root, catalog);
    expect((await loadStreamRegistry(root, 'chat-1')).entries).toEqual([entry]);
    const index: unknown = JSON.parse(await readFile(paths.index, 'utf8'));
    expect(index).toMatchObject({ version: 1 });
    await rm(paths.descriptor);
    await expect(validateStreamClosure(root, catalog)).rejects.toThrow(
      ChatDeltaJournalIntegrityError,
    );
  });

  it('uses shallow stat closure by default and bounded deep digest validation', async () => {
    const paths = streamRegistryPaths(root, 'chat-1', streamKey);
    const bytes = encodeStreamRegistry('chat-1', 2, [entry]);
    await mkdir(paths.streamDirectory, { recursive: true });
    await writeFile(paths.registry, bytes);
    const log = Array.from(
      { length: 10_000 },
      (_, i) => `${JSON.stringify({ id: i })}\n`,
    ).join('');
    await writeFile(paths.log, log);
    await writeFile(
      paths.descriptor,
      JSON.stringify({
        ...createEmptyStreamDescriptor(entry, 2),
        committedByteLength: Buffer.byteLength(log),
        committedRowCount: 10_000,
        committedSha256: createHash('sha256').update(log).digest('hex'),
      }),
    );
    const catalog = {
      version: 1 as const,
      checkpointRevision: 2,
      parents: {
        'chat-1': {
          entryCount: 1,
          registrySha256: createHash('sha256').update(bytes).digest('hex'),
          registryBytes: bytes.length,
        },
      },
    };
    await validateStreamClosure(root, catalog, { readOnly: true });
    await validateStreamClosure(root, catalog, { readOnly: true, deep: true });
    expect(
      (await validateStreamTarget(root, catalog, target, { readOnly: true }))
        .target,
    ).toEqual(target);
    await expect(
      validateStreamTarget(
        root,
        catalog,
        { ...target, delegationId: 'missing' },
        { readOnly: true },
      ),
    ).rejects.toThrow(UnknownTranscriptStreamError);
    await writeFile(paths.log, `${'x'.repeat(Buffer.byteLength(log) - 1)}\n`);
    await validateStreamClosure(root, catalog, { readOnly: true });
    await expect(
      validateStreamClosure(root, catalog, { readOnly: true, deep: true }),
    ).rejects.toThrow(ChatDeltaJournalIntegrityError);
  });

  it('compares descriptor revisions and settlement receipts', () => {
    const descriptor = createEmptyStreamDescriptor(entry, 2);
    const next = applyStreamDescriptorUpdate(descriptor, {
      version: 1,
      target,
      expectedStreamRevision: 0,
      nextStreamRevision: 1,
      cardState: null,
    });
    expect(next.streamRevision).toBe(1);
    expect(() =>
      applyStreamDescriptorUpdate(descriptor, {
        version: 1,
        target,
        expectedStreamRevision: 1,
        nextStreamRevision: 2,
      }),
    ).toThrow(ChatDeltaJournalIntegrityError);
  });

  it('refuses a stale registry, a missing known registry, or a shorter log', async () => {
    const paths = streamRegistryPaths(root, 'chat-1', streamKey);
    const bytes = encodeStreamRegistry('chat-1', 2, [entry]);
    const catalog = {
      version: 1 as const,
      checkpointRevision: 2,
      parents: {
        'chat-1': {
          entryCount: 1,
          registrySha256: createHash('sha256').update(bytes).digest('hex'),
          registryBytes: bytes.length,
        },
      },
    };
    await expect(validateStreamClosure(root, catalog)).rejects.toThrow(
      ChatDeltaJournalIntegrityError,
    );
    await mkdir(paths.streamDirectory, { recursive: true });
    await writeFile(paths.registry, encodeStreamRegistry('chat-1', 2, []));
    await expect(validateStreamClosure(root, catalog)).rejects.toThrow(
      ChatDeltaJournalIntegrityError,
    );
    await writeFile(paths.registry, bytes);
    await writeFile(
      paths.descriptor,
      JSON.stringify({
        ...createEmptyStreamDescriptor(entry, 2),
        committedByteLength: 2,
      }),
    );
    await writeFile(paths.log, '');
    await expect(validateStreamClosure(root, catalog)).rejects.toThrow(
      ChatDeltaJournalIntegrityError,
    );
  });

  it('refuses a tuple/key mismatch even with a matching line hash', () => {
    expect(() =>
      encodeStreamRegistry('chat-1', 2, [
        { ...entry, streamKey: 'f'.repeat(64) },
      ]),
    ).toThrow(ChatDeltaJournalIntegrityError);
  });

  it('fails closed on missing catalog and future descriptor fields', async () => {
    await expect(loadStreamCatalog(root)).rejects.toThrow(
      ChatDeltaJournalIntegrityError,
    );
    const descriptor = createEmptyStreamDescriptor(entry, 2);
    expect(() =>
      parseStreamDescriptor(
        Buffer.from(JSON.stringify({ ...descriptor, future: true })),
      ),
    ).toThrow(ChatStorageNewerFormatError);
  });
});

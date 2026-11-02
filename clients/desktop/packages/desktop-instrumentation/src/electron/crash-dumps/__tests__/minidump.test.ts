import { execFileSync, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import type { ReadOptions, ReadOptionsWithBuffer, ReadPosition } from 'node:fs';
import type * as FsPromisesModule from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MINIDUMP_READ_BUDGET_BYTES,
  readMinidumpExecutablePath,
} from '../minidump';

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});

interface DirectoryEntryFixture {
  readonly streamType: number;
}

interface MinidumpFixtureOptions {
  readonly directoryEntries?: readonly DirectoryEntryFixture[];
  readonly directoryRva?: number;
  readonly executablePath?: string;
  readonly moduleCount?: number;
  readonly moduleListDataSize?: number;
  readonly moduleListRva?: number;
  readonly nameBytes?: Buffer;
  readonly nameLength?: number;
  readonly nameRva?: number;
  readonly numberOfStreams?: number;
  readonly signature?: number;
  readonly truncateNameBytes?: number;
  readonly version?: number;
}

interface ReadBehavior {
  readonly closeThrows?: boolean;
  readonly maxReadSize?: number;
  readonly shrinkAtRead?: number;
  readonly zeroAtRead?: number;
}

interface ReadObservation {
  bytesRead: number;
  closeCalls: number;
  readCalls: number;
  shrinkSucceeded: boolean;
}

const MINIDUMP_HEADER_SIZE = 32;
const MINIDUMP_DIRECTORY_SIZE = 12;
const MINIDUMP_MODULE_SIZE = 108;
const DEFAULT_EXECUTABLE_PATH =
  '/Applications/Canopy.app/Contents/MacOS/Canopy';
const MAX_U32 = 0xffffffff;
const canRunMkfifo =
  process.platform !== 'win32' && spawnSync('mkfifo').error === undefined;

const temporaryDirectories: string[] = [];
const originalOpen =
  jest.requireActual<typeof FsPromisesModule>('node:fs/promises').open;
const realTruncate =
  jest.requireActual<typeof FsPromisesModule>('node:fs/promises').truncate;

afterEach(async () => {
  jest.restoreAllMocks();
  jest.mocked(fsPromises.open).mockReset();
  jest.mocked(fsPromises.open).mockImplementation(originalOpen);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        fsPromises.rm(directory, { force: true, recursive: true }),
      ),
  );
});

async function createFixtureFile(
  options: MinidumpFixtureOptions = {},
): Promise<{ readonly directory: string; readonly filePath: string }> {
  const directory = await fsPromises.mkdtemp(
    join(tmpdir(), 'minidump-reader-'),
  );
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'synthetic.dmp');
  await fsPromises.writeFile(filePath, buildMinidumpFixture(options));
  return { directory, filePath };
}

function buildMinidumpFixture(options: MinidumpFixtureOptions = {}): Buffer {
  const directoryEntries = options.directoryEntries ?? [{ streamType: 4 }];
  const physicalDirectoryRva = MINIDUMP_HEADER_SIZE;
  const physicalModuleListRva =
    physicalDirectoryRva + directoryEntries.length * MINIDUMP_DIRECTORY_SIZE;
  const physicalModuleListSize = 4 + MINIDUMP_MODULE_SIZE;
  const physicalNameRva = physicalModuleListRva + physicalModuleListSize;
  const nameBytes =
    options.nameBytes ??
    Buffer.from(options.executablePath ?? DEFAULT_EXECUTABLE_PATH, 'utf16le');
  const fileSize = physicalNameRva + 4 + nameBytes.length + 2;
  const fixture = Buffer.alloc(fileSize);

  fixture.writeUInt32LE(options.signature ?? 0x504d444d, 0);
  fixture.writeUInt32LE(options.version ?? 0x0001a793, 4);
  fixture.writeUInt32LE(options.numberOfStreams ?? directoryEntries.length, 8);
  fixture.writeUInt32LE(options.directoryRva ?? physicalDirectoryRva, 12);
  fixture.writeUInt32LE(0, 16);
  fixture.writeUInt32LE(0, 20);
  fixture.writeBigUInt64LE(0n, 24);

  const moduleListDataSize =
    options.moduleListDataSize ?? physicalModuleListSize;
  const moduleListRva = options.moduleListRva ?? physicalModuleListRva;
  for (let index = 0; index < directoryEntries.length; index += 1) {
    const entryOffset = physicalDirectoryRva + index * MINIDUMP_DIRECTORY_SIZE;
    const directoryEntry = directoryEntries[index];
    if (directoryEntry === undefined) {
      continue;
    }
    fixture.writeUInt32LE(directoryEntry.streamType, entryOffset);
    fixture.writeUInt32LE(moduleListDataSize, entryOffset + 4);
    fixture.writeUInt32LE(moduleListRva, entryOffset + 8);
  }

  fixture.writeUInt32LE(options.moduleCount ?? 1, physicalModuleListRva);
  const firstModuleOffset = physicalModuleListRva + 4;
  fixture.writeBigUInt64LE(0x100000000n, firstModuleOffset);
  fixture.writeUInt32LE(0x2000, firstModuleOffset + 8);
  fixture.writeUInt32LE(0, firstModuleOffset + 12);
  fixture.writeUInt32LE(0, firstModuleOffset + 16);
  fixture.writeUInt32LE(
    options.nameRva ?? physicalNameRva,
    firstModuleOffset + 20,
  );
  fixture.writeUInt32LE(
    options.nameLength ?? nameBytes.length,
    physicalNameRva,
  );
  nameBytes.copy(fixture, physicalNameRva + 4);

  if (options.truncateNameBytes !== undefined) {
    return fixture.subarray(0, physicalNameRva + 4 + options.truncateNameBytes);
  }
  return fixture;
}

function instrumentOpenedHandle(behavior: ReadBehavior = {}): ReadObservation {
  const observation: ReadObservation = {
    bytesRead: 0,
    closeCalls: 0,
    readCalls: 0,
    shrinkSucceeded: false,
  };
  jest.mocked(fsPromises.open).mockImplementation(async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    const originalRead = handle.read.bind(handle);
    const originalClose = handle.close.bind(handle);

    function observedRead<T extends NodeJS.ArrayBufferView>(
      buffer: T,
      offset?: number | null,
      length?: number | null,
      position?: ReadPosition | null,
    ): Promise<fsPromises.FileReadResult<T>>;
    function observedRead<T extends NodeJS.ArrayBufferView>(
      buffer: T,
      options?: ReadOptions,
    ): Promise<fsPromises.FileReadResult<T>>;
    function observedRead<T extends NodeJS.ArrayBufferView = Buffer>(
      options?: ReadOptionsWithBuffer<T>,
    ): Promise<fsPromises.FileReadResult<T>>;
    async function observedRead(
      input:
        | NodeJS.ArrayBufferView
        | ReadOptionsWithBuffer<NodeJS.ArrayBufferView> = {},
      offsetOrOptions?: number | null | ReadOptions,
      length?: number | null,
      position?: ReadPosition | null,
    ): Promise<fsPromises.FileReadResult<NodeJS.ArrayBufferView>> {
      const options = ArrayBuffer.isView(input)
        ? typeof offsetOrOptions === 'object' && offsetOrOptions !== null
          ? offsetOrOptions
          : { offset: offsetOrOptions, length, position }
        : input;
      const buffer = ArrayBuffer.isView(input)
        ? input
        : (input.buffer ?? Buffer.alloc(16384));
      observation.readCalls += 1;
      if (behavior.shrinkAtRead === observation.readCalls) {
        await realTruncate(
          String(path),
          MINIDUMP_HEADER_SIZE + MINIDUMP_DIRECTORY_SIZE,
        );
        observation.shrinkSucceeded = true;
      }
      if (behavior.zeroAtRead === observation.readCalls) {
        return { buffer, bytesRead: 0 };
      }
      const bufferOffset = options.offset ?? 0;
      const requestedLength =
        options.length ?? buffer.byteLength - bufferOffset;
      const actualLength = Math.min(
        requestedLength,
        behavior.maxReadSize ?? requestedLength,
      );
      const result = await originalRead(
        buffer,
        bufferOffset,
        actualLength,
        options.position ?? null,
      );
      observation.bytesRead += result.bytesRead;
      return result;
    }
    jest.spyOn(handle, 'read').mockImplementation(observedRead);
    jest.spyOn(handle, 'close').mockImplementation(async () => {
      observation.closeCalls += 1;
      await originalClose();
      if (behavior.closeThrows === true) {
        throw new Error('simulated close failure');
      }
    });
    return handle;
  });
  return observation;
}

describe('readMinidumpExecutablePath', () => {
  it('reads module zero using the confirmed minidump offsets', async () => {
    const executablePath = '/Applications/Canopy.app/Contents/MacOS/Canopy';
    const { filePath } = await createFixtureFile({ executablePath });

    await expect(readMinidumpExecutablePath(filePath)).resolves.toEqual({
      executablePath,
      status: 'ok',
    });
  });

  it.each([
    { label: 'bad signature', options: { signature: 0 } },
    { label: 'bad version', options: { version: 0xa792 } },
    { label: 'zero streams', options: { numberOfStreams: 0 } },
    { label: 'too many streams', options: { numberOfStreams: 257 } },
    { label: 'directory outside the file', options: { directoryRva: MAX_U32 } },
    {
      label: 'missing ModuleListStream',
      options: { directoryEntries: [{ streamType: 3 }] },
    },
    {
      label: 'duplicate ModuleListStream entries',
      options: {
        directoryEntries: [{ streamType: 4 }, { streamType: 4 }],
      },
    },
    {
      label: 'module-list RVA outside the file',
      options: { moduleListRva: MAX_U32 },
    },
    {
      label: 'module-list DataSize below its count prefix',
      options: { moduleListDataSize: 3 },
    },
    {
      label: 'module-list DataSize outside the file',
      options: { moduleListDataSize: MAX_U32 },
    },
    { label: 'zero modules', options: { moduleCount: 0 } },
    { label: 'module entries exceed DataSize', options: { moduleCount: 2 } },
    { label: 'name RVA outside the file', options: { nameRva: MAX_U32 } },
    { label: 'odd name length', options: { nameLength: 3 } },
    { label: 'empty name', options: { nameLength: 0 } },
    { label: 'name exceeds 1024 code units', options: { nameLength: 2050 } },
  ])('returns unreadable for $label', async ({ options }) => {
    const { filePath } = await createFixtureFile(options);

    await expect(readMinidumpExecutablePath(filePath)).resolves.toEqual({
      status: 'unreadable',
    });
  });

  it('rejects a string whose bytes extend past the file size', async () => {
    const executablePath = '/usr/bin/node';
    const nameBytes = Buffer.from(executablePath, 'utf16le');
    const { filePath } = await createFixtureFile({
      executablePath,
      truncateNameBytes: nameBytes.length - 1,
    });

    await expect(readMinidumpExecutablePath(filePath)).resolves.toEqual({
      status: 'unreadable',
    });
  });

  it('decodes a valid UTF-16 surrogate pair', async () => {
    const executablePath = '/tmp/📁/node';
    const { filePath } = await createFixtureFile({ executablePath });

    await expect(readMinidumpExecutablePath(filePath)).resolves.toEqual({
      executablePath,
      status: 'ok',
    });
  });

  it.each([
    {
      label: 'a lone high surrogate',
      nameBytes: Buffer.from([0x2f, 0x00, 0x00, 0xd8]),
    },
    {
      label: 'a lone low surrogate',
      nameBytes: Buffer.from([0x2f, 0x00, 0x00, 0xdc]),
    },
    {
      label: 'a NUL code unit',
      nameBytes: Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x61, 0x00]),
    },
  ])('rejects $label', async ({ nameBytes }) => {
    const { filePath } = await createFixtureFile({ nameBytes });

    await expect(readMinidumpExecutablePath(filePath)).resolves.toEqual({
      status: 'unreadable',
    });
  });

  it('loops over short reads and remains within the read budget', async () => {
    const { filePath } = await createFixtureFile();
    const observation = instrumentOpenedHandle({ maxReadSize: 5 });

    await expect(readMinidumpExecutablePath(filePath)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(observation.readCalls).toBeGreaterThan(1);
    expect(observation.bytesRead).toBeLessThanOrEqual(
      MINIDUMP_READ_BUDGET_BYTES,
    );
    expect(observation.closeCalls).toBe(1);
  });

  it('treats a zero-byte read as unreadable and still closes the handle', async () => {
    const { filePath } = await createFixtureFile();
    const observation = instrumentOpenedHandle({ zeroAtRead: 1 });

    await expect(readMinidumpExecutablePath(filePath)).resolves.toEqual({
      status: 'unreadable',
    });
    expect(observation.closeCalls).toBe(1);
  });

  it('treats a file that shrinks after fstat as unreadable', async () => {
    const { filePath } = await createFixtureFile();
    const observation = instrumentOpenedHandle({ shrinkAtRead: 3 });

    await expect(readMinidumpExecutablePath(filePath)).resolves.toEqual({
      status: 'unreadable',
    });
    expect(observation.shrinkSucceeded).toBe(true);
    expect(observation.readCalls).toBe(3);
    expect(observation.bytesRead).toBe(
      MINIDUMP_HEADER_SIZE + MINIDUMP_DIRECTORY_SIZE,
    );
    expect(observation.closeCalls).toBe(1);
  });

  it('closes handles on success and validation failure even if close throws', async () => {
    const success = await createFixtureFile();
    const invalid = await createFixtureFile({ signature: 0 });
    const observation = instrumentOpenedHandle({ closeThrows: true });

    await expect(
      readMinidumpExecutablePath(success.filePath),
    ).resolves.toMatchObject({
      status: 'ok',
    });
    await expect(readMinidumpExecutablePath(invalid.filePath)).resolves.toEqual(
      {
        status: 'unreadable',
      },
    );
    expect(observation.closeCalls).toBe(2);
  });

  it('uses the optional no-follow and nonblocking open flags', async () => {
    const { filePath } = await createFixtureFile();
    const openSpy = jest.mocked(fsPromises.open);
    let expectedFlags = fsConstants.O_RDONLY;
    if (typeof fsConstants.O_NOFOLLOW === 'number') {
      expectedFlags |= fsConstants.O_NOFOLLOW;
    }
    if (
      process.platform !== 'win32' &&
      typeof fsConstants.O_NONBLOCK === 'number'
    ) {
      expectedFlags |= fsConstants.O_NONBLOCK;
    }

    await readMinidumpExecutablePath(filePath);

    expect(openSpy).toHaveBeenCalledWith(filePath, expectedFlags);
  });

  it('returns unreadable when opening a missing path fails', async () => {
    const { directory } = await createFixtureFile();

    await expect(
      readMinidumpExecutablePath(join(directory, 'missing.dmp')),
    ).resolves.toEqual({ status: 'unreadable' });
  });

  it('rejects directories as non-regular files', async () => {
    const { directory } = await createFixtureFile();

    await expect(readMinidumpExecutablePath(directory)).resolves.toEqual({
      status: 'unreadable',
    });
  });

  const fifoTest =
    !canRunMkfifo || typeof fsConstants.O_NONBLOCK !== 'number' ? it.skip : it;
  fifoTest(
    'opens a FIFO without waiting for a writer and rejects its file type',
    async () => {
      const { directory } = await createFixtureFile();
      const fifoPath = join(directory, 'pending.fifo');
      execFileSync('mkfifo', [fifoPath]);

      await expect(readMinidumpExecutablePath(fifoPath)).resolves.toEqual({
        status: 'unreadable',
      });
    },
    2_000,
  );

  const noFollowTest =
    typeof fsConstants.O_NOFOLLOW === 'number' ? it : it.skip;
  noFollowTest('does not open a symlinked file', async () => {
    const { directory, filePath } = await createFixtureFile();
    const symlinkPath = join(directory, 'link-no-follow.dmp');
    await fsPromises.symlink(filePath, symlinkPath);

    await expect(readMinidumpExecutablePath(symlinkPath)).resolves.toEqual({
      status: 'unreadable',
    });
  });
});

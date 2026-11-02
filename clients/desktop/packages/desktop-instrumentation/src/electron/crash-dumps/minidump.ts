import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export const MINIDUMP_READ_BUDGET_BYTES = 16 * 1024;

export type MinidumpExecutableResult =
  | { readonly status: 'ok'; readonly executablePath: string }
  | { readonly status: 'unreadable' };

interface ReadBudget {
  bytesRead: number;
}

interface ModuleListStream {
  readonly dataSize: number;
  readonly rva: number;
}

const MINIDUMP_SIGNATURE = 0x504d444d;
const MINIDUMP_VERSION = 0xa793;
const MINIDUMP_HEADER_SIZE = 32;
const MINIDUMP_DIRECTORY_SIZE = 12;
const MINIDUMP_MODULE_LIST_STREAM = 4;
const MINIDUMP_MODULE_SIZE = 108;
const MINIDUMP_MODULE_NAME_RVA_OFFSET = 20;
const MAX_STREAM_COUNT = 256;
const MAX_MODULE_NAME_BYTES = 2048;

// The 32-byte header and 12-byte directories follow Microsoft's minidump API:
// https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/ns-minidumpapiset-minidump_module
// MINIDUMP_MODULE is 108 bytes: a base u64, four u32s, 52-byte file info,
// two descriptors and two u64s; ModuleNameRva is at byte 20.
// Breakpad uses module 0 as the main module and caps names at 1024 UTF-16 units:
// https://raw.githubusercontent.com/google/breakpad/main/src/processor/minidump.cc

export async function readMinidumpExecutablePath(
  filePath: string,
): Promise<MinidumpExecutableResult> {
  let handle: FileHandle | undefined;

  try {
    let flags = fsConstants.O_RDONLY;
    if (typeof fsConstants.O_NOFOLLOW === 'number') {
      flags |= fsConstants.O_NOFOLLOW;
    }
    // POSIX only: a FIFO would otherwise block the open before fstat rejects it.
    if (typeof fsConstants.O_NONBLOCK === 'number') {
      flags |= fsConstants.O_NONBLOCK;
    }

    handle = await fsPromises.open(filePath, flags);
    const fileStats = await handle.stat();
    if (
      !fileStats.isFile() ||
      !Number.isSafeInteger(fileStats.size) ||
      fileStats.size < 0
    ) {
      return { status: 'unreadable' };
    }

    const fileSize = fileStats.size;
    const budget: ReadBudget = { bytesRead: 0 };
    const header = await readExact(
      handle,
      fileSize,
      0,
      MINIDUMP_HEADER_SIZE,
      budget,
    );
    if (
      header === null ||
      header.readUInt32LE(0) !== MINIDUMP_SIGNATURE ||
      (header.readUInt32LE(4) & 0xffff) !== MINIDUMP_VERSION
    ) {
      return { status: 'unreadable' };
    }

    const streamCount = header.readUInt32LE(8);
    if (streamCount < 1 || streamCount > MAX_STREAM_COUNT) {
      return { status: 'unreadable' };
    }

    const streamDirectoryRva = header.readUInt32LE(12);
    const streamDirectorySize = streamCount * MINIDUMP_DIRECTORY_SIZE;
    if (!isRangeWithinFile(streamDirectoryRva, streamDirectorySize, fileSize)) {
      return { status: 'unreadable' };
    }

    const streamDirectory = await readExact(
      handle,
      fileSize,
      streamDirectoryRva,
      streamDirectorySize,
      budget,
    );
    if (streamDirectory === null) {
      return { status: 'unreadable' };
    }

    let moduleListStream: ModuleListStream | undefined;
    for (let index = 0; index < streamCount; index += 1) {
      const entryOffset = index * MINIDUMP_DIRECTORY_SIZE;
      const streamType = streamDirectory.readUInt32LE(entryOffset);
      if (streamType !== MINIDUMP_MODULE_LIST_STREAM) {
        continue;
      }
      if (moduleListStream !== undefined) {
        return { status: 'unreadable' };
      }
      moduleListStream = {
        dataSize: streamDirectory.readUInt32LE(entryOffset + 4),
        rva: streamDirectory.readUInt32LE(entryOffset + 8),
      };
    }

    if (
      moduleListStream === undefined ||
      moduleListStream.dataSize < 4 ||
      !isRangeWithinFile(
        moduleListStream.rva,
        moduleListStream.dataSize,
        fileSize,
      )
    ) {
      return { status: 'unreadable' };
    }

    const moduleCountBytes = await readExact(
      handle,
      fileSize,
      moduleListStream.rva,
      4,
      budget,
    );
    if (moduleCountBytes === null) {
      return { status: 'unreadable' };
    }
    const moduleCount = moduleCountBytes.readUInt32LE(0);
    const moduleListBytes = 4 + moduleCount * MINIDUMP_MODULE_SIZE;
    if (moduleCount < 1 || moduleListBytes > moduleListStream.dataSize) {
      return { status: 'unreadable' };
    }

    const firstModule = await readExact(
      handle,
      fileSize,
      moduleListStream.rva + 4,
      MINIDUMP_MODULE_NAME_RVA_OFFSET + 4,
      budget,
    );
    if (firstModule === null) {
      return { status: 'unreadable' };
    }
    const nameRva = firstModule.readUInt32LE(MINIDUMP_MODULE_NAME_RVA_OFFSET);
    if (!isRangeWithinFile(nameRva, 4, fileSize)) {
      return { status: 'unreadable' };
    }

    const nameLengthBytes = await readExact(
      handle,
      fileSize,
      nameRva,
      4,
      budget,
    );
    if (nameLengthBytes === null) {
      return { status: 'unreadable' };
    }
    const nameLength = nameLengthBytes.readUInt32LE(0);
    if (
      nameLength < 2 ||
      nameLength > MAX_MODULE_NAME_BYTES ||
      nameLength % 2 !== 0 ||
      !isRangeWithinFile(nameRva + 4, nameLength, fileSize)
    ) {
      return { status: 'unreadable' };
    }

    const nameBytes = await readExact(
      handle,
      fileSize,
      nameRva + 4,
      nameLength,
      budget,
    );
    if (nameBytes === null) {
      return { status: 'unreadable' };
    }
    const executablePath = decodeStrictUtf16Le(nameBytes);
    if (executablePath === undefined) {
      return { status: 'unreadable' };
    }

    return { status: 'ok', executablePath };
  } catch {
    return { status: 'unreadable' };
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Closing is best-effort and must not change the reader's result.
      }
    }
  }
}

async function readExact(
  handle: FileHandle,
  fileSize: number,
  offset: number,
  length: number,
  budget: ReadBudget,
): Promise<Buffer | null> {
  if (!isRangeWithinFile(offset, length, fileSize)) {
    return null;
  }

  const buffer = Buffer.alloc(length);
  let totalBytesRead = 0;
  while (totalBytesRead < length) {
    const remainingBudget = MINIDUMP_READ_BUDGET_BYTES - budget.bytesRead;
    if (remainingBudget <= 0) {
      return null;
    }
    const requestedBytes = Math.min(length - totalBytesRead, remainingBudget);
    const result = await handle.read(
      buffer,
      totalBytesRead,
      requestedBytes,
      offset + totalBytesRead,
    );
    const bytesRead = result.bytesRead;
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
      return null;
    }
    budget.bytesRead += bytesRead;
    if (
      bytesRead === 0 ||
      bytesRead > requestedBytes ||
      budget.bytesRead > MINIDUMP_READ_BUDGET_BYTES
    ) {
      return null;
    }
    totalBytesRead += bytesRead;
  }
  return buffer;
}

function isRangeWithinFile(
  offset: number,
  length: number,
  fileSize: number,
): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    Number.isSafeInteger(fileSize) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= fileSize
  );
}

function decodeStrictUtf16Le(buffer: Buffer): string | undefined {
  let decoded = '';
  for (let offset = 0; offset < buffer.length; offset += 2) {
    const codeUnit = buffer.readUInt16LE(offset);
    if (codeUnit === 0) {
      return undefined;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextOffset = offset + 2;
      if (nextOffset >= buffer.length) {
        return undefined;
      }
      const nextCodeUnit = buffer.readUInt16LE(nextOffset);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return undefined;
      }
      decoded += String.fromCharCode(codeUnit, nextCodeUnit);
      offset = nextOffset;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    }
    decoded += String.fromCharCode(codeUnit);
  }
  return decoded;
}

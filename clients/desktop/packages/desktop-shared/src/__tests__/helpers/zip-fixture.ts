/**
 * Minimal ZIP writer for tests.
 *
 * Real zip writers sanitize entry names, which makes them useless for building
 * the adversarial archives the Cursor extractor must reject (traversal,
 * absolute paths, symlinks). This emits the bytes directly so a test can put
 * any name or attribute into the central directory.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipFixtureEntry {
  name: string;
  /** Omit to emit a directory entry. */
  content?: Buffer | string;
  method?: 'store' | 'deflate';
  /** Upper byte selects the host system; 3 marks a Unix-created entry. */
  versionMadeBy?: number;
  /** Unix mode lives in the high 16 bits, e.g. 0o120777 for a symlink. */
  externalAttributes?: number;
  /** Overrides the real uncompressed size recorded in the headers. */
  declaredSize?: number;
}

const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01

export function buildZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const isDirectory = entry.content === undefined;
    const raw = isDirectory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(String(entry.content), 'utf8');
    const useDeflate = entry.method === 'deflate' && !isDirectory;
    const payload = useDeflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = raw.length === 0 ? 0 : crc32(raw);
    const declaredSize = entry.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** Convenience: a Unix symlink entry whose "content" is the link target. */
export function symlinkEntry(name: string, target: string): ZipFixtureEntry {
  return {
    name,
    content: target,
    versionMadeBy: (3 << 8) | 20,
    // `<<` is signed 32-bit in JS and would overflow to a negative value here.
    externalAttributes: (0o120777 * 0x10000) >>> 0,
  };
}

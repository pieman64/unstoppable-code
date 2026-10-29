import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

const DEFAULT_EXTRACTION_LIMITS = {
  maxEntries: 10_000,
  maxExpandedBytes: 512 * 1024 * 1024,
} as const;

type ExtractionLimits = {
  maxEntries: number;
  maxExpandedBytes: number;
};

function createArchiveResourceGuard(limits: ExtractionLimits): {
  guardEntry: (entry: tar.ReadEntry) => void;
  guardIgnoredEntry: (entry: tar.ReadEntry) => void;
  guardMetadata: (metadata: string) => void;
} {
  let entryCount = 0;
  let expandedBytes = 0;

  const countRecord = (size: number, description: string): void => {
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      throw new Error(
        `Session bundle archive exceeds the ${limits.maxEntries} entry limit.`,
      );
    }

    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(
        `Session bundle archive contains an invalid ${description} size.`,
      );
    }
    expandedBytes += size;
    if (expandedBytes > limits.maxExpandedBytes) {
      throw new Error(
        `Session bundle archive exceeds the ${limits.maxExpandedBytes} byte expanded-size limit.`,
      );
    }
  };

  const guardEntry = (entry: tar.ReadEntry): void => {
    if (entry.type === 'Link' || entry.type === 'SymbolicLink') {
      const linkType = entry.type === 'Link' ? 'hard link' : 'symbolic link';
      throw new Error(
        `Session bundle archive contains a forbidden ${linkType} entry: ${entry.path}`,
      );
    }

    countRecord(entry.size, `entry (${entry.path})`);
  };

  return {
    guardEntry,
    guardIgnoredEntry: (entry): void => {
      if (entry.meta) {
        countRecord(entry.size, 'metadata record');
        return;
      }
      guardEntry(entry);
    },
    guardMetadata: (metadata): void => {
      countRecord(Buffer.byteLength(metadata), 'metadata record');
    },
  };
}

async function readArchiveWithGuard(
  gzPath: string,
  reader: tar.Parser,
  limits: ExtractionLimits,
  resumeEntries: boolean,
): Promise<void> {
  const { guardEntry, guardIgnoredEntry, guardMetadata } =
    createArchiveResourceGuard(limits);
  reader.on('entry', (entry: tar.ReadEntry) => {
    try {
      guardEntry(entry);
    } catch (error) {
      reader.abort(
        error instanceof Error ? error : new Error('Invalid session bundle'),
      );
      return;
    }
    if (resumeEntries) {
      entry.resume();
    }
  });
  reader.on('meta', (metadata: string) => {
    try {
      guardMetadata(metadata);
    } catch (error) {
      reader.abort(
        error instanceof Error ? error : new Error('Invalid session bundle'),
      );
    }
  });
  reader.on('ignoredEntry', (entry: tar.ReadEntry) => {
    try {
      guardIgnoredEntry(entry);
    } catch (error) {
      reader.abort(
        error instanceof Error ? error : new Error('Invalid session bundle'),
      );
    }
  });
  await pipeline(createReadStream(gzPath), reader);
}

export async function packSessionBundle(
  bundleDir: string,
  outFile: string,
): Promise<{ sizeBytes: number; contentHash: string }> {
  const entries = (await readdir(bundleDir)).sort();
  await tar.create(
    {
      gzip: true,
      portable: true,
      cwd: bundleDir,
      file: outFile,
    },
    entries,
  );

  const [archiveStats, archiveBytes] = await Promise.all([
    stat(outFile),
    readFile(outFile),
  ]);
  return {
    sizeBytes: archiveStats.size,
    contentHash: createHash('sha256').update(archiveBytes).digest('hex'),
  };
}

export async function unpackSessionBundle(
  gzPath: string,
  destDir: string,
  limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
): Promise<void> {
  // Validate the complete archive before writing any attacker-controlled data
  // to disk. The extraction pass repeats the guard so a changed archive cannot
  // bypass the limits between validation and extraction.
  await readArchiveWithGuard(
    gzPath,
    new tar.Parser({
      strict: true,
    }),
    limits,
    true,
  );
  await readArchiveWithGuard(
    gzPath,
    new tar.Unpack({
      strict: true,
      preservePaths: false,
      cwd: destDir,
    }),
    limits,
    false,
  );
}

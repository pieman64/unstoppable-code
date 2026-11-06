import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  statfs,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  createPlatformEndpointServices,
  hostPlatformServices,
} from '@canopy/core-platform';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { BrandCore } from '@canopy/protocol/brand';
import {
  resolveBuildStoragePaths,
  historicalSecureDataDir,
} from '@canopy/core-runtime/node/secure-data-dir';
import {
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootInventory,
  type InternalRootJournal,
  type InternalRootExternalSnapshot,
} from '@canopy/core-runtime/node/internal-root-migration';

const run = promisify(execFile);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z
  .object({
    brandId: z.enum(['canopy', 'unstoppable-code']),
    brandDisplayName: z.string(),
    build: z.literal('internal'),
    source: z.string(),
    destination: z.string(),
    historicalSecure: z.string(),
    coordination: z.string(),
  })
  .strict();
const inventorySchema = z
  .object({
    sourceIdentity: z.string().nullable(),
    destinationIdentity: z.string().nullable(),
    fingerprint: digest,
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    historicalSecure: z.boolean(),
    nestedSecure: z.boolean(),
    stableOwned: z.boolean(),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(6),
    transactionId: z.uuid(),
    identity: identitySchema,
    internalDeclaration: z.boolean(),
    phase: z.enum([
      'prepared',
      'source-settled',
      'building',
      'publishing',
      'rebuilding',
      'restoring-external',
      'complete',
    ]),
    inventory: inventorySchema,
    externalFiles: z.array(z.string()),
    stagingRoot: z.string(),
    stagingIdentity: z.string().optional(),
    externalSnapshots: z
      .array(
        z
          .object({
            path: z.string(),
            preimage: digest,
            mode: z.number().int().min(0).max(0o777),
            postimage: digest.optional(),
          })
          .strict(),
      )
      .optional(),
    publicationIdentity: z.string().optional(),
    publicationFingerprint: digest.optional(),
    settledFingerprint: digest.optional(),
    secureRelocation: z.literal('pending'),
  })
  .strict();

export function internalRootIdentity(
  home: string,
  brand: Pick<BrandCore, 'id' | 'displayName' | 'storage'>,
): InternalRootIdentity {
  if (brand.id !== 'canopy' && brand.id !== 'unstoppable-code')
    throw new Error('Unsupported internal brand.');
  const pathFor = (build: 'stable' | 'internal'): string =>
    resolveBuildStoragePaths({
      home,
      brand,
      identity: { brandId: brand.id, build },
    }).dataRoot;
  return {
    brandId: brand.id,
    brandDisplayName: brand.displayName,
    build: 'internal',
    source: pathFor('stable'),
    destination: pathFor('internal'),
    historicalSecure: historicalSecureDataDir(
      home,
      brand.storage.secureDataDirNames,
      'internal',
    ),
    coordination: join(home, `.${brand.id}-internal-migration`),
  };
}

function refuseLayout(detail: string): never {
  throw new InternalRootMigrationRefused('unsupported-layout', detail);
}

export async function statIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw error;
  }
}

export async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    refuseLayout(`Expected an owner-only canonical directory: ${path}`);
  const os = hostOperatingSystem();
  if (
    !os ||
    (
      await hostPlatformServices(
        createPlatformEndpointServices(os),
      ).secureFiles.permissions({
        path,
        kind: 'directory',
        mode: 'owner-only',
        action: 'verify',
      })
    ).state !== 'private'
  )
    refuseLayout(
      `Directory privacy, including native ACLs, is unprovable: ${path}`,
    );
}

export async function flush(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durableJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await flush(dirname(path));
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) {
    if (!Buffer.isBuffer(bytes)) throw new Error('Expected file bytes');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

interface TreeManifest {
  readonly fingerprint: string;
  readonly files: number;
  readonly bytes: number;
}
async function manifest(root: string, durable = false): Promise<TreeManifest> {
  const rootDevice = (await lstat(root)).dev;
  const hash = createHash('sha256');
  const row = (value: unknown): void => {
    hash.update(JSON.stringify(value));
    hash.update('\n');
  };
  let files = 0;
  let bytes = 0;
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const stat = await lstat(path);
    if (stat.dev !== rootDevice)
      refuseLayout(`Cross-filesystem tree entry: ${path}`);
    if (stat.uid !== process.getuid?.())
      refuseLayout(`Foreign-owned tree entry: ${path}`);
    const mode = stat.mode & 0o7777;
    const metadata = [
      relative,
      mode,
      stat.uid,
      stat.gid,
      stat.size,
      Math.floor(stat.mtimeMs),
    ];
    if (stat.isSymbolicLink()) row(['link', ...metadata, await readlink(path)]);
    else if (stat.isDirectory()) {
      // Directory sizes are filesystem-specific, unlike file and symlink sizes.
      row([
        'directory',
        relative,
        mode,
        stat.uid,
        stat.gid,
        Math.floor(stat.mtimeMs),
      ]);
      for (const child of (await readdir(path)).sort())
        await visit(join(relative, child));
      if (durable) await flush(path);
    } else if (stat.isFile()) {
      if (stat.nlink !== 1)
        refuseLayout(`Hard-linked file requires manual qualification: ${path}`);
      // Only small W5 log/receipt records get byte hashes; never scan worktree
      // contents or opaque credential payloads. Other changes are metadata-only.
      const critical =
        relative.startsWith('w5/') && stat.size <= 16 * 1024 * 1024;
      row(['file', ...metadata, critical ? await hashFile(path) : null]);
      files += 1;
      bytes += stat.size;
      if (durable) await flush(path);
    } else if (!(stat.isSocket() && relative.startsWith('runtime/')))
      // Sockets carry no recoverable data; C must discard stale runtime state.
      refuseLayout(`Special file: ${path}`);
  }
  await visit('');
  return {
    fingerprint: hash.digest('hex'),
    files,
    bytes,
  };
}

function inode(stat: Stats | null): string | null {
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

export async function inspectInternalRoot(
  identity: InternalRootIdentity,
  inspectDestination = false,
): Promise<InternalRootInventory> {
  const home = dirname(identity.source);
  if (resolve(home) !== home || (await realpath(home)) !== home)
    refuseLayout('HOME must be canonical, not an alias.');
  for (const path of [
    identity.source,
    identity.destination,
    identity.historicalSecure,
    identity.coordination,
    internalRootStaging(identity),
  ]) {
    if (dirname(path) !== home)
      refuseLayout('Migration paths must be canonical siblings.');
    if (await statIfPresent(path)) await privateDirectory(path);
  }
  const source = await statIfPresent(identity.source);
  const destination = await statIfPresent(identity.destination);
  const live = inspectDestination ? identity.destination : identity.source;
  const exists = inspectDestination ? destination : source;
  const tree = exists
    ? await manifest(live)
    : { fingerprint: '', files: 0, bytes: 0 };
  const ownerPath = join(live, 'build-storage-owner.json');
  let stableOwned = false;
  if (exists && (await statIfPresent(ownerPath))) {
    const metadata = await lstat(ownerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096)
      refuseLayout('Unsupported storage owner record.');
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(ownerPath, 'utf8'));
    } catch {
      refuseLayout('Unsupported storage owner record.');
    }
    const owner = z
      .object({
        version: z.literal(1),
        brandId: z.enum(['canopy', 'unstoppable-code']),
        build: z.enum(['stable', 'internal', 'rc', 'dev']),
      })
      .strict()
      .safeParse(raw);
    if (
      !owner.success ||
      owner.data.brandId !== identity.brandId ||
      !['stable', 'internal'].includes(owner.data.build)
    )
      refuseLayout('Unsupported storage owner record.');
    stableOwned = owner.data.build === 'stable';
  }
  return {
    sourceIdentity: inode(source),
    destinationIdentity: inode(destination),
    ...tree,
    historicalSecure: (await statIfPresent(identity.historicalSecure)) !== null,
    nestedSecure:
      exists !== null &&
      (await statIfPresent(join(live, 'secure-storage'))) !== null,
    stableOwned,
  };
}

export async function readInternalRootJournal(
  identity: InternalRootIdentity,
): Promise<InternalRootJournal | null> {
  const path = join(identity.coordination, 'journal.json');
  if (!(await statIfPresent(identity.coordination))) return null;
  await privateDirectory(identity.coordination);
  const stat = await statIfPresent(path);
  if (!stat) {
    const names = await readdir(identity.coordination);
    if (
      names.some(
        (name) =>
          !['coordination.sqlite', 'coordination.sqlite-journal'].includes(
            name,
          ),
      )
    )
      throw new InternalRootMigrationRefused(
        'journal-unsupported',
        'Nonempty coordination directory without a recognized journal; retain it for recovery.',
      );
    return null;
  }
  try {
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 16 * 1024 * 1024 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error('Unsafe journal');
    const journal = journalSchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    );
    if (
      !isDeepStrictEqual(journal.identity, identity) ||
      journal.stagingRoot !== internalRootStaging(identity) ||
      !journal.inventory.sourceIdentity ||
      journal.inventory.destinationIdentity !== null ||
      journal.inventory.stableOwned ||
      (identity.brandId === 'unstoppable-code' &&
        (!journal.internalDeclaration || journal.inventory.nestedSecure)) ||
      (journal.phase !== 'prepared' && !journal.settledFingerprint) ||
      (['publishing', 'complete', 'restoring-external', 'rebuilding'].includes(
        journal.phase,
      ) &&
        (!journal.publicationIdentity ||
          !journal.publicationFingerprint ||
          journal.stagingIdentity !== journal.publicationIdentity)) ||
      new Set(journal.externalFiles).size !== journal.externalFiles.length ||
      (journal.externalSnapshots !== undefined &&
        !isDeepStrictEqual(
          journal.externalSnapshots.map((entry) => entry.path),
          journal.externalFiles,
        )) ||
      ([
        'building',
        'publishing',
        'complete',
        'restoring-external',
        'rebuilding',
      ].includes(journal.phase) &&
        !journal.externalSnapshots) ||
      (['publishing', 'complete', 'restoring-external', 'rebuilding'].includes(
        journal.phase,
      ) &&
        journal.externalSnapshots?.some((entry) => !entry.postimage))
    )
      throw new Error('Unrecognized transaction');
    await validateExternalRootFiles(identity, journal.externalFiles);
    return journal;
  } catch {
    throw new InternalRootMigrationRefused(
      'journal-unsupported',
      'Unknown, older (including v4/v5), malformed or newer journal. Preserve both roots and request teammate-assisted recovery.',
    );
  }
}

/** Production never falls back to a byte copy: macOS cp -c requires clonefile. */
export async function cloneInternalRoot(
  source: string,
  destination: string,
): Promise<void> {
  const from = await lstat(source);
  const parent = await lstat(dirname(destination));
  const filesystem = await statfs(source);
  if (
    hostOperatingSystem() !== 'darwin' ||
    from.dev !== parent.dev ||
    filesystem.type !== 26 // Darwin APFS statfs f_type (not the on-disk NX magic).
  )
    throw new InternalRootMigrationRefused(
      'clone-unavailable',
      'Destination staging requires macOS APFS on the source volume. No full-copy fallback is supported.',
    );
  try {
    await run('/bin/cp', ['-c', '-R', '-p', source, destination], {
      timeout: 3_600_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    // BSD cp may report skipped Unix sockets with exit 1. They have no destination
    // payload; accept ONLY that diagnostic, then verify the full data manifest.
    const stderr: unknown =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? error.stderr
        : null;
    const exit: unknown =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : null;
    const warnings =
      typeof stderr === 'string'
        ? stderr.trim().split('\n').filter(Boolean)
        : [];
    let socketsOnly = exit === 1 && warnings.length > 0;
    for (const line of warnings) {
      const match = /^cp: (.+) is a socket \(not copied\)\.$/.exec(line);
      const path = match?.[1];
      if (
        !path ||
        !path.startsWith(`${source}/runtime/`) ||
        !(await statIfPresent(path))?.isSocket()
      )
        socketsOnly = false;
    }
    if (socketsOnly) return;
    throw new InternalRootMigrationRefused(
      'clone-unavailable',
      'APFS clone failed. Retain the journal and partial staging tree; check same-volume clone support and free metadata space before retrying.',
    );
  }
}

/** Deterministic private location, never an ordinary resolver candidate. */
export function internalRootStaging(identity: InternalRootIdentity): string {
  return `${identity.destination}.migration-staging`;
}

/** A sibling is ours only after its exact inode has been durably journaled. */
export async function validateInternalRootStaging(
  identity: InternalRootIdentity,
  journal: InternalRootJournal | null,
): Promise<void> {
  const path = internalRootStaging(identity);
  const stat = await statIfPresent(path);
  if (!stat) return;
  if (
    !journal ||
    inode(stat) !== journal.stagingIdentity ||
    (journal.phase !== 'building' && journal.phase !== 'publishing')
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Unknown or replaced migration staging tree. Preserve it and the journal for teammate-assisted recovery.',
    );
  await privateDirectory(path);
  if ((stat.mode & 0o7777) !== 0o700)
    refuseLayout('Migration staging requires mode 0700.');
  if (stat.dev !== (await lstat(identity.source)).dev)
    refuseLayout('Migration staging must remain on the source volume.');
}

export async function validateExternalRootFiles(
  identity: InternalRootIdentity,
  files: readonly string[],
): Promise<void> {
  for (const path of files) {
    if (
      resolve(path) !== path ||
      (await realpath(path)) !== path ||
      [
        identity.source,
        identity.destination,
        identity.coordination,
        internalRootStaging(identity),
        identity.historicalSecure,
      ].some((root) => path === root || path.startsWith(`${root}/`))
    )
      refuseLayout(
        'External repair files must be canonical and outside both roots, coordination and secure history.',
      );
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 1024 * 1024 ||
      (stat.mode & 0o7000) !== 0
    )
      refuseLayout(
        'External metadata must be regular, owner-held, unaliased records no larger than 1 MiB.',
      );
  }
}

function externalFingerprint(bytes: Buffer, mode: number): string {
  return createHash('sha256').update(`${mode}:`).update(bytes).digest('hex');
}

async function readExternalMetadata(
  path: string,
): Promise<{ bytes: Buffer; mode: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.size > 1024 * 1024
    )
      refuseExternalRecovery('Unsafe or oversized external metadata.');
    // Bound the read itself, not just a racy pre-read stat.
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    if (
      size > 1024 * 1024 ||
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      inode(await lstat(path)) !== inode(after)
    )
      refuseExternalRecovery('External metadata changed while being read.');
    return { bytes: buffer.subarray(0, size), mode: after.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function preimagePath(journal: InternalRootJournal, path: string): string {
  const name = createHash('sha256').update(path).digest('hex');
  return join(journal.identity.coordination, `external-${name}.preimage`);
}

async function writeDurableBytes(
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await flush(dirname(path));
}

async function readPreimage(
  journal: InternalRootJournal,
  entry: InternalRootExternalSnapshot,
): Promise<Buffer> {
  await privateDirectory(journal.identity.coordination);
  const path = preimagePath(journal, entry.path);
  const stat = await statIfPresent(path);
  if (
    !stat ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o600 ||
    stat.size > 1024 * 1024
  )
    refuseExternalRecovery('Missing or unsafe external preimage.');
  const { bytes } = await readExternalMetadata(path);
  if (externalFingerprint(bytes, entry.mode) !== entry.preimage)
    refuseExternalRecovery('External preimage changed.');
  return bytes;
}

function refuseExternalRecovery(detail: string): never {
  throw new InternalRootMigrationRefused(
    'recovery-required',
    `${detail} Preserve both roots, external metadata and the journal for teammate-assisted recovery; do not start either build.`,
  );
}

/** Small opaque metadata copies only; never a root backup or credential decoder. */
export async function captureInternalRootExternal(
  journal: InternalRootJournal,
): Promise<readonly InternalRootExternalSnapshot[]> {
  await validateExternalRootFiles(journal.identity, journal.externalFiles);
  const entries: InternalRootExternalSnapshot[] = [];
  for (const path of journal.externalFiles) {
    const { bytes, mode } = await readExternalMetadata(path);
    const entry = { path, mode, preimage: externalFingerprint(bytes, mode) };
    const backup = preimagePath(journal, path);
    if (await statIfPresent(backup)) await readPreimage(journal, entry);
    else {
      await writeDurableBytes(backup, bytes, 0o600);
      await readPreimage(journal, entry);
    }
    entries.push(entry);
  }
  return entries;
}

export async function sealInternalRootExternal(
  journal: InternalRootJournal,
): Promise<readonly InternalRootExternalSnapshot[]> {
  await validateExternalRootFiles(journal.identity, journal.externalFiles);
  if (!journal.externalSnapshots)
    refuseExternalRecovery('Missing external preimages.');
  const entries: InternalRootExternalSnapshot[] = [];
  for (const entry of journal.externalSnapshots) {
    await readPreimage(journal, entry);
    // C syncs replacement contents; B also makes their directory entries durable
    // before the journal can seal these external postimages for publication.
    await flush(entry.path);
    await flush(dirname(entry.path));
    const { bytes, mode } = await readExternalMetadata(entry.path);
    entries.push({
      ...entry,
      postimage: externalFingerprint(bytes, mode),
    });
  }
  return entries;
}

async function inspectExternalRestore(
  journal: InternalRootJournal,
  allowRestored: boolean,
): Promise<void> {
  await validateExternalRootFiles(journal.identity, journal.externalFiles);
  if (!journal.externalSnapshots)
    refuseExternalRecovery('Missing external preimages.');
  // Check the entire set before restoring any file; a changed later backlink
  // must not leave an otherwise completed installation partially restored.
  for (const entry of journal.externalSnapshots) {
    await readPreimage(journal, entry);
    const { bytes, mode } = await readExternalMetadata(entry.path);
    const actual = externalFingerprint(bytes, mode);
    if (
      !entry.postimage ||
      (actual !== entry.postimage &&
        !(allowRestored && actual === entry.preimage))
    )
      refuseExternalRecovery(
        `External metadata changed since repair: ${entry.path}.`,
      );
  }
}

export async function assertInternalRootExternalPostimages(
  journal: InternalRootJournal,
): Promise<void> {
  await inspectExternalRestore(journal, false);
}

export async function assertInternalRootExternalPreimages(
  journal: InternalRootJournal,
): Promise<void> {
  await validateExternalRootFiles(journal.identity, journal.externalFiles);
  if (!journal.externalSnapshots)
    refuseExternalRecovery('Missing external preimages.');
  for (const entry of journal.externalSnapshots) {
    await readPreimage(journal, entry);
    const { bytes, mode } = await readExternalMetadata(entry.path);
    if (externalFingerprint(bytes, mode) !== entry.preimage)
      refuseExternalRecovery(
        `External metadata changed after restore: ${entry.path}.`,
      );
  }
}

export async function restoreInternalRootExternal(
  journal: InternalRootJournal,
): Promise<void> {
  await inspectExternalRestore(journal, true);
  for (const entry of journal.externalSnapshots ?? []) {
    // Durable restore intent accepts mixed pre/postimages after interruption.
    const bytes = await readPreimage(journal, entry);
    await validateExternalRootFiles(journal.identity, [entry.path]);
    const current = await readExternalMetadata(entry.path);
    const actual = externalFingerprint(current.bytes, current.mode);
    if (actual === entry.preimage) {
      await flush(entry.path);
      await flush(dirname(entry.path));
      continue;
    }
    if (actual !== entry.postimage)
      refuseExternalRecovery(
        `External metadata changed during restore: ${entry.path}.`,
      );
    await writeDurableBytes(entry.path, bytes, entry.mode);
  }
}

export async function buildInternalRoot(
  journal: InternalRootJournal,
  cloneTree: (
    source: string,
    destination: string,
  ) => Promise<void> = cloneInternalRoot,
): Promise<string> {
  const { identity } = journal;
  if (await statIfPresent(identity.destination))
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Never overwrite an independent destination.',
    );
  await validateInternalRootStaging(identity, journal);
  const sibling = internalRootStaging(identity);
  const staging = join(identity.coordination, 'staging');
  if (await statIfPresent(sibling)) {
    if (await statIfPresent(staging))
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Both private clone and sibling staging exist. Preserve both for recovery.',
      );
    // Re-enter private coordination before discarding a partial repaired tree.
    await rename(sibling, staging);
    await flush(dirname(sibling));
    await flush(identity.coordination);
  }
  if (await statIfPresent(staging)) {
    await privateDirectory(staging);
    await rm(staging, { recursive: true });
  }
  await cloneTree(identity.source, staging);
  await privateDirectory(staging);
  if (
    (await manifest(staging)).fingerprint !== journal.settledFingerprint ||
    (await inspectInternalRoot(identity)).fingerprint !==
      journal.settledFingerprint
  )
    throw new InternalRootMigrationRefused(
      'source-changed',
      'Clone differs from settled source. Retain the original; retry migration after diagnosis.',
    );
  const stat = await lstat(staging);
  await flush(staging);
  await flush(identity.coordination);
  return `${stat.dev}:${stat.ino}`;
}

/** Called only after the clone's inode is durable in the non-moving journal. */
export async function exposeInternalRootStaging(
  journal: InternalRootJournal,
): Promise<void> {
  const { identity } = journal;
  const from = join(identity.coordination, 'staging');
  const to = internalRootStaging(identity);
  if (
    (await statIfPresent(to)) ||
    inode(await statIfPresent(from)) !== journal.stagingIdentity
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Staging changed before exposure. Preserve the journal and both trees for recovery.',
    );
  await privateDirectory(from);
  if (((await lstat(from)).mode & 0o7777) !== 0o700)
    refuseLayout('Migration staging requires mode 0700.');
  if ((await lstat(from)).dev !== (await lstat(dirname(to))).dev)
    refuseLayout('Migration staging must remain on the source volume.');
  await rename(from, to);
  await flush(identity.coordination);
  await flush(dirname(to));
}

/** Seal the repaired staging tree only if it is still the clone we built. */
export async function sealInternalRoot(
  journal: InternalRootJournal,
  publicationIdentity: string,
): Promise<string> {
  const staging = internalRootStaging(journal.identity);
  await privateDirectory(staging);
  if (inode(await statIfPresent(staging)) !== publicationIdentity)
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Staging was replaced during repair. Preserve the journal and request recovery.',
    );
  // clonefile/cp exit alone does not durably publish every nested entry.
  return (await manifest(staging, true)).fingerprint;
}

/** Revalidate a sealed tree on BOTH sides of the publication crash window. */
export async function internalRootPublicationRoot(
  journal: InternalRootJournal,
): Promise<string> {
  const staging = internalRootStaging(journal.identity);
  const to = await statIfPresent(journal.identity.destination);
  const from = await statIfPresent(staging);
  const path =
    !to && inode(from) === journal.publicationIdentity
      ? staging
      : !from && inode(to) === journal.publicationIdentity
        ? journal.identity.destination
        : null;
  if (!path)
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Destination or staging identity changed. Preserve the journal and request recovery.',
    );
  await privateDirectory(path);
  if ((await manifest(path)).fingerprint !== journal.publicationFingerprint)
    throw new InternalRootMigrationRefused(
      'source-changed',
      'Sealed destination changed during publication. Preserve both roots and the journal for teammate-assisted recovery.',
    );
  // The recursive scan can be long; do not use its pre-scan path observations.
  if (
    inode(await statIfPresent(path)) !== journal.publicationIdentity ||
    (await statIfPresent(
      path === staging ? journal.identity.destination : staging,
    ))
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Destination or staging changed during verification. Preserve both trees for recovery.',
    );
  return path;
}

export async function publishInternalRoot(
  journal: InternalRootJournal,
): Promise<void> {
  const path = await internalRootPublicationRoot(journal);
  if (path !== journal.identity.destination)
    await rename(path, journal.identity.destination);
  await flush(dirname(journal.identity.destination));
  await flush(journal.identity.coordination);
}

/** Only an explicitly journaled rebuild may discard the previous destination. */
export async function discardInternalRootDestination(
  journal: InternalRootJournal,
  checkOnly = false,
): Promise<void> {
  const destination = journal.identity.destination;
  const discarded = join(journal.identity.coordination, 'discarding');
  const to = await statIfPresent(destination);
  const old = await statIfPresent(discarded);
  if (to && old)
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Both destination and discarded tree exist. Preserve them for recovery.',
    );
  const path = to ? destination : discarded;
  const stat = to ?? old;
  if (!stat) return; // Interrupted deletion; rebuild intent is already durable.
  if (inode(stat) !== journal.publicationIdentity)
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Recorded destination was replaced. Never discard another installation.',
    );
  await privateDirectory(path);
  if (await statIfPresent(join(path, 'secure-storage')))
    throw new InternalRootMigrationRefused(
      'recovery-required',
      'Destination contains secure storage absent from the restore source. Preserve it and obtain CAN-5786 secure-relocation recovery before rebuilding.',
    );
  if (checkOnly) return;
  if (to) {
    // Never leave a partially deleted resolver candidate after interrupted rm.
    await rename(destination, discarded);
    await flush(dirname(destination));
    await flush(journal.identity.coordination);
  }
  await rm(discarded, { recursive: true });
  await flush(journal.identity.coordination);
}

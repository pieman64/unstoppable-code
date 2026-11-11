import { observeStoragePathSync } from '@canopy/core-platform/storage-path-observation';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  chmod,
  chown,
  utimes,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  statfs,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import { isWithin } from '@canopy/core-runtime/node/relocation/transition';
import {
  DEFAULT_FILESYSTEM_HOST,
  copyInternalRootTree,
  createPrivateMigrationDirectory,
  qualifyCopyVolume,
  qualifyMigrationGroup,
  observeMigrationNode,
  migrationNodeIdentity,
  ownedMigrationNode,
  windowsFilesystem,
  type InternalRootFilesystemHost,
} from './filesystem-host';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
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
  internalRootDestinationExistsRecovery,
  type InternalRootIdentity,
  type InternalRootInventory,
  type InternalRootJournal,
  type InternalRootExternalSnapshot,
} from '@canopy/core-runtime/node/internal-root-migration';

import { internalRootSourceIsSeparate } from '@canopy/core-runtime/node/internal-root-source';
import {
  validateInternalRootJournal,
  isInternalRootCleanupReport,
  isInternalRootCleanupStagingName,
} from '@canopy/core-runtime/node/internal-root-journal';

const run = promisify(execFile);

export function internalRootIdentity(
  home: string,
  brand: Pick<BrandCore, 'id' | 'displayName' | 'storage'>,
  sourceDirectory?: string,
): InternalRootIdentity {
  if (brand.id !== 'canopy' && brand.id !== 'unstoppable-code')
    throw new Error('Unsupported internal brand.');
  const trustedHome = observeStoragePathSync(home).canonicalPath;
  const pathFor = (build: 'stable' | 'internal'): string =>
    resolveBuildStoragePaths({
      home: trustedHome,
      brand,
      identity: { brandId: brand.id, build },
    }).dataRoot;
  const identity: InternalRootIdentity = {
    brandId: brand.id,
    brandDisplayName: brand.displayName,
    build: 'internal',
    source: sourceDirectory ?? pathFor('stable'),
    destination: pathFor('internal'),
    historicalSecure: historicalSecureDataDir(
      trustedHome,
      brand.storage.secureDataDirNames,
      'internal',
    ),
    coordination: join(trustedHome, `.${brand.id}-internal-migration`),
  };
  if (
    !internalRootSourceIsSeparate(identity.source, [
      identity.destination,
      identity.historicalSecure,
      identity.coordination,
      `${identity.destination}.migration-staging`,
      join(trustedHome, `.${brand.id}-internal-startup.json`),
    ])
  )
    refuseLayout(
      'The source must be an absolute canonical directory separate from the internal destination and maintenance paths.',
    );
  return identity;
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

export async function privateDirectory(
  path: string,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== path ||
    (hostOperatingSystem() !== 'win32' && (stat.mode & 0o077) !== 0) ||
    !ownedMigrationNode(stat)
  )
    refuseLayout(
      `Expected an owner-only canonical directory: ${path}.${
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        ownedMigrationNode(stat) &&
        canonical === path &&
        hostOperatingSystem() !== 'win32' &&
        (stat.mode & 0o077) !== 0
          ? ` After verifying ownership, run: chmod 700 '${path.split("'").join("'\"'\"'")}'`
          : ''
      }`,
    );
  if (await observeMigrationNode(path, stat, host)) return;
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
  if (hostOperatingSystem() === 'win32' && (await lstat(path)).isDirectory()) {
    await flushDirectory(path);
    return;
  }
  const handle = await open(
    path,
    hostOperatingSystem() === 'win32' ? 'r+' : 'r',
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durableJson(
  path: string,
  value: unknown,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
  options: { readonly removeTempOnFailure?: boolean } = {},
): Promise<void> {
  if (hostOperatingSystem() === 'win32')
    await privateDirectory(dirname(path), host);
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceMigrationFile(temp, path, host);
    await flush(dirname(path));
  } catch (error) {
    if (options.removeTempOnFailure) await rm(temp, { force: true });
    throw error;
  }
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
async function manifest(
  root: string,
  durable = false,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
  omitted: (relative: string) => boolean = () => false,
): Promise<TreeManifest> {
  const rootDevice = (await lstat(root)).dev;
  const hash = createHash('sha256');
  const row = (value: unknown): void => {
    hash.update(JSON.stringify(value));
    hash.update('\n');
  };
  let files = 0;
  let bytes = 0;
  async function visit(relative: string): Promise<void> {
    if (omitted(relative)) return;
    const path = join(root, relative);
    const stat = await lstat(path);
    if (stat.dev !== rootDevice)
      refuseLayout(`Cross-filesystem tree entry: ${path}`);
    if (!ownedMigrationNode(stat))
      refuseLayout(`Foreign-owned tree entry: ${path}`);
    qualifyMigrationGroup(path, stat);
    const windows = await observeMigrationNode(path, stat, host);
    const mode = stat.mode & 0o7777;
    const metadata = [
      relative,
      mode,
      stat.uid,
      stat.gid,
      stat.size,
      Math.floor(stat.mtimeMs),
    ];
    if (windows)
      row(['windows', relative, windows.attributes, windows.security]);
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
      // Source hard links are copied as independent files; inode/link counts
      // intentionally do not participate in the source/copy fingerprint.
      // Only small W5 log/receipt records get byte hashes; never scan worktree
      // contents or opaque credential payloads. Other changes are metadata-only.
      const critical =
        relative.startsWith(`w5${sep}`) && stat.size <= 16 * 1024 * 1024;
      row([
        'file',
        ...metadata,
        critical
          ? hostOperatingSystem() === 'win32'
            ? createHash('sha256')
                .update(windowsFilesystem(host).read(path))
                .digest('hex')
            : await hashFile(path)
          : null,
      ]);
      files += 1;
      bytes += stat.size;
      if (durable) {
        if (windows && windows.attributes & 1) {
          if (!windowsFilesystem(host).hasReadonlyCopyFlush(path))
            throw new InternalRootMigrationRefused(
              'recovery-required',
              `Readonly construction file lacks a matching in-process copy-flush receipt: ${path}. Retain the journal and rerun to rebuild staging; never clear readonly to force a seal.`,
            );
        } else await flush(path);
      }
    } else if (!(stat.isSocket() && relative.startsWith(`runtime${sep}`)))
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

async function inodeAt(
  path: string,
  stat: Stats | null,
): Promise<string | null> {
  return stat ? migrationNodeIdentity(path, stat) : null;
}

export async function inspectInternalRoot(
  identity: InternalRootIdentity,
  inspectDestination = false,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<InternalRootInventory> {
  const home = dirname(identity.destination);
  const observedHome = observeStoragePathSync(home);
  if (
    resolve(home) !== home ||
    observedHome.kind !== 'directory' ||
    observedHome.canonicalPath !== home
  )
    refuseLayout('HOME must be canonical, not an alias.');
  if (
    !internalRootSourceIsSeparate(identity.source, [
      identity.destination,
      identity.historicalSecure,
      identity.coordination,
      internalRootStaging(identity),
      join(home, `.${identity.brandId}-internal-startup.json`),
    ])
  )
    refuseLayout('The source overlaps internal storage or maintenance paths.');
  for (const path of [
    identity.source,
    identity.destination,
    identity.historicalSecure,
    identity.coordination,
    internalRootStaging(identity),
  ]) {
    if (path !== identity.source && dirname(path) !== home)
      refuseLayout(
        'Destination and maintenance paths must be canonical HOME siblings.',
      );
    const observed = observeStoragePathSync(path);
    if (
      observed.symbolicLinkComponents.length ||
      observed.canonicalPath !== path ||
      !['directory', 'missing'].includes(observed.kind)
    )
      refuseLayout(
        'Migration paths must be canonical directories, not aliases.',
      );
    if (observed.kind !== 'missing') await privateDirectory(path, host);
  }
  const source = observeStoragePathSync(identity.source).stat ?? null;
  const destination = observeStoragePathSync(identity.destination).stat ?? null;
  if (source && source.dev !== observedHome.stat?.dev)
    refuseLayout(
      'The source and internal destination must share the HOME volume. No cross-volume copying is supported.',
    );
  if (source && hostOperatingSystem() === 'linux')
    await qualifyCopyVolume(identity.source, identity.destination);
  const live = inspectDestination ? identity.destination : identity.source;
  const exists = inspectDestination ? destination : source;
  const tree = exists
    ? await manifest(live, false, host)
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
    sourceIdentity: await inodeAt(identity.source, source),
    destinationIdentity: await inodeAt(identity.destination, destination),
    ...tree,
    historicalSecure:
      observeStoragePathSync(identity.historicalSecure).kind !== 'missing',
    nestedSecure:
      exists !== null &&
      observeStoragePathSync(join(live, 'secure-storage')).kind !== 'missing',
    stableOwned,
  };
}

export async function assertPrivateMigrationFile(
  path: string,
  host: InternalRootFilesystemHost,
): Promise<Stats> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 16 * 1024 * 1024 ||
    !ownedMigrationNode(stat) ||
    (hostOperatingSystem() !== 'win32' && stat.mode & 0o077)
  )
    throw new Error('Unsafe migration evidence');
  await observeMigrationNode(path, stat, host);
  return stat;
}

async function readPrivateMigrationJson(
  path: string,
  host: InternalRootFilesystemHost,
): Promise<unknown> {
  await assertPrivateMigrationFile(path, host);
  return JSON.parse(
    hostOperatingSystem() === 'win32'
      ? windowsFilesystem(host).read(path).toString('utf8')
      : await readFile(path, 'utf8'),
  );
}

function repairPlanFingerprint(plan: unknown): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function lifecycleEvidencePath(
  identity: InternalRootIdentity,
  transactionId: string,
  plan: unknown,
): string {
  return join(
    identity.coordination,
    `lifecycle-journals-${transactionId}-${repairPlanFingerprint(plan)}.json`,
  );
}

/** Keep the on-disk v7 plan readable by installed internal-478 validators. */
export async function saveInternalRootJournal(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(journal)) + 1 > 16 * 1024 * 1024)
    throw new InternalRootMigrationRefused(
      'unsupported-layout',
      'Frozen repair evidence exceeds the journal limit. Preserve both roots and the existing journal for offline diagnosis.',
    );
  await privateDirectory(journal.identity.coordination, host);
  const { lifecycleJournals, abandonedPaths, ...plan } =
    journal.repairPlan ?? {};
  if (lifecycleJournals !== undefined || abandonedPaths !== undefined) {
    const path = lifecycleEvidencePath(
      journal.identity,
      journal.transactionId,
      plan,
    );
    const evidence = {
      version: 1,
      transactionId: journal.transactionId,
      planFingerprint: repairPlanFingerprint(plan),
      lifecycleJournals: lifecycleJournals ?? [],
      ...(abandonedPaths === undefined ? {} : { abandonedPaths }),
    };
    // Never replace evidence still referenced by the last durable journal.
    if (await statIfPresent(path)) {
      if (
        !isDeepStrictEqual(await readPrivateMigrationJson(path, host), evidence)
      )
        throw new InternalRootMigrationRefused(
          'source-changed',
          'Frozen lifecycle evidence changed for the same plan. Preserve the journal and both roots for offline diagnosis.',
        );
    } else await durableJson(path, evidence, host);
  }
  await durableJson(
    join(journal.identity.coordination, 'journal.json'),
    journal.repairPlan ? { ...journal, repairPlan: plan } : journal,
    host,
  );
}

export async function readInternalRootJournal(
  identity: InternalRootIdentity,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<InternalRootJournal | null> {
  const path = join(identity.coordination, 'journal.json');
  if (!(await statIfPresent(identity.coordination))) return null;
  await privateDirectory(identity.coordination, host);
  const stat = await statIfPresent(path);
  if (!stat) {
    const names = await readdir(identity.coordination);
    if (
      names.some(
        (name) =>
          ![
            'coordination.sqlite',
            'coordination.sqlite-journal',
            'cleanup-candidates.json',
          ].includes(name) && !isInternalRootCleanupStagingName(name),
      )
    )
      throw new InternalRootMigrationRefused(
        'journal-unsupported',
        'Nonempty coordination directory without a recognized journal; retain it for recovery.',
      );
    for (const name of names.filter(isInternalRootCleanupStagingName)) {
      try {
        await assertPrivateMigrationFile(
          join(identity.coordination, name),
          host,
        );
      } catch {
        throw new InternalRootMigrationRefused(
          'journal-unsupported',
          'Unsafe cleanup report staging file; retain it for recovery.',
        );
      }
    }
    const report = join(identity.coordination, 'cleanup-candidates.json');
    if (await statIfPresent(report)) {
      try {
        if (
          !isInternalRootCleanupReport(
            await readPrivateMigrationJson(report, host),
            report,
          )
        )
          throw new Error('Invalid report');
      } catch {
        throw new InternalRootMigrationRefused(
          'journal-unsupported',
          'Unrecognized or unsafe cleanup report; retain it for recovery.',
        );
      }
    }
    return null;
  }
  try {
    let journal = validateInternalRootJournal(
      await readPrivateMigrationJson(path, host),
      identity,
    );
    const planEvidencePath = lifecycleEvidencePath(
      identity,
      journal.transactionId,
      journal.repairPlan ?? {},
    );
    const evidencePath = (await statIfPresent(planEvidencePath))
      ? planEvidencePath
      : join(identity.coordination, 'lifecycle-journals.json');
    if (
      journal.repairPlan &&
      journal.repairPlan.lifecycleJournals === undefined &&
      (await statIfPresent(evidencePath))
    ) {
      const evidence = z
        .object({
          version: z.literal(1),
          transactionId: z.literal(journal.transactionId),
          planFingerprint: z.literal(repairPlanFingerprint(journal.repairPlan)),
          lifecycleJournals: z.array(z.unknown()),
          abandonedPaths: z.array(z.string()).optional(),
        })
        .strict()
        .parse(await readPrivateMigrationJson(evidencePath, host));
      journal = validateInternalRootJournal(
        {
          ...journal,
          repairPlan: {
            ...journal.repairPlan,
            lifecycleJournals: evidence.lifecycleJournals,
            ...(evidence.abandonedPaths === undefined
              ? {}
              : { abandonedPaths: evidence.abandonedPaths }),
          },
        },
        identity,
      );
    }
    await validateExternalRootFiles(identity, journal.externalFiles, host);
    return journal;
  } catch {
    throw new InternalRootMigrationRefused(
      'journal-unsupported',
      'Unknown, older (including v4/v5), malformed or newer journal. Preserve both roots and request teammate-assisted recovery.',
    );
  }
}

/** APFS-only primitive; portable construction is explicitly selected by build. */
export async function cloneInternalRoot(
  source: string,
  destination: string,
  root = source,
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
        !path.startsWith(`${root}/runtime/`) ||
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
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const path = internalRootStaging(identity);
  const stat = await statIfPresent(path);
  if (!stat) return;
  if (
    !journal ||
    (await inodeAt(path, stat)) !== journal.stagingIdentity ||
    (journal.phase !== 'building' && journal.phase !== 'publishing')
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Unknown or replaced migration staging tree. Preserve it and the journal for teammate-assisted recovery.',
    );
  await privateDirectory(path, host);
  if (hostOperatingSystem() !== 'win32' && (stat.mode & 0o7777) !== 0o700)
    refuseLayout('Migration staging requires mode 0700.');
  if (stat.dev !== (await lstat(identity.source)).dev)
    refuseLayout('Migration staging must remain on the source volume.');
}

export async function validateExternalRootFiles(
  identity: InternalRootIdentity,
  files: readonly string[],
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
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
      ].some((root) => isWithin(root, path))
    )
      refuseLayout(
        'External repair files must be canonical and outside both roots, coordination and secure history.',
      );
    if (hostOperatingSystem() === 'win32')
      await privateDirectory(dirname(path), host);
    const stat = await lstat(path);
    await observeMigrationNode(path, stat, host);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !ownedMigrationNode(stat) ||
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
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<{ bytes: Buffer; mode: number }> {
  if (hostOperatingSystem() === 'win32') {
    const before = await lstat(path);
    await observeMigrationNode(path, before, host);
    const beforeIdentity = await migrationNodeIdentity(path, before);
    const bytes = windowsFilesystem(host).read(path);
    const after = await lstat(path);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      bytes.length > 1024 * 1024 ||
      before.size !== bytes.length ||
      beforeIdentity !== (await migrationNodeIdentity(path, after)) ||
      before.mode !== after.mode ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      refuseExternalRecovery('External metadata changed while being read.');
    return { bytes, mode: before.mode & 0o777 };
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !ownedMigrationNode(before) ||
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
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  if (hostOperatingSystem() === 'win32')
    await privateDirectory(dirname(path), host);
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    if (hostOperatingSystem() !== 'win32') await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceMigrationFile(temp, path, host);
  await flush(dirname(path));
}

async function readPreimage(
  journal: InternalRootJournal,
  entry: InternalRootExternalSnapshot,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<Buffer> {
  await privateDirectory(journal.identity.coordination, host);
  const path = preimagePath(journal, entry.path);
  const stat = await statIfPresent(path);
  if (
    !stat ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    !ownedMigrationNode(stat) ||
    (hostOperatingSystem() !== 'win32' && (stat.mode & 0o7777) !== 0o600) ||
    stat.size > 1024 * 1024
  )
    refuseExternalRecovery('Missing or unsafe external preimage.');
  await observeMigrationNode(path, stat, host);
  const { bytes } = await readExternalMetadata(path, host);
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
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<readonly InternalRootExternalSnapshot[]> {
  await validateExternalRootFiles(
    journal.identity,
    journal.externalFiles,
    host,
  );
  const entries: InternalRootExternalSnapshot[] = [];
  for (const path of journal.externalFiles) {
    const { bytes, mode } = await readExternalMetadata(path, host);
    const entry = { path, mode, preimage: externalFingerprint(bytes, mode) };
    const backup = preimagePath(journal, path);
    if (await statIfPresent(backup)) await readPreimage(journal, entry, host);
    else {
      await writeDurableBytes(backup, bytes, 0o600, host);
      await readPreimage(journal, entry, host);
    }
    entries.push(entry);
  }
  return entries;
}

export async function sealInternalRootExternal(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<readonly InternalRootExternalSnapshot[]> {
  await validateExternalRootFiles(
    journal.identity,
    journal.externalFiles,
    host,
  );
  if (!journal.externalSnapshots)
    refuseExternalRecovery('Missing external preimages.');
  const entries: InternalRootExternalSnapshot[] = [];
  for (const entry of journal.externalSnapshots) {
    await readPreimage(journal, entry, host);
    // C syncs replacement contents; B also makes their directory entries durable
    // before the journal can seal these external postimages for publication.
    if (
      hostOperatingSystem() === 'win32' &&
      windowsFilesystem(host).inspect(entry.path).attributes & 1
    ) {
      const windows = windowsFilesystem(host);
      if (!windows.hasReadonlyCopyFlush(entry.path)) {
        // Unchanged readonly backlinks need no new content flush. A changed
        // postimage must carry the private replacement's retained flush receipt.
        const original = await readExternalMetadata(entry.path, host);
        if (
          externalFingerprint(original.bytes, original.mode) !== entry.preimage
        )
          refuseExternalRecovery(
            'Readonly external replacement lacks a matching flush receipt.',
          );
      }
    } else await flush(entry.path);
    await flush(dirname(entry.path));
    const { bytes, mode } = await readExternalMetadata(entry.path, host);
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
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  await validateExternalRootFiles(
    journal.identity,
    journal.externalFiles,
    host,
  );
  if (!journal.externalSnapshots)
    refuseExternalRecovery('Missing external preimages.');
  // Check the entire set before restoring any file; a changed later backlink
  // must not leave an otherwise completed installation partially restored.
  for (const entry of journal.externalSnapshots) {
    await readPreimage(journal, entry, host);
    const { bytes, mode } = await readExternalMetadata(entry.path, host);
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
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  await inspectExternalRestore(journal, false, host);
}

export async function assertInternalRootExternalPreimages(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  await validateExternalRootFiles(
    journal.identity,
    journal.externalFiles,
    host,
  );
  if (!journal.externalSnapshots)
    refuseExternalRecovery('Missing external preimages.');
  for (const entry of journal.externalSnapshots) {
    await readPreimage(journal, entry, host);
    const { bytes, mode } = await readExternalMetadata(entry.path, host);
    if (externalFingerprint(bytes, mode) !== entry.preimage)
      refuseExternalRecovery(
        `External metadata changed after restore: ${entry.path}.`,
      );
  }
}

export async function restoreInternalRootExternal(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  await inspectExternalRestore(journal, true, host);
  for (const entry of journal.externalSnapshots ?? []) {
    // Durable restore intent accepts mixed pre/postimages after interruption.
    const bytes = await readPreimage(journal, entry, host);
    await validateExternalRootFiles(journal.identity, [entry.path], host);
    const current = await readExternalMetadata(entry.path, host);
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
    await writeDurableBytes(entry.path, bytes, entry.mode, host);
  }
}

export async function buildInternalRoot(
  journal: InternalRootJournal,
  cloneTree?: (source: string, destination: string) => Promise<void>,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<string> {
  const { identity } = journal;
  const excluded = (journal.repairPlan?.abandonedPaths ?? []).filter((path) =>
    isWithin(identity.source, path),
  );
  const omitted = (relative: string): boolean =>
    excluded.some((path) => isWithin(path, join(identity.source, relative)));
  let constructionIdentity: string | null = null;
  const portableCopy =
    !cloneTree && ['linux', 'win32'].includes(hostOperatingSystem() ?? '');
  if (await statIfPresent(identity.destination))
    throw new InternalRootMigrationRefused(
      'destination-exists',
      internalRootDestinationExistsRecovery(identity.destination),
    );
  await validateInternalRootStaging(identity, journal, host);
  const sibling = internalRootStaging(identity);
  const staging = join(identity.coordination, 'staging');
  if (await statIfPresent(sibling)) {
    if (await statIfPresent(staging))
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Both private clone and sibling staging exist. Preserve both for recovery.',
      );
    // Re-enter private coordination before discarding a partial repaired tree.
    await renameMigrationDirectory(
      sibling,
      staging,
      journal.stagingIdentity,
      host,
    );
    await flush(dirname(sibling));
    await flush(identity.coordination);
  }
  if (await statIfPresent(staging)) {
    await privateDirectory(staging, host);
    if (
      portableCopy &&
      (!journal.stagingIdentity ||
        (await migrationNodeIdentity(staging, await lstat(staging))) !==
          journal.stagingIdentity)
    )
      refuseLayout('Private staging was replaced. Preserve it for recovery.');
    if (portableCopy) await manifest(staging, false, host);
    if (hostOperatingSystem() === 'win32') {
      if (!journal.stagingIdentity)
        refuseLayout('Missing recorded staging identity.');
      windowsFilesystem(host).removeRecordedTree(
        staging,
        journal.stagingIdentity,
      );
    } else await rm(staging, { recursive: true });
  }
  if (portableCopy) {
    await createPrivateMigrationDirectory(staging, host);
    const stagingIdentity = await migrationNodeIdentity(
      staging,
      await lstat(staging),
    );
    constructionIdentity = stagingIdentity;
    if (!stagingIdentity) refuseLayout('Construction identity is unavailable.');
    await flush(identity.coordination);
    await saveInternalRootJournal({ ...journal, stagingIdentity }, host);
    await copyInternalRootTree(identity.source, staging, host, true, omitted);
  } else if (excluded.length) {
    const clone =
      cloneTree ??
      ((from: string, to: string): Promise<void> =>
        cloneInternalRoot(from, to, identity.source));
    const visit = async (from: string, to: string): Promise<void> => {
      if (excluded.some((path) => isWithin(path, from))) return;
      if (!excluded.some((path) => isWithin(from, path))) {
        await clone(from, to);
        return;
      }
      const stat = await lstat(from);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        refuseLayout(`Aliased omission parent: ${from}`);
      await mkdir(to, { mode: 0o700 });
      for (const name of await readdir(from))
        await visit(join(from, name), join(to, name));
      await chown(to, stat.uid, stat.gid);
      await chmod(to, stat.mode & 0o7777);
      await utimes(
        to,
        stat.atimeMs / 1000,
        (Math.floor(stat.mtimeMs) + 0.5) / 1000,
      );
    };
    await visit(identity.source, staging);
  } else await (cloneTree ?? cloneInternalRoot)(identity.source, staging);
  if (
    constructionIdentity &&
    (await inodeAt(staging, await statIfPresent(staging))) !==
      constructionIdentity
  )
    refuseLayout(
      'Private staging was replaced during construction. Preserve it for recovery.',
    );
  await privateDirectory(staging, host);
  if (
    (await manifest(staging, false, host)).fingerprint !==
      (excluded.length
        ? (await manifest(identity.source, false, host, omitted)).fingerprint
        : journal.settledFingerprint) ||
    (await inspectInternalRoot(identity, false, host)).fingerprint !==
      journal.settledFingerprint
  )
    throw new InternalRootMigrationRefused(
      'source-changed',
      'Clone differs from settled source. Retain the original; retry migration after diagnosis.',
    );
  const stat = await lstat(staging);
  if (
    constructionIdentity &&
    (await migrationNodeIdentity(staging, stat)) !== constructionIdentity
  )
    refuseLayout(
      'Private staging changed during verification. Preserve it for recovery.',
    );
  await flush(staging);
  await flush(identity.coordination);
  return migrationNodeIdentity(staging, stat);
}

/** Called only after the clone's inode is durable in the non-moving journal. */
export async function exposeInternalRootStaging(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const { identity } = journal;
  const from = join(identity.coordination, 'staging');
  const to = internalRootStaging(identity);
  if (
    (await statIfPresent(to)) ||
    (await inodeAt(from, await statIfPresent(from))) !== journal.stagingIdentity
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Staging changed before exposure. Preserve the journal and both trees for recovery.',
    );
  await privateDirectory(from, host);
  if (
    hostOperatingSystem() !== 'win32' &&
    ((await lstat(from)).mode & 0o7777) !== 0o700
  )
    refuseLayout('Migration staging requires mode 0700.');
  if ((await lstat(from)).dev !== (await lstat(dirname(to))).dev)
    refuseLayout('Migration staging must remain on the source volume.');
  await renameMigrationDirectory(from, to, journal.stagingIdentity, host);
  await flush(identity.coordination);
  await flush(dirname(to));
}

/** Seal the repaired staging tree only if it is still the clone we built. */
export async function sealInternalRoot(
  journal: InternalRootJournal,
  publicationIdentity: string,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<string> {
  const staging = internalRootStaging(journal.identity);
  await privateDirectory(staging, host);
  if (
    (await inodeAt(staging, await statIfPresent(staging))) !==
    publicationIdentity
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Staging was replaced during repair. Preserve the journal and request recovery.',
    );
  // clonefile/cp exit alone does not durably publish every nested entry.
  return (await manifest(staging, true, host)).fingerprint;
}

/** Revalidate a sealed tree on BOTH sides of the publication crash window. */
export async function internalRootPublicationRoot(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<string> {
  const staging = internalRootStaging(journal.identity);
  const to = await statIfPresent(journal.identity.destination);
  const from = await statIfPresent(staging);
  const path =
    !to && (await inodeAt(staging, from)) === journal.publicationIdentity
      ? staging
      : !from &&
          (await inodeAt(journal.identity.destination, to)) ===
            journal.publicationIdentity
        ? journal.identity.destination
        : null;
  if (!path)
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Destination or staging identity changed. Preserve the journal and request recovery.',
    );
  await privateDirectory(path, host);
  if (
    (await manifest(path, false, host)).fingerprint !==
    journal.publicationFingerprint
  )
    throw new InternalRootMigrationRefused(
      'source-changed',
      'Sealed destination changed during publication. Preserve both roots and the journal for teammate-assisted recovery.',
    );
  // The recursive scan can be long; do not use its pre-scan path observations.
  if (
    (await inodeAt(path, await statIfPresent(path))) !==
      journal.publicationIdentity ||
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
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const path = await internalRootPublicationRoot(journal, host);
  if (path !== journal.identity.destination)
    await renameMigrationDirectory(
      path,
      journal.identity.destination,
      journal.publicationIdentity,
      host,
    );
  await flush(dirname(journal.identity.destination));
  await flush(journal.identity.coordination);
}

/** Only an explicitly journaled rebuild may discard the previous destination. */
export async function discardInternalRootDestination(
  journal: InternalRootJournal,
  checkOnly = false,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
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
  if ((await migrationNodeIdentity(path, stat)) !== journal.publicationIdentity)
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Recorded destination was replaced. Never discard another installation.',
    );
  await privateDirectory(path, host);
  if (await statIfPresent(join(path, 'secure-storage')))
    throw new InternalRootMigrationRefused(
      'recovery-required',
      'Destination contains secure storage absent from the restore source. Preserve it and obtain CAN-5786 secure-relocation recovery before rebuilding.',
    );
  if (checkOnly) return;
  if (to) {
    // Never leave a partially deleted resolver candidate after interrupted rm.
    await renameMigrationDirectory(
      destination,
      discarded,
      journal.publicationIdentity,
      host,
    );
    await flush(dirname(destination));
    await flush(journal.identity.coordination);
  }
  if (hostOperatingSystem() !== 'darwin')
    await manifest(discarded, false, host);
  if (hostOperatingSystem() === 'win32') {
    if (!journal.publicationIdentity)
      refuseLayout('Missing recorded publication identity.');
    windowsFilesystem(host).removeRecordedTree(
      discarded,
      journal.publicationIdentity,
    );
  } else await rm(discarded, { recursive: true });
  await flush(journal.identity.coordination);
}

async function replaceMigrationFile(
  from: string,
  to: string,
  host: InternalRootFilesystemHost,
): Promise<void> {
  if (hostOperatingSystem() !== 'win32') {
    await rename(from, to);
    return;
  }
  if (await statIfPresent(to)) {
    const windows = windowsFilesystem(host);
    windows.finish(to, from);
    windows.replace(from, to);
    return;
  }
  const result = await hostPlatformServices(
    createPlatformEndpointServices('win32'),
  ).secureFiles.rename({ from, to, mode: 'replace' });
  if (result.kind !== 'renamed' || result.sourceState !== 'removed')
    refuseLayout(
      'Metadata replacement could not be confirmed. Preserve the journal.',
    );
}

/** Shared with classification in the repair composition; no lexical slash test. */
export { isWithin as isWithinInternalRoot } from '@canopy/core-runtime/node/relocation/transition';

async function renameMigrationDirectory(
  from: string,
  to: string,
  identity: string | undefined,
  host: InternalRootFilesystemHost,
): Promise<void> {
  if (hostOperatingSystem() !== 'linux') {
    await rename(from, to);
    return;
  }
  if (!host.renameNoReplace || !identity)
    refuseLayout(
      'Linux no-replace directory publication is unavailable. Preserve both trees.',
    );
  try {
    host.renameNoReplace(from, to, identity);
  } catch {
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'No-replace directory rename refused. Preserve both trees and the journal for recovery.',
    );
  }
}

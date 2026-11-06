import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import {
  createPlatformEndpointServices,
  hostPlatformServices,
} from '@canopy/core-platform';
import { daemonName, type BrandCore } from '@canopy/protocol/brand';
import { listW5HostPeers, inspectW5MaintenanceOwner } from '../w5-host-cohort';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootColdRecovery,
  type InternalRootMigrationWorker,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  inspectInternalRoot,
  captureInternalRootExternal,
  sealInternalRootExternal,
  assertInternalRootExternalPostimages,
  assertInternalRootExternalPreimages,
  restoreInternalRootExternal,
  readInternalRootJournal,
  buildInternalRoot,
  publishInternalRoot,
  sealInternalRoot,
  internalRootPublicationRoot,
  discardInternalRootDestination,
  internalRootStaging,
  validateInternalRootStaging,
  exposeInternalRootStaging,
  validateExternalRootFiles,
  durableJson,
  privateDirectory,
  statIfPresent,
  flush,
} from './filesystem';
export { internalRootIdentity, readInternalRootJournal } from './filesystem';
const run = promisify(execFile);

type ExecutableBrand = Pick<BrandCore, 'displayName' | 'cliName'>;

export function assertInternalRootColdProcesses(
  stdout: string,
  selfPid: number,
  selfParent: number,
  brands: readonly ExecutableBrand[],
): void {
  if (!brands.length) throw new Error('Missing trusted executable identities');
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) throw new Error('Unrecognized process table');
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        executable: match[3] ?? '',
      };
    });
  if (!rows.some((row) => row.pid === selfPid && row.parent === selfParent))
    throw new Error('Incomplete process table');
  const active = rows.filter((row) => {
    if (row.pid === selfPid) return false;
    if (
      row.parent === selfPid &&
      ['/bin/ps', '/usr/sbin/lsof'].includes(row.executable)
    )
      return false;
    const name = basename(row.executable);
    // Product names/channels follow generate-electron-builder-config.mjs;
    // Electron derives Helper names from productName. No arguments are read.
    return brands.some(
      (brand) =>
        name === brand.cliName ||
        name === daemonName(brand) ||
        [
          brand.displayName,
          `${brand.displayName} (Internal)`,
          `${brand.displayName} (RC)`,
        ].some(
          (product) =>
            name === product ||
            name === `${product} Helper` ||
            (name.startsWith(`${product} Helper (`) && name.endsWith(')')) ||
            row.executable.includes(`/${product}.app/Contents/`),
        ),
    );
  });
  if (active.length)
    throw new InternalRootMigrationRefused(
      'writer-active',
      `Product executables remain (PIDs ${active.map((row) => row.pid).join(', ')}). Stop the app, CLI, daemon and helpers before retrying.`,
    );
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) ||
      dirname(path) === path
    )
      throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

/** NUL-delimited lsof fields preserve whitespace/newlines in file names. */
export async function assertInternalRootColdOpenFiles(
  stdout: string,
  stderr: string,
  roots: readonly string[],
  exemptPids: ReadonlySet<number>,
): Promise<void> {
  // Only a specifically identified skipped mount outside every affected tree
  // is harmless. Permission/process-table errors and unknown diagnostics refuse.
  let skippedMount = false;
  for (const line of stderr.trim().split('\n').filter(Boolean)) {
    const warning =
      /^lsof: WARNING: can't stat\(\) .+ file system (\/.+)$/.exec(line.trim());
    if (warning?.[1]) {
      const path = await canonical(warning[1]);
      if (roots.some((root) => under(path, root) || under(root, path)))
        throw new Error('Affected mount inspection incomplete');
      skippedMount = true;
    } else if (
      !(
        skippedMount &&
        /^\s*Output information may be incomplete\.?$/.test(line)
      )
    )
      throw new Error('Incomplete open-file inspection');
  }
  let pid = 0;
  let sawSelf = false;
  for (const raw of stdout.split('\0')) {
    const field = raw.replace(/^\n/, '');
    if (!field) continue;
    if (field.startsWith('p')) {
      if (!/^p[1-9]\d*$/.test(field)) throw new Error('Invalid lsof PID');
      pid = Number(field.slice(1));
      if (exemptPids.has(pid)) sawSelf = true;
    } else if (field.startsWith('n')) {
      if (!pid) throw new Error('Missing lsof PID');
      if (exemptPids.has(pid) || !field.startsWith('n/')) continue;
      const path = await canonical(field.slice(1).replace(/ \(deleted\)$/, ''));
      if (roots.some((root) => under(path, root)))
        throw new InternalRootMigrationRefused(
          'writer-active',
          `Process ${pid} has an open file or working directory under an affected tree.`,
        );
    } else if (!field.startsWith('f'))
      throw new Error('Unrecognized lsof field');
  }
  if (!sawSelf) throw new Error('Incomplete user open-file table');
}

export async function assertInternalRootDaemonStopped(
  root: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(join(root, 'runtime', 'core.sock'));
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      reject(
        new InternalRootMigrationRefused(
          'writer-active',
          'The root daemon socket still accepts connections. Stop the daemon before retrying.',
        ),
      );
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Daemon socket inspection timed out'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

/** Read-only targeted snapshot, not an exclusion guarantee against old writers. */
export async function proveInternalRootCold(
  identity: InternalRootIdentity,
  externalFiles: readonly string[],
  brands: readonly ExecutableBrand[],
): Promise<void> {
  if (hostOperatingSystem() !== 'darwin')
    throw new InternalRootMigrationRefused(
      'cold-proof-unavailable',
      'Only native macOS maintenance sessions are supported; Windows cohort registration is unavailable.',
    );
  try {
    const { stdout } = await run(
      '/bin/ps',
      ['-ww', '-U', String(process.getuid?.()), '-o', 'pid=,ppid=,comm='],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assertInternalRootColdProcesses(stdout, process.pid, process.ppid, brands);
    const roots = await Promise.all(
      [
        identity.source,
        identity.destination,
        identity.historicalSecure,
        identity.coordination,
        internalRootStaging(identity),
        ...externalFiles.map((path) =>
          path.includes('/.git/') ? `${path.split('/.git/')[0]}/.git` : path,
        ),
      ].map(canonical),
    );
    const script = process.argv[1]
      ? await canonical(process.argv[1])
      : process.cwd();
    if (roots.some((root) => under(process.cwd(), root) || under(script, root)))
      throw new InternalRootMigrationRefused(
        'writer-active',
        'Run from a checkout outside both roots and the affected maintenance trees.',
      );
    const inspection = run(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-u', String(process.getuid?.()), '-F0pfn'],
      { timeout: 30_000, maxBuffer: 128 * 1024 * 1024 },
    );
    const exemptPids = new Set([process.pid]);
    if (inspection.child.pid) exemptPids.add(inspection.child.pid);
    const result = await inspection;
    await assertInternalRootColdOpenFiles(
      result.stdout,
      result.stderr,
      roots,
      exemptPids,
    );
    const services = hostPlatformServices(
      createPlatformEndpointServices('darwin'),
    );
    for (const dataRoot of [identity.source, identity.destination]) {
      const options = {
        dataRoot,
        inspect: (
          pid: number,
          signal?: AbortSignal,
        ): ReturnType<typeof services.supervision.inspectProcess> =>
          services.supervision.inspectProcess({ pid, signal }),
        secureFiles: services.secureFiles,
      };
      // Existing read-only cohort/maintenance parsers retain PID-reuse rules.
      if (
        (await listW5HostPeers(options)).length ||
        (await inspectW5MaintenanceOwner(options))
      )
        throw new InternalRootMigrationRefused(
          'writer-active',
          'A W5 cohort or maintenance owner is live or unprovable. Use W5 offline diagnosis before retrying.',
        );
    }
    // Held W5 SQLite process locks have open files under runtime/locks and were
    // covered by the same user-scoped lsof pass; never create locks in inventory.
    await assertInternalRootDaemonStopped(identity.source);
    await assertInternalRootDaemonStopped(identity.destination);
  } catch (error) {
    if (error instanceof InternalRootMigrationRefused) throw error;
    throw new InternalRootMigrationRefused(
      'cold-proof-unavailable',
      'Process/open-file inspection failed or was incomplete. Preserve the installation; retry with native macOS inspection access.',
    );
  }
}

/** SQLite's OS lock is outside both resolver candidates and released on crash. */
async function coordinate(
  identity: InternalRootIdentity,
): Promise<() => Promise<void>> {
  await mkdir(identity.coordination, { mode: 0o700, recursive: true });
  await privateDirectory(identity.coordination);
  const path = join(identity.coordination, 'coordination.sqlite');
  const stat = await statIfPresent(path);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
    throw new InternalRootMigrationRefused(
      'coordination-held',
      'Unsafe coordination database; retain it for recovery.',
    );
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch {
    db.close();
    throw new InternalRootMigrationRefused(
      'coordination-held',
      'Another migration holds coordination. Never remove the lock database.',
    );
  }
  try {
    await flush(identity.coordination);
    await flush(dirname(identity.coordination));
  } catch (error) {
    db.close();
    throw error;
  }
  return (): Promise<void> =>
    Promise.resolve().then(() => {
      try {
        db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    });
}

export function createInternalRootMigrationWorker(options: {
  readonly executableBrands?: readonly ExecutableBrand[];
  /** Test-only clone substitute; production always requires APFS clonefile. */
  readonly cloneTree?: (source: string, destination: string) => Promise<void>;
  readonly recoverW5: (
    source: string,
    qualification: InternalRootColdRecovery,
  ) => Promise<void>;
  /** Test-only substitute: the installed composition always uses native proof. */
  readonly proveCold?: (
    identity: InternalRootIdentity,
    externalFiles?: readonly string[],
  ) => Promise<void>;
}): InternalRootMigrationWorker {
  const coordinationTokens = new Map<string, symbol>();
  const worker: InternalRootMigrationWorker = {
    inventory: inspectInternalRoot,
    readJournal: readInternalRootJournal,
    coordinate: async (
      identity,
    ): ReturnType<InternalRootMigrationWorker['coordinate']> => {
      const release = await coordinate(identity);
      const token = Symbol('internal-root-migration');
      coordinationTokens.set(identity.coordination, token);
      return async (): Promise<void> => {
        if (coordinationTokens.get(identity.coordination) === token)
          coordinationTokens.delete(identity.coordination);
        await release();
      };
    },
    saveJournal: async (journal): Promise<void> => {
      await privateDirectory(journal.identity.coordination);
      await durableJson(
        join(journal.identity.coordination, 'journal.json'),
        journal,
      );
    },
    proveCold:
      options.proveCold ??
      ((identity, externalFiles = []) =>
        proveInternalRootCold(
          identity,
          externalFiles,
          options.executableBrands ?? [],
        )),
    stagingRoot: internalRootStaging,
    validateStaging: validateInternalRootStaging,
    validateExternal: validateExternalRootFiles,
    build: (journal) => buildInternalRoot(journal, options.cloneTree),
    exposeStaging: exposeInternalRootStaging,
    seal: sealInternalRoot,
    publicationRoot: internalRootPublicationRoot,
    publish: publishInternalRoot,
    validateRebuild: (journal) => discardInternalRootDestination(journal, true),
    discardDestination: discardInternalRootDestination,
    captureExternal: captureInternalRootExternal,
    sealExternal: sealInternalRootExternal,
    assertExternalPostimages: assertInternalRootExternalPostimages,
    assertExternalPreimages: assertInternalRootExternalPreimages,
    restoreExternal: restoreInternalRootExternal,
    recoverW5: async (journal): Promise<void> => {
      const token = coordinationTokens.get(journal.identity.coordination);
      const assertHeld = async (): Promise<void> => {
        const loaded = await readInternalRootJournal(journal.identity);
        const stat = await statIfPresent(journal.identity.source);
        if (
          !token ||
          coordinationTokens.get(journal.identity.coordination) !== token ||
          loaded?.transactionId !== journal.transactionId ||
          loaded.phase !== 'prepared' ||
          !stat ||
          `${stat.dev}:${stat.ino}` !== journal.inventory.sourceIdentity
        )
          throw new InternalRootMigrationRefused(
            'recovery-required',
            'Migration qualification lost. Retain the original root and journal; retry only while cold.',
          );
      };
      await assertHeld();
      await worker.proveCold(journal.identity, journal.externalFiles);
      await options.recoverW5(journal.identity.source, {
        identity: journal.identity,
        transactionId: journal.transactionId,
        assertHeld,
      });
      await assertHeld();
    },
    transactionId: randomUUID,
  };
  return worker;
}

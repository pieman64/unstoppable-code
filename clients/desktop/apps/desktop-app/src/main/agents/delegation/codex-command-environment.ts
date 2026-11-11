import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { LocalDelegationContext } from '@canopy/desktop-shared/node/delegation/local-runner';
import {
  DARWIN_DELEGATION_SHARED_TEMPORARY_ROOTS,
  delegationOutermostRoots,
  delegationToolchainReadRoots,
} from '@canopy/desktop-shared/node/delegation/command-environment';
import {
  getCanopyDataDir,
  getCanopySecureDataDir,
} from '@canopy/execution-engine/canopy-paths';
import type { CodexDelegationPreparation } from './codex-runner';
import { logMainProcessWarn } from '../../lib/main-process-logging';

/**
 * Captured login-shell PATH, bounded resolved toolchain reads and a private
 * writable per-run TMPDIR beyond the validated Git executable. PATH never
 * grants shared-temporary namespaces, private directories or app data. Inside
 * home, only executable and runtime directories are granted, not tool-manager
 * folders that may hold credentials.
 */
export async function delegatedCodexCommandEnvironment(
  commandPath: string,
  context: LocalDelegationContext,
): Promise<NonNullable<CodexDelegationPreparation['commandEnvironment']>> {
  const platform = hostOperatingSystem();
  const created = await fs.mkdtemp(
    path.join(os.tmpdir(), 'delegated-runtime-'),
  );
  context.retain(() => fs.rm(created, { recursive: true, force: true }));
  // The sandbox compares canonical paths; macOS temp directories sit behind
  // the /var -> /private/var link.
  const temporaryDirectory = await fs.realpath(created);
  // The sandbox resolves paths, so grants are derived only from resolved PATH
  // entries; an entry that does not resolve grants nothing. PATH itself keeps
  // every entry as captured, for executable lookup.
  const entries = commandPath
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry));
  const resolved = (
    await Promise.all(
      entries.map((entry) =>
        fs.realpath(entry).catch((): undefined => undefined),
      ),
    )
  ).filter((entry): entry is string => entry !== undefined);
  const sharedTemporaryPathEntries =
    platform === 'darwin'
      ? Array.from(
          new Set(
            resolved.filter((entry) =>
              DARWIN_DELEGATION_SHARED_TEMPORARY_ROOTS.includes(entry),
            ),
          ),
        )
      : [];
  if (sharedTemporaryPathEntries.length)
    logMainProcessWarn(
      '[delegation] Command PATH includes a shared temporary directory. PATH alone does not authorize access to it; use a dedicated executable directory for tools there.',
      { resolvedPathEntries: sharedTemporaryPathEntries },
    );
  const home = await fs
    .realpath(os.homedir())
    .catch((): string => os.homedir());
  // The app's data directories stay out of reach at their real locations too.
  const dataDirectories = [getCanopyDataDir(), getCanopySecureDataDir()];
  const excludedRoots = [
    ...dataDirectories,
    ...(await Promise.all(
      dataDirectories.map((directory) =>
        fs.realpath(directory).catch((): string => directory),
      ),
    )),
  ];
  const candidates = delegationToolchainReadRoots(resolved, {
    home,
    excludedRoots,
  });
  // Named runtime siblings in home or shared temp must resolve to themselves:
  // a missing directory grants nothing; a symlink cannot alias private data.
  const granted = (
    await Promise.all(
      candidates.map(async (root) => {
        const relative = path.relative(home, root);
        const insideHome =
          relative !== '' &&
          !relative.startsWith('..') &&
          !path.isAbsolute(relative);
        const insideSharedTemporary =
          platform === 'darwin' &&
          DARWIN_DELEGATION_SHARED_TEMPORARY_ROOTS.some((shared) =>
            root.startsWith(`${shared}/`),
          );
        if (!insideHome && !insideSharedTemporary) return root;
        const real = await fs.realpath(root).catch((): undefined => undefined);
        return real === root ? root : undefined;
      }),
    )
  ).filter((root): root is string => root !== undefined);
  return {
    commandPath,
    toolchainReadRoots: delegationOutermostRoots(granted),
    temporaryDirectory,
  };
}

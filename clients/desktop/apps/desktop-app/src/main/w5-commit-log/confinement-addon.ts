import { win32 } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { getCanopyRuntimeMode } from '@canopy/execution-engine/canopy-paths';
import type { CanopyRuntimeMode } from '@canopy/protocol/brand';

/** The build's `.cache/native-owned-child`, fixed when main is bundled. */
declare const __CANOPY_OWNED_CHILD_SOURCE_DIR__: string | undefined;

const ADDON = 'core-owned-child.node';

export interface W5ConfinementAddonHost {
  readonly os: PlatformOperatingSystem | null;
  readonly runtimeMode: CanopyRuntimeMode;
  readonly arch: string;
  /** Electron's `process.resourcesPath`; absent outside Electron. */
  readonly resourcesPath: string | undefined;
  /** Where `build:owned-child` writes, from the build, never the cwd. */
  readonly sourceDirectory: string | undefined;
}

/**
 * win32: the owned-child addon serving handle-confined W5 capture reads (the
 * one `electron-daemon-host.ts` loads), staged under `resources/cli`, or the
 * `build:owned-child` output in a dev runtime. Undefined elsewhere, or when
 * the location is unknown, which refuses capture as `confinement-unavailable`.
 *
 * The dev test is `getCanopyRuntimeMode()`, not Electron's `app.isPackaged`:
 * offline maintenance bundles this host outside Electron, where `electron`
 * has no `app`. In Electron both test for the default `electron` binary. They
 * differ only for an unpackaged `rc` build, which finds no addon in
 * Electron's own resources and refuses capture rather than read unconfined.
 */
export function selectW5ConfinementAddon(
  host: W5ConfinementAddonHost,
): string | undefined {
  if (host.os !== 'win32') return undefined;
  if (host.runtimeMode === 'dev')
    return host.sourceDirectory === undefined
      ? undefined
      : win32.join(host.sourceDirectory, `win32-${host.arch}`, ADDON);
  return host.resourcesPath === undefined
    ? undefined
    : win32.join(host.resourcesPath, 'cli', ADDON);
}

/** This process's addon location; see {@link selectW5ConfinementAddon}. */
export function hostW5ConfinementAddon(): string | undefined {
  return selectW5ConfinementAddon({
    os: hostOperatingSystem(),
    runtimeMode: getCanopyRuntimeMode(),
    arch: process.arch,
    resourcesPath:
      typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : undefined,
    sourceDirectory:
      typeof __CANOPY_OWNED_CHILD_SOURCE_DIR__ === 'string'
        ? __CANOPY_OWNED_CHILD_SOURCE_DIR__
        : undefined,
  });
}

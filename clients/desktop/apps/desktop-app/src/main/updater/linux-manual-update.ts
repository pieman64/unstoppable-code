import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { BRAND } from '@canopy/brand/current';

/** Architectures with a published Debian package; nothing else is offered. */
export type LinuxPackageArchitecture = 'x64' | 'arm64';

const DPKG_ARCHITECTURE_TIMEOUT_MS = 5_000;

/** dpkg architecture names map onto the Node/Electron target names. */
const DPKG_ARCHITECTURES: ReadonlyMap<string, LinuxPackageArchitecture> =
  new Map([
    ['amd64', 'x64'],
    ['arm64', 'arm64'],
  ]);

function processArchitecture(): LinuxPackageArchitecture | null {
  return process.arch === 'x64' || process.arch === 'arm64'
    ? process.arch
    : null;
}

/** Package-manager ownership, not an executable suffix or an environment flag. */
export async function isInstalledLinuxDeb(): Promise<boolean> {
  if (
    processArchitecture() === null ||
    process.env.APPIMAGE ||
    process.env.APPDIR
  ) {
    return false;
  }
  try {
    const files = await readFile(
      `/var/lib/dpkg/info/${BRAND.cliName}-desktop.list`,
      'utf8',
    );
    return files.split('\n').includes(process.execPath);
  } catch {
    // Missing/unreadable ownership records never authorize a package path.
    return false;
  }
}

function dpkgPrintArchitecture(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/dpkg',
      ['--print-architecture'],
      { timeout: DPKG_ARCHITECTURE_TIMEOUT_MS, maxBuffer: 4096 },
      (error, stdout) => {
        resolve(error ? null : String(stdout));
      },
    );
  });
}

/**
 * The installed package architecture. dpkg's native architecture is
 * authoritative; an unsupported dpkg answer never falls back to the process
 * architecture, which only stands in when dpkg itself is unavailable.
 */
export async function installedLinuxPackageArchitecture(): Promise<LinuxPackageArchitecture | null> {
  const reported = (await dpkgPrintArchitecture())?.trim();
  if (!reported) return processArchitecture();
  return DPKG_ARCHITECTURES.get(reported) ?? null;
}

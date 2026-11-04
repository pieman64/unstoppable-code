import { execFile } from 'node:child_process';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';

/** Architectures with a published Debian package; nothing else is offered. */
export type LinuxPackageArchitecture = 'x64' | 'arm64';

/**
 * How the running executable was installed. Only package-manager ownership
 * records count; an executable suffix or environment flag never does.
 */
export type LinuxInstallSource =
  | { kind: 'deb'; packageName: string }
  | { kind: 'pacman'; packageName: string; version: string }
  | { kind: 'appimage' }
  | { kind: 'unknown' };

export type PackageManagedLinuxInstallSource = Extract<
  LinuxInstallSource,
  { packageName: string }
>;

export interface LinuxInstallRoots {
  dpkgInfoDir?: string;
  pacmanLocalDir?: string;
  execPath?: string;
}

/** Repository installs update through the system package manager only. */
export const PACMAN_UPDATE_COMMAND = 'sudo pacman -Syu';

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

function linuxPackageName(): string {
  return `${BRAND.cliName}-desktop`;
}

async function isDpkgOwned(
  packageName: string,
  dpkgInfoDir: string,
  execPath: string,
): Promise<boolean> {
  try {
    const files = await readFile(
      join(dpkgInfoDir, `${packageName}.list`),
      'utf8',
    );
    return files.split('\n').includes(execPath);
  } catch {
    // Missing/unreadable ownership records never authorize a package path.
    return false;
  }
}

/** pacman database files hold `%SECTION%` headers, values, and a blank line. */
function pacmanSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    const header = /^%([A-Z0-9]+)%$/.exec(line);
    if (header) {
      current = [];
      sections.set(header[1], current);
    } else if (line === '') {
      current = null;
    } else {
      current?.push(line);
    }
  }
  return sections;
}

function singleValue(
  sections: Map<string, string[]>,
  name: string,
): string | null {
  const values = sections.get(name);
  return values?.length === 1 ? values[0] : null;
}

async function pacmanOwnedVersion(
  entryDir: string,
  packageName: string,
  ownedPath: string,
): Promise<string | null> {
  try {
    const desc = pacmanSections(await readFile(join(entryDir, 'desc'), 'utf8'));
    const version = singleValue(desc, 'VERSION');
    if (singleValue(desc, 'NAME') !== packageName || !version) return null;
    const files = pacmanSections(
      await readFile(join(entryDir, 'files'), 'utf8'),
    );
    return files.get('FILES')?.includes(ownedPath) ? version : null;
  } catch {
    return null;
  }
}

async function detectPacman(
  packageName: string,
  pacmanLocalDir: string,
  execPath: string,
): Promise<LinuxInstallSource> {
  try {
    const resolved = await realpath(execPath);
    if (!resolved.startsWith('/')) return { kind: 'unknown' };
    // pacman records owned paths relative to the filesystem root.
    const ownedPath = resolved.slice(1);
    const entries = await readdir(pacmanLocalDir, { withFileTypes: true });
    const versions: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${packageName}-`))
        continue;
      const version = await pacmanOwnedVersion(
        join(pacmanLocalDir, entry.name),
        packageName,
        ownedPath,
      );
      if (version) versions.push(version);
    }
    return versions.length === 1
      ? { kind: 'pacman', packageName, version: versions[0] }
      : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

/** Reads ownership records directly: no subprocess, no elevation, no writes. */
export async function detectLinuxInstallSource(
  roots: LinuxInstallRoots = {},
): Promise<LinuxInstallSource> {
  if (process.env.APPIMAGE || process.env.APPDIR) return { kind: 'appimage' };
  if (processArchitecture() === null) return { kind: 'unknown' };
  const packageName = linuxPackageName();
  const execPath = roots.execPath ?? process.execPath;
  if (
    await isDpkgOwned(
      packageName,
      roots.dpkgInfoDir ?? '/var/lib/dpkg/info',
      execPath,
    )
  )
    return { kind: 'deb', packageName };
  return detectPacman(
    packageName,
    roots.pacmanLocalDir ?? '/var/lib/pacman/local',
    execPath,
  );
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
 * architecture, which only stands in when dpkg itself is unavailable (for
 * example on Arch Linux, where a missing dpkg resolves silently).
 */
export async function installedLinuxPackageArchitecture(): Promise<LinuxPackageArchitecture | null> {
  const reported = (await dpkgPrintArchitecture())?.trim();
  if (!reported) return processArchitecture();
  return DPKG_ARCHITECTURES.get(reported) ?? null;
}

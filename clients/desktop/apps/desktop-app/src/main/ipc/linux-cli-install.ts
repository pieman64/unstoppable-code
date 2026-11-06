import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BRAND } from '@canopy/brand/current';
import {
  CODE_GRAPH_RUNTIME_ROOTS,
  DAEMON_EXECUTION_HOST_ENTRIES,
  DAEMON_SECRET_PROTECTION_MEMBERS,
} from '@canopy/core-platform/execution-host/daemon-payload';
import { daemonName } from '@canopy/protocol/brand';
import type {
  CliInstallResult,
  CliPathStatus,
} from '@canopy/desktop-shared/types';

const TOOLS = ['claude', 'codex', 'codex-code-mode-host', 'gh', 'rg', 'rtk'];
const DAEMON = daemonName(BRAND);
const DAEMON_FILES = [
  `${DAEMON}.identity.json`,
  'w5-commit-log-worker.js',
  ...DAEMON_SECRET_PROTECTION_MEMBERS,
];
// The daemon's execution host entries beside it, and the graph runtime its
// code-graph hosts share with the CLI: the release's own lists (CAN-5672).
const DAEMON_HOSTS = 'execution-hosts';
const RECEIPT = '.cli-install.json';

interface InstallOptions {
  bundledCliPath: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

interface InstallPaths {
  root: string;
  versions: string;
  current: string;
  bin: string;
  launcher: string;
  target: string;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === code
  );
}

async function statIfPresent(file: string): Promise<Stats | null> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function absolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.normalize(value);
}

function installPaths(options: InstallOptions): InstallPaths {
  const env = options.env ?? process.env;
  const home = absolutePath(options.homeDir ?? homedir(), 'Home directory');
  const data = absolutePath(
    env.XDG_DATA_HOME || path.join(home, '.local/share'),
    'XDG_DATA_HOME',
  );
  const bin = absolutePath(
    env.XDG_BIN_HOME || path.join(home, '.local/bin'),
    'XDG_BIN_HOME',
  );
  const root = path.join(data, BRAND.cliName, 'cli');
  const current = path.join(root, 'current');
  return {
    root,
    versions: path.join(root, 'versions'),
    current,
    bin,
    launcher: path.join(bin, BRAND.cliName),
    target: path.join(current, BRAND.cliName),
  };
}

// Walk before reading or creating anything below an existing directory. Never
// follow a destination ancestor link, including XDG overrides and ~/.local/bin.
async function directories(
  directory: string,
  create = false,
  privateLeaf = false,
): Promise<boolean> {
  let current = path.parse(directory).root;
  for (const component of directory
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    let stat = await statIfPresent(current);
    if (!stat && create) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
      stat = await fs.lstat(current);
    }
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `Refusing CLI directory symlink or non-directory: ${current}`,
      );
    }
    if (
      current === directory &&
      privateLeaf &&
      ((stat.mode & 0o777) !== 0o700 ||
        (process.getuid && stat.uid !== process.getuid()))
    ) {
      throw new Error(
        `CLI data directory must be private and owned by this user: ${current}`,
      );
    }
  }
  return true;
}

// One layout projection for both copying and freshness checks: the .deb
// splits tools/daemon/notices out of resources/cli; an extracted tarball is flat.
async function distributionMembers(source: string): Promise<
  Array<{
    source: string;
    name: string;
  }>
> {
  await directories(source);
  const entries = await fs.readdir(source);
  if (entries.includes(RECEIPT))
    throw new Error('Reserved CLI install receipt in source.');
  const members = entries.map((name) => ({
    source: path.join(source, name),
    name,
  }));
  if (
    path.basename(source) === 'cli' &&
    path.basename(path.dirname(source)) === 'resources'
  ) {
    const companions = [
      ...TOOLS,
      DAEMON,
      ...DAEMON_FILES,
      'node-pty',
      DAEMON_HOSTS,
      'THIRD_PARTY_NOTICES.txt',
    ];
    const existing = await Promise.all(
      companions.map((name) => statIfPresent(path.join(source, name))),
    );
    if (existing.some(Boolean) && !existing.every(Boolean)) {
      throw new Error('Incomplete in-place CLI distribution.');
    }
    if (!existing.every(Boolean)) {
      const resources = path.dirname(source);
      const bin = path.join(resources, 'bin');
      if (!(await directories(bin)))
        throw new Error('Incomplete CLI distribution: companion tools.');
      for (const name of companions)
        members.push({
          source: path.join(
            name === 'THIRD_PARTY_NOTICES.txt' ? resources : bin,
            name,
          ),
          name,
        });
    }
  }
  return members.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

interface PackageSnapshot {
  identity: string;
  files: Array<{ source: string; name: string }>;
}

// One bounded cache per GUI process. Metadata invalidates it; the durable
// receipt stores content identity, so inode/permission changes and restarts
// cannot make an identical package appear outdated.
let cachedPackageRevision: { identity: string; revision: string } | null = null;

async function snapshotPackage(
  executable: string,
): Promise<PackageSnapshot | null> {
  if (!(await statIfPresent(executable))) return null;
  const identity = createHash('sha256').update(executable);
  const files: PackageSnapshot['files'] = [];
  async function visit(file: string, name: string): Promise<void> {
    const stat = await fs.lstat(file, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Unsafe CLI distribution member: ${file}`);
    }
    if (stat.isFile()) {
      identity.update(
        JSON.stringify([
          name,
          String(stat.dev),
          String(stat.ino),
          String(stat.mode),
          String(stat.size),
          String(stat.mtimeNs),
          String(stat.ctimeNs),
        ]),
      );
      files.push({ source: file, name });
    } else {
      for (const entry of (await fs.readdir(file)).sort()) {
        await visit(path.join(file, entry), path.join(name, entry));
      }
    }
  }
  for (const member of await distributionMembers(path.dirname(executable))) {
    if (!(await statIfPresent(member.source))) {
      throw new Error(`Incomplete CLI distribution: ${member.name}`);
    }
    await visit(member.source, member.name);
  }
  await requirePayload(path.dirname(executable));
  return { identity: identity.digest('hex'), files };
}

async function packageRevision(bundledCliPath: string): Promise<string | null> {
  const executable = absolutePath(bundledCliPath, 'Bundled CLI');
  try {
    const snapshot = await snapshotPackage(executable);
    if (!snapshot) return null;
    if (cachedPackageRevision?.identity === snapshot.identity) {
      return cachedPackageRevision.revision;
    }
    const revision = createHash('sha256');
    for (const file of snapshot.files) {
      const input = await fs.open(
        file.source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!(await input.stat()).isFile())
          throw new Error(`Unsafe CLI distribution member: ${file.source}`);
        const hash = createHash('sha256');
        await pipeline(input.createReadStream(), hash);
        revision.update(JSON.stringify([file.name, hash.digest('hex')]));
      } finally {
        await input.close();
      }
    }
    if ((await snapshotPackage(executable))?.identity !== snapshot.identity) {
      throw new Error('CLI package changed during installation. Try again.');
    }
    const result = revision.digest('hex');
    cachedPackageRevision = { identity: snapshot.identity, revision: result };
    return result;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

async function managedVersion(paths: InstallPaths): Promise<{
  packageRevision: string | null;
} | null> {
  if (!(await directories(paths.root, false, true))) return null;
  const pointer = await statIfPresent(paths.current);
  if (!pointer) return null;
  if (!pointer.isSymbolicLink())
    throw new Error(`Unmanaged CLI version pointer: ${paths.current}`);
  const target = await fs.readlink(paths.current);
  if (!/^versions\/[0-9a-f-]{36}$/.test(target)) {
    throw new Error(`Unmanaged CLI version pointer: ${paths.current}`);
  }
  const version = path.join(paths.root, target);
  if (!(await directories(version, false, true))) return null;
  const receipt = await fs.lstat(path.join(version, RECEIPT));
  const executable = await fs.lstat(path.join(version, BRAND.cliName));
  if (
    !receipt.isFile() ||
    receipt.isSymbolicLink() ||
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    (executable.mode & 0o111) === 0
  ) {
    throw new Error(`Invalid managed CLI version: ${version}`);
  }
  const value: unknown = JSON.parse(
    await fs.readFile(path.join(version, RECEIPT), 'utf8'),
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    Reflect.get(value, 'version') !== 1 ||
    Reflect.get(value, 'cliName') !== BRAND.cliName
  ) {
    throw new Error(`Invalid CLI install receipt: ${version}`);
  }
  const revision: unknown = Reflect.get(value, 'packageRevision');
  return {
    packageRevision: typeof revision === 'string' ? revision : null,
  };
}

async function status(
  options: InstallOptions,
  comparePackage = false,
): Promise<CliPathStatus> {
  const paths = installPaths(options);
  await directories(paths.bin);
  await directories(paths.root, false, true);
  const stat = await statIfPresent(paths.launcher);
  const base = {
    symlinkPath: paths.launcher,
    symlinkTarget: null,
    bundledCliPath: options.bundledCliPath,
    managedPathEntry: paths.bin,
  };
  if (!stat) return { ...base, state: 'missing' };
  if (!stat.isSymbolicLink()) return { ...base, state: 'regular-file' };
  const target = await fs.readlink(paths.launcher);
  const managed =
    path.resolve(paths.bin, target) === paths.target
      ? await managedVersion(paths)
      : null;
  let revision: string | null = null;
  if (managed && comparePackage) {
    try {
      revision = await packageRevision(options.bundledCliPath);
    } catch {
      // A damaged or unavailable GUI package cannot invalidate the independent
      // installed CLI or prevent its removal. Explicit install stays strict.
    }
  }
  return {
    ...base,
    symlinkTarget: target,
    state: !managed
      ? 'foreign-symlink'
      : revision !== null && revision !== managed.packageRevision
        ? 'outdated'
        : 'correct-symlink',
  };
}

// Open the source without following links, and create a fresh destination. The
// whole tree is private and unpublished until every copy and validation succeeds.
async function copyTree(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (
    stat.isSymbolicLink() ||
    (!stat.isDirectory() && !stat.isFile()) ||
    (stat.mode & 0o7022) !== 0 ||
    (stat.isFile() && stat.nlink !== 1)
  ) {
    throw new Error(`Unsafe CLI distribution member: ${source}`);
  }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { mode: 0o755 });
    for (const entry of await fs.readdir(source)) {
      await copyTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  const input = await fs.open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await input.stat();
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino
    ) {
      throw new Error(`CLI distribution member changed during copy: ${source}`);
    }
    const output = await fs.open(destination, 'wx', stat.mode & 0o777);
    try {
      await output.chmod(stat.mode & 0o777);
      await pipeline(input.createReadStream(), output.createWriteStream());
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function requirePayload(directory: string): Promise<void> {
  const members = new Map(
    (await distributionMembers(directory)).map(({ name, source }) => [
      name,
      source,
    ]),
  );
  const executables = [BRAND.cliName, ...TOOLS, DAEMON];
  for (const name of [
    ...executables,
    ...DAEMON_FILES,
    'THIRD_PARTY_NOTICES.txt',
  ]) {
    const source = members.get(name);
    const stat = source ? await statIfPresent(source) : null;
    if (
      !stat ||
      !stat.isFile() ||
      stat.size === 0 ||
      (executables.includes(name) && (stat.mode & 0o111) === 0)
    ) {
      throw new Error(`Incomplete CLI distribution: ${name}`);
    }
  }
  for (const [directory, name] of [
    ['node-pty', 'package.json'],
    ['node-pty', 'build/Release/pty.node'],
    ...DAEMON_EXECUTION_HOST_ENTRIES.map((entry) => [DAEMON_HOSTS, entry]),
  ]) {
    const source = members.get(directory);
    const stat = source ? await statIfPresent(path.join(source, name)) : null;
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error(`Incomplete CLI distribution: ${directory}/${name}`);
    }
  }
  for (const name of CODE_GRAPH_RUNTIME_ROOTS) {
    if (!(await statIfPresent(path.join(directory, name)))?.isDirectory())
      throw new Error(`Incomplete CLI distribution: ${name}`);
    const files = await fs.readdir(path.join(directory, name), {
      recursive: true,
    });
    const extensions = name.endsWith('code-graph')
      ? ['.wasm', '.scm']
      : name.endsWith('web-tree-sitter')
        ? ['.wasm', '.js']
        : ['.js'];
    for (const extension of extensions) {
      const matches = files.filter((file) => file.endsWith(extension));
      if (matches.length === 0)
        throw new Error(`Incomplete CLI distribution: ${name} (${extension})`);
      for (const file of matches) {
        const stat = await fs.lstat(path.join(directory, name, file));
        if (!stat.isFile() || stat.size === 0)
          throw new Error(`Incomplete CLI resource: ${name}/${file}`);
      }
    }
    if (name.startsWith('node_modules/')) {
      const stat = await fs.lstat(path.join(directory, name, 'package.json'));
      if (!stat.isFile() || stat.size === 0)
        throw new Error(`Incomplete CLI module: ${name}`);
    }
  }
}

function failure(error: unknown): CliInstallResult {
  const message: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'message')
      : null;
  return {
    success: false,
    error:
      typeof message === 'string' && message.trim()
        ? message
        : 'CLI installation failed.',
  };
}

/** Linux-only host service; the existing IPC contract is unchanged. */
export function createLinuxCliInstaller(options: InstallOptions): {
  getStatus: () => Promise<CliPathStatus>;
  install: () => Promise<CliInstallResult>;
  uninstall: () => Promise<CliInstallResult>;
} {
  return {
    getStatus: (): Promise<CliPathStatus> => status(options, true),
    install: async (): Promise<CliInstallResult> => {
      let staging: string | null = null;
      let temporaryPointer: string | null = null;
      try {
        const paths = installPaths(options);
        const before = await status(options);
        if (before.state !== 'missing' && before.state !== 'correct-symlink') {
          throw new Error(
            `${paths.launcher} is already occupied and will not be overwritten.`,
          );
        }
        await directories(paths.root, true, true);
        await directories(paths.versions, true, true);
        await directories(paths.bin, true);
        // Validate any existing private pointer before replacing it, even when
        // the public launcher was manually removed.
        const previous = await managedVersion(paths);
        const pointerExists = await statIfPresent(paths.current);
        if (pointerExists && !previous)
          throw new Error('Incomplete managed CLI version.');
        staging = await fs.mkdtemp(path.join(paths.versions, '.staging-'));
        const source = path.dirname(
          absolutePath(options.bundledCliPath, 'Bundled CLI'),
        );
        const revision = await packageRevision(options.bundledCliPath);
        if (revision === null) throw new Error('Bundled CLI is missing.');
        for (const member of await distributionMembers(source)) {
          await copyTree(member.source, path.join(staging, member.name));
        }
        await requirePayload(staging);
        if ((await packageRevision(options.bundledCliPath)) !== revision) {
          throw new Error(
            'CLI package changed during installation. Try again.',
          );
        }
        await fs.writeFile(
          path.join(staging, RECEIPT),
          JSON.stringify({
            version: 1,
            cliName: BRAND.cliName,
            packageRevision: revision,
          }),
          { flag: 'wx', mode: 0o600 },
        );
        const id = randomUUID();
        await fs.rename(staging, path.join(paths.versions, id));
        staging = null;
        const newPointer = path.join(paths.root, `.current-${id}`);
        await fs.symlink(`versions/${id}`, newPointer);
        temporaryPointer = newPointer;
        await directories(paths.bin);
        const refreshed = await status(options);
        if (
          refreshed.state !== 'missing' &&
          refreshed.state !== 'correct-symlink'
        ) {
          throw new Error(
            `${paths.launcher} is already occupied and will not be overwritten.`,
          );
        }
        if (pointerExists) {
          await managedVersion(paths);
          await fs.rename(temporaryPointer, paths.current);
        } else {
          await fs.symlink(`versions/${id}`, paths.current);
          await fs.unlink(temporaryPointer);
        }
        temporaryPointer = null;
        // Never rename over the public command. Upgrades repoint only our
        // private pointer; exclusive symlink creation preserves racing entries.
        if (refreshed.state === 'missing')
          await fs.symlink(paths.target, paths.launcher);
        return { success: true, error: null };
      } catch (error) {
        return failure(error);
      } finally {
        // Cleanup must not replace the primary error or reject the IPC result.
        // A leftover staging directory is private and never executable via the
        // launcher; complete versions are intentionally retained separately.
        const cleanup: Promise<unknown>[] = [];
        if (staging)
          cleanup.push(fs.rm(staging, { recursive: true, force: true }));
        if (temporaryPointer) cleanup.push(fs.unlink(temporaryPointer));
        await Promise.allSettled(cleanup);
      }
    },
    uninstall: async (): Promise<CliInstallResult> => {
      try {
        const paths = installPaths(options);
        const current = await status(options);
        if (current.state === 'missing') return { success: true, error: null };
        if (current.state !== 'correct-symlink')
          throw new Error(
            `${paths.launcher} is not managed by ${BRAND.displayName}.`,
          );
        await fs.unlink(paths.launcher);
        // Deliberately retain ALL complete versions, including the current one.
        // A CLI, agent, or companion may still lazily load modules/WASM long
        // after its parent exits. Neither GUI lifecycle nor uninstall proves
        // quiescence; no process tracker or unsafe age-based GC belongs here.
        return { success: true, error: null };
      } catch (error) {
        return failure(error);
      }
    },
  };
}

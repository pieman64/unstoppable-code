import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BRAND } from '@canopy/brand/current';
import type {
  CliInstallResult,
  CliPathStatus,
} from '@canopy/desktop-shared/types';

const TOOLS = ['claude', 'codex', 'codex-code-mode-host', 'gh', 'rg', 'rtk'];
const RESOURCE_ROOTS = [
  'resources/code-graph',
  'node_modules/web-tree-sitter',
  'node_modules/typescript',
];
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

async function managedVersion(paths: InstallPaths): Promise<string | null> {
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
  return version;
}

async function status(options: InstallOptions): Promise<CliPathStatus> {
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
  const owned =
    path.resolve(paths.bin, target) === paths.target &&
    (await managedVersion(paths)) !== null;
  return {
    ...base,
    symlinkTarget: target,
    state: owned ? 'correct-symlink' : 'foreign-symlink',
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
  for (const name of [BRAND.cliName, ...TOOLS, 'THIRD_PARTY_NOTICES.txt']) {
    const stat = await fs.lstat(path.join(directory, name));
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      (name !== 'THIRD_PARTY_NOTICES.txt' && (stat.mode & 0o111) === 0)
    ) {
      throw new Error(`Incomplete CLI distribution: ${name}`);
    }
  }
  for (const name of RESOURCE_ROOTS) {
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
    getStatus: (): Promise<CliPathStatus> => status(options),
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
        await directories(source);
        for (const entry of await fs.readdir(source)) {
          if (entry === RECEIPT)
            throw new Error('Reserved CLI install receipt in source.');
          await copyTree(path.join(source, entry), path.join(staging, entry));
        }
        // Electron stages the SEA/modules/resources under resources/cli, but
        // tools under resources/bin and notices at the resources root. Compose
        // a standalone tree before publication: the installed CLI must resolve
        // tools beside itself rather than depend on a GUI installation.
        if (
          path.basename(source) === 'cli' &&
          path.basename(path.dirname(source)) === 'resources'
        ) {
          const resources = path.dirname(source);
          const members = [...TOOLS, 'THIRD_PARTY_NOTICES.txt'];
          const stagedPayload = staging;
          const existing = await Promise.all(
            members.map((member) =>
              statIfPresent(path.join(stagedPayload, member)),
            ),
          );
          // Accept a complete tree or the split package, never a mixture of
          // potentially different companion versions from both source roots.
          if (existing.some(Boolean) && !existing.every(Boolean)) {
            throw new Error('Incomplete in-place CLI distribution.');
          }
          if (!existing.every(Boolean)) {
            const bin = path.join(resources, 'bin');
            if (!(await directories(bin))) {
              throw new Error('Incomplete CLI distribution: companion tools.');
            }
            for (const tool of TOOLS) {
              await copyTree(path.join(bin, tool), path.join(staging, tool));
            }
            await copyTree(
              path.join(resources, 'THIRD_PARTY_NOTICES.txt'),
              path.join(staging, 'THIRD_PARTY_NOTICES.txt'),
            );
          }
        }
        await requirePayload(staging);
        await fs.writeFile(
          path.join(staging, RECEIPT),
          JSON.stringify({ version: 1, cliName: BRAND.cliName }),
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

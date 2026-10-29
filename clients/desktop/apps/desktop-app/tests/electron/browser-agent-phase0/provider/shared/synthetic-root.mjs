// Synthetic, disposable probe root. Every home, config, data and working
// directory a provider can observe lives here, never in the user's real home.
import { existsSync, realpathSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './constants.mjs';

const ROOT_PREFIX = 'canopy-browser-agent-probe-';

/**
 * Directory layout. All paths are absolute and resolved through realpath so
 * provider-reported paths (for example Codex `codexHome`) compare exactly.
 *
 * @typedef {object} SyntheticLayout
 * @property {string} root
 * @property {string} home        HOME for the probe child and every provider.
 * @property {string} codexHome   CODEX_HOME (= home/.codex, Codex's default).
 * @property {string} claudeHomeDir home/.claude (Claude's default user dir).
 * @property {string} claudeConfigDir CLAUDE_CONFIG_DIR (distinct from home/.claude).
 * @property {string} canopyDataDir CANOPY_DATA_DIR.
 * @property {string} tmp          TMPDIR.
 * @property {string} ancestor     A synthetic repository (contains `.git`).
 * @property {string} project      A project directory inside `ancestor`.
 * @property {string} epochs       Parent of per-epoch empty working dirs.
 * @property {string} records      Hook/notify invocation recorders write here.
 */

/**
 * Create a fresh synthetic root under the real OS temp directory.
 *
 * @param {string} label short label, e.g. `codex` or `claude`
 * @returns {Promise<SyntheticLayout & { cleanup: () => Promise<void>, newEpochDir: (name: string) => Promise<string> }>}
 */
export async function createSyntheticRoot(label) {
  if (!/^[a-z0-9-]{1,32}$/.test(label))
    throw new Error(`Invalid label ${label}`);
  const base = realpathSync.native(os.tmpdir());
  const root = realpathSync.native(
    await mkdtemp(path.join(base, `${ROOT_PREFIX}${label}-`)),
  );
  assertOutsideRepository(root);
  const layout = {
    root,
    home: path.join(root, 'home'),
    codexHome: path.join(root, 'home', '.codex'),
    claudeHomeDir: path.join(root, 'home', '.claude'),
    claudeConfigDir: path.join(root, 'claude-config'),
    canopyDataDir: path.join(root, 'canopy-data'),
    tmp: path.join(root, 'tmp'),
    ancestor: path.join(root, 'ancestor'),
    project: path.join(root, 'ancestor', 'project'),
    epochs: path.join(root, 'epochs'),
    records: path.join(root, 'records'),
  };
  for (const dir of Object.values(layout))
    await mkdir(dir, { recursive: true, mode: 0o700 });
  // The restricted Codex profile strips Git environment controls. A test-only
  // Git config in the synthetic canonical home prevents default marketplace
  // discovery from reaching HTTP(S), while retaining local fixture transport.
  await writeFile(
    path.join(layout.home, '.gitconfig'),
    '[protocol]\n    allow = never\n[protocol "file"]\n    allow = always\n',
    { mode: 0o600 },
  );
  // A synthetic repository marker so project/ancestor instruction discovery
  // has something to find; epoch directories are never inside it.
  await mkdir(path.join(layout.ancestor, '.git'), { recursive: true });
  await writeFile(
    path.join(layout.ancestor, '.git', 'HEAD'),
    'ref: refs/heads/main\n',
  );
  const usedEpochs = new Set();
  return {
    ...layout,
    /** Create a fresh, empty working directory for one context epoch. */
    async newEpochDir(name) {
      if (!/^[a-z0-9-]{1,48}$/.test(name) || usedEpochs.has(name))
        throw new Error(`Epoch dir name must be unique and simple: ${name}`);
      usedEpochs.add(name);
      const dir = path.join(layout.epochs, name);
      await mkdir(dir, { mode: 0o700 });
      assertOutsideRepository(dir);
      if ((await readdir(dir)).length !== 0)
        throw new Error(`Epoch dir not empty: ${dir}`);
      return dir;
    },
    cleanup: () => removeSyntheticRoot(root),
  };
}

/** Serializable layout for the child manifest. */
export function layoutManifest(layout) {
  const keys = [
    'root',
    'home',
    'codexHome',
    'claudeHomeDir',
    'claudeConfigDir',
    'canopyDataDir',
    'tmp',
    'ancestor',
    'project',
    'epochs',
    'records',
  ];
  return Object.fromEntries(keys.map((key) => [key, layout[key]]));
}

/** Rebuild the helpers for a layout read from a manifest (inside the child). */
export function attachLayoutHelpers(layout) {
  // The orchestrator creates the root in its OS temp directory, then gives
  // the child an owned TMPDIR inside that root. Preserve the parent cleanup
  // guard while validating this distinct, intentional child layout.
  const childTemp = realpathSync.native(os.tmpdir());
  const ownedTemp = path.join(path.resolve(layout.root), 'tmp');
  const base =
    childTemp === ownedTemp
      ? path.dirname(path.resolve(layout.root))
      : childTemp;
  assertSyntheticRoot(layout.root, base);
  if (layout.tmp !== ownedTemp)
    throw new Error('Synthetic TMPDIR must be root/tmp');
  for (const candidate of Object.values(layout)) {
    if (typeof candidate !== 'string' || !isInside(layout.root, candidate))
      throw new Error('Synthetic layout path escapes its root');
  }
  const usedEpochs = new Set();
  return {
    ...layout,
    async newEpochDir(name) {
      if (!/^[a-z0-9-]{1,48}$/.test(name) || usedEpochs.has(name))
        throw new Error(`Epoch dir name must be unique and simple: ${name}`);
      usedEpochs.add(name);
      const dir = path.join(layout.epochs, name);
      await mkdir(dir, { mode: 0o700 });
      assertOutsideRepository(dir);
      if ((await readdir(dir)).length !== 0)
        throw new Error(`Epoch dir not empty: ${dir}`);
      return dir;
    },
  };
}

/** Throw unless `dir` is a probe root directly under the OS temp directory. */
export function assertSyntheticRoot(
  dir,
  base = realpathSync.native(os.tmpdir()),
) {
  const resolved = path.resolve(dir);
  if (
    path.dirname(resolved) !== base ||
    !path.basename(resolved).startsWith(ROOT_PREFIX)
  )
    throw new Error(`Not a synthetic probe root: ${resolved}`);
}

/** True when `candidate` equals `root` or is inside it. */
export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Throw if `dir` is inside this repository or any directory with a `.git`
 * entry (a repository or worktree), walking every ancestor.
 */
export function assertOutsideRepository(dir) {
  const resolved = path.resolve(dir);
  if (isInside(REPO_ROOT, resolved))
    throw new Error(`Inside the Canopy repository: ${resolved}`);
  let current = resolved;
  while (true) {
    if (existsSync(path.join(current, '.git')))
      throw new Error(`Inside a repository or worktree: ${resolved}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function makeWritable(dir) {
  await chmod(dir, 0o700).catch(() => {});
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(
    () => [],
  )) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await makeWritable(target);
    else if (!entry.isSymbolicLink())
      await chmod(target, 0o600).catch(() => {});
  }
}

/** Remove a synthetic root. Refuses anything that is not one. */
export async function removeSyntheticRoot(root) {
  assertSyntheticRoot(root);
  if (!existsSync(root)) return;
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

/** List every file under a directory (relative paths), for rollout/state diffs. */
export async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(
      () => [],
    )) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else {
        const info = await stat(target).catch(() => null);
        out.push({
          path: path.relative(dir, target),
          bytes: info?.size ?? null,
        });
      }
    }
  }
  await walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

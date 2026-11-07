import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  movedOwnedPath,
  isWithin,
  RelocationRefusedError,
  type RelocationTransition,
} from './transition';

import {
  assertRelocationWorkingRoot,
  relocationWorkingPath,
} from './working-root';

/** Worker-host Git execution; the offline core never launches a process. */
export type RelocationGit = (
  cwd: string,
  args: readonly string[],
) => Promise<string>;
export interface RelocationGitCheckout {
  readonly path: string;
  readonly commonDirectory: string;
  readonly head: string;
  readonly branch: string;
  readonly status: string;
}
export interface RelocationBacklink {
  readonly path: string;
  readonly contents: string;
}
export interface RelocationGitPlan {
  readonly checkouts: readonly RelocationGitCheckout[];
  /** Individual-file preimages for B's journal or optional backups; never whole trees. */
  readonly backlinks: readonly RelocationBacklink[];
}

async function observe(
  git: RelocationGit,
  path: string,
): Promise<RelocationGitCheckout> {
  let entry: string[] | undefined;
  for (const record of (
    await git(path, ['worktree', 'list', '--porcelain', '-z'])
  ).split('\0\0')) {
    const fields = record.split('\0');
    const listed = fields
      .find((field) => field.startsWith('worktree '))
      ?.slice(9);
    if (
      listed &&
      (sep === '\\' ? (await realpath(listed)) === path : listed === path)
    )
      entry = fields;
  }
  const head = entry?.find((field) => field.startsWith('HEAD '))?.slice(5);
  const branch = entry?.includes('detached')
    ? 'HEAD'
    : entry?.find((field) => field.startsWith('branch '))?.slice(7);
  // The listing represents unborn HEAD with a zero OID; rev-parse HEAD refuses it.
  if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || !branch)
    throw new RelocationRefusedError('unreadable-git-checkout');
  return {
    path,
    commonDirectory: await canonicalGitPath(
      (
        await git(path, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).replace(/\r?\n$/, ''),
    ),
    head,
    branch,
    status: await git(path, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]),
  };
}

/** Run before copying, under B's cold-maintenance proof. No file is changed. */
export async function prepareRelocationGit(
  git: RelocationGit,
  paths: readonly string[],
  options: { readonly portableFilesystem?: boolean } = {},
): Promise<RelocationGitPlan> {
  const checkouts: RelocationGitCheckout[] = [];
  const backlinks = new Map<string, string>();
  for (const path of new Set(paths)) {
    if ((await realpath(path)) !== path)
      throw new RelocationRefusedError('symlink-checkout');
    const checkout = await observe(git, path);
    if ((await realpath(checkout.commonDirectory)) !== checkout.commonDirectory)
      throw new RelocationRefusedError('symlink-common-directory');
    if (options.portableFilesystem) {
      const configuration = await git(path, ['config', '--null', '--list']);
      if (
        configuration
          .split('\0')
          .some((record) =>
            ['core.worktree', 'extensions.worktreeconfig'].includes(
              record.split('\n')[0]?.toLowerCase() ?? '',
            ),
          )
      )
        throw new RelocationRefusedError('unsupported-git-worktree-config');
      for (const unsupported of [
        join(path, '.gitmodules'),
        join(checkout.commonDirectory, 'modules'),
        join(checkout.commonDirectory, 'config.worktree'),
        join(checkout.commonDirectory, 'objects', 'info', 'alternates'),
      ]) {
        if (await present(unsupported))
          throw new RelocationRefusedError('unsupported-git-layout');
      }
    }
    if (
      options.portableFilesystem &&
      (await git(path, ['ls-files', '--stage', '-z']))
        .split('\0')
        .some((entry) => entry.startsWith('160000 '))
    )
      throw new RelocationRefusedError('unsupported-git-submodule');
    checkouts.push(checkout);
    const dotGit = join(path, '.git');
    const dotGitState = await lstat(dotGit);
    if (dotGitState.isSymbolicLink())
      throw new RelocationRefusedError('symlink-git-directory');
    if (dotGitState.isFile()) {
      backlinks.set(dotGit, await readFile(dotGit, 'utf8'));
      const gitDir = await canonicalGitPath(
        (await git(path, ['rev-parse', '--absolute-git-dir'])).replace(
          /\r?\n$/,
          '',
        ),
      );
      if (options.portableFilesystem && gitDir === checkout.commonDirectory)
        throw new RelocationRefusedError('unsupported-separate-git-directory');
      if ((await realpath(gitDir)) !== gitDir)
        throw new RelocationRefusedError('symlink-git-directory');
      if (
        options.portableFilesystem &&
        (await present(join(gitDir, 'config.worktree')))
      )
        throw new RelocationRefusedError('unsupported-git-worktree-config');
      for (const file of ['gitdir', 'commondir']) {
        const target = join(gitDir, file);
        if (
          !(await lstat(target)).isFile() ||
          (await realpath(target)) !== target
        )
          throw new RelocationRefusedError('symlink-backlink');
        backlinks.set(target, await readFile(target, 'utf8'));
      }
    }
  }
  // Every linked checkout must be inventoried, including ones outside the root.
  for (const common of new Set(checkouts.map((row) => row.commonDirectory))) {
    const checkout = checkouts.find((row) => row.commonDirectory === common);
    if (!checkout) throw new RelocationRefusedError('missing-git-checkout');
    const listed = await git(checkout.path, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ]);
    const represented = new Set(checkouts.map((row) => row.path));
    for (const record of listed.split('\0\0')) {
      const fields = record.split('\0');
      if (fields.includes('bare')) continue;
      for (const field of fields) {
        if (
          field.startsWith('worktree ') &&
          !represented.has(
            sep === '\\' ? await realpath(field.slice(9)) : field.slice(9),
          )
        )
          throw new RelocationRefusedError('uninventoried-git-checkout');
      }
    }
  }
  return {
    checkouts,
    backlinks: [...backlinks].map(([path, contents]) => ({ path, contents })),
  };
}

/** A failed write leaves a complete preimage; a failed publish is safe to resume. */
async function replaceBacklink(image: RelocationBacklink): Promise<void> {
  const temp = join(
    dirname(image.path),
    `.${basename(image.path)}.relocation-${randomUUID()}.tmp`,
  );
  // CopyFile preserves Windows attributes (notably Git's hidden .git files).
  // CREATE_ALWAYS cannot overwrite hidden files; update only the private temp.
  const windows = sep === '\\';
  let temporaryOwned = false;
  try {
    if (windows) {
      await copyFile(image.path, temp, constants.COPYFILE_EXCL);
      temporaryOwned = true;
    }
    const handle = await open(
      temp,
      windows ? 'r+' : 'wx',
      (await lstat(image.path)).mode & 0o777,
    );
    temporaryOwned = true;
    try {
      await writeFile(handle, image.contents);
      if (windows) await handle.truncate(Buffer.byteLength(image.contents));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, image.path);
  } finally {
    if (temporaryOwned) await rm(temp, { force: true });
  }
}

/** Repair only inventoried backlink files; Git repair would persist staging paths. */
export async function repairRelocationGit(
  transition: RelocationTransition,
  plan: RelocationGitPlan,
  workingRoot: string,
): Promise<void> {
  await assertRelocationWorkingRoot(transition, workingRoot);
  const writes: RelocationBacklink[] = [];
  const expected: RelocationBacklink[] = [];
  for (const image of plan.backlinks) {
    const isCheckout = plan.checkouts.some(
      (row) => join(row.path, '.git') === image.path,
    );
    const name = basename(image.path);
    if (!isCheckout && name !== 'gitdir' && name !== 'commondir')
      throw new RelocationRefusedError('unrecognized-git-backlink');
    const prefix = isCheckout ? 'gitdir: ' : '';
    if (!image.contents.startsWith(prefix))
      throw new RelocationRefusedError('unreadable-git-backlink');
    const text = image.contents.slice(prefix.length).replace(/\r?\n$/, '');
    if (!text || text.includes('\0'))
      throw new RelocationRefusedError('unreadable-git-backlink');
    const resolvedTarget = resolveGitBacklink(dirname(image.path), text);
    const target =
      sep === '\\' ? await canonicalGitPath(resolvedTarget) : resolvedTarget;
    if (
      (name === 'gitdir' &&
        !isCheckout &&
        !plan.checkouts.some((row) => join(row.path, '.git') === target)) ||
      (name === 'commondir' &&
        !plan.checkouts.some((row) => row.commonDirectory === target))
    )
      throw new RelocationRefusedError('unproven-git-backlink');
    const finalPath = movedOwnedPath(transition, image.path);
    const finalTarget = movedOwnedPath(transition, target);
    const contents =
      finalPath === image.path && finalTarget === target
        ? image.contents
        : `${prefix}${gitBacklinkText(dirname(finalPath), finalTarget, isAbsolute(text))}\n`;
    const path = relocationWorkingPath(transition, workingRoot, finalPath);
    if (!(await lstat(path)).isFile() || (await realpath(path)) !== path)
      throw new RelocationRefusedError('symlink-backlink');
    const current = await readFile(path, 'utf8');
    if (current !== image.contents && current !== contents)
      throw new RelocationRefusedError('git-backlink-changed');
    expected.push({ path, contents });
    if (current !== contents) {
      if (isWithin(transition.from.canonicalDataRoot, path))
        throw new RelocationRefusedError('source-git-backlink');
      writes.push({ path, contents });
    }
  }
  for (const image of writes) await replaceBacklink(image);
  for (const image of expected) {
    if ((await readFile(image.path, 'utf8')) !== image.contents)
      throw new RelocationRefusedError('git-verification-failed');
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    throw error;
  }
}

function resolveGitBacklink(parent: string, text: string): string {
  // Drive-relative and device namespace names are not Git-owned path evidence.
  if (sep === '\\' && (/^[A-Za-z]:(?![\\/])/.test(text) || /^[\\/]/.test(text)))
    throw new RelocationRefusedError('noncanonical-git-backlink');
  return resolve(parent, text);
}

/** Git accepts an absolute cross-drive target when relative() cannot express it. */
export function gitBacklinkText(
  parent: string,
  target: string,
  absolute: boolean,
): string {
  const value = absolute ? target : relative(parent, target);
  return sep === '\\' ? value.replace(/\\/g, '/') : value;
}

async function canonicalGitPath(path: string): Promise<string> {
  if (sep !== '\\') return path;
  const canonical = await realpath(path);
  if (relative(resolve(path), canonical) !== '')
    throw new RelocationRefusedError('symlink-git-directory');
  return canonical;
}

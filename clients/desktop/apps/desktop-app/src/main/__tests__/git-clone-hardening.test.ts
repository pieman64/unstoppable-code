import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cloneRepoWithProgress } from '../lib/git';

/**
 * A clone of an organization project is the first moment repository-controlled
 * content gets a say on the member's machine. These cover what it is allowed to
 * do there: populate a working tree, and nothing else.
 *
 * These drive the real `git` binary against real repositories on disk, which is
 * the only way to show that a filter driver or a hook did not run. `git.test.ts`
 * mocks `node:child_process` and `node:fs/promises` wholesale, so they cannot
 * live there; the suite is already split by concern the same way
 * (`git-tree-snapshot`, `git-executable`, `git-default-branch`).
 */
let root: string;
let origin: string;
let destination: string;
let previousGlobalConfig: string | undefined;

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  });
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    (): boolean => true,
    (): boolean => false,
  );

beforeEach(async (): Promise<void> => {
  previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  root = await mkdtemp(join(tmpdir(), 'clone-hardening-'));
  origin = join(root, 'repo.git');
  destination = join(root, 'checkout');
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, 'seed']);
  await writeFile(join(root, 'seed', 'README.md'), 'fixture');
  git(join(root, 'seed'), ['add', '.']);
  git(join(root, 'seed'), ['commit', '-m', 'initial']);
  git(join(root, 'seed'), ['push', 'origin', 'main']);
});

afterEach(async (): Promise<void> => {
  if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
  await rm(root, { recursive: true, force: true });
});

async function clone(): Promise<void> {
  await cloneRepoWithProgress(origin, destination, {
    nonInteractive: true,
    onProgress: (): void => {},
  });
}

/** Commits `content` at `path` in the fixture repository. */
async function commit(path: string, content: string): Promise<void> {
  await mkdir(join(root, 'seed', join(path, '..')), { recursive: true });
  await writeFile(join(root, 'seed', path), content, { mode: 0o755 });
  git(join(root, 'seed'), ['add', '.']);
  git(join(root, 'seed'), ['commit', '-m', `add ${path}`]);
  git(join(root, 'seed'), ['push', 'origin', 'main']);
}

it('populates the working tree', async (): Promise<void> => {
  await clone();
  expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe(
    'fixture',
  );
});

it('restores a non-UTF-8 attributes file byte for byte', async (): Promise<void> => {
  // Attributes files are not required to be UTF-8, and a round trip through a
  // string would rewrite the bytes the user's template put there.
  const bytes = Buffer.from([0x2a, 0x20, 0x74, 0x65, 0x78, 0x74, 0xff, 0x0a]);
  const template = join(root, 'git-template', 'info');
  await mkdir(template, { recursive: true });
  await writeFile(join(template, 'attributes'), bytes);
  const config = join(root, 'global-git-config');
  await writeFile(
    config,
    `[init]\n\ttemplateDir = ${join(root, 'git-template')}\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  await clone();
  expect(
    await readFile(join(destination, '.git', 'info', 'attributes')),
  ).toEqual(bytes);
});

it('refuses a clone whose default branch no longer exists', async (): Promise<void> => {
  // A remote HEAD pointing at a deleted or renamed branch resolves no HEAD in
  // the clone. Taking the empty-repository path there would leave an empty
  // working tree that looks like a successful setup.
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/gone']);
  await expect(clone()).rejects.toThrow('no usable default branch');
});

it('accepts a genuinely empty repository', async (): Promise<void> => {
  const empty = join(root, 'empty.git');
  git(root, ['init', '--bare', '-b', 'main', empty]);
  await cloneRepoWithProgress(empty, join(root, 'empty-checkout'), {
    nonInteractive: true,
    onProgress: (): void => {},
  });
  expect(await exists(join(root, 'empty-checkout', '.git'))).toBe(true);
});

it('does not run a filter driver the repository asks for', async (): Promise<void> => {
  // A committed `.gitattributes` can name any driver the user happens to have
  // configured globally, and checkout is where it would run — before anything
  // has looked at this repository.
  const config = join(root, 'global-git-config');
  await writeFile(
    config,
    '[filter "boom"]\n\tsmudge = sed s/fixture/pwned/\n\tclean = cat\n',
  );
  await commit('.gitattributes', '* filter=boom\n');
  process.env.GIT_CONFIG_GLOBAL = config;
  await clone();
  expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe(
    'fixture',
  );
});

it('does not run a hook the repository ships', async (): Promise<void> => {
  // A global *relative* `core.hooksPath` resolves inside the new checkout, so a
  // committed `post-checkout` would run there.
  const marker = join(root, 'HOOK_RAN');
  const config = join(root, 'global-git-config');
  await writeFile(config, '[core]\n\thooksPath = .githooks\n');
  await commit('.githooks/post-checkout', `#!/bin/sh\ntouch ${marker}\n`);
  process.env.GIT_CONFIG_GLOBAL = config;
  await clone();
  expect(await exists(marker)).toBe(false);
});

it('leaves no attributes file behind when the clone had none', async (): Promise<void> => {
  // The safety rule is for this checkout only. Leaving it would disable LFS,
  // diff and merge drivers for every later operation in the user's repository.
  await clone();
  expect(await exists(join(destination, '.git', 'info', 'attributes'))).toBe(
    false,
  );
});

it('puts back attributes the clone arrived with', async (): Promise<void> => {
  // `init.templateDir` seeds `.git/info/attributes` at clone time. That file is
  // the user's, not ours.
  const template = join(root, 'git-template', 'info');
  await mkdir(template, { recursive: true });
  await writeFile(join(template, 'attributes'), '*.bin binary\n');
  const config = join(root, 'global-git-config');
  await writeFile(
    config,
    `[init]\n\ttemplateDir = ${join(root, 'git-template')}\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  await clone();
  expect(
    await readFile(join(destination, '.git', 'info', 'attributes'), 'utf8'),
  ).toBe('*.bin binary\n');
});

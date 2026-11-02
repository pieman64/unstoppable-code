import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeData } from '@canopy/desktop-shared/types';

let incarnation = Date.now();
/** Canonical files and a real source repository shared by W5 boundary suites. */
export function createW5BoundaryFixture(
  worktrees: (createdAt: string) => readonly WorktreeData[] = () => [],
  additionalWorkspaceIds: readonly string[] = [],
): { dir: string; root: string; repo: string } {
  const createdAt = new Date(incarnation++).toISOString();
  // Git reports canonical paths, including /private/var for macOS temp folders.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5-boundaries-')));
  const root = join(dir, 'data', 'workspaces');
  const repo = join(dir, 'repo');
  mkdirSync(join(root, 'a'), { recursive: true });
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  ]);
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: ['a', ...additionalWorkspaceIds].map((id, order) => ({
        id,
        name: id === 'a' ? 'Original' : id,
        type: 'single-repo',
        color: '#7C3AED',
        collapsed: false,
        order,
      })),
    }),
  );
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: repo,
      repos: [],
      itemSortMode: 'manual',
    }),
  );
  writeFileSync(
    join(root, 'a', 'worktrees.json'),
    JSON.stringify({ version: 1, worktrees: worktrees(createdAt) }),
  );
  for (const id of additionalWorkspaceIds) {
    mkdirSync(join(root, id));
    writeFileSync(
      join(root, id, 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: repo,
        repos: [],
        sentinel: 'untouched',
      }),
    );
    writeFileSync(
      join(root, id, 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: [], sentinel: 'untouched' }),
    );
  }
  return { dir, root, repo };
}

// Located by its source text, so edits elsewhere in the store keep the hook.
// The core store reads through desktop's late-bound nodeW5FileStore.read.
const PREFLIGHT_READ_LINE =
  readFileSync(
    require.resolve('@canopy/core-runtime/node/w5/commit-log-file-store'),
    'utf8',
  )
    .split('\n')
    .findIndex((line) => line.includes('await readFile(file.path)')) + 1;
// Either separator: Windows stacks use backslashes.
const PREFLIGHT_READ_FRAME = new RegExp(
  `[\\\\/]w5[\\\\/]commit-log-file-store\\.ts:${PREFLIGHT_READ_LINE}:`,
);

/** Whether `stack` is the commit queue's final fingerprint preflight read. */
export function isW5FinalPreflightRead(stack: string): boolean {
  if (PREFLIGHT_READ_LINE === 0)
    throw new Error('The W5 final preflight read moved');
  return PREFLIGHT_READ_FRAME.test(stack);
}

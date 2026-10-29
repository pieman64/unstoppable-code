import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { seedLargeArchiveRepository } from '../seeders/largeArchiveFixture.mjs';
import { removeRepositoryGitEnv } from '../../../../../scripts/lib/git-repository-env.mjs';

// Git fixtures below must not reach the caller's repository when run from a hook.
removeRepositoryGitEnv();

test('large archive fixture preserves LF bytes even with Windows Git line-ending defaults', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'archive-git-defaults-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Archive fixture');
    git('config', 'user.email', 'archive@example.invalid');
    git('config', 'core.autocrlf', 'true');
    let seeded;
    try {
      seeded = seedLargeArchiveRepository(repo);
    } catch (error) {
      assert.fail(`Fixture Git command failed: ${error.code}`);
    }
    assert.ok(seeded.attributeBytes > 8 * 1024 * 1024);
    git('checkout-index', '--force', '--all');
    assert.equal(
      readFileSync(path.join(repo, seeded.paths[0]), 'utf8'),
      'retained content\n',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10 });
  }
});

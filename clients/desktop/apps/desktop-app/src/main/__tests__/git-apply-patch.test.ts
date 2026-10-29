import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.unmock('../lib/git');

import { applyPatch3Way } from '../lib/git';

function runGit(repoPath: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
  });
}

function createRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'canopy-git-apply-'));
  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.name', 'Canopy Test']);
  runGit(repoPath, ['config', 'user.email', 'canopy@example.com']);
  runGit(repoPath, ['config', 'commit.gpgsign', 'false']);
  return repoPath;
}

function commitFile(repoPath: string, content: string, message: string): void {
  writeFileSync(join(repoPath, 'file.txt'), content, 'utf8');
  runGit(repoPath, ['add', 'file.txt']);
  runGit(repoPath, ['commit', '-m', message]);
}

describe('applyPatch3Way', () => {
  let repoPath = '';

  afterEach((): void => {
    if (repoPath) {
      rmSync(repoPath, { recursive: true, force: true });
      repoPath = '';
    }
  });

  it('applies a clean patch from stdin', async (): Promise<void> => {
    repoPath = createRepo();
    commitFile(repoPath, 'one\ntwo\nthree\n', 'initial');

    writeFileSync(join(repoPath, 'file.txt'), 'one\nchanged\nthree\n', 'utf8');
    const patchText = runGit(repoPath, ['diff', '--binary', 'HEAD']);
    runGit(repoPath, ['reset', '--hard', 'HEAD']);

    await expect(applyPatch3Way(repoPath, patchText)).resolves.toEqual({
      appliedWithConflicts: false,
    });

    expect(readFileSync(join(repoPath, 'file.txt'), 'utf8')).toBe(
      'one\nchanged\nthree\n',
    );
  });

  it('uses a three-way merge when the base file has drifted', async (): Promise<void> => {
    repoPath = createRepo();
    const baseContent = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\n';
    commitFile(repoPath, baseContent, 'initial');

    writeFileSync(
      join(repoPath, 'file.txt'),
      'alpha\nbravo\ncharlie\nDELTA\necho\nfoxtrot\ngolf\n',
      'utf8',
    );
    const patchText = runGit(repoPath, ['diff', '--binary', 'HEAD']);
    runGit(repoPath, ['reset', '--hard', 'HEAD']);

    commitFile(
      repoPath,
      'ALPHA\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\n',
      'drift base',
    );
    expect((): string =>
      runGit(repoPath, ['apply', '--check'], patchText),
    ).toThrow();

    await applyPatch3Way(repoPath, patchText);

    expect(readFileSync(join(repoPath, 'file.txt'), 'utf8')).toBe(
      'ALPHA\nbravo\ncharlie\nDELTA\necho\nfoxtrot\ngolf\n',
    );
  });

  it('surfaces git stderr when applying the patch fails', async (): Promise<void> => {
    repoPath = createRepo();

    await expect(
      applyPatch3Way(repoPath, 'this is not a patch\n'),
    ).rejects.toThrow('No valid patches in input');
  });

  it('reports a conflicted three-way merge instead of throwing', async (): Promise<void> => {
    repoPath = createRepo();
    commitFile(repoPath, 'one\ntwo\nthree\n', 'initial');

    writeFileSync(join(repoPath, 'file.txt'), 'one\nOURS\nthree\n', 'utf8');
    const patchText = runGit(repoPath, ['diff', '--binary', 'HEAD']);
    runGit(repoPath, ['reset', '--hard', 'HEAD']);

    // Diverge the same line so the three-way merge must conflict.
    commitFile(repoPath, 'one\nTHEIRS\nthree\n', 'conflicting base');

    await expect(applyPatch3Way(repoPath, patchText)).resolves.toEqual({
      appliedWithConflicts: true,
    });
    expect(readFileSync(join(repoPath, 'file.txt'), 'utf8')).toContain(
      '<<<<<<<',
    );
  });

  it('treats an empty patch as a successful no-op', async (): Promise<void> => {
    await expect(
      applyPatch3Way('/path/that/does/not/exist', ''),
    ).resolves.toEqual({ appliedWithConflicts: false });
  });
});

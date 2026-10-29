import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// A local checkout stays behind its origin; advancing the producer after the
// composer loads proves creation fetches again rather than reusing picker data.
export function seedStaleWorktreeBase(userDataDir, repoPath) {
  const git = (cwd, args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const branchName = git(repoPath, ['branch', '--show-current']);
  const localHead = git(repoPath, ['rev-parse', 'HEAD']);
  const remotePath = path.join(userDataDir, 'base-origin.git');
  const producerPath = path.join(userDataDir, 'base-producer');
  git(userDataDir, ['clone', '--bare', repoPath, remotePath]);
  git(repoPath, ['remote', 'add', 'origin', remotePath]);
  git(userDataDir, ['clone', remotePath, producerPath]);
  git(producerPath, ['config', 'user.email', 'test@example.com']);
  git(producerPath, ['config', 'user.name', 'Canopy Test']);
  let generation = 0;
  const advanceRemote = () => {
    generation += 1;
    writeFileSync(
      path.join(producerPath, 'remote-base-marker.txt'),
      `remote generation ${generation}\n`,
    );
    git(producerPath, ['add', 'remote-base-marker.txt']);
    git(producerPath, ['commit', '-m', `Advance remote base ${generation}`]);
    git(producerPath, ['push', 'origin', branchName]);
    return git(producerPath, ['rev-parse', 'HEAD']);
  };
  const initialRemoteHead = advanceRemote();
  git(repoPath, ['fetch', 'origin']);
  return { branchName, localHead, initialRemoteHead, advanceRemote };
}

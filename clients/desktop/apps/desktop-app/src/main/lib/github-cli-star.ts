import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type {
  GitHubCliStarOutcome,
  GitHubRepositoryTarget,
} from '@canopy/core-runtime/node/github';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  getBundledGhBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';

// The star runs as the bundled `gh`'s own account and reads no Canopy
// credential, so it lives outside `github-auth`: core GitHub adapters may
// import it without crossing the credential boundary.

const execFileAsync = promisify(execFile);

const GH_NOT_AUTHENTICATED =
  /not logged in|gh auth login|authentication|HTTP 401/i;

function execFailureStderr(err: unknown): string {
  if (err instanceof Error && 'stderr' in err) {
    const { stderr } = err;
    if (typeof stderr === 'string' && stderr.trim() !== '')
      return stderr.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Stars `owner/repo` on github.com with the bundled `gh`'s own account. One
 * exec: its exit status and stderr classify a missing or signed-out CLI.
 * `--hostname` and a non-repository cwd keep a `GH_HOST` or a checkout's
 * remote from redirecting the request. Never throws.
 */
export async function starGitHubRepositoryWithCli(
  { owner, repo }: GitHubRepositoryTarget,
  { signal }: { readonly signal: AbortSignal },
): Promise<GitHubCliStarOutcome> {
  try {
    await execFileAsync(
      getBundledGhBinaryPath(),
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'PUT',
        `/user/starred/${owner}/${repo}`,
      ],
      {
        timeout: 10_000,
        signal,
        cwd: tmpdir(),
        env: getEnhancedEnv({
          includeCanopySecrets: false,
          environment: false,
        }),
        windowsHide: hostOperatingSystem() === 'win32',
      },
    );
    return { kind: 'starred' };
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT')
      return { kind: 'not-installed' };
    const detail = execFailureStderr(err);
    if (GH_NOT_AUTHENTICATED.test(detail)) return { kind: 'not-authenticated' };
    return { kind: 'failed', detail };
  }
}

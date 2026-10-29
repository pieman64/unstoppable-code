import type { GitHubAuthFailureCode } from '@canopy/desktop-shared/types/github';
import { isGitHubBrokerError } from './github-broker/errors';

/**
 * Evidence that a push, fetch or clone did not authenticate to GitHub. The
 * name ends in `Error` so the renderer can recognise it across IPC.
 */
export class GitHubAuthFailureError extends Error {
  readonly cause: Error;
  constructor(error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    super(cause.message);
    this.cause = cause;
    this.name = 'GitHubAuthFailureError';
  }
}

export function githubAuthFailureCode(
  error: unknown,
): GitHubAuthFailureCode | undefined {
  if (
    error instanceof GitHubAuthFailureError ||
    (isGitHubBrokerError(error) && error.code === 'not_authenticated')
  ) {
    return 'github_not_authenticated';
  }
  return undefined;
}

function isHttpsGitHubUrl(url: string): boolean {
  try {
    const remote = new URL(url);
    return (
      remote.protocol === 'https:' &&
      remote.hostname === 'github.com' &&
      !remote.port
    );
  } catch {
    return false;
  }
}

/**
 * Credential failures on HTTPS github.com for push, fetch or clone. Credential
 * failures alone are eligible; permission and transport errors are not. A
 * failure that names another remote, such as a manifest repository cloned
 * after a GitHub source, is not GitHub's.
 */
export function classifyGitHubAuthFailure(
  remoteUrl: string | null,
  error: unknown,
): GitHubAuthFailureCode | undefined {
  if (!remoteUrl || !isHttpsGitHubUrl(remoteUrl)) return undefined;
  const message = error instanceof Error ? error.message : '';
  const stderr =
    error !== null &&
    typeof error === 'object' &&
    'stderr' in error &&
    typeof error.stderr === 'string'
      ? error.stderr
      : '';
  const text = `${message}\n${stderr}`;
  const namedRemote = /\bfor '(https?:\/\/[^']+)'/i.exec(text)?.[1];
  if (namedRemote !== undefined && !isHttpsGitHubUrl(namedRemote))
    return undefined;
  if (
    /could not read (?:Username|Password)|authentication failed|invalid username(?: (?:or|and) |\/)(?:password|token)/i.test(
      text,
    )
  ) {
    return 'github_not_authenticated';
  }
  return undefined;
}

import { isValidAuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import {
  classifyGitHubIntegrationAuthFailure,
  GITHUB_INTEGRATION_DEPENDENCY_ID,
  type GitHubIntegrationAuthFailureInput,
} from '../integration-auth-classifier';

function input(
  overrides: Partial<GitHubIntegrationAuthFailureInput> = {},
): GitHubIntegrationAuthFailureInput {
  return {
    code: 'not_authenticated',
    diagnostic:
      'No GitHub token is available. Configure a PAT or sign in with the GitHub CLI.',
    ...overrides,
  };
}

describe('classifyGitHubIntegrationAuthFailure', () => {
  it('maps not_authenticated to an integration failure with a github_login recovery', () => {
    const out = classifyGitHubIntegrationAuthFailure(input());
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.dependencyClass).toBe('integration');
    expect(out.dependencyId).toBe(GITHUB_INTEGRATION_DEPENDENCY_ID);
    expect(out.displayName).toBe('GitHub');
    expect(out.recovery).toEqual({ kind: 'github_login' });
    expect(isValidAuthDependencyFailure(out)).toBe(true);
  });

  it('reports unauthenticated, not expired: the broker cannot tell them apart', () => {
    const out = classifyGitHubIntegrationAuthFailure(input());
    expect(out?.failureClass).toBe('unauthenticated');
  });

  // The broker only reports `not_authenticated` AFTER it has invalidated its
  // token cache and re-resolved the credential, so every other code is either
  // retriable or about a different problem. Emitting a reconnect prompt for one
  // of them would tell the user to fix something that is not broken.
  it.each([
    'credential_reset',
    'github_unavailable',
    'rate_limited',
    'network',
    'server_error',
    'timeout',
    'not_found_or_inaccessible',
    'permission_denied',
    'already_terminal',
    'capacity_exceeded',
    'invalid_input',
    'internal_error',
  ])('declines %s', (code) => {
    expect(classifyGitHubIntegrationAuthFailure(input({ code }))).toBeNull();
  });

  it('redacts credential material out of the diagnostic it carries', () => {
    const out = classifyGitHubIntegrationAuthFailure(
      input({
        diagnostic:
          'GitHub rejected token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for this request.',
      }),
    );
    expect(out?.detail).toBeDefined();
    expect(out?.detail).not.toContain(
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
  });
});

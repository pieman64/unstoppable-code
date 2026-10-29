import { isValidAuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import { toAuthDependencyFailure } from '../auth-recovery-projection';
import type { AgentFailureClassification } from '../../types/agent-failures';

function classification(
  kind: AgentFailureClassification['kind'],
): AgentFailureClassification {
  return {
    kind,
    code: 'authentication_failed',
    provider: 'claude',
    account_scope: 'native',
    diagnostic_message: 'You are not signed in to Claude.',
  };
}

describe('toAuthDependencyFailure', () => {
  it('maps provider_authentication_required to a recoverable class with a terminal action', () => {
    const out = toAuthDependencyFailure(
      classification('provider_authentication_required'),
    );
    expect(out.dependencyClass).toBe('provider');
    expect(out.dependencyId).toBe('claude');
    expect(out.displayName).toBe('Claude');
    expect(out.failureClass).toBe('unauthenticated');
    expect(out.recovery).toEqual({
      kind: 'provider_terminal',
      provider: 'claude',
    });
  });

  it('maps provider_usage_limit to quota_exceeded with NO recovery action', () => {
    const out = toAuthDependencyFailure(classification('provider_usage_limit'));
    expect(out.failureClass).toBe('quota_exceeded');
    expect(out.recovery).toEqual({ kind: 'none' });
  });

  it('maps provider_temporarily_unavailable to provider_outage with NO recovery action', () => {
    const out = toAuthDependencyFailure(
      classification('provider_temporarily_unavailable'),
    );
    expect(out.failureClass).toBe('provider_outage');
    expect(out.recovery).toEqual({ kind: 'none' });
  });

  it('redacts the diagnostic message', () => {
    const raw = classification('provider_authentication_required');
    const out = toAuthDependencyFailure({
      ...raw,
      diagnostic_message: 'rejected Bearer sk-supersecrettoken',
    });
    expect(out.detail).not.toContain('sk-supersecrettoken');
  });

  it('redacts the full declared secret vocabulary, not a subset', () => {
    // `detail` reaches the transcript and the web Portal, so it must go
    // through `redactSecrets` — the repo's declared single source of truth —
    // rather than a parallel regex list (CAN-1814 review).
    const raw = classification('provider_authentication_required');
    const out = toAuthDependencyFailure({
      ...raw,
      diagnostic_message:
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c pat github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345 aws AKIAIOSFODNN7EXAMPLE',
    });
    expect(out.detail).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out.detail).not.toContain('github_pat_11ABCDEFG0');
    expect(out.detail).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('produces a failure that satisfies the protocol invariant for every kind', () => {
    const kinds: AgentFailureClassification['kind'][] = [
      'provider_authentication_required',
      'provider_usage_limit',
      'provider_temporarily_unavailable',
    ];
    for (const kind of kinds) {
      const out = toAuthDependencyFailure(classification(kind));
      expect(isValidAuthDependencyFailure(out)).toBe(true);
    }
  });
});

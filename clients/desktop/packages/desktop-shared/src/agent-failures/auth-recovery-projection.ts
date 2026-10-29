import type {
  AuthDependencyFailure,
  AuthFailureClass,
  AuthRecoveryMethod,
} from '@canopy/protocol/auth-recovery';
import { toAuthDiagnosticDetail } from './auth-diagnostic-detail';
import type { AgentFailureClassification } from '../types/agent-failures';

function providerDisplayName(
  provider: AgentFailureClassification['provider'],
): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return provider;
}

/**
 * Project the desktop-only provider failure classification onto the
 * browser-safe wire model carried by the transcript.
 *
 * This is the single seam between the two layers. The switch is exhaustive on
 * purpose: adding an `AgentFailureClassification['kind']` must fail the build
 * here rather than silently defaulting to a recoverable class and rendering a
 * login prompt for something that is not an auth failure.
 */
export function toAuthDependencyFailure(
  classification: AgentFailureClassification,
): AuthDependencyFailure {
  const { provider } = classification;
  // `classifier.ts` already runs `diagnostic_message` through `redactSecrets`,
  // so this pass is belt-and-braces on the value that actually leaves the
  // machine rather than the only guard.
  const detail = toAuthDiagnosticDetail(classification.diagnostic_message);

  let failureClass: AuthFailureClass;
  let recovery: AuthRecoveryMethod;

  switch (classification.kind) {
    case 'provider_authentication_required':
      failureClass = 'unauthenticated';
      recovery =
        provider === 'claude' || provider === 'codex'
          ? { kind: 'provider_terminal', provider }
          : { kind: 'none' };
      break;
    case 'provider_usage_limit':
      failureClass = 'quota_exceeded';
      recovery = { kind: 'none' };
      break;
    case 'provider_temporarily_unavailable':
      failureClass = 'provider_outage';
      recovery = { kind: 'none' };
      break;
  }

  return {
    dependencyClass: 'provider',
    dependencyId: provider,
    displayName: providerDisplayName(provider),
    failureClass,
    recovery,
    detail,
  };
}

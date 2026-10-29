import { toAuthDependencyFailure } from '@canopy/desktop-shared/agent-failures';
import { CANOPY_AUTH_FAILURE_EVENT_TYPE } from '@canopy/desktop-shared/types';
import type { AgentFailureClassification } from '@canopy/desktop-shared/types/agent-failures';
import { buildProviderAuthFailureEvent } from '../provider-auth-failure-event';

function classification(
  kind: AgentFailureClassification['kind'],
): AgentFailureClassification {
  return {
    kind,
    code: 'authentication_failed',
    provider: 'claude',
    account_scope: 'native',
    diagnostic_message: "You're not signed in to Claude.",
  };
}

describe('buildProviderAuthFailureEvent', () => {
  it('emits an event for an authentication classification', () => {
    const out = buildProviderAuthFailureEvent(
      classification('provider_authentication_required'),
    );
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.type).toBe(CANOPY_AUTH_FAILURE_EVENT_TYPE);
    expect(out.toolUseId).toBeUndefined();
    expect(out.failure.recovery).toEqual({
      kind: 'provider_terminal',
      provider: 'claude',
    });
  });

  it('emits nothing for a usage-limit classification', () => {
    expect(
      buildProviderAuthFailureEvent(classification('provider_usage_limit')),
    ).toBeNull();
  });

  it('emits nothing for a transient outage', () => {
    expect(
      buildProviderAuthFailureEvent(
        classification('provider_temporarily_unavailable'),
      ),
    ).toBeNull();
  });

  it('matches the projection exactly', () => {
    const source = classification('provider_authentication_required');
    const out = buildProviderAuthFailureEvent(source);
    expect(out?.failure).toEqual(toAuthDependencyFailure(source));
  });
});

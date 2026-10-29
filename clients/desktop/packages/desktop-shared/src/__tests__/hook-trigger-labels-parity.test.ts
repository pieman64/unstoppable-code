import { getHookTriggerDisplayName, SUPPORTED_HOOK_TRIGGERS } from '../hooks';
import { triggerDisplayName as portalTriggerDisplayName } from '../../../ui-app/src/code/activity/portal-hooks-section-mapper';

describe('hook trigger display label parity', () => {
  it.each([
    ...SUPPORTED_HOOK_TRIGGERS,
    'custom-trigger',
    'custom:trigger:name',
  ])('matches desktop and portal implementations for %p', (triggerName) => {
    expect(portalTriggerDisplayName(triggerName)).toBe(
      getHookTriggerDisplayName(triggerName),
    );
  });
});

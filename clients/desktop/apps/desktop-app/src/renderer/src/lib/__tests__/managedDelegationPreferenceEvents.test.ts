/** @jest-environment jsdom */
import * as discovery from '@canopy/protocol/delegation/discovery';
import {
  MANAGED_DELEGATION_PREFERENCE_UPDATED_EVENT,
  subscribeManagedDelegationPreferenceUpdated,
} from '../managedDelegationPreferenceEvents';

describe('managed delegation lifetime preference events', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([512, 1024])(
    'carries the valid lifetime choice %s',
    (lifetimeLimit) => {
      jest
        .spyOn(discovery, 'managedDelegationLifetimeLimitChoices')
        .mockReturnValue([512, 1024]);
      const listener = jest.fn();
      const unsubscribe = subscribeManagedDelegationPreferenceUpdated(listener);
      try {
        window.dispatchEvent(
          new CustomEvent(MANAGED_DELEGATION_PREFERENCE_UPDATED_EVENT, {
            detail: { mode: 'off', revocationIncomplete: false, lifetimeLimit },
          }),
        );
        expect(listener).toHaveBeenCalledWith({
          mode: 'off',
          revocationIncomplete: false,
          lifetimeLimit,
        });
      } finally {
        unsubscribe();
      }
    },
  );

  it.each([0, -1, 513, 1024, 512.5, '512', null, NaN, Infinity])(
    'drops invalid lifetime value %s without losing the policy event',
    (lifetimeLimit) => {
      const listener = jest.fn();
      const unsubscribe = subscribeManagedDelegationPreferenceUpdated(listener);
      try {
        window.dispatchEvent(
          new CustomEvent(MANAGED_DELEGATION_PREFERENCE_UPDATED_EVENT, {
            detail: {
              mode: 'proactive',
              revocationIncomplete: false,
              lifetimeLimit,
            },
          }),
        );
        expect(listener).toHaveBeenCalledWith({
          mode: 'proactive',
          revocationIncomplete: false,
        });
      } finally {
        unsubscribe();
      }
    },
  );
});

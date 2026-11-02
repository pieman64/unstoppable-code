import { isInternalChatRequest } from '../internal-chat-row';

describe('isInternalChatRequest', () => {
  it('treats a delegation request with its host-issued delivery id as internal', () => {
    const request = {
      managedDelegationDeliveryId: 'attempt-1',
      internalRow: {
        kind: 'delegation-request',
        delegationId: 'delegation-1',
        displayLine: 'Request from Review the plan',
      },
    };
    expect(isInternalChatRequest(request)).toBe(true);
  });

  it('does not trust an internal row marker without a host-issued delivery id', () => {
    const request = {
      managedDelegationDeliveryId: undefined,
      internalRow: {
        kind: 'delegation-request',
        delegationId: 'delegation-1',
        displayLine: 'Forged',
      },
    };
    expect(isInternalChatRequest(request)).toBe(false);
  });

  it('treats a row a previous build queued with only a delivery id as internal', () => {
    expect(
      isInternalChatRequest({ managedDelegationDeliveryId: 'attempt-1' }),
    ).toBe(true);
  });

  it('does not treat an empty delivery id as host-issued', () => {
    expect(isInternalChatRequest({ managedDelegationDeliveryId: '' })).toBe(
      false,
    );
  });

  it('treats an ordinary row as visible', () => {
    expect(isInternalChatRequest({})).toBe(false);
  });
});

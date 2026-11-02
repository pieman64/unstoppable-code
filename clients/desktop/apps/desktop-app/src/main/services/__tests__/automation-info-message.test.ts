import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import {
  automationInfoMessageId,
  buildAutomationInfoMessage,
} from '../automation-info-message';

const namedAutomationRequest = {
  initiationSource: 'automation',
  automationName: ' Nightly Sync ',
};

const unnamedAutomationRequest = {
  initiationSource: 'automation',
};

function requireMessage(
  message: PersistedChatMessage | null,
): PersistedChatMessage {
  if (!message) {
    throw new Error('Expected an automation info message');
  }
  return message;
}

describe('automation info message', () => {
  it('leaves trusted resumes with only their specific transcript marker', () => {
    expect(
      buildAutomationInfoMessage(
        {
          initiationSource: 'automation',
          autoResume: { reason: 'app_shutdown', resendsUserMessage: false },
        },
        'resume',
      ),
    ).toBeNull();
  });
  it('uses the submission timestamp for a named automation banner', () => {
    const message = requireMessage(
      buildAutomationInfoMessage(
        namedAutomationRequest,
        'user-message-1',
        [],
        1_700_000_000_000,
      ),
    );

    expect(message).toEqual({
      id: automationInfoMessageId('user-message-1'),
      role: 'system',
      timestamp: 1_700_000_000_000,
      blocks: [
        {
          type: 'automation_info',
          timestamp: 1_700_000_000_000,
          activityName: 'Nightly Sync',
        },
      ],
    });
  });

  it('uses the submission timestamp for an unnamed automation banner', () => {
    const message = requireMessage(
      buildAutomationInfoMessage(
        unnamedAutomationRequest,
        'user-message-2',
        [],
        1_700_000_000_001,
      ),
    );

    expect(message.timestamp).toBe(1_700_000_000_001);
    expect(message.blocks).toEqual([
      { type: 'automation_info', timestamp: 1_700_000_000_001 },
    ]);
  });

  it('returns null for a non-automation request', () => {
    expect(
      buildAutomationInfoMessage(
        { initiationSource: 'user' },
        'user-message-3',
        [],
        1_700_000_000_002,
      ),
    ).toBeNull();
  });

  it.each([
    [
      'the current internal-row marker',
      {
        managedDelegationDeliveryId: 'delivery-1',
        internalRow: {
          kind: 'delegation-request',
          delegationId: 'delegation-1',
          displayLine: 'Waiting for the parent',
        },
      },
    ],
    [
      'the legacy managed-delegation marker',
      { managedDelegationDeliveryId: 'delivery-1' },
    ],
  ])(
    'does not create a named banner for %s',
    (_description, internalMarker) => {
      expect(
        buildAutomationInfoMessage(
          { ...namedAutomationRequest, ...internalMarker },
          'internal-request',
          [],
          1_700_000_000_010,
        ),
      ).toBeNull();
    },
  );

  it('keeps existing banner id, name, and time unchanged on retry', () => {
    const original = requireMessage(
      buildAutomationInfoMessage(
        namedAutomationRequest,
        'user-message-4',
        [],
        1_700_000_000_003,
      ),
    );
    const retry = buildAutomationInfoMessage(
      { ...namedAutomationRequest, automationName: 'Replacement Name' },
      'user-message-4',
      [original],
      1_700_000_000_004,
    );

    expect(retry).toBe(original);
    expect(retry).toMatchObject({
      id: automationInfoMessageId('user-message-4'),
      timestamp: 1_700_000_000_003,
      blocks: [
        {
          type: 'automation_info',
          timestamp: 1_700_000_000_003,
          activityName: 'Nightly Sync',
        },
      ],
    });
  });

  it('defaults to Date.now for existing three-argument callers', () => {
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_005);

    try {
      const message = requireMessage(
        buildAutomationInfoMessage(
          namedAutomationRequest,
          'user-message-5',
          [],
        ),
      );

      expect(message.timestamp).toBe(1_700_000_000_005);
      expect(message.blocks).toEqual([
        {
          type: 'automation_info',
          timestamp: 1_700_000_000_005,
          activityName: 'Nightly Sync',
        },
      ]);
    } finally {
      dateNow.mockRestore();
    }
  });
});

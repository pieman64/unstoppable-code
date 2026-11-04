import {
  CONTACT_ORG_ADMIN_COPY,
  DISPATCH_DEAD_END_COPY,
  MESSAGE_QUEUED_TITLE,
  OUT_OF_CREDITS_TITLE,
  POLICY_BILLING_DEAD_END_COPY,
  POLICY_ONLY_DEAD_END_COPY,
  QUEUED_MESSAGE_RETAINED_COPY,
  creditsOnlyDeadEndCopy,
  creditsReplenishmentCopy,
  failedTurnCopy,
  notSignedInCopy,
  retainedMessageCopy,
} from '../creditsRecoveryCopy';

/**
 * CAN-4764 — the recovery copy moved verbatim from the desktop banner and the
 * web notice. Pin every string so a change lands here on purpose.
 */
describe('credits recovery copy', () => {
  it('keeps the shared lines', () => {
    expect(CONTACT_ORG_ADMIN_COPY).toBe(
      'Contact your org admin to increase your spend quota.',
    );
    expect(MESSAGE_QUEUED_TITLE).toBe('Message queued');
    expect(QUEUED_MESSAGE_RETAINED_COPY).toBe(
      'Your queued message is still saved. Add credits, then click Try again.',
    );
    expect(OUT_OF_CREDITS_TITLE).toBe("You're out of AI credits");
  });

  it('says what happened to the message for each origin', () => {
    expect(retainedMessageCopy('queue')).toBe(QUEUED_MESSAGE_RETAINED_COPY);
    expect(retainedMessageCopy('create')).toBe(
      'Nothing was sent. Add credits, then try again.',
    );
    expect(retainedMessageCopy('composer')).toBe(
      'Your message is still in the composer. Add credits, then send it again.',
    );
  });

  describe('replenishment line', () => {
    // The line is in the viewer's locale and time zone, so compare against
    // the same formatter rather than a fixed string.
    const at = '2026-11-03T09:30:00.000Z';
    const localTime = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(at));

    it('names a daily refill', () => {
      expect(creditsReplenishmentCopy({ kind: 'daily', at })).toBe(
        `Daily credits refill ${localTime}.`,
      );
    });

    it('names a monthly renewal', () => {
      expect(creditsReplenishmentCopy({ kind: 'monthly', at })).toBe(
        `Monthly credits renew ${localTime}.`,
      );
    });

    it('is absent without a refill or with an invalid time', () => {
      expect(creditsReplenishmentCopy(null)).toBeNull();
      expect(
        creditsReplenishmentCopy({ kind: 'daily', at: 'not a date' }),
      ).toBeNull();
    });
  });

  it('keeps the desktop dead-end arms', () => {
    expect(POLICY_ONLY_DEAD_END_COPY).toEqual({
      title: 'No model available',
      message:
        "Your organization's model policy doesn't allow any model you can run right now, so ask your organization admin to allow a model you can use.",
    });
    expect(POLICY_BILLING_DEAD_END_COPY).toEqual({
      title: 'No model available',
      message:
        "Your organization's allowed models all need a billing source you don't have yet.",
    });
    expect(DISPATCH_DEAD_END_COPY).toEqual({
      title: 'No billing source',
      message: 'No available model can be paid for right now.',
    });
  });

  it('injects the app name and provider label', () => {
    expect(creditsOnlyDeadEndCopy('Acme')).toEqual({
      title: 'AI Credits required',
      message:
        'Your organization only allows models that require Acme AI Credits.',
    });
    expect(failedTurnCopy('Acme')).toEqual({
      title: 'Message not sent',
      message: "Your Acme AI Credits didn't cover that message.",
    });
    expect(
      notSignedInCopy({ appName: 'Acme', providerLabel: 'Claude' }),
    ).toEqual({
      title: 'Not signed in to Claude',
      message: 'You have no Acme AI Credits to cover this chat either.',
    });
  });
});

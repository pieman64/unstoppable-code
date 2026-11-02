import { createPostHogOperationTracker } from '../operations';

// CAN-4633: free AI credit grants and the no-credits recovery surfaces.
describe('AI credit grant and recovery operations', () => {
  it('projects a daily credit grant with its bounded outcome properties', () => {
    const tracker = createPostHogOperationTracker();
    const event = tracker.finish(
      'canopy.daily_credit_grant',
      { status: 'success' },
      'main',
      {
        context: {
          grant_status: 'blocked',
          grant_blocked_reason: 'network_limit',
          grant_amount: 10,
          grant_source: 'balance_read',
          email: 'private@example.com',
          balance_credits: 42,
        },
      },
    );
    expect(event?.event).toBe('billing:daily_credit_grant_update');
    expect(event?.properties).toMatchObject({
      grant_status: 'blocked',
      grant_blocked_reason: 'network_limit',
      grant_amount: 10,
      grant_source: 'balance_read',
    });
    expect(event?.properties).not.toHaveProperty('email');
    expect(event?.properties).not.toHaveProperty('balance_credits');
  });

  it.each([
    [
      'canopy.credits_recovery',
      'billing:credits_recovery_view',
      { recovery_surface: 'chat_banner', recovery_trigger: 'failed_turn' },
    ],
    [
      'canopy.credits_recovery_action',
      'billing:credits_recovery_click',
      { recovery_surface: 'model_recovery', recovery_action: 'drip_opt_in' },
    ],
  ] as const)(
    'projects %s with its fixed recovery properties',
    (operation, expected, context) => {
      const tracker = createPostHogOperationTracker();
      const event = tracker.finish(operation, { status: 'success' }, 'main', {
        context: { ...context, chat_id: 'private', model_id: 'private' },
      });
      expect(event?.event).toBe(expected);
      expect(event?.properties).toMatchObject(context);
      expect(event?.properties).not.toHaveProperty('chat_id');
      expect(event?.properties).not.toHaveProperty('model_id');
    },
  );

  it('forwards the daily credit grant status on chat:turn_end', () => {
    const tracker = createPostHogOperationTracker();
    const event = tracker.finish(
      'canopy.chat_turn',
      { status: 'failure', failureReason: 'error' },
      'main',
      {
        context: {
          failure_category: 'no_credits',
          daily_credit_grant_status: 'not_opted_in',
        },
      },
    );
    expect(event?.event).toBe('chat:turn_end');
    expect(event?.properties).toMatchObject({
      failure_category: 'no_credits',
      daily_credit_grant_status: 'not_opted_in',
    });
  });
});

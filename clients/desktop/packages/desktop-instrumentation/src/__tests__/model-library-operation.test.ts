import { createPostHogOperationTracker } from '../operations';

it.each([
  ['canopy.model_recovery', 'billing:model_recovery_view', 'needs_purchase'],
  ['canopy.model_access', 'billing:model_access_update', 'unlocked'],
] as const)(
  'projects %s with bounded recovery properties',
  (operation, expected, access) => {
    const tracker = createPostHogOperationTracker();
    const event = tracker.finish(operation, { status: 'success' }, 'main', {
      context: {
        recovery_source: 'picker',
        model_id: 'model-1',
        library_access: access,
        account_id: 'private',
        chat_id: 'private',
      },
    });
    expect(event?.event).toBe(expected);
    expect(event?.properties).toMatchObject({
      recovery_source: 'picker',
      model_id: 'model-1',
      library_access: access,
    });
    expect(event?.properties).not.toHaveProperty('account_id');
    expect(event?.properties).not.toHaveProperty('chat_id');
  },
);

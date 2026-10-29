import { createPostHogOperationTracker } from '../operations';

it('projects only bounded share-dialog context without registry data', () => {
  const tracker = createPostHogOperationTracker();
  tracker.start('canopy.share_dialog');
  const event = tracker.finish(
    'canopy.share_dialog',
    { status: 'success' },
    'main',
    {
      context: {
        resource_kind: 'plugin',
        source: 'usage_nudge',
        skill_name: 'private',
        count: 5,
      },
    },
  );
  expect(event?.event).toBe('sharing:dialog_open');
  expect(event?.properties).toEqual(
    expect.objectContaining({
      resource_kind: 'plugin',
      source: 'usage_nudge',
      surface: 'main',
    }),
  );
  expect(event?.properties).not.toHaveProperty('skill_name');
  expect(event?.properties).not.toHaveProperty('count');
});

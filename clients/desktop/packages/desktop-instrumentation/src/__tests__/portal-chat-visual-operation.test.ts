import {
  DESKTOP_OPERATIONS,
  createPostHogOperationTracker,
} from '../operations';

it('pins the Portal visual-view event and privacy-safe properties', () => {
  expect(DESKTOP_OPERATIONS['canopy.portal_chat_visual_read']).toMatchObject({
    kind: 'product',
    posthogEvent: 'chat:visual_view',
    contextKeys: ['page_count', 'size_bytes', 'transport_type'],
  });
  const tracker = createPostHogOperationTracker();
  tracker.start('canopy.portal_chat_visual_read', { operationKey: 'read' });
  const event = tracker.finish(
    'canopy.portal_chat_visual_read',
    { status: 'success' },
    'main',
    {
      operationKey: 'read',
      context: {
        page_count: 2,
        size_bytes: 384_001,
        transport_type: 'portal_inline',
        chat_id: 'private',
        sha256: 'secret',
        title: 'private',
      },
    },
  );
  expect(event?.event).toBe('chat:visual_view');
  expect(event?.properties).toMatchObject({
    page_count: 2,
    size_bytes: 384_001,
    transport_type: 'portal_inline',
    status: 'success',
    surface: 'main',
  });
  expect(typeof event?.properties.duration_ms).toBe('number');
  expect(Object.keys(event?.properties ?? {}).sort()).toEqual(
    [
      'duration_ms',
      'page_count',
      'size_bytes',
      'status',
      'surface',
      'transport_type',
    ].sort(),
  );
});

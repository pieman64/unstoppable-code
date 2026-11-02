import { createPostHogOperationTracker } from '../operations';

it.each(['plan', 'default'])(
  'projects composer_mode=%s with only bounded chat send properties, never message content',
  (composerMode) => {
    const tracker = createPostHogOperationTracker();
    tracker.start('canopy.chat_message_send');
    const event = tracker.finish(
      'canopy.chat_message_send',
      { status: 'success' },
      'main',
      {
        context: {
          chat_surface: 'home',
          composer_mode: composerMode,
          is_suggested_prompt: true,
          provider: 'claude',
          model: 'claude-sonnet-5-5',
          is_ai_credits_billed: false,
          is_first_message: true,
          text: 'private message',
          chat_id: 'private',
          project_id: 'private',
        },
      },
    );
    expect(event?.event).toBe('chat:message_send');
    expect(event?.properties).toEqual(
      expect.objectContaining({
        chat_surface: 'home',
        composer_mode: composerMode,
        is_suggested_prompt: true,
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        is_ai_credits_billed: false,
        is_first_message: true,
        status: 'success',
        surface: 'main',
      }),
    );
    expect(event?.properties).not.toHaveProperty('text');
    expect(event?.properties).not.toHaveProperty('chat_id');
    expect(event?.properties).not.toHaveProperty('project_id');
  },
);

it('leaves composer_mode absent for sends from older clients', () => {
  const tracker = createPostHogOperationTracker();
  const event = tracker.finish(
    'canopy.chat_message_send',
    { status: 'success' },
    'main',
    { context: { chat_surface: 'home' } },
  );

  expect(event?.event).toBe('chat:message_send');
  expect(event?.properties).toEqual(
    expect.objectContaining({ chat_surface: 'home', status: 'success' }),
  );
  expect(event?.properties).not.toHaveProperty('composer_mode');
});

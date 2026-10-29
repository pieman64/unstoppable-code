import { appAdvisorActionSchema } from '../definitions';

// The Cost panel and the Session breakdown in App Advisor's closed
// `panel.add_tab` schema, which only checks their shape.
describe('appAdvisorActionSchema — cost panels', () => {
  it('accepts the Cost panel as a bare kind', () => {
    for (const action of [
      { type: 'panel.add_tab', kind: 'cost' },
      { type: 'panel.add_tab', kind: 'cost', groupId: 'group-side' },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('requires a chat for the Session breakdown', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'panel.add_tab',
        kind: 'session-breakdown',
        chatId: 'chat-1',
      }).success,
    ).toBe(true);
    for (const action of [
      { type: 'panel.add_tab', kind: 'session-breakdown' },
      { type: 'panel.add_tab', kind: 'session-breakdown', chatId: '' },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }
  });
});

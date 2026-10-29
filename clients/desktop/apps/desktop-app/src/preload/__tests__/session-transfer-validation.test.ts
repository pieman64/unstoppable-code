import { isChatSessionImportedEvent } from '../session-transfer-validation';

const event = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  activateTab: true,
  tab: {
    id: 'chat',
    title: 'Imported chat',
    messages: [],
    createdAt: '2026-07-17T00:00:00.000Z',
  },
};

describe('session transfer preload validation', () => {
  it.each([true, false])('accepts activateTab=%s', (activateTab) => {
    expect(isChatSessionImportedEvent({ ...event, activateTab })).toBe(true);
  });

  it('rejects non-boolean activation values', () => {
    expect(isChatSessionImportedEvent({ ...event, activateTab: 'false' })).toBe(
      false,
    );
  });
});

import { deriveWorktreeChatName } from '../worktree-chat-name';

describe('deriveWorktreeChatName', () => {
  it('uses the selected oldest chat custom title, including an explicit placeholder name', () => {
    expect(
      deriveWorktreeChatName([
        {
          customTitle: 'New Chat',
          title: 'Old title',
          description: 'Generated',
          createdAt: '2026-10-01',
        },
        {
          customTitle: 'Later custom',
          title: 'Later title',
          createdAt: '2026-10-02',
        },
      ]),
    ).toBe('New Chat');
    expect(
      deriveWorktreeChatName([
        {
          customTitle: '  ',
          title: 'Old title',
          description: 'Generated',
          createdAt: '2026-10-01',
        },
      ]),
    ).toBe('Generated');
  });
  it('names the worktree after its first chat, preferring the summary', () => {
    expect(
      deriveWorktreeChatName([
        {
          title: 'Later chat',
          description: 'Later summary',
          createdAt: '2026-10-02T00:00:00.000Z',
        },
        {
          title: 'fix the sidebar toggle so it...',
          description: 'Fix the sidebar toggle',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ]),
    ).toBe('Fix the sidebar toggle');
  });

  it('falls back to the title and skips file tabs and placeholders', () => {
    expect(
      deriveWorktreeChatName([
        {
          kind: 'file',
          title: 'README.md',
          createdAt: '2026-09-30T00:00:00.000Z',
        },
        {
          title: '  Add dark mode  ',
          description: '   ',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ]),
    ).toBe('Add dark mode');
    expect(
      deriveWorktreeChatName([
        { title: 'New Chat', createdAt: '2026-10-01T00:00:00.000Z' },
      ]),
    ).toBeUndefined();
    expect(deriveWorktreeChatName([])).toBeUndefined();
  });
});

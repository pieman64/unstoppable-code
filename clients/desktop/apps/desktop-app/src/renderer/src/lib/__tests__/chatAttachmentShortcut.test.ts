import {
  isChatAttachmentShortcutTarget,
  type ChatAttachmentShortcutTarget,
} from '../chatAttachmentShortcut';

const target: ChatAttachmentShortcutTarget = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

describe('isChatAttachmentShortcutTarget', () => {
  it('matches only the intended chat composer', () => {
    expect(isChatAttachmentShortcutTarget({ ...target }, target)).toBe(true);
    expect(
      isChatAttachmentShortcutTarget({ ...target, chatId: 'chat-2' }, target),
    ).toBe(false);
    expect(
      isChatAttachmentShortcutTarget(
        { ...target, worktreeId: 'worktree-2' },
        target,
      ),
    ).toBe(false);
  });

  it('rejects missing or malformed event details', () => {
    expect(isChatAttachmentShortcutTarget(null, target)).toBe(false);
    expect(isChatAttachmentShortcutTarget({ chatId: 'chat-1' }, target)).toBe(
      false,
    );
  });
});

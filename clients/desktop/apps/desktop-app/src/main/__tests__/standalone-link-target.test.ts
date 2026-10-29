import { buildStandaloneChatLinkTarget } from '../lib/standalone-link-target';

describe('buildStandaloneChatLinkTarget', () => {
  it('preserves the standalone-chat worktreeId-only wire shape', () => {
    expect(buildStandaloneChatLinkTarget('cowork-default', 'chat-1')).toEqual({
      page: 'chat',
      kind: 'standalone-chat',
      worktreeId: 'cowork-default',
      chatId: 'chat-1',
    });
  });

  it('omits chatId entirely when the caller has none', () => {
    // A workspace-level target still navigates. Substituting another id (such
    // as the Work Entry id) would produce a dead link, because
    // `AuditTrailPage.openEntry` passes `chatId` to `selectChat`, which
    // resolves the owning Work Entry for a chat id.
    const target = buildStandaloneChatLinkTarget('cowork-default');
    expect(target).toEqual({
      page: 'chat',
      kind: 'standalone-chat',
      worktreeId: 'cowork-default',
    });
    expect(target).not.toHaveProperty('chatId');
  });
});

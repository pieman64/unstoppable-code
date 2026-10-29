import { listWorktreeChatSummaryBatch } from '../worktree-chat-summary-batch';
import { listWorktreeChatSummaries } from '../chat-service';
jest.mock('../chat-service', () => ({ listWorktreeChatSummaries: jest.fn() }));

it('bounds reads at four, preserves order and propagates strict inventory failures', async () => {
  const targets = Array.from({ length: 13 }, (_, i) => ({
    workspaceLocalId: 'workspace',
    worktreeLocalId: `tree-${i}`,
  }));
  let active = 0;
  let peak = 0;
  const batch = await listWorktreeChatSummaryBatch(targets, async (target) => {
    peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return [
      {
        localId: target.worktreeLocalId,
        chatId: target.worktreeLocalId,
        scope: 'worktree',
        title: 'Chat',
      },
    ];
  });
  expect(peak).toBe(4);
  expect(batch.map(({ target }) => target)).toEqual(targets);
  jest
    .mocked(listWorktreeChatSummaries)
    .mockRejectedValue(new Error('unreadable'));
  await expect(listWorktreeChatSummaryBatch(targets)).rejects.toThrow(
    'unreadable',
  );
});

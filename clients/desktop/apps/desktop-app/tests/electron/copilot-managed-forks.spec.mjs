import { expect, test } from '@playwright/test';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

async function readChat(fixture, target) {
  return fixture.window.evaluate(async (scope) => {
    const [tabs, transcript] = await Promise.all([
      window.api.chat.loadTabs(scope),
      window.api.chat.getTranscriptPage(scope),
    ]);
    const tab = tabs.tabs.find((entry) => entry.id === scope.chatId);
    // Inactive tabs have metadata only; read the selected transcript directly.
    return tab ? { ...tab, messages: transcript.messages } : undefined;
  }, target);
}

for (const branched of [false, true]) {
  test(`Copilot starts an independent ${branched ? 'branched' : 'same-worktree'} chat through its managed tool`, async () => {
    test.setTimeout(240_000);
    const f = await launchCopilotSelectionFixture({
      seedBeforeLaunch: ({ userDataDir }) =>
        seedWorktreeChat({
          userDataDir,
          workspaceId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          providerType: 'copilot',
          tabs: [
            {
              id: 'copilot-selection',
              title: 'Managed fork source',
              model: 'copilot:fixture-model',
              approvalMode: 'full-access',
            },
          ],
        }),
    });
    try {
      await f.connect();
      await f.openChat();
      await f.send(
        `COPILOT_MANAGED_FORK_SOURCE ${branched ? 'COPILOT_MANAGED_BRANCH' : ''}: Remember COPILOT_MANAGED_FORK_CANARY and start an independent chat.`,
      );
      let source;
      await expect
        .poll(
          async () => {
            source = await readChat(f, f.target);
            return source?.messages.some((message) =>
              message.blocks.some(
                (block) =>
                  block.type === 'text' &&
                  block.text ===
                    'Copilot source continued after starting its independent child.',
              ),
            );
          },
          { timeout: 90_000 },
        )
        .toBe(true)
        .catch(async (error) => {
          await test.info().attach('source-tab', {
            body: JSON.stringify(source ?? null, null, 2),
            contentType: 'application/json',
          });
          const tabs = await f.window.evaluate(
            (target) => window.api.chat.loadTabs(target),
            f.target,
          );
          await test.info().attach('worktree-tabs', {
            body: JSON.stringify(tabs, null, 2),
            contentType: 'application/json',
          });
          throw error;
        });
      expect(source?.providerType).toBe('copilot');
      // The tool result is the authoritative destination; do not infer it from tab ordering.
      const block = source?.messages
        .flatMap((m) => m.blocks)
        .find(
          (b) =>
            b.type === 'tool_result' &&
            typeof b.output === 'string' &&
            b.output.includes('"independent"'),
        );
      if (!block) throw new Error('Managed fork receipt missing');
      const reply = JSON.parse(block.output);
      expect(reply.chatId).not.toBe(f.target.chatId);
      if (branched) expect(reply.worktreeId).not.toBe(f.target.worktreeId);
      else expect(reply.worktreeId).toBe(f.target.worktreeId);
      let child;
      await expect
        .poll(
          async () => {
            child = await readChat(f, {
              projectId: f.target.projectId,
              worktreeId: reply.worktreeId,
              chatId: reply.chatId,
            });
            return child?.messages.some((m) =>
              m.blocks.some(
                (b) =>
                  b.type === 'text' &&
                  b.text ===
                    'Copilot independent child retained the conversation.',
              ),
            );
          },
          { timeout: 90_000 },
        )
        .toBe(true);
      expect(child.sdkSessionId).not.toBe(source.sdkSessionId);
      expect(child.providerType).toBe('copilot');
      expect(child.forkedFrom?.chatId).toBe(f.target.chatId);
    } finally {
      await f.close();
    }
  });
}

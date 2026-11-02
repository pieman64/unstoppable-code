import { expect } from '@playwright/test';
import { launchCursorSelectionFixture } from './cursor-selection.mjs';

/** Drives a fresh Cursor chat to a native approval that holds its transcript open. */
export async function launchCursorTranscriptFixture({
  notices = false,
  reused = false,
} = {}) {
  // The native approval below only prompts in Ask; new chats default to
  // Full Access (CAN-3055), so stamp the seeded chat explicitly.
  const fixture = await launchCursorSelectionFixture({
    notices,
    approvalMode: 'ask',
  });
  try {
    // These fixtures assert individual tool cards and turn folding.
    await fixture.window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await fixture.connection(true);
    await fixture.openChat();
    const panel = fixture.window.getByTestId('panel-content-chat');
    if (!notices) {
      await panel.getByTestId('chat-model-picker').click();
      await fixture.window
        .getByTestId('chat-model-option-cursor-default')
        .click();
    }
    await panel
      .getByRole('textbox')
      .first()
      .fill(
        `CURSOR_CHAT_E2E_TRANSCRIPT${reused ? '_REUSED' : ''}: Explain this project.`,
      );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    // Native reads/searches reach the real approval policy. Preserve the
    // transcript's successful Read/Grep and denied Glob before holding at the
    // Write/Shell approval the caller exercises.
    const approval = panel.getByTestId('tool-approval-card');
    for (const [tool, decision] of [
      ['Read', 'allow'],
      ['Glob', 'deny'],
      ['Grep', 'allow'],
    ]) {
      await expect(approval).toContainText(`Cursor wants to use ${tool}`);
      await approval.getByTestId(`tool-approval-${decision}`).click();
    }
    await expect(approval).toContainText(
      reused ? 'package.json' : 'git status',
    );
    const complete = async () => {
      await panel.getByTestId('tool-approval-allow').click();
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0);
      await expect(
        panel.getByText('This is a TypeScript project.', { exact: true }),
      ).toBeVisible();
    };
    return { ...fixture, panel, complete };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

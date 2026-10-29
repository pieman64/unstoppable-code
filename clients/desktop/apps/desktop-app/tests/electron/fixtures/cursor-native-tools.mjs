import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchCursorSelectionFixture } from './cursor-selection.mjs';

/** Real UI/session/approval hook, with deterministic native effects in the ACP peer. */
export async function launchCursorNativeToolFixture(tool, options = {}) {
  const { invalidGrepFirst = false, ...selectionOptions } = options;
  const f = await launchCursorSelectionFixture({
    approvalMode: 'ask',
    ...selectionOptions,
  });
  try {
    writeFileSync(
      path.join(f.worktreePath, 'cursor-native-source.txt'),
      'native search needle\n',
    );
    writeFileSync(
      path.join(f.worktreePath, 'cursor-native-delete.txt'),
      'delete only after approval\n',
    );
    await f.connection(true);
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-option-cursor-default').click();
    await panel
      .getByRole('textbox')
      .first()
      .fill(
        `${invalidGrepFirst ? 'CURSOR_CHAT_E2E_INVALID_GREP ' : ''}CURSOR_CHAT_E2E_NATIVE_${tool}`,
      );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    return {
      ...f,
      panel,
      effectFile: path.join(f.worktreePath, `cursor-native-executed-${tool}`),
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

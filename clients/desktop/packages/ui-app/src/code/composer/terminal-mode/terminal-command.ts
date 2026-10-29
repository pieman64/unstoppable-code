/**
 * Pure parsing for the composer's terminal mode: a draft whose first
 * non-whitespace character is `!` sends the rest of its first line to a new
 * terminal.
 */

/** Whether `draftText` puts the composer in terminal mode. */
export function isTerminalDraft(draftText: string): boolean {
  return draftText.replace(/^\s+/, '').startsWith('!');
}

/** The draft after its leading `!` (and the whitespace around it), all lines. */
export function terminalDraftBody(draftText: string): string {
  return draftText.replace(/^\s*!\s*/, '');
}

/**
 * The raw command a terminal-mode draft sends: its first line after `!`,
 * trimmed. Later lines are not sent; a picked script action is the only way
 * to send a multiline body.
 */
export function terminalDraftCommand(draftText: string): string {
  if (!isTerminalDraft(draftText)) return '';
  const firstLine = terminalDraftBody(draftText).split(/\r?\n/, 1)[0];
  return firstLine?.trim() ?? '';
}

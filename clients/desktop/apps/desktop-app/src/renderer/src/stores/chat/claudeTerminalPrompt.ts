// Prompt/paste-data builders and write helpers for the Claude managed
// terminal chat interface mode.
import { isTerminalBackedInterfaceMode } from '@canopy/desktop-shared/types';
import { useClaudeTerminalStore } from '@/stores/claudeTerminalStore';
import { worktreeKey } from './utils';
import { resolveTabProviderType } from './tab-utils';
import { chatStoreApi } from './store-ref';
import type {
  ChatSendMessageRequest,
  FileReference,
  TerminalWriteDisposition,
} from '@canopy/desktop-shared/types';
import { formatPendingSystemInstructionBlock } from '@canopy/desktop-shared/lib/pending-system-instructions';
import {
  TERMINAL_BRACKETED_PASTE_END,
  TERMINAL_BRACKETED_PASTE_START,
  TERMINAL_ENTER_KEY,
} from './constants';

export function buildClaudeTerminalPromptText(
  text: string,
  fileReferences: FileReference[] | undefined,
  attachmentPaths: string[] | undefined,
  attachmentPromptContexts:
    | ChatSendMessageRequest['attachmentPromptContexts']
    | undefined,
  hiddenContext: ChatSendMessageRequest['hiddenContext'] | undefined,
  pendingSystemInstructions:
    | ChatSendMessageRequest['pendingSystemInstructions']
    | undefined,
): string {
  const browserResourcePathSet = new Set(
    (attachmentPromptContexts ?? [])
      .filter((context) => context.promptKind === 'in-app-browser-resource')
      .map((context) => context.attachmentPath),
  );
  const linearTicketPathSet = new Set(
    (attachmentPromptContexts ?? [])
      .filter((context) => context.promptKind === 'linear-ticket')
      .map((context) => context.attachmentPath),
  );
  const referencedPaths = [
    ...(fileReferences?.map(
      (reference) => reference.absolutePath || reference.displayPath,
    ) ?? []),
    ...((attachmentPaths ?? []).filter(
      (attachmentPath) =>
        !browserResourcePathSet.has(attachmentPath) &&
        !linearTicketPathSet.has(attachmentPath),
    ) ?? []),
  ].filter((value, index, array) => value && array.indexOf(value) === index);
  const browserResourcePaths = (attachmentPaths ?? []).filter(
    (attachmentPath, index, array) =>
      browserResourcePathSet.has(attachmentPath) &&
      array.indexOf(attachmentPath) === index,
  );
  const linearTicketPaths = (attachmentPaths ?? []).filter(
    (attachmentPath, index, array) =>
      linearTicketPathSet.has(attachmentPath) &&
      array.indexOf(attachmentPath) === index,
  );

  const parts = [
    formatPendingSystemInstructionBlock(pendingSystemInstructions),
    hiddenContext?.text?.trim() ?? '',
    text,
    browserResourcePaths.length > 0
      ? `In-app browser resource attachments:\nThese were captured from the in-app browser session and may reference selected UI elements, page URL/title, locators, DOM excerpts, screenshots, viewport/theme, and recent console/network diagnostics.\n${browserResourcePaths
          .map((reference) => `- ${reference}`)
          .join('\n')}`
      : '',
    linearTicketPaths.length > 0
      ? `Linear ticket snapshot attachments:\nRead the referenced markdown file(s) and treat the ticket as the task's source context.\n${linearTicketPaths
          .map((reference) => `- ${reference}`)
          .join('\n')}`
      : '',
    // Bare paths, one per line, with no label: the Claude Code TUI converts
    // pasted image paths into [Image #N] attachments in place, so any prose
    // around them ends up verbatim in the submitted prompt (and the imported
    // transcript). See the transcript sanitizers in
    // claude-terminal-transcript-sync.ts for the matching import-side
    // cleanup.
    referencedPaths.join('\n'),
  ].filter((part) => part.length > 0);

  return parts.join('\n\n');
}

export function buildClaudeTerminalPasteData(promptText: string): string {
  const normalizedPrompt = promptText
    .replace(/\r\n?/g, '\n')
    // Strip C0 control bytes (keeping tab and the already-normalized newline)
    // before wrapping the content in bracketed-paste framing. Repository-
    // controlled selection text (CAN-1250) or any pasted file content can
    // carry a raw ESC[201~; left intact it would close the bracketed paste
    // early and turn the trailing bytes into live Claude Code TUI input.
    // Removing the ESC (and other control bytes) makes any such sequence inert
    // literal text. See editorSelectionContext.ts serialization.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return `${TERMINAL_BRACKETED_PASTE_START}${normalizedPrompt}${TERMINAL_BRACKETED_PASTE_END}`;
}

// Keystrokes written ahead of any prompt sent to an already-running Claude
// Code TUI: the first Escape dismisses any lingering overlay (or clears
// existing composer text), Space makes the composer non-empty, and the final
// Escape clears it. The Space between the Escapes is load-bearing — two
// consecutive Escape presses trigger Claude Code's double-Escape conversation
// rewind overlay, which then swallows the submit Enter while the pasted
// prompt sits unsent in the composer. Sent as discrete writes with a short
// gap so the TUI's escape-sequence disambiguation timer treats each Escape
// as a standalone keypress.
export const CLAUDE_TERMINAL_CLEAR_SEQUENCE_KEYS = [
  '\x1b',
  ' ',
  '\x1b',
] as const;

export const CLAUDE_TERMINAL_CLEAR_SEQUENCE_DELAY_MS = 75;

// Wait for the TUI to ingest the bracketed paste into its composer before
// writing the submitting Enter. When Enter rides in the same chunk as the
// paste (or follows immediately) a busy TUI can process it before the paste
// lands, leaving the prompt typed-but-unsent.
export const CLAUDE_TERMINAL_PASTE_SUBMIT_DELAY_MS = 150;

export async function writeClaudeTerminalClearSequence(
  terminalId: string,
  options?: { acceptedInputId?: string; idempotencyKey?: string },
): Promise<TerminalWriteDisposition[]> {
  const idempotencyKey = options?.acceptedInputId ?? options?.idempotencyKey;
  const dispositions: TerminalWriteDisposition[] = [];
  for (
    let index = 0;
    index < CLAUDE_TERMINAL_CLEAR_SEQUENCE_KEYS.length;
    index += 1
  ) {
    const key = CLAUDE_TERMINAL_CLEAR_SEQUENCE_KEYS[index];
    dispositions.push(
      await window.api.terminal.write({
        terminalId,
        data: key,
        ...(idempotencyKey
          ? { idempotencyKey: `${idempotencyKey}-clear-${index}` }
          : {}),
      }),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, CLAUDE_TERMINAL_CLEAR_SEQUENCE_DELAY_MS),
    );
  }
  return dispositions;
}

// Prompts that carry attachment paths need a longer settle before the
// submitting Enter: the TUI scans the pasted text for file paths, reads each
// file, and rewrites image paths into `[Image #N]` attachments inside the
// composer. An Enter arriving during that rewrite is intermittently dropped.
export const CLAUDE_TERMINAL_ATTACHMENT_SUBMIT_DELAY_MS = 750;

export async function writeClaudeTerminalPrompt(
  terminalId: string,
  promptText: string,
  options?: {
    acceptedInputId?: string;
    hasAttachments?: boolean;
    idempotencyKey?: string;
  },
): Promise<TerminalWriteDisposition[]> {
  const idempotencyKey = options?.acceptedInputId ?? options?.idempotencyKey;
  const pasteDisposition = await window.api.terminal.write({
    terminalId,
    data: buildClaudeTerminalPasteData(promptText),
    ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}-paste` } : {}),
  });
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      options?.hasAttachments === true
        ? CLAUDE_TERMINAL_ATTACHMENT_SUBMIT_DELAY_MS
        : CLAUDE_TERMINAL_PASTE_SUBMIT_DELAY_MS,
    ),
  );
  const submitDisposition = await window.api.terminal
    .write({
      terminalId,
      data: TERMINAL_ENTER_KEY,
      ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}-submit` } : {}),
    })
    .catch(async (error: unknown) => {
      // A refused submit leaves the withdrawn text in the composer. Unkeyed,
      // so receipts of the clear before the paste cannot skip these keys.
      if (idempotencyKey)
        await writeClaudeTerminalClearSequence(terminalId).catch(
          () => undefined,
        );
      throw error;
    });
  return [pasteDisposition, submitDisposition];
}

export function canSendToClaudeTerminalState(
  state:
    | {
        terminalId?: string;
        turnState?: string;
        readyForInput?: boolean;
      }
    | undefined,
): state is { terminalId: string; turnState?: string } {
  return (
    state !== undefined &&
    typeof state.terminalId === 'string' &&
    state.terminalId.length > 0 &&
    // `turnState: 'idle'` flips as soon as the process spawns; only the first
    // hook callback proves the TUI can accept pasted input. Writing earlier
    // gets swallowed by CLI startup, so unready sends stay queued (or ride
    // along as the launch's initial prompt) instead.
    state.readyForInput === true &&
    state.turnState !== 'exited' &&
    state.turnState !== 'error' &&
    state.turnState !== 'cleaning_up' &&
    state.turnState !== 'uninitialized'
  );
}

/**
 * Restart a live managed Claude Code terminal after a Canopy-side settings
 * change (model / thinking level / plan mode). The CLI reads those settings
 * only as launch arguments, so a relaunch is the only way to apply them; the
 * conversation carries over because relaunches resume the same
 * `sdkSessionId`. Visible `claude-code` tabs relaunch immediately so the
 * surface reflects the change; `auto` tabs tear down lazily and the next
 * send relaunches with the prompt as the CLI's initial argument. A running
 * turn is never interrupted — mid-turn changes apply on the next relaunch.
 */
export async function restartClaudeTerminalForSettingsChange(
  sel: { projectId: string; worktreeId: string },
  chatId: string,
): Promise<void> {
  const tab = chatStoreApi()
    .getState()
    .worktreeChats[worktreeKey(sel)]?.tabs.find((t) => t.id === chatId);
  if (!tab || !isTerminalBackedInterfaceMode(tab.interfaceMode)) return;
  if (resolveTabProviderType(tab) !== 'claude') return;
  const live = await window.api.claudeTerminal
    .getState(sel.projectId, sel.worktreeId, chatId)
    .catch(() => undefined);
  if (
    !live?.terminalId ||
    live.turnState === 'running' ||
    live.turnState === 'cleaning_up' ||
    live.turnState === 'exited' ||
    live.turnState === 'error'
  ) {
    return;
  }
  await useClaudeTerminalStore
    .getState()
    .cleanup(sel.projectId, sel.worktreeId, chatId, 'settings-change');
  if (tab.interfaceMode === 'claude-code') {
    await chatStoreApi()
      .getState()
      .ensureClaudeTerminal(chatId, sel)
      .catch(() => undefined);
  }
}

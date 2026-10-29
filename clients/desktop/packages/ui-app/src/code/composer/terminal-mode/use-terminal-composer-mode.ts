'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTerminalDraft, terminalDraftCommand } from './terminal-command';

/** Shown in the terminal mode label's place when a command did not reach the terminal. */
export const TERMINAL_SEND_FAILED_MESSAGE = "Couldn't send to terminal";

/**
 * Thrown by a host's `runInTerminal` when it stopped before anything was sent
 * (a picked script changed, for example). Its message replaces the generic
 * send failure; the draft stays as it is.
 */
export class TerminalComposerBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalComposerBlockedError';
  }
}

export interface UseTerminalComposerModeOptions {
  /** The serialized draft text. */
  readonly draftText: string;
  /**
   * Host gate for terminal mode: a real worktree, a writable composer and a
   * terminal to send into. While false a `!` draft is ordinary text.
   */
  readonly enabled: boolean;
  /**
   * Spawns a new terminal and writes the command once. Resolves only after the
   * write succeeded; any rejection keeps the draft. Never retried.
   */
  readonly runInTerminal: (command: string) => Promise<void>;
  /** After a successful write: the host clears its draft and refocuses. */
  readonly onSent: () => void;
}

export interface TerminalComposerMode {
  /** The draft starts with `!` and terminal mode is enabled. */
  readonly active: boolean;
  /** The raw command: the first line after `!`, trimmed. */
  readonly command: string;
  /** The last send's failure, until the draft changes or the mode ends. */
  readonly error: string | null;
  /** Send the command; resolves true once it reached the terminal. */
  readonly send: () => Promise<boolean>;
}

/**
 * The composer's terminal mode (`!` drafts): parses the command, sends it
 * through the host's terminal runner, and owns the error/reset behavior. The
 * draft is cleared (through `onSent`) only after a successful write; on any
 * failure it stays in the box with the error in the mode label's place.
 */
export function useTerminalComposerMode({
  draftText,
  enabled,
  runInTerminal,
  onSent,
}: UseTerminalComposerModeOptions): TerminalComposerMode {
  const active = enabled && isTerminalDraft(draftText);
  const command = active ? terminalDraftCommand(draftText) : '';
  const [failure, setFailure] = useState<{
    readonly message: string;
    readonly draftText: string;
  } | null>(null);
  const sendingRef = useRef(false);
  const runRef = useRef(runInTerminal);
  runRef.current = runInTerminal;
  const sentRef = useRef(onSent);
  sentRef.current = onSent;

  // Editing the draft or leaving the mode clears the last failure.
  useEffect(() => {
    if (failure !== null && (!active || failure.draftText !== draftText)) {
      setFailure(null);
    }
  }, [active, draftText, failure]);

  const send = useCallback(async (): Promise<boolean> => {
    if (!active || !command || sendingRef.current) return false;
    sendingRef.current = true;
    try {
      await runRef.current(command);
    } catch (error) {
      setFailure({
        message:
          error instanceof TerminalComposerBlockedError
            ? error.message
            : TERMINAL_SEND_FAILED_MESSAGE,
        draftText,
      });
      return false;
    } finally {
      sendingRef.current = false;
    }
    setFailure(null);
    sentRef.current();
    return true;
  }, [active, command, draftText]);

  return {
    active,
    command,
    error:
      active && failure !== null && failure.draftText === draftText
        ? failure.message
        : null,
    send,
  };
}

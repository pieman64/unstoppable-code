import { TERMINAL_SHELL_UNAVAILABLE_PREFIX } from '@canopy/protocol/terminal';

const IPC_INVOKE_WRAPPER = /^error invoking remote method '[^']*':\s*/i;
const ERROR_CLASS_PREFIX = /^(?:error|[a-z][a-z0-9_]*error):\s*/i;

/**
 * The plain sentence from a main-process "shell unavailable" error (a chosen or
 * restored shell that cannot start), or `null` for any other error so the
 * caller keeps its generic text. The error may sit behind an IPC wrapper and an
 * error-class prefix.
 */
export function terminalShellUnavailableMessage(error: unknown): string | null {
  let message: string;
  try {
    const raw =
      typeof error === 'string'
        ? error
        : typeof error === 'object' && error !== null && 'message' in error
          ? error.message
          : null;
    if (typeof raw !== 'string') return null;
    message = raw.trim();
  } catch {
    return null;
  }
  const unwrap = (value: string): string =>
    value.replace(IPC_INVOKE_WRAPPER, '').replace(ERROR_CLASS_PREFIX, '');
  for (let next = unwrap(message); next !== message; ) {
    message = next;
    next = unwrap(message);
  }
  if (!message.startsWith(TERMINAL_SHELL_UNAVAILABLE_PREFIX)) return null;
  const sentence = message
    .slice(TERMINAL_SHELL_UNAVAILABLE_PREFIX.length)
    .trim();
  return sentence.length > 0 ? sentence : null;
}

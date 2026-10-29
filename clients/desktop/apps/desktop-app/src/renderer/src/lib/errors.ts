/**
 * Renderer-side error helpers.
 *
 * Electron rejects a renderer-side `ipcRenderer.invoke(...)` with an `Error`
 * whose `.message` is wrapped with the channel name and the original error's
 * `toString()` — for example:
 *
 *   "Error invoking remote method 'chat:send-message': ResourceGuardError:
 *    Canopy is under high memory pressure. Wait for active work to finish
 *    before starting another chat."
 *
 * Use {@link extractIpcErrorMessage} on every renderer code path that takes a
 * caught IPC rejection and renders it to the user, so the message is shown
 * verbatim with no `Error invoking remote method '…':` wrapper, no class-name
 * prefix, and no `Error:` prefix.
 */
const IPC_INVOKE_WRAPPER_REGEX = /^Error invoking remote method '[^']*':\s*/;
const ERROR_CLASS_PREFIX_REGEX = /^(?:Error|[A-Z][A-Za-z0-9_]*Error):\s*/;

export function extractIpcErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error && err.message
      ? err.message
      : typeof err === 'string'
        ? err
        : '';
  if (!raw) return 'Unknown error';
  let message = raw.replace(IPC_INVOKE_WRAPPER_REGEX, '');
  message = message.replace(ERROR_CLASS_PREFIX_REGEX, '');
  return message.length > 0 ? message : 'Unknown error';
}

const IPC_ERROR_NAME_REGEX =
  /^(?:Error invoking remote method '[^']*':\s*)?([A-Z][A-Za-z0-9_]*Error):\s/;

/**
 * The error class name Electron keeps in front of a wrapped IPC message
 * (`CopilotPolicyError: …`), or undefined for a plain `Error`. Lets a
 * renderer show a main-process message verbatim only when main named it.
 */
export function extractIpcErrorName(err: unknown): string | undefined {
  const raw =
    err instanceof Error && err.message
      ? err.message
      : typeof err === 'string'
        ? err
        : '';
  const name = IPC_ERROR_NAME_REGEX.exec(raw)?.[1];
  return name && name !== 'Error' ? name : undefined;
}

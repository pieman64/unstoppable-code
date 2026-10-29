/**
 * Plain sentences for the desktop's resource-context refusals, which reach the
 * share dialog as `Resource unavailable (<reason>)`, often behind an Electron
 * `Error invoking remote method '…':` wrapper and an error-class prefix.
 */
const REFUSAL_SENTENCES: ReadonlyMap<string, string> = new Map([
  ['unsupported-target', "This share can't be moved to that destination."],
  [
    'context-mismatch',
    'Switch to the organization that owns this share, then try again.',
  ],
  ['access-removed', 'You no longer have access to this share.'],
  ['unknown-provenance', "This share's owner couldn't be confirmed."],
  ['missing-dependency', "A dependency of this share isn't available."],
]);

const IPC_INVOKE_WRAPPER = /^error invoking remote method '[^']*':\s*/i;
const ERROR_CLASS_PREFIX = /^(?:error|[a-z][a-z0-9_]*error):\s*/i;
const REFUSAL =
  /^(?:resource|pipeline|skill|agent|automation|collection|plugin) unavailable \(([a-z-]+)\)\.?$/i;

function readMessage(error: unknown): string | null {
  if (typeof error === 'string') return error;
  try {
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const { message } = error;
      return typeof message === 'string' ? message : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The plain sentence for a known resource-context refusal, or `null` for any
 * other error so the caller keeps its own handling.
 */
export function resourceContextRefusalMessage(error: unknown): string | null {
  const raw = readMessage(error);
  if (raw === null) return null;
  let message = raw.trim();
  // Transport and class prefixes can alternate, including an outer Error.
  const unwrap = (value: string): string =>
    value.replace(IPC_INVOKE_WRAPPER, '').replace(ERROR_CLASS_PREFIX, '');
  for (let next = unwrap(message); next !== message; ) {
    message = next;
    next = unwrap(message);
  }
  const reason = REFUSAL.exec(message.trim())?.[1]?.toLowerCase();
  if (reason === undefined) return null;
  return REFUSAL_SENTENCES.get(reason) ?? null;
}

/** Commands bound to a browser's main document, cancellable together. */
export interface DocumentCommands {
  documentCommands?: Set<(error: Error) => void>;
}

/** Rejects every command bound to the document (it was replaced or lost). */
export function cancelDocumentCommands(
  owner: DocumentCommands,
  error: Error,
): void {
  for (const cancel of Array.from(owner.documentCommands ?? [])) cancel(error);
}

/**
 * A page model command bound to the main document, as the preload's
 * prepared and probe commands were: rejected when the document is
 * replaced or the renderer lost (`cancelDocumentCommands`), when `signal`
 * aborts, and after `timeoutMs` (the timeouts those commands had), so a
 * command that never answers cannot hold an action lane or a wait.
 */
export function documentCommand<T>(
  owner: DocumentCommands,
  name: string,
  command: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const commands = owner.documentCommands ?? new Set();
  owner.documentCommands = commands;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cancel = (error: Error): void => finish(() => reject(error));
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      commands.delete(cancel);
      complete();
    };
    commands.add(cancel);
    const timer = setTimeout(
      () =>
        finish(() => reject(new Error(`Browser command timed out: ${name}`))),
      timeoutMs,
    );
    const abort = (): void =>
      finish(() =>
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException('Browser command cancelled.', 'AbortError'),
        ),
      );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    command.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        ),
    );
  });
}

import { randomUUID } from 'node:crypto';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import type { SendableBrowserWindow } from '../lib/window-send';
import { requestApprovalFromRenderer } from './prompt-bridge';
import {
  registerApprovalSecretConsumer,
  cancelApproval,
} from './pending-approvals';

/** Key references live only for this callback's probe/storage lifetime. */
export async function requestSecretInputApproval<T>(options: {
  sessionKey: string;
  event: Omit<ApprovalRequestEvent, 'requestId' | 'secretInput'>;
  getWindow: () => SendableBrowserWindow | null;
  signal: AbortSignal;
  consume: (secret: string) => Promise<T>;
}): Promise<T | null> {
  let requestId: string | undefined;
  let operation: Promise<T> | undefined;
  const cancel = (): void => {
    if (requestId) cancelApproval(requestId, 'secret_input_cancelled');
  };
  if (options.signal.aborted) return null;
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    const decision = await requestApprovalFromRenderer({
      sessionKey: options.sessionKey,
      getWindow: options.getWindow,
      timeoutMs: 120_000,
      event: {
        ...options.event,
        secretInput: {
          kind: 'secret-input',
          bindingId: randomUUID(),
          label: 'API key',
        },
      },
      onRegistered: (id) => {
        requestId = id;
        registerApprovalSecretConsumer(id, (secret) => {
          if (options.signal.aborted) return;
          operation = options.consume(secret);
          // Attach immediately; an asynchronous storage refusal must not become an unhandled rejection.
          void operation.catch(() => undefined);
        });
        if (options.signal.aborted) cancel();
      },
    });
    if (decision.behavior !== 'allow' || options.signal.aborted || !operation)
      return null;
    return await operation;
  } catch (error) {
    if (operation && !options.signal.aborted) throw error;
    return null;
  } finally {
    options.signal.removeEventListener('abort', cancel);
    if (requestId) cancelApproval(requestId, 'secret_input_finished');
  }
}

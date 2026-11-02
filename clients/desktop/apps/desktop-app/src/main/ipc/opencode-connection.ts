import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  type OpenCodeConnectionStatus,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';
import { OPENCODE_CONNECTION_TIMEOUT_MS } from '@canopy/desktop-shared/types/opencode-connection';
import { validateId } from '../lib/validation';
import { sendToWebContents } from '../lib/web-contents-send';
import { peekOpenCodeRuntimeAvailability } from '../opencode/runtime-availability';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
import { notifyPortalModelCatalogChanged } from '../portal/portal-event-bus';

const operations = new Set<{
  owner: number;
  controller: AbortController;
  done: Promise<unknown>;
  mutation: boolean;
  operationId?: string;
}>();
let shuttingDown = false;

function assertOwner(event: IpcMainInvokeEvent): void {
  if (
    shuttingDown ||
    event.sender.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame ||
    !BrowserWindow.fromWebContents(event.sender)
  )
    throw new Error('OpenCode setup window is unavailable.');
}

async function owned<T>(
  event: IpcMainInvokeEvent,
  mutation: boolean,
  run: (
    signal: AbortSignal,
    progress: (status: OpenCodeConnectionStatus) => void,
  ) => Promise<T>,
  operationId?: string,
): Promise<T> {
  assertOwner(event);
  if (Array.from(operations).some((operation) => operation.mutation))
    throw new Error('OpenCode setup is already running.');
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  const owner = event.sender;
  owner.once('destroyed', stop);
  owner.once('render-process-gone', stop);
  owner.once('did-start-navigation', stop);
  const previous = mutation ? Array.from(operations) : [];
  const done = Promise.resolve().then(async () => {
    for (const operation of previous) operation.controller.abort();
    await Promise.allSettled(previous.map((operation) => operation.done));
    assertOwner(event);
    controller.signal.throwIfAborted();
    return run(
      AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(mutation ? OPENCODE_CONNECTION_TIMEOUT_MS : 60_000),
      ]),
      (status) => {
        if (!owner.isDestroyed() && !controller.signal.aborted)
          sendToWebContents(
            owner,
            IPC_CHANNELS.opencodeConnectionProgress,
            status,
          );
      },
    );
  });
  const operation = {
    owner: owner.id,
    controller,
    done,
    mutation,
    operationId,
  };
  operations.add(operation);
  try {
    return await done;
  } finally {
    operations.delete(operation);
    owner.off('destroyed', stop);
    owner.off('render-process-gone', stop);
    owner.off('did-start-navigation', stop);
  }
}

function parseOperationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  validateId(value, 'OpenCode operation id');
  if (value.length > 200) throw new Error('OpenCode operation id is too long.');
  return value;
}

function publish(): void {
  broadcastModelRegistryUpdated();
  void notifyPortalModelCatalogChanged().catch(() => undefined);
}

export async function shutdownOpenCodeConnections(): Promise<void> {
  shuttingDown = true;
  for (const operation of Array.from(operations)) operation.controller.abort();
  const { revokeOpenCodeRuntimes } = await import('../opencode/connection');
  await Promise.allSettled([
    revokeOpenCodeRuntimes(),
    ...Array.from(operations).map((operation) => operation.done),
  ]);
}

export function registerOpenCodeConnectionHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.opencodeConnectionStatus, async (event) => {
    assertOwner(event);
    const before = peekOpenCodeRuntimeAvailability();
    const { opencodeConnectionStatus } = await import('../opencode/connection');
    const status = await opencodeConnectionStatus();
    if (before !== peekOpenCodeRuntimeAvailability()) publish();
    return status;
  });
  registerIpcHandler(IPC_CHANNELS.opencodeConnectionModels, (event) =>
    owned(event, false, async (signal) => {
      const { listOpenCodeModels } = await import('../opencode/connection');
      const models = await listOpenCodeModels(signal);
      publish();
      return models;
    }),
  );
  registerIpcHandler(
    IPC_CHANNELS.opencodeConnectionConnect,
    (event, operationId?: unknown) => {
      const id = parseOperationId(operationId);
      return owned(
        event,
        true,
        async (signal, progress) => {
          const { connectOpenCode } = await import('../opencode/connection');
          try {
            // Connect discovers the catalog and publishes it after durable enablement.
            return await connectOpenCode(signal, progress);
          } finally {
            publish();
          }
        },
        id,
      );
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.opencodeConnectionCancel,
    async (event, operationId?: unknown) => {
      assertOwner(event);
      const id = parseOperationId(operationId);
      const pending = Array.from(operations).filter(
        (operation) =>
          operation.owner === event.sender.id &&
          (id === undefined || operation.operationId === id),
      );
      for (const operation of pending) operation.controller.abort();
      await Promise.allSettled(pending.map((operation) => operation.done));
    },
  );
  registerIpcHandler(IPC_CHANNELS.opencodeConnectionDisconnect, (event) =>
    owned(event, true, async () => {
      const { disconnectOpenCode } = await import('../opencode/connection');
      await disconnectOpenCode();
      publish();
    }),
  );
}

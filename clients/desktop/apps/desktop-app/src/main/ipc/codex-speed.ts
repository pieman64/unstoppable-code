import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import {
  IPC_CHANNELS,
  type CodexSpeedCatalog,
  type CodexSpeedReadCapabilitiesOptions,
  type CodexSpeedSetActiveRequest,
  type ReadCodexSpeedRouteRequest,
} from '@canopy/desktop-shared/types';
import type { CodexSpeedRouteFacts } from '@canopy/execution-engine/lib/codex-speed-availability';
import { isCodexSpeedReadRouteRequest } from '@canopy/desktop-shared/lib/codex-speed-route';
import { readCodexSpeedRouteFacts } from '../codex/speed-route-context';
import { registerAccountProxyCodexSpeedCatalog } from '../account-proxy/codex-speed-catalog';
import { validateId } from '../lib/validation';
import {
  readCodexSpeedCatalog,
  setCodexSpeedConsumerActive,
  subscribeCodexSpeedCatalog,
} from '../model-routing/codex-account-models';
import { registerCodexAccountModelRegistrySync } from '../model-routing/codex-account-model-registry';
import { sendToAllWindows } from '../lib/window-send';
import { registerIpcHandler } from './register';

const DESKTOP_WINDOW_REQUIRED =
  'Codex speed capabilities require a desktop window.';
const INVALID_REQUEST = 'Invalid Codex speed capability request.';
const MAX_CONSUMER_ID_LENGTH = 128;
const CONSUMER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
/** Bounds the bookkeeping any one renderer can create. */
const MAX_CONSUMERS_PER_SENDER = 64;

/**
 * Consumer ids each renderer (`WebContents.id`) holds active in the catalog
 * module, so a window that closes, crashes, or reloads releases them. Kept at
 * module level so re-registering the handlers still releases the consumers
 * of senders that are already observed.
 */
const consumersBySender = new Map<number, Set<string>>();
let disposeCatalogBroadcast: (() => void) | null = null;

function assertDesktopWindowSender(event: IpcMainInvokeEvent): WebContents {
  const { sender } = event;
  if (
    sender.isDestroyed() ||
    event.senderFrame !== sender.mainFrame ||
    !BrowserWindow.fromWebContents(sender)
  )
    throw new Error(DESKTOP_WINDOW_REQUIRED);
  return sender;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseReadOptions(
  options: unknown,
): CodexSpeedReadCapabilitiesOptions | undefined {
  if (options === undefined) return undefined;
  if (
    !isPlainObject(options) ||
    !hasOnlyKeys(options, ['force', 'route']) ||
    (options.force !== undefined && typeof options.force !== 'boolean') ||
    (options.route !== undefined && options.route !== 'account-proxy')
  )
    throw new Error(INVALID_REQUEST);
  const force = options.force === true;
  const route = options.route === 'account-proxy';
  if (!force && !route) return undefined;
  return {
    ...(force ? { force: true } : {}),
    ...(route ? { route: 'account-proxy' } : {}),
  };
}

function isConsumerId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_CONSUMER_ID_LENGTH &&
    CONSUMER_ID_PATTERN.test(value)
  );
}

function parseSetActiveRequest(request: unknown): CodexSpeedSetActiveRequest {
  if (
    !isPlainObject(request) ||
    Object.keys(request).length !== 2 ||
    !hasOnlyKeys(request, ['consumerId', 'active'])
  )
    throw new Error(INVALID_REQUEST);
  const { consumerId, active } = request;
  if (!isConsumerId(consumerId) || typeof active !== 'boolean')
    throw new Error(INVALID_REQUEST);
  return { consumerId, active };
}

/** Main-side key: unique across windows that reuse a consumer id. */
function consumerKey(senderId: number, consumerId: string): string {
  return `${senderId}:${consumerId}`;
}

function releaseSenderConsumers(senderId: number): void {
  const consumers = consumersBySender.get(senderId);
  if (!consumers || consumers.size === 0) return;
  const released = Array.from(consumers);
  consumers.clear();
  for (const consumerId of released)
    setCodexSpeedConsumerActive(consumerKey(senderId, consumerId), false);
}

/**
 * The sender's consumer set, observing its lifecycle the first time. A crash
 * or a main-frame navigation (including reload) discards the page that
 * registered the consumers, but the same contents may register again; only
 * `destroyed` ends the observation.
 */
function observeSender(sender: WebContents): Set<string> {
  const senderId = sender.id;
  const existing = consumersBySender.get(senderId);
  if (existing) return existing;
  const consumers = new Set<string>();
  consumersBySender.set(senderId, consumers);
  const release = (): void => {
    releaseSenderConsumers(senderId);
  };
  sender.on('render-process-gone', release);
  sender.on('did-navigate', release);
  sender.once('destroyed', () => {
    sender.off('render-process-gone', release);
    sender.off('did-navigate', release);
    releaseSenderConsumers(senderId);
    consumersBySender.delete(senderId);
  });
  return consumers;
}

export function registerCodexSpeedHandlers(): void {
  // Admission and selectors read the proxy route's own Codex catalog.
  registerAccountProxyCodexSpeedCatalog();
  // Re-registration (hot reload, tests) must never broadcast twice.
  const previousBroadcast = disposeCatalogBroadcast;
  disposeCatalogBroadcast = null;
  previousBroadcast?.();
  disposeCatalogBroadcast = subscribeCodexSpeedCatalog((catalog): void => {
    sendToAllWindows(IPC_CHANNELS.codexSpeedChanged, catalog);
  });
  // Account-only Codex models follow the same catalog (CAN-4716).
  registerCodexAccountModelRegistrySync();

  registerIpcHandler<[request: unknown], CodexSpeedRouteFacts>(
    IPC_CHANNELS.codexSpeedReadRoute,
    async (event, request): Promise<CodexSpeedRouteFacts> => {
      assertDesktopWindowSender(event);
      if (!isCodexSpeedReadRouteRequest(request))
        throw new Error(INVALID_REQUEST);
      const context = request.context;
      if (context.kind === 'chat') {
        validateId(context.projectId, 'projectId');
        validateId(context.worktreeId, 'worktreeId');
        validateId(context.chatId, 'chatId');
      } else if (context.kind === 'home' && context.projectId !== undefined) {
        validateId(context.projectId, 'projectId');
      }
      const parsed: ReadCodexSpeedRouteRequest = {
        context: { ...context },
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.modelSelection === undefined
          ? {}
          : { modelSelection: request.modelSelection }),
      };
      return readCodexSpeedRouteFacts(parsed);
    },
  );

  registerIpcHandler<[options?: unknown], CodexSpeedCatalog>(
    IPC_CHANNELS.codexSpeedRead,
    async (event, options): Promise<CodexSpeedCatalog> => {
      assertDesktopWindowSender(event);
      return readCodexSpeedCatalog(parseReadOptions(options));
    },
  );

  registerIpcHandler<[request: unknown], void>(
    IPC_CHANNELS.codexSpeedSetActive,
    (event, request): void => {
      const sender = assertDesktopWindowSender(event);
      const { consumerId, active } = parseSetActiveRequest(request);
      if (active) {
        const consumers = observeSender(sender);
        if (
          !consumers.has(consumerId) &&
          consumers.size >= MAX_CONSUMERS_PER_SENDER
        )
          throw new Error(INVALID_REQUEST);
        // Recorded before forwarding so a failure still leaves the key to be
        // released with its sender; the catalog set is idempotent.
        consumers.add(consumerId);
      } else {
        consumersBySender.get(sender.id)?.delete(consumerId);
      }
      setCodexSpeedConsumerActive(consumerKey(sender.id, consumerId), active);
    },
  );
}

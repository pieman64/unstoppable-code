import {
  IPC_CHANNELS,
  type CodexSpeedApi,
  type CodexSpeedCatalog,
  type CodexSpeedReadCapabilitiesOptions,
  type CodexSpeedSetActiveRequest,
  type ReadCodexSpeedRouteRequest,
} from '@canopy/desktop-shared/types';
import type { CodexSpeedRouteFacts } from '@canopy/execution-engine/lib/codex-speed-availability';
import {
  isCodexSpeedReadRouteRequest,
  isCodexSpeedRouteFacts,
} from '@canopy/desktop-shared/lib/codex-speed-route';
import { isCodexSpeedCatalog } from '@canopy/execution-engine/lib/codex-speed-availability';

const INVALID_REQUEST = 'Invalid Codex speed capability request.';
const UNAVAILABLE = 'Codex speed capabilities were unavailable.';
// Mirrors the main-process validation in `main/ipc/codex-speed.ts`.
const MAX_CONSUMER_ID_LENGTH = 128;
const CONSUMER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

type CodexSpeedChangedListener = (event: unknown, payload: unknown) => void;

interface CodexSpeedIpc {
  invoke(
    channel: typeof IPC_CHANNELS.codexSpeedReadRoute,
    request: ReadCodexSpeedRouteRequest,
  ): Promise<unknown>;
  invoke(
    channel: typeof IPC_CHANNELS.codexSpeedRead,
    options?: CodexSpeedReadCapabilitiesOptions,
  ): Promise<unknown>;
  invoke(
    channel: typeof IPC_CHANNELS.codexSpeedSetActive,
    request: CodexSpeedSetActiveRequest,
  ): Promise<unknown>;
  on(
    channel: typeof IPC_CHANNELS.codexSpeedChanged,
    listener: CodexSpeedChangedListener,
  ): void;
  removeListener(
    channel: typeof IPC_CHANNELS.codexSpeedChanged,
    listener: CodexSpeedChangedListener,
  ): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Valid read options as a fresh object, or undefined for a plain read. */
function parseReadOptions(
  options: unknown,
): CodexSpeedReadCapabilitiesOptions | undefined {
  if (options === undefined) return undefined;
  if (
    !isPlainObject(options) ||
    !Object.keys(options).every((key) => key === 'force' || key === 'route') ||
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

/** A fresh request carrying only the validated fields. */
function parseSetActiveRequest(request: unknown): CodexSpeedSetActiveRequest {
  if (!isPlainObject(request)) throw new Error(INVALID_REQUEST);
  const { consumerId, active } = request;
  if (
    typeof consumerId !== 'string' ||
    consumerId.length > MAX_CONSUMER_ID_LENGTH ||
    !CONSUMER_ID_PATTERN.test(consumerId) ||
    typeof active !== 'boolean'
  )
    throw new Error(INVALID_REQUEST);
  return { consumerId, active };
}

/** Build the Codex speed capability bridge against an injectable IPC seam. */
export function createCodexSpeedApi(ipc: CodexSpeedIpc): CodexSpeedApi {
  return {
    readRoute: async (request): Promise<CodexSpeedRouteFacts> => {
      if (!isCodexSpeedReadRouteRequest(request))
        throw new Error(INVALID_REQUEST);
      const response = await ipc.invoke(IPC_CHANNELS.codexSpeedReadRoute, {
        context: { ...request.context },
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.modelSelection === undefined
          ? {}
          : { modelSelection: request.modelSelection }),
      });
      if (!isCodexSpeedRouteFacts(response)) throw new Error(UNAVAILABLE);
      return response;
    },
    // Async so invalid input rejects, before any IPC, instead of throwing.
    readCapabilities: async (
      options?: CodexSpeedReadCapabilitiesOptions,
    ): Promise<CodexSpeedCatalog> => {
      const parsed = parseReadOptions(options);
      const response = parsed
        ? await ipc.invoke(IPC_CHANNELS.codexSpeedRead, parsed)
        : await ipc.invoke(IPC_CHANNELS.codexSpeedRead);
      if (!isCodexSpeedCatalog(response)) throw new Error(UNAVAILABLE);
      return response;
    },
    setActive: async (request: CodexSpeedSetActiveRequest): Promise<void> => {
      await ipc.invoke(
        IPC_CHANNELS.codexSpeedSetActive,
        parseSetActiveRequest(request),
      );
    },
    onChanged: (
      callback: (catalog: CodexSpeedCatalog) => void,
    ): (() => void) => {
      const listener: CodexSpeedChangedListener = (_event, payload): void => {
        if (isCodexSpeedCatalog(payload)) callback(payload);
      };
      let subscribed = true;
      ipc.on(IPC_CHANNELS.codexSpeedChanged, listener);
      return (): void => {
        if (!subscribed) return;
        subscribed = false;
        ipc.removeListener(IPC_CHANNELS.codexSpeedChanged, listener);
      };
    },
  };
}

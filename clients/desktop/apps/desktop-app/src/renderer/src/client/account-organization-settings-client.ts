import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type {
  AccountOrganizationSettingsApi,
  AccountOrganizationSettingsEventMessage,
  AccountOrganizationSettingsResponse,
  CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  SettingsOperationError,
  settingsOperation,
  validateSettingsOperationInput,
  validateSettingsOperationResult,
  type SettingsErrorCode,
  type SettingsEvent,
  type SettingsOperationName,
  type SettingsReadMap,
  type SettingsReadName,
  type SettingsSubscriptionScope,
  type SettingsWriteMap,
  type SettingsWriteName,
} from '@canopy/protocol/settings';

/**
 * Field of an upload entry's input carrying `{ bytes, contentType }`. Main
 * strips it, enforces the entry's size and type limits, and performs the
 * signed upload itself. Mirrors `SETTINGS_UPLOAD_FILE_FIELD` in main.
 */
export const SETTINGS_UPLOAD_FILE_FIELD = 'file';

/** The signed-in, non-guest cloud account id, or null. */
export type SettingsAccountIdSource = () => Promise<string | null>;

export interface DesktopSettingsClientOptions {
  /** Called when main reports the asserted account is not signed in. */
  onUnauthenticated?: () => void;
  randomId?: () => string;
}

/** Feed items remembered per subscription for event-id deduplication. */
const SEEN_EVENT_LIMIT = 512;
/** Scopes whose last sequence is remembered for resubscription. */
const SEQUENCE_MEMORY_LIMIT = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Input validation before sending; upload files are checked by main. */
function inputIsValid(name: SettingsOperationName, input: unknown): boolean {
  let fields: unknown = input;
  if (settingsOperation(name).transport === 'upload') {
    if (!isRecord(input)) return false;
    fields = Object.fromEntries(
      Object.entries(input).filter(
        ([key]) => key !== SETTINGS_UPLOAD_FILE_FIELD,
      ),
    );
  }
  return validateSettingsOperationInput(name, fields).ok;
}

/**
 * Upload entries carry the picked file as a `Blob` (a `File` from an
 * `<input type="file">`), which IPC cannot clone. Main expects the bytes and
 * the declared type, and checks both against the entry before signing.
 */
async function serializeUploadInput(
  name: SettingsOperationName,
  input: unknown,
): Promise<unknown> {
  if (settingsOperation(name).transport !== 'upload' || !isRecord(input))
    return input;
  const file = input[SETTINGS_UPLOAD_FILE_FIELD];
  if (typeof Blob === 'undefined' || !(file instanceof Blob)) return input;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    ...input,
    [SETTINGS_UPLOAD_FILE_FIELD]: { bytes, contentType: file.type },
  };
}

function isReadResult<K extends SettingsReadName>(
  operation: K,
  value: unknown,
): value is SettingsReadMap[K]['result'] {
  return validateSettingsOperationResult(operation, value).ok;
}

function isWriteResult<K extends SettingsWriteName>(
  operation: K,
  value: unknown,
): value is SettingsWriteMap[K]['result'] {
  return validateSettingsOperationResult(operation, value).ok;
}

function streamErrorFor(
  code: SettingsErrorCode,
): 'expired' | 'forbidden' | 'unsupported_server' | undefined {
  if (code === 'expired' || code === 'unauthenticated') return 'expired';
  if (code === 'forbidden' || code === 'not_found') return 'forbidden';
  if (code === 'unsupported_server') return 'unsupported_server';
  return undefined;
}

function defaultRandomId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Desktop {@link AccountOrganizationSettingsClient} over the preload bridge.
 * Every call names a table entry; main chooses the URL, method, headers,
 * identity and upload target. Results are validated again here.
 */
export function createDesktopSettingsClient(
  api: AccountOrganizationSettingsApi,
  getAccountId: SettingsAccountIdSource,
  options: DesktopSettingsClientOptions = {},
): AccountOrganizationSettingsClient {
  const randomId = options.randomId ?? defaultRandomId;
  const routes = new Map<string, (event: SettingsEvent) => void>();
  const lastSequences = new Map<string, number>();
  let stopEvents: (() => void) | null = null;

  function route(message: AccountOrganizationSettingsEventMessage): void {
    routes.get(message.subscriptionId)?.(message.event);
  }

  function addRoute(id: string, handler: (event: SettingsEvent) => void): void {
    routes.set(id, handler);
    stopEvents ??= api.onEvent(route);
  }

  function removeRoute(id: string): void {
    routes.delete(id);
    if (routes.size > 0 || stopEvents === null) return;
    stopEvents();
    stopEvents = null;
  }

  function rememberSequence(key: string, sequence: number): void {
    lastSequences.delete(key);
    lastSequences.set(key, sequence);
    if (lastSequences.size <= SEQUENCE_MEMORY_LIMIT) return;
    const oldest = lastSequences.keys().next();
    if (oldest.done !== true) lastSequences.delete(oldest.value);
  }

  async function requireAccountId(): Promise<string> {
    const accountId = await getAccountId();
    if (accountId === null)
      throw new SettingsOperationError({ code: 'unauthenticated' });
    return accountId;
  }

  async function call(
    kind: 'read' | 'write',
    operation: SettingsOperationName,
    input: unknown,
  ): Promise<unknown> {
    if (!inputIsValid(operation, input))
      throw new SettingsOperationError({
        code: 'failed',
        message: 'Invalid input',
      });
    const accountId = await requireAccountId();
    const payload = await serializeUploadInput(operation, input);
    let response: AccountOrganizationSettingsResponse;
    try {
      response = await api[kind]({ accountId, operation, input: payload });
    } catch {
      throw new SettingsOperationError({
        code: kind === 'write' ? 'uncertain' : 'failed',
      });
    }
    if (!response.ok) {
      if (response.error.code === 'unauthenticated')
        options.onUnauthenticated?.();
      throw new SettingsOperationError(response.error);
    }
    return response.result;
  }

  return {
    async read<K extends SettingsReadName>(
      operation: K,
      input: SettingsReadMap[K]['input'],
    ): Promise<SettingsReadMap[K]['result']> {
      const result = await call('read', operation, input);
      if (!isReadResult(operation, result))
        throw new SettingsOperationError({ code: 'invalid_response' });
      return result;
    },
    async write<K extends SettingsWriteName>(
      operation: K,
      input: SettingsWriteMap[K]['input'],
    ): Promise<SettingsWriteMap[K]['result']> {
      const result = await call('write', operation, input);
      if (!isWriteResult(operation, result))
        throw new SettingsOperationError({ code: 'invalid_response' });
      return result;
    },
    subscribe(
      scope: SettingsSubscriptionScope,
      listener: (event: SettingsEvent) => void,
    ): () => void {
      const subscriptionId = randomId();
      const seen = new Set<string>();
      let closed = false;
      let sequenceKey: string | null = null;
      let lastSequence =
        scope.kind === 'organization-feed' ? scope.lastSequence : undefined;
      const organizationId = scope.organizationId;

      const disable = (code: SettingsErrorCode): void => {
        if (closed) return;
        const error = streamErrorFor(code);
        listener({
          type: 'state',
          ...(organizationId === undefined ? {} : { organizationId }),
          state: 'disabled',
          ...(error === undefined ? {} : { error }),
        });
      };

      addRoute(subscriptionId, (event) => {
        if (closed) return;
        if (event.type === 'feed.item') {
          if (
            seen.has(event.eventId) ||
            (lastSequence !== undefined && event.sequence <= lastSequence)
          )
            return;
          seen.add(event.eventId);
          if (seen.size > SEEN_EVENT_LIMIT) {
            const oldest = seen.values().next();
            if (oldest.done !== true) seen.delete(oldest.value);
          }
          lastSequence = event.sequence;
          if (sequenceKey !== null)
            rememberSequence(sequenceKey, event.sequence);
        }
        listener(event);
      });

      const start = async (): Promise<void> => {
        const accountId = await getAccountId();
        if (closed) return;
        if (accountId === null) {
          disable('unauthenticated');
          removeRoute(subscriptionId);
          return;
        }
        // Only the feed resumes from a sequence; credit signals restart.
        if (scope.kind === 'organization-feed') {
          sequenceKey = `${accountId}\n${scope.organizationId}\n${scope.teamId ?? ''}`;
          lastSequence ??= lastSequences.get(sequenceKey);
        }
        const response = await api.subscribe({
          accountId,
          subscriptionId,
          scope:
            scope.kind === 'organization-feed' && lastSequence !== undefined
              ? { ...scope, lastSequence }
              : scope,
        });
        if (closed) {
          // Unsubscribed while main was opening the stream.
          await api.unsubscribe({ subscriptionId });
          return;
        }
        if (!response.ok) {
          if (response.error.code === 'unauthenticated')
            options.onUnauthenticated?.();
          disable(response.error.code);
          removeRoute(subscriptionId);
        }
      };
      void start().catch(() => {
        disable('failed');
        removeRoute(subscriptionId);
      });

      return (): void => {
        if (closed) return;
        closed = true;
        removeRoute(subscriptionId);
        void api.unsubscribe({ subscriptionId }).catch(() => undefined);
      };
    },
  };
}

function accountIdFrom(account: CanopyCloudAccountPublicState): string | null {
  if (!account.hasApiKey || isGuestAccount(account)) return null;
  return account.account?.id ?? null;
}

export interface CanopyCloudAccountIdSource {
  readonly get: SettingsAccountIdSource;
  /** Drop the cached id so the next call reads the account again. */
  readonly invalidate: () => void;
}

/**
 * The signed-in, non-guest cloud account id, read through the preload and
 * cached until the renderer announces an account change. An inconclusive
 * read is never cached.
 */
export function createCanopyCloudAccountIdSource(
  loadAccount: () => Promise<CanopyCloudAccountPublicState>,
): CanopyCloudAccountIdSource {
  let cached: Promise<string | null> | null = null;
  let generation = 0;
  let listening = false;
  const invalidate = (): void => {
    generation += 1;
    cached = null;
  };
  return {
    invalidate,
    get: (): Promise<string | null> => {
      if (!listening && typeof window !== 'undefined') {
        listening = true;
        window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, invalidate);
      }
      if (cached !== null) return cached;
      const started = generation;
      const read = loadAccount().then(
        (account): string | null => {
          if (!isConclusiveAccountRead(account)) {
            if (generation === started) cached = null;
            return null;
          }
          return accountIdFrom(account);
        },
        (): null => {
          if (generation === started) cached = null;
          return null;
        },
      );
      cached = read;
      return read;
    },
  };
}

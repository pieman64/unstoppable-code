import { isAccountProxyRoutingStrategy } from '@canopy/desktop-shared/lib/account-proxy';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  AccountProxyAccountRequest,
  AccountProxyChatRequest,
  AccountProxyConnectRequest,
  AccountProxyLocalControlRequest,
  AccountProxySetAccountDisabledRequest,
  AccountProxySetRoutingStrategyRequest,
  AccountProxySignInRequest,
} from '@canopy/desktop-shared/types/account-proxy';
import { accountProxyRemoteSignInFor } from '../account-proxy/remote-sign-in';
import { getFeatureFlagService } from '../feature-flags';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

const MAX_URL_LENGTH = 2048;
const MAX_KEY_LENGTH = 4096;
/** The proxy's account ids are 16 hex characters; allow some headroom. */
const MAX_AUTH_INDEX_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConnectRequest(value: unknown): AccountProxyConnectRequest {
  if (
    !isRecord(value) ||
    typeof value.url !== 'string' ||
    typeof value.managementKey !== 'string' ||
    value.url.length > MAX_URL_LENGTH ||
    value.managementKey.length > MAX_KEY_LENGTH
  ) {
    throw new Error('Invalid account proxy connection.');
  }
  return { url: value.url, managementKey: value.managementKey };
}

function parseAccountRequest(value: unknown): AccountProxyAccountRequest {
  if (
    !isRecord(value) ||
    typeof value.authIndex !== 'string' ||
    value.authIndex.length > MAX_AUTH_INDEX_LENGTH
  ) {
    throw new Error('Invalid account proxy account.');
  }
  validateId(value.authIndex, 'account proxy account');
  return { authIndex: value.authIndex };
}

function parseSetDisabledRequest(
  value: unknown,
): AccountProxySetAccountDisabledRequest {
  const account = parseAccountRequest(value);
  if (!isRecord(value) || typeof value.disabled !== 'boolean') {
    throw new Error('Invalid account proxy account.');
  }
  return { ...account, disabled: value.disabled };
}

function parseRoutingStrategyRequest(
  value: unknown,
): AccountProxySetRoutingStrategyRequest {
  // The proxy saves any string it is sent, so only known strategies go out.
  if (!isRecord(value) || !isAccountProxyRoutingStrategy(value.strategy)) {
    throw new Error('Invalid account proxy account order.');
  }
  return { strategy: value.strategy };
}

function parseChatRequest(value: unknown): AccountProxyChatRequest {
  if (!isRecord(value)) throw new Error('Invalid chat.');
  const { projectId, worktreeId, chatId } = value;
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  validateId(chatId, 'chatId');
  return { projectId, worktreeId, chatId };
}

function parseLocalControlRequest(
  value: unknown,
): AccountProxyLocalControlRequest {
  if (
    !isRecord(value) ||
    (value.action !== 'start' &&
      value.action !== 'stop' &&
      value.action !== 'restart')
  ) {
    throw new Error('Invalid account proxy action.');
  }
  return { action: value.action };
}

function parseSignInRequest(value: unknown): AccountProxySignInRequest {
  if (!isRecord(value)) throw new Error('Invalid account proxy sign-in.');
  if (value.action === 'reopen' || value.action === 'cancel') {
    return { action: value.action };
  }
  if (
    value.action === 'start' &&
    (value.provider === 'claude' || value.provider === 'codex')
  ) {
    return { action: 'start', provider: value.provider };
  }
  throw new Error('Invalid account proxy sign-in.');
}

function publishStatus(): void {
  void import('../account-proxy/service')
    .then(({ publishAccountProxyStatus }) => publishAccountProxyStatus())
    .catch(() => undefined);
}

/** Call after the opt-in or a routing preference changed. */
export function notifyAccountProxyPreferencesChanged(): void {
  publishStatus();
}

export function registerAccountProxyHandlers(): void {
  // Turning the flag off hides every proxy surface at once.
  getFeatureFlagService().onSnapshotChanged(publishStatus);
  registerIpcHandler(
    IPC_CHANNELS.accountProxyStatus,
    async (_event, options?: unknown) => {
      const { getAccountProxyStatus } =
        await import('../account-proxy/service');
      return getAccountProxyStatus({
        refresh: isRecord(options) && options.refresh === true,
        refreshUsage: isRecord(options) && options.refreshUsage === true,
      });
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountProxyConnect,
    async (_event, request: unknown) => {
      const parsed = parseConnectRequest(request);
      const { connectAccountProxy } = await import('../account-proxy/service');
      return connectAccountProxy(parsed);
    },
  );
  registerIpcHandler(IPC_CHANNELS.accountProxyDisconnect, async () => {
    const { disconnectAccountProxy } = await import('../account-proxy/service');
    return disconnectAccountProxy();
  });
  registerIpcHandler(
    IPC_CHANNELS.accountProxySetAccountDisabled,
    async (_event, request: unknown) => {
      const parsed = parseSetDisabledRequest(request);
      const { setAccountProxyAccountDisabled } =
        await import('../account-proxy/service');
      return setAccountProxyAccountDisabled(parsed.authIndex, parsed.disabled);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountProxySessionAccounts,
    async (_event, request: unknown) => {
      const chat = parseChatRequest(request);
      const [
        { getAccountProxySessionAccounts },
        { findAccountProxyAccount },
        { buildChatSessionKey },
      ] = await Promise.all([
        import('../account-proxy/attribution'),
        import('../account-proxy/service'),
        import('../agents/session-key'),
      ]);
      return getAccountProxySessionAccounts(
        buildChatSessionKey(chat.projectId, chat.worktreeId, chat.chatId),
        findAccountProxyAccount,
      );
    },
  );
  registerIpcHandler(IPC_CHANNELS.accountProxySetUpLocal, async () => {
    const { setUpLocalAccountProxy } = await import('../account-proxy/service');
    return setUpLocalAccountProxy();
  });
  registerIpcHandler(
    IPC_CHANNELS.accountProxyControlLocal,
    async (_event, request: unknown) => {
      const parsed = parseLocalControlRequest(request);
      const { controlLocalAccountProxy } =
        await import('../account-proxy/service');
      return controlLocalAccountProxy(parsed);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountProxySignIn,
    async (event, request: unknown) => {
      const parsed = parseSignInRequest(request);
      const { signInLocalAccountProxyAccount } =
        await import('../account-proxy/service');
      return signInLocalAccountProxyAccount(
        parsed,
        accountProxyRemoteSignInFor(event.sender),
      );
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountProxyRemoveAccount,
    async (_event, request: unknown) => {
      const parsed = parseAccountRequest(request);
      const { removeAccountProxyAccount } =
        await import('../account-proxy/service');
      return removeAccountProxyAccount(parsed.authIndex);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountProxySetRoutingStrategy,
    async (_event, request: unknown) => {
      const parsed = parseRoutingStrategyRequest(request);
      const { setAccountProxyRoutingStrategy } =
        await import('../account-proxy/service');
      return setAccountProxyRoutingStrategy(parsed.strategy);
    },
  );
}

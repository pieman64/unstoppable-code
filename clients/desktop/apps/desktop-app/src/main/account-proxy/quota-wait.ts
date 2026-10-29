import { setTimeout as delay } from 'node:timers/promises';
import type { AgentFailureClassification } from '@canopy/desktop-shared/types/agent-failures';
import type { TransientAgentRetryOptions } from '@canopy/desktop-shared/agent-failures';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import { accountProxyNoUsableAccountsMessage } from '@canopy/desktop-shared/lib/account-proxy';
import { getAccountProxyStatus } from './service';
import { canResumeAccountProxyChat } from './quota-recovery';

export type AccountProxyQuotaWait = NonNullable<
  TransientAgentRetryOptions<unknown>['waitForQuotaRecovery']
>;
let shutdown = new AbortController();

export function stopAccountProxyQuotaWaits(): void {
  shutdown.abort(new Error('The application is shutting down.'));
}

/** Cancel this waiter without cancelling inventory shared by other work. */
function readStatusForWait(
  options: Parameters<typeof getAccountProxyStatus>[0],
  signal: AbortSignal,
): Promise<AccountProxyStatus> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Capacity wait was cancelled.'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void getAccountProxyStatus(options).then(
      (status) => {
        cleanup();
        resolve(status);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Shared management cache; the caller keeps its native session and work state. */
export async function waitForAccountProxyCapacity(
  provider: 'claude' | 'codex',
  connectionId: string,
  failure: Pick<AgentFailureClassification, 'resets_at'>,
  signal?: AbortSignal,
): Promise<void> {
  const abort = signal
    ? AbortSignal.any([signal, shutdown.signal])
    : shutdown.signal;
  const detectedAt = Date.now();
  const resetAt = failure.resets_at ? Date.parse(failure.resets_at) : NaN;
  for (;;) {
    abort.throwIfAborted();
    let status = await readStatusForWait(
      {
        refresh: true,
        maxAgeMs:
          Number.isFinite(resetAt) && resetAt <= Date.now() ? 5000 : 30_000,
      },
      abort,
    );
    const now = Date.now();
    if (
      status.accounts.some(
        (account) =>
          account.provider === provider &&
          ((account.availableAt !== null && account.availableAt <= now) ||
            account.limits.some(
              (limit) =>
                limit.resetsAt !== null &&
                limit.resetsAt <= now &&
                (status.refreshedAt ?? 0) < limit.resetsAt,
            )),
      )
    ) {
      status = await readStatusForWait(
        { refresh: true, maxAgeMs: 5000 },
        abort,
      );
    }
    abort.throwIfAborted();
    if (
      !status.available ||
      status.connection?.id !== connectionId ||
      !(provider === 'claude' ? status.routeClaude : status.routeCodex)
    ) {
      throw new Error(
        'The account proxy connection for this continuation is unavailable.',
      );
    }
    const noUsableAccounts =
      status.state === 'connected' && !status.error
        ? accountProxyNoUsableAccountsMessage(status.accounts, provider)
        : null;
    if (noUsableAccounts) throw new Error(noUsableAccounts);
    if (
      canResumeAccountProxyChat(
        { provider, accountProxyConnectionId: connectionId, detectedAt },
        status,
        Date.now(),
      )
    )
      return;
    await delay(5000, undefined, { signal: abort });
  }
}

export function createAccountProxyQuotaWait(
  provider: string,
  accountKey: string | undefined,
): AccountProxyQuotaWait | undefined {
  if (
    (provider !== 'claude' && provider !== 'codex') ||
    !accountKey?.startsWith('account-proxy:')
  )
    return undefined;
  const connectionId = accountKey.slice('account-proxy:'.length);
  if (!connectionId) return undefined;
  return (failure, signal): Promise<void> =>
    waitForAccountProxyCapacity(provider, connectionId, failure, signal);
}

export function resetAccountProxyQuotaWaitsForTests(): void {
  shutdown = new AbortController();
}

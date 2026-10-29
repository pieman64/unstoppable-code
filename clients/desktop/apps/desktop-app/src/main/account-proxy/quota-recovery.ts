import type {
  ResumeQueueEntry,
  ResumeQueueItem,
  UsageLimitedChatEntry,
} from '@canopy/desktop-shared/types';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import {
  isAccountProxyAccountReady,
  isAccountProxyAccountSignedOut,
} from '@canopy/desktop-shared/lib/account-proxy';
import {
  resumeTargetKey,
  type ResumeQueueService,
} from '../services/resume-queue-service';

export interface AccountProxyPipelineInterruption {
  item: ResumeQueueItem;
  requirements: Array<{
    provider: UsageLimitedChatEntry['provider'];
    accountProxyConnectionId: string;
    detectedAt: number;
    resetsAt?: number;
  }>;
}

interface RecoveryDependencies {
  now: () => number;
  readInterrupted: () => Promise<UsageLimitedChatEntry[]>;
  readPipelines?: () => Promise<AccountProxyPipelineInterruption[]>;
  readStatus: (options: {
    refresh: boolean;
    maxAgeMs: number;
  }) => Promise<AccountProxyStatus>;
  resolveItems: (
    entries: UsageLimitedChatEntry[],
  ) => Promise<ResumeQueueItem[]>;
}

/** A reset is a reason to refresh, never proof that an upstream accepts work. */
export function canResumeAccountProxyChat(
  entry: Pick<
    UsageLimitedChatEntry,
    'provider' | 'accountProxyConnectionId' | 'detectedAt'
  >,
  status: AccountProxyStatus,
  now: number,
): boolean {
  if (
    !entry.accountProxyConnectionId ||
    status.connection?.id !== entry.accountProxyConnectionId ||
    !status.available ||
    status.state !== 'connected' ||
    status.error ||
    (status.refreshedAt ?? 0) <= entry.detectedAt ||
    (entry.provider !== 'claude' && entry.provider !== 'codex') ||
    !(entry.provider === 'claude' ? status.routeClaude : status.routeCodex)
  )
    return false;
  return status.accounts.some((account) => {
    if (account.provider !== entry.provider) return false;
    // Quota percentages are passive response headers. An active account may
    // have recovered externally even while those counters still say 100%.
    if (isAccountProxyAccountReady(account)) return true;
    // CPA can retain its quota error until the next successful request.
    // Only its actual cooldown is an admission limit; passive quota resets
    // can change externally and cannot permanently prevent a bounded probe.
    const message = account.statusMessage ?? '';
    return (
      account.status === 'error' &&
      /quota|usage.limit|rate.limit|429|model_cooldown/i.test(message) &&
      !isAccountProxyAccountSignedOut(account) &&
      (account.availableAt === null || account.availableAt <= now)
    );
  });
}

/** Uses the existing resume host timer and durable queue, without a new poller. */
export class AccountProxyQuotaRecovery {
  private nextScanAt = 0;

  constructor(private readonly deps: RecoveryDependencies) {}

  async collect(queue: ResumeQueueService): Promise<void> {
    const now = this.deps.now();
    if (now < this.nextScanAt || queue.snapshot().paused || queue.isStopping())
      return;
    this.nextScanAt = now + 5000;
    await queue.pruneAutomaticResumeSuppressions();
    const terminal = new Set(
      queue
        .snapshot()
        .entries.filter(
          (entry) => entry.status !== 'waiting' && entry.status !== 'resuming',
        )
        .map(
          (entry) => `${resumeTargetKey(entry.target)}:${entry.interruptionId}`,
        ),
    );
    for (const entry of queue.snapshot().entries) {
      if (
        entry.target.kind === 'pipeline' &&
        (entry.status === 'stopped' ||
          entry.status === 'failed' ||
          entry.status === 'skipped')
      ) {
        for (const id of entry.target.statusReasonIds)
          terminal.add(`${resumeTargetKey(entry.target)}:${id}`);
      }
    }
    for (const entry of queue.snapshot().suppressedAutomaticResumes ?? []) {
      terminal.add(`${entry.targetKey}:${entry.interruptionId}`);
    }
    const pipelineInterruptions = (
      (await this.deps.readPipelines?.()) ?? []
    ).filter(
      (entry) =>
        !terminal.has(
          `${resumeTargetKey(entry.item.target)}:${entry.item.interruptionId}`,
        ) &&
        (entry.item.target.kind !== 'pipeline' ||
          !entry.item.target.statusReasonIds.some((id) =>
            terminal.has(`${resumeTargetKey(entry.item.target)}:${id}`),
          )),
    );
    const interrupted = (await this.deps.readInterrupted()).filter(
      (entry) =>
        entry.accountProxyConnectionId &&
        entry.resumeReason === 'usage_limit' &&
        !entry.accountProxyAutoResumeSuppressed &&
        !terminal.has(
          `${resumeTargetKey({ kind: 'chat', ...entry })}:${entry.detectedAt}`,
        ),
    );
    if (!interrupted.length && !pipelineInterruptions.length) {
      this.nextScanAt = now + 30_000;
      return;
    }
    const requirements = [
      ...interrupted,
      ...pipelineInterruptions.flatMap((entry) => entry.requirements),
    ];
    const before = await this.deps.readStatus({
      refresh: false,
      maxAgeMs: 30_000,
    });
    if (
      !before.available ||
      !requirements.some(
        (entry) =>
          entry.accountProxyConnectionId === before.connection?.id &&
          (entry.provider === 'claude'
            ? before.routeClaude
            : entry.provider === 'codex' && before.routeCodex),
      )
    )
      return;
    const resetDue = requirements.some(
      (entry) =>
        (entry.resetsAt !== undefined &&
          entry.resetsAt <= now &&
          (before.refreshedAt ?? 0) < entry.resetsAt) ||
        before.accounts.some(
          (account) =>
            account.provider === entry.provider &&
            ((account.availableAt !== null && account.availableAt <= now) ||
              account.limits.some(
                (limit) =>
                  limit.resetsAt !== null &&
                  limit.resetsAt <= now &&
                  (before.refreshedAt ?? 0) < limit.resetsAt,
              )),
        ),
    );
    const status = await this.deps.readStatus({
      refresh: true,
      maxAgeMs: resetDue ? 5000 : 30_000,
    });
    if (queue.snapshot().paused || queue.isStopping()) return;
    // Every recorded attempt, including Stop and failure, is an explicit outcome.
    // Only a new interruption may automatically enroll this target again.
    const attempted = new Set(
      queue
        .snapshot()
        .entries.map(
          (entry) => `${resumeTargetKey(entry.target)}:${entry.interruptionId}`,
        ),
    );
    const eligible = interrupted.filter(
      (entry) =>
        canResumeAccountProxyChat(entry, status, now) &&
        !attempted.has(
          `${resumeTargetKey({ kind: 'chat', ...entry })}:${entry.detectedAt}`,
        ),
    );
    const readyPipelines = pipelineInterruptions.filter(
      (entry) =>
        entry.requirements.length > 0 &&
        entry.requirements.every((requirement) =>
          canResumeAccountProxyChat(requirement, status, now),
        ) &&
        !attempted.has(
          `${resumeTargetKey(entry.item.target)}:${entry.item.interruptionId}`,
        ),
    );
    if (!eligible.length && !readyPipelines.length) return;
    const enrolled = new Map(
      eligible.map((entry) => [
        `${resumeTargetKey({ kind: 'chat', ...entry })}:${entry.detectedAt}`,
        entry.accountProxyConnectionId,
      ]),
    );
    const items = (await this.deps.resolveItems(eligible)).filter(
      (entry) =>
        entry.accountProxyConnectionId !== undefined &&
        enrolled.get(
          `${resumeTargetKey(entry.target)}:${entry.interruptionId}`,
        ) === entry.accountProxyConnectionId,
    );
    items.push(...readyPipelines.map((entry) => entry.item));
    if (!queue.snapshot().paused && !queue.isStopping() && items.length)
      await queue.enqueue(items, { automatic: true });
  }
}

export function proxyQueueInterruption(
  entry: ResumeQueueEntry,
): Pick<
  UsageLimitedChatEntry,
  'provider' | 'accountProxyConnectionId' | 'detectedAt'
> | null {
  const provider = entry.providers?.[0];
  if (!entry.accountProxyConnectionId || !provider) return null;
  return {
    provider,
    accountProxyConnectionId: entry.accountProxyConnectionId,
    detectedAt: Number(entry.interruptionId),
  };
}

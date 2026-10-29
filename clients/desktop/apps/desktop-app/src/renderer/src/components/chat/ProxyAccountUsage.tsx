import { Fragment, useEffect, useState, type JSX, type ReactNode } from 'react';
import {
  accountProxyAccountKey,
  accountProxyAccountsForHarness,
  type AccountProxyHarness,
} from '@canopy/desktop-shared/lib/account-proxy';
import { projectAccountProxyUsageAccount } from '@canopy/desktop-shared/lib/account-proxy-usage-projection';
import type {
  AccountProxyAccount,
  AccountProxyChatRequest,
  AccountProxySessionAccount,
} from '@canopy/desktop-shared/types/account-proxy';
import type { CostProxyAccountRow } from '@canopy/protocol/cost-view';
import {
  providerAccountUsageLeadWindowId,
  providerAccountUsageStatusText,
  providerAccountUsageSummaryLimits,
  UsageIndicatorAccountSummary,
  UsageSectionHeader,
  UsageTextAction,
  type UsageIndicatorAccountSummaryProps,
} from '@canopy/ui-shared/components';
import { ClaudeIcon, CodexIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useMinuteClock } from '@canopy/ui-shared';
import {
  formatProxyAccountEstimate,
  formatProxyAccountShare,
  proxyAccountName,
} from '@canopy/ui-shared/components/cost';
import {
  ACCOUNT_PROXY_VIA_LABEL,
  accountProxyClock,
  accountProxyPlanLabel,
  accountProxyPoolNotice,
  accountProxyProviderLabel,
} from '@/components/settings/account-proxy/accountProxyCopy';
import {
  refreshAccountProxyStatus,
  useAccountProxyStatus,
} from '@/stores/accountProxyStore';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProxyUsageExpandedStore } from '@/stores/proxyUsageExpandedStore';

/** More accounts than this read as a count under the last one. */
const MAX_SHOWN_ACCOUNTS = 3;

interface ProxyUsageRow {
  readonly accountKey: string;
  readonly provider: string | undefined;
  readonly name: string;
  /** What follows the via label: the share of turns and the estimate. */
  readonly details: readonly string[];
  /** The account's share of the chat's turns (`75% of turns`). */
  readonly share: string;
  readonly account: AccountProxyAccount | undefined;
}

function rowStatus(row: ProxyUsageRow, nowMs: number): string {
  const parts = [ACCOUNT_PROXY_VIA_LABEL, ...row.details];
  if (row.account?.status === 'cooling' && row.account.availableAt !== null) {
    parts.push(`back at ${accountProxyClock(row.account.availableAt)}`);
  }
  const usage = row.account
    ? providerAccountUsageStatusText(
        projectAccountProxyUsageAccount(row.account),
        nowMs,
      )
    : undefined;
  const via = parts.join(' · ');
  return usage === undefined ? via : `${via}. ${usage}`;
}

/** The account's named limits, from the same projection every view uses. */
function summaryLimits(
  account: AccountProxyAccount | undefined,
): UsageIndicatorAccountSummaryProps['limits'] {
  return account
    ? providerAccountUsageSummaryLimits(
        projectAccountProxyUsageAccount(account),
      )
    : [];
}

/** When a resting account can serve again, or undefined. */
function restingUntil(
  account: AccountProxyAccount | undefined,
): number | undefined {
  return account?.status === 'cooling' && account.availableAt !== null
    ? account.availableAt
    : undefined;
}

/**
 * A card's limits: a resting account's limiting window drops its reset time,
 * which the card's header already shows as "Back at".
 */
function cardLimits(
  account: AccountProxyAccount | undefined,
  backAt: number | undefined,
): UsageIndicatorAccountSummaryProps['limits'] {
  const limits = summaryLimits(account);
  if (backAt === undefined) return limits;
  return limits.map((limit) => {
    if (limit.resetsAt === undefined) return limit;
    const resetsAt = new Date(limit.resetsAt).getTime();
    if (!Number.isFinite(resetsAt) || Math.abs(resetsAt - backAt) > 60_000) {
      return limit;
    }
    const repeated = { ...limit };
    delete repeated.resetsAt;
    return repeated;
  });
}

/** A card's line for a failed read; routine freshness is not repeated. */
function cardStatus(
  account: AccountProxyAccount | undefined,
  nowMs: number,
): string | undefined {
  if (!account) return undefined;
  const projected = projectAccountProxyUsageAccount(account);
  return projected.error
    ? providerAccountUsageStatusText(projected, nowMs)
    : undefined;
}

/** The provider's mark at the card's plan line (12px, quiet ink). */
function providerMark(provider: string | undefined): JSX.Element | undefined {
  if (provider === 'claude') return <ClaudeIcon size={12} />;
  if (provider === 'codex') return <CodexIcon size={12} />;
  return undefined;
}

/**
 * Proxy account cards (Labs): one "Proxy accounts" row with Manage, then the
 * cards it folds. Open, the last card sits 4px above the divider of the
 * popover's "See detailed breakdown" footer (its inset again) rather than
 * the popover's 16px: the section pulls back the 12px gap.
 */
function ProxyAccountsSection({
  collapsed,
  onToggle,
  onManage,
  children,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onManage: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-testid="usage-indicator-proxy-accounts"
      className={`flex flex-col gap-3 ${collapsed ? '' : '-mb-3'}`}
    >
      <UsageSectionHeader
        label="Proxy accounts"
        expanded={!collapsed}
        onToggle={onToggle}
        testId="usage-indicator-proxy-section-toggle"
        action={
          <UsageTextAction
            label="Manage"
            ariaLabel="Manage proxy accounts"
            onClick={onManage}
          />
        }
      />
      {collapsed ? null : children}
    </div>
  );
}

/** The pool line: the via label, why no account is named, and its usage. */
function poolStatus(
  detail: string | null,
  only: AccountProxyAccount | undefined,
  nowMs: number,
): string {
  const via =
    detail === null
      ? ACCOUNT_PROXY_VIA_LABEL
      : `${ACCOUNT_PROXY_VIA_LABEL} · ${detail}`;
  const usage = only
    ? providerAccountUsageStatusText(
        projectAccountProxyUsageAccount(only),
        nowMs,
      )
    : undefined;
  return usage === undefined ? via : `${via}. ${usage}`;
}

/** The accounts serving the chat's live session, read once per open. */
function useSessionAccounts(
  chat: AccountProxyChatRequest | undefined,
): readonly AccountProxySessionAccount[] {
  const [accounts, setAccounts] = useState<
    readonly AccountProxySessionAccount[]
  >([]);
  const projectId = chat?.projectId;
  const worktreeId = chat?.worktreeId;
  const chatId = chat?.chatId;
  useEffect(() => {
    const accountProxy =
      typeof window !== 'undefined' ? window.api?.accountProxy : undefined;
    if (!accountProxy || !projectId || !worktreeId || !chatId) return;
    let active = true;
    accountProxy.sessionAccounts({ projectId, worktreeId, chatId }).then(
      (next) => {
        if (active) setAccounts(next);
      },
      () => undefined,
    );
    return (): void => {
      active = false;
    };
  }, [projectId, worktreeId, chatId]);
  return accounts;
}

/**
 * The account-proxy accounts behind a chat the proxy serves, for the
 * composer's usage popover: the account serving its session now, then each
 * account's share of the chat's recorded turns, its estimate, and the limits
 * the proxy last reported for it (CAN-4021). Before any account has answered,
 * the pool the proxy picks from.
 */
export function ProxyAccountUsage({
  accounts,
  harness,
  chat,
}: {
  readonly accounts: readonly CostProxyAccountRow[];
  readonly harness: AccountProxyHarness;
  readonly chat?: AccountProxyChatRequest;
}): JSX.Element {
  const status = useAccountProxyStatus();
  const cardsOn = useLabsExperimentEnabled('proxy-account-cards');
  const expandedAccounts = useProxyUsageExpandedStore(
    (state) => state.expanded,
  );
  const toggleAccount = useProxyUsageExpandedStore((state) => state.toggle);
  const sectionCollapsed = useProxyUsageExpandedStore(
    (state) => state.sectionCollapsed,
  );
  const toggleSection = useProxyUsageExpandedStore(
    (state) => state.toggleSection,
  );
  useEffect(() => {
    void refreshAccountProxyStatus({ refreshUsage: true });
  }, []);
  const openSettings = useNavigationStore((state) => state.openSettings);
  const sessionAccounts = useSessionAccounts(chat);
  const nowMs = useMinuteClock();
  const onManage = (): void => openSettings('account-proxy');
  const connectionId = status?.connection?.id;
  const byKey = new Map(
    connectionId === undefined
      ? []
      : (status?.accounts ?? []).map((account) => [
          accountProxyAccountKey(connectionId, account.authIndex),
          account,
        ]),
  );
  const turns = accounts.reduce((total, row) => total + row.turnShare, 0);
  const rows: ProxyUsageRow[] = accounts.map((row) => {
    const account = byKey.get(row.accountKey);
    return {
      accountKey: row.accountKey,
      provider: account?.provider ?? row.provider,
      name: proxyAccountName({ ...row, label: account?.label ?? row.label }),
      details: [
        formatProxyAccountShare(row.turnShare, turns),
        formatProxyAccountEstimate(row),
      ],
      share: formatProxyAccountShare(row.turnShare, turns),
      account,
    };
  });
  // The account serving the session now leads, even before its first turn
  // is recorded. It is keyed by the connection that served it: after a move
  // to another connection, the live list names other credentials under the
  // same ids, so `byKey` finds it only while its own connection is live. A
  // host that does not report the connection leaves it unled rather than
  // guessing the live one.
  const current = sessionAccounts.find((entry) => entry.current);
  const currentConnectionId = current?.connectionId;
  if (current !== undefined && currentConnectionId !== undefined) {
    const accountKey = accountProxyAccountKey(
      currentConnectionId,
      current.authIndex,
    );
    const index = rows.findIndex((row) => row.accountKey === accountKey);
    const account = byKey.get(accountKey);
    const provider = account?.provider ?? current.provider ?? harness;
    const [currentRow] =
      index >= 0
        ? rows.splice(index, 1)
        : [
            {
              accountKey,
              provider,
              name: proxyAccountName({
                accountKey,
                label: account?.label ?? current.label ?? '',
                provider,
              }),
              details: [],
              share: formatProxyAccountShare(0, turns),
              account,
            },
          ];
    if (currentRow) rows.unshift(currentRow);
  }

  // With cards on and no account named yet, the pool the proxy picks from
  // shows as cards too, each without a share.
  let rowsArePool = false;
  if (
    cardsOn &&
    rows.length === 0 &&
    connectionId !== undefined &&
    accountProxyPoolNotice(status, harness) === null
  ) {
    for (const account of accountProxyAccountsForHarness(
      status?.accounts ?? [],
      harness,
    )) {
      const accountKey = accountProxyAccountKey(
        connectionId,
        account.authIndex,
      );
      rows.push({
        accountKey,
        provider: account.provider,
        name: proxyAccountName({
          accountKey,
          label: account.label,
          provider: account.provider,
        }),
        details: [],
        share: '',
        account,
      });
      rowsArePool = true;
    }
  }

  if (rows.length === 0) {
    const harnessLabel = accountProxyProviderLabel(harness);
    const notice = accountProxyPoolNotice(status, harness);
    const pool = accountProxyAccountsForHarness(
      status?.accounts ?? [],
      harness,
    );
    const only = notice === null && pool.length === 1 ? pool[0] : undefined;
    const detail =
      notice ??
      (only === undefined
        ? `One of ${String(pool.length)} ${harnessLabel} accounts serves this chat`
        : null);
    const summary = (
      <UsageIndicatorAccountSummary
        providerLabel={harnessLabel}
        plan={only ? accountProxyPlanLabel(only) : undefined}
        account={only?.label}
        status={poolStatus(detail, only, nowMs)}
        limits={summaryLimits(only)}
        {...(cardsOn ? {} : { onManage })}
      />
    );
    if (!cardsOn) {
      return <div data-testid="usage-indicator-proxy-accounts">{summary}</div>;
    }
    return (
      <ProxyAccountsSection
        collapsed={sectionCollapsed}
        onToggle={toggleSection}
        onManage={onManage}
      >
        {summary}
      </ProxyAccountsSection>
    );
  }

  const shown = rows.slice(0, MAX_SHOWN_ACCOUNTS);
  const hidden = rows.length - shown.length;
  const moreNote =
    hidden > 0 ? (
      <p className="text-xs fg-tertiary">
        {rowsArePool
          ? hidden === 1
            ? '1 more account in the pool.'
            : `${String(hidden)} more accounts in the pool.`
          : hidden === 1
            ? '1 more account served this chat.'
            : `${String(hidden)} more accounts served this chat.`}
      </p>
    ) : null;
  const providerLabel = (row: ProxyUsageRow): string =>
    row.provider === undefined
      ? 'Account proxy'
      : accountProxyProviderLabel(row.provider);

  if (cardsOn) {
    const folds = shown.length > 1;
    return (
      <ProxyAccountsSection
        collapsed={sectionCollapsed}
        onToggle={toggleSection}
        onManage={onManage}
      >
        <div className="flex flex-col gap-1">
          {shown.map((row) => {
            const backAt = restingUntil(row.account);
            return (
              <UsageIndicatorAccountSummary
                key={row.accountKey}
                providerLabel={providerLabel(row)}
                plan={
                  row.account ? accountProxyPlanLabel(row.account) : undefined
                }
                account={row.name}
                status={cardStatus(row.account, nowMs)}
                limits={cardLimits(row.account, backAt)}
                detail={
                  backAt === undefined
                    ? row.share
                    : `Back at ${accountProxyClock(backAt)}`
                }
                icon={providerMark(row.provider)}
                disclosure={
                  folds
                    ? {
                        expanded: expandedAccounts[row.accountKey] === true,
                        onToggle: (): void => toggleAccount(row.accountKey),
                        leadLimitId: row.account
                          ? providerAccountUsageLeadWindowId(
                              projectAccountProxyUsageAccount(row.account),
                            )
                          : undefined,
                      }
                    : undefined
                }
              />
            );
          })}
          {moreNote}
        </div>
      </ProxyAccountsSection>
    );
  }

  return (
    <div
      data-testid="usage-indicator-proxy-accounts"
      className="flex flex-col gap-3"
    >
      {shown.map((row, index) => (
        <Fragment key={row.accountKey}>
          {index > 0 ? (
            <div
              aria-hidden="true"
              className="h-[var(--border-hairline)] shrink-0 bg-line-quaternary"
            />
          ) : null}
          <UsageIndicatorAccountSummary
            providerLabel={providerLabel(row)}
            plan={row.account ? accountProxyPlanLabel(row.account) : undefined}
            account={row.name}
            status={rowStatus(row, nowMs)}
            limits={summaryLimits(row.account)}
            onManage={onManage}
          />
        </Fragment>
      ))}
      {moreNote}
    </div>
  );
}

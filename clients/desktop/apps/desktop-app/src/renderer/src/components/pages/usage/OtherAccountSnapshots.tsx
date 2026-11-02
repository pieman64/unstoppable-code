/* eslint-disable react-refresh/only-export-components -- exports the shared
   `computeRelevantAccountSnapshots` helper (reused by the account change modal)
   alongside the display components; splitting them would fragment a single
   cohesive snapshot module. */
import { type JSX, useEffect, useMemo, useState } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  AgentProviderType,
  RetainedAccountUsageSnapshot,
} from '@canopy/desktop-shared/types';
import {
  computeAccountKey,
  snapshotHasFutureReset,
} from '@canopy/desktop-shared/lib/account-usage-snapshots';
import {
  Button,
  UsageRowList,
  UsageWindowRow,
} from '@canopy/ui-shared/components';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import { buildSubCards } from './usage-sub-cards';
import { ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

interface OtherAccountSnapshotsProps {
  provider: AgentProviderType;
  activeEmail: string | undefined;
  activeSubscriptionLabel: string | undefined;
  snapshots: RetainedAccountUsageSnapshot[];
  nowMs: number;
}

/**
 * Filters retained snapshots to the "other accounts" set worth surfacing for a
 * provider: same provider, not the currently-active account, and still within a
 * future reset window. Shared by the inline usage-card section and the account
 * change modal so both compute an identical relevant set.
 */
export function computeRelevantAccountSnapshots(
  provider: AgentProviderType,
  activeEmail: string | undefined,
  activeSubscriptionLabel: string | undefined,
  snapshots: RetainedAccountUsageSnapshot[],
  nowMs: number,
): RetainedAccountUsageSnapshot[] {
  const activeAccountKey = computeAccountKey(
    provider,
    activeEmail,
    activeSubscriptionLabel,
  );
  if (activeAccountKey === null) {
    return [];
  }
  return snapshots
    .filter((snapshot) => snapshot.provider === provider)
    .filter((snapshot) => snapshot.accountKey !== activeAccountKey)
    .filter((snapshot) => snapshotHasFutureReset(snapshot.rateLimits, nowMs));
}

function accountTypeLabel(snapshot: RetainedAccountUsageSnapshot): string {
  return snapshot.subscriptionLabel ?? 'Account';
}

function accountEmailLabel(snapshot: RetainedAccountUsageSnapshot): string {
  return snapshot.accountEmail ?? snapshot.accountKey;
}

/** Single-line label for the account dropdown / picker options. */
function accountOptionLabel(snapshot: RetainedAccountUsageSnapshot): string {
  const type = accountTypeLabel(snapshot);
  return snapshot.accountEmail ? `${type} · ${snapshot.accountEmail}` : type;
}

interface OtherAccountSnapshotsPanelProps {
  provider: AgentProviderType;
  /** Snapshots already narrowed via {@link computeRelevantAccountSnapshots}. */
  snapshots: RetainedAccountUsageSnapshot[];
  nowMs: number;
  /** Extra classes on the panel root (e.g. spacing when embedded). */
  className?: string;
}

/**
 * The snapshot UI — a static label for one account or an account picker for
 * several accounts, remaining-limit sub-cards for the selected account, and a
 * collection timestamp. Assumes `snapshots` is the already-relevant set;
 * renders nothing when empty. Reused by the inline usage-card section and the
 * account change modal's expandable panel.
 */
export function OtherAccountSnapshotsPanel({
  provider,
  snapshots,
  nowMs,
  className = '',
}: OtherAccountSnapshotsPanelProps): JSX.Element | null {
  const [selectedAccountKey, setSelectedAccountKey] = useState<string | null>(
    () => snapshots[0]?.accountKey ?? null,
  );

  useEffect(() => {
    if (
      snapshots.length > 0 &&
      !snapshots.some((snapshot) => snapshot.accountKey === selectedAccountKey)
    ) {
      setSelectedAccountKey(snapshots[0].accountKey);
    }
  }, [selectedAccountKey, snapshots]);

  if (snapshots.length === 0) {
    return null;
  }

  const selected =
    snapshots.find((snapshot) => snapshot.accountKey === selectedAccountKey) ??
    snapshots[0];
  const cards = buildSubCards(provider, selected.rateLimits);
  const capturedLabel = new Date(selected.capturedAt).toLocaleString();

  return (
    <div className={`space-y-3 ${className}`}>
      <p className="text-xs fg-secondary">
        Usage snapshots collected from recently used accounts where reset
        windows are still relevant.
      </p>

      {snapshots.length > 1 ? (
        <select
          aria-label="Select account snapshot"
          data-testid={`other-account-select-${provider}`}
          value={selected.accountKey}
          onChange={(event): void => {
            setSelectedAccountKey(event.target.value);
          }}
          className="w-full truncate rounded-md border bg-base px-2 py-1.5 text-s fg-primary"
        >
          {snapshots.map((snapshot) => (
            // Each option names an account's email. A native option cannot
            // hold a span, so session replay blocks the whole option.
            <option
              key={snapshot.accountKey}
              value={snapshot.accountKey}
              className={POSTHOG_REPLAY_BLOCK_CLASS}
            >
              {accountOptionLabel(snapshot)}
            </option>
          ))}
        </select>
      ) : (
        <div
          data-testid={`other-account-single-${provider}`}
          className="min-w-0"
        >
          <div className="truncate text-xs font-medium fg-primary">
            {capitalizeFirstLetter(accountTypeLabel(selected))}
          </div>
          {/* Session replay blocks the other account's email. */}
          <div
            className={`truncate text-2xs fg-secondary ${POSTHOG_REPLAY_BLOCK_CLASS}`}
          >
            {accountEmailLabel(selected)}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <UsageRowList>
          {cards.map((card) => (
            <UsageWindowRow
              key={`${selected.accountKey}-${card.key}`}
              window={card}
              nowMs={nowMs}
            />
          ))}
        </UsageRowList>
        <p className="px-0.5 text-xs fg-tertiary">Collected {capturedLabel}</p>
      </div>
    </div>
  );
}

export function OtherAccountSnapshots({
  provider,
  activeEmail,
  activeSubscriptionLabel,
  snapshots,
  nowMs,
}: OtherAccountSnapshotsProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);

  const relevant = useMemo(
    () =>
      computeRelevantAccountSnapshots(
        provider,
        activeEmail,
        activeSubscriptionLabel,
        snapshots,
        nowMs,
      ),
    [provider, activeEmail, activeSubscriptionLabel, snapshots, nowMs],
  );

  if (relevant.length === 0) {
    return null;
  }

  return (
    <div className="mt-1.5">
      <Button
        variant="ghost"
        size="compact"
        onClick={(): void => setExpanded((value) => !value)}
        data-testid={`other-account-snapshots-toggle-${provider}`}
        aria-expanded={expanded}
      >
        <AppCatalogChevronRightMediumIcon
          size={14}
          className={`shrink-0 transition-transform motion-reduce:transition-none ${
            expanded ? 'rotate-90' : ''
          }`}
          aria-hidden="true"
        />
        <span>Other account snapshots</span>
      </Button>

      {expanded && (
        <OtherAccountSnapshotsPanel
          provider={provider}
          snapshots={relevant}
          nowMs={nowMs}
          className="mt-1.5"
        />
      )}
    </div>
  );
}

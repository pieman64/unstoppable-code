'use client';

import { useState, type JSX } from 'react';
import { ChevronRightIcon } from '@canopy/ui-shared/icons';
import { ItemListSection, type ActivityListItem } from './ItemListSection';

export interface RepoGroupedEntry {
  readonly repoId?: string;
  readonly repoName?: string;
  readonly target?: string;
  /** Active run inside this entry; keeps its repo bucket auto-expanded. */
  readonly running?: boolean;
  readonly item: ActivityListItem;
}

export interface RepoBucket {
  readonly repoId: string;
  readonly repoName: string;
  readonly entries: RepoGroupedEntry[];
}

export function groupByRepo(entries: readonly RepoGroupedEntry[]): {
  repoless: RepoGroupedEntry[];
  repos: RepoBucket[];
} {
  const repoless: RepoGroupedEntry[] = [];
  const repos = new Map<string, RepoBucket>();
  for (const entry of entries) {
    if (entry.target !== 'workspace-repo' || !entry.repoId) {
      repoless.push(entry);
      continue;
    }
    const bucket = repos.get(entry.repoId);
    if (bucket) bucket.entries.push(entry);
    else
      repos.set(entry.repoId, {
        repoId: entry.repoId,
        repoName: entry.repoName ?? entry.repoId,
        entries: [entry],
      });
  }
  return { repoless, repos: Array.from(repos.values()) };
}

export interface RepoGroupedItemListSectionProps {
  readonly entries: readonly RepoGroupedEntry[];
  readonly kind: 'scripts' | 'hooks';
}

export function RepoGroupedItemListSection({
  entries,
  kind,
}: RepoGroupedItemListSectionProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  if (entries.length === 0)
    return (
      <p
        className="text-xs fg-secondary"
        data-testid={`activity-${kind}-empty`}
      >
        No {kind}.
      </p>
    );
  const grouped = groupByRepo(entries);
  return (
    <div className="space-y-2" data-testid={`activity-${kind}`}>
      {grouped.repoless.length > 0 && (
        <ItemListSection
          emptyLabel={`No ${kind}.`}
          items={grouped.repoless.map((entry) => entry.item)}
        />
      )}
      {grouped.repos.map((bucket) => {
        const hasRunningChild = bucket.entries.some(
          (entry) => entry.running === true,
        );
        const open = expanded.has(bucket.repoId) || hasRunningChild;
        return (
          <div key={bucket.repoId}>
            <button
              type="button"
              aria-expanded={open}
              onClick={(): void =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(bucket.repoId)) next.delete(bucket.repoId);
                  else next.add(bucket.repoId);
                  return next;
                })
              }
              className="focus-ring flex w-full items-center gap-1.5 rounded-lg border bg-fg-primary/[0.03] px-2.5 py-2 text-left text-xs font-medium fg-primary/80 transition-colors hover:bg-fg-primary/[0.05]"
              data-testid={`portal-${kind}-repo-header`}
            >
              <ChevronRightIcon
                width={14}
                height={14}
                className={`transition-transform ${open ? 'rotate-90' : ''}`}
              />
              <span className="flex-1">{bucket.repoName}</span>
              <span className="text-3xs font-normal fg-secondary/60">
                {bucket.entries.length} {kind}
              </span>
            </button>
            {open && (
              <div className="mt-1 pl-4">
                <ItemListSection
                  emptyLabel={`No ${kind}.`}
                  items={bucket.entries.map((entry) => entry.item)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

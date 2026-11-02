import { useState, type JSX } from 'react';
import type { PanelKind } from '@canopy/protocol';
import {
  PanelEmptyGroupCatalog,
  type PanelEmptyGroupCatalogEntry,
} from '@canopy/ui-shared/components/panels';
import {
  AutomationsIcon,
  FilesIcon,
  TerminalIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { PanelEmptyGroupActions } from '@canopy/ui-app/panel-grid-surface';
import { addEmptyFileTabPanelToGroup } from '@/lib/panels/addChatPanel';
import {
  listAddablePanels,
  type AddablePanelEntry,
} from '@/lib/panels/registry';
import {
  createBrowserPanel,
  createTerminalPanel,
} from '@/lib/panels/panel-creation-actions';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';

export interface PanelSurfacePickerProps {
  readonly worktreeKey: string;
  /** The group the chosen surface opens in. */
  readonly groupId: string;
  readonly addTab: PanelEmptyGroupActions['addTab'];
  /** Runs after a surface opened (a new tab closes itself here). */
  readonly onOpened?: () => void;
  /** Kinds this surface cannot host (read-only scopes, popouts). */
  readonly excludeKinds?: readonly PanelKind[];
  readonly testId?: string;
}

/**
 * Early access: everything that can be opened in a group, one row each, in
 * the `+` menu's order: File, the one-of-a-kind surfaces, Memory, Terminal,
 * Plans, Usage, and Automations. Rows with variants (Terminal, Usage,
 * Automations) open the default one. Shown by an empty Side Panel and by a
 * new tab.
 */
export function PanelSurfacePicker({
  worktreeKey,
  groupId,
  addTab,
  onOpened,
  excludeKinds,
  testId = 'side-panel-empty-state',
}: PanelSurfacePickerProps): JSX.Element {
  // Re-read the catalog when the layout changes: a surface already open
  // elsewhere in the worktree drops out of the list.
  usePanelLayoutStore((state) => state.layouts[worktreeKey]);
  const [busy, setBusy] = useState<PanelKind | null>(null);

  const create = (kind: PanelKind, run: () => Promise<boolean>): void => {
    if (busy !== null) return;
    setBusy(kind);
    void run()
      .then((opened) => {
        if (opened) onOpened?.();
      })
      .finally(() => setBusy(null));
  };
  const open = (
    kind: PanelKind,
    opts?: Parameters<PanelEmptyGroupActions['addTab']>[1],
  ): void => {
    addTab(kind, opts);
    onOpened?.();
  };

  const catalog = listAddablePanels(worktreeKey).filter(
    (entry) => !excludeKinds?.includes(entry.kind),
  );
  const row = (
    key: string,
    entry: AddablePanelEntry,
    label: string = entry.label,
  ): PanelEmptyGroupCatalogEntry => ({
    key,
    label,
    icon: entry.icon,
    testId: `side-panel-empty-item-${key}`,
    disabled: busy !== null,
    busy: busy === entry.kind,
    onActivate:
      entry.kind === 'browser'
        ? (): void =>
            create('browser', () => createBrowserPanel(worktreeKey, groupId))
        : (): void =>
            open(
              entry.kind,
              entry.instance !== undefined
                ? { instance: entry.instance, title: label }
                : undefined,
            ),
  });
  const section = (sectionId: string): AddablePanelEntry | undefined =>
    catalog.find(
      (entry) =>
        entry.kind === 'activity-card' &&
        entry.instance?.sectionId === sectionId,
    );
  const firstOf = (group: string): AddablePanelEntry | undefined =>
    catalog.find((entry) => entry.group === group);

  const entries: PanelEmptyGroupCatalogEntry[] = [];
  if (!excludeKinds?.includes('file-diff')) {
    entries.push({
      key: 'file',
      label: 'File',
      icon: <FilesIcon />,
      testId: 'side-panel-empty-item-file',
      disabled: busy !== null,
      onActivate: (): void => {
        if (addEmptyFileTabPanelToGroup(worktreeKey, groupId) !== null) {
          onOpened?.();
        }
      },
    });
  }
  for (const entry of catalog) {
    if (
      entry.instance === undefined &&
      entry.group === undefined &&
      entry.kind !== 'chat' &&
      entry.kind !== 'new-tab' &&
      // Activity opens from its own card, section by section.
      entry.kind !== 'activity-section'
    ) {
      entries.push(row(entry.kind, entry));
    }
  }
  const memory = section('memory');
  if (memory !== undefined) entries.push(row('memory', memory));
  if (!excludeKinds?.includes('terminal')) {
    entries.push({
      key: 'terminal',
      label: 'Terminal',
      icon: <TerminalIcon />,
      testId: 'side-panel-empty-item-terminal',
      disabled: busy !== null,
      busy: busy === 'terminal',
      onActivate: (): void =>
        create('terminal', () => createTerminalPanel(worktreeKey, groupId)),
    });
  }
  const plans = section('plans');
  if (plans !== undefined) entries.push(row('plans', plans, 'Plans'));
  const usage = firstOf('usage');
  if (usage !== undefined) entries.push(row('usage', usage, 'Usage'));
  const automations = firstOf('automations');
  if (automations !== undefined) {
    entries.push({
      ...row('automations', automations, 'Automations'),
      icon: <AutomationsIcon size={14} />,
    });
  }

  return (
    <PanelEmptyGroupCatalog title="Open…" entries={entries} testId={testId} />
  );
}

export interface SidePanelEmptyStateProps {
  readonly worktreeKey: string;
  readonly groupId: string;
  readonly actions: PanelEmptyGroupActions;
  readonly excludeKinds?: readonly PanelKind[];
}

/** Early access: an empty Side Panel shows the surface picker. */
export function SidePanelEmptyState({
  worktreeKey,
  groupId,
  actions,
  excludeKinds,
}: SidePanelEmptyStateProps): JSX.Element {
  return (
    <PanelSurfacePicker
      worktreeKey={worktreeKey}
      groupId={groupId}
      addTab={actions.addTab}
      {...(excludeKinds !== undefined ? { excludeKinds } : {})}
    />
  );
}

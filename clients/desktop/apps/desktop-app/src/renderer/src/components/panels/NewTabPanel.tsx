import type { JSX } from 'react';
import { findPanelLocation } from '@/lib/panels/panel-reveal';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { PanelSurfacePicker } from './SidePanelEmptyState';

export interface NewTabPanelProps {
  readonly panelId: string;
  readonly worktreeKey: string;
}

/**
 * A new tab: the `+` button's empty tab. It lists what can be opened and,
 * once a surface opens, closes itself so the chosen panel takes its place.
 */
export function NewTabPanel({
  panelId,
  worktreeKey,
}: NewTabPanelProps): JSX.Element {
  // Strings, so the selectors stay stable between store updates.
  const layoutKey = usePanelLayoutStore(
    () => findPanelLocation(worktreeKey, panelId)?.layoutKey ?? null,
  );
  const groupId = usePanelLayoutStore(
    () => findPanelLocation(worktreeKey, panelId)?.groupId ?? null,
  );
  if (layoutKey === null || groupId === null) return <></>;
  return (
    <PanelSurfacePicker
      worktreeKey={worktreeKey}
      groupId={groupId}
      testId="new-tab-picker"
      addTab={(kind, opts): void => {
        usePanelLayoutStore.getState().addTab(layoutKey, groupId, kind, {
          ...(opts?.title !== undefined ? { title: opts.title } : {}),
          ...(opts?.instance !== undefined ? { instance: opts.instance } : {}),
        });
      }}
      onOpened={(): void => {
        usePanelLayoutStore.getState().closeTab(layoutKey, groupId, panelId);
      }}
    />
  );
}

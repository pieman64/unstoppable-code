'use client';

import { lazy, Suspense, type JSX } from 'react';
import type { WorkspaceSettingsDialogProps } from './WorkspaceSettingsDialog';

const LazyWorkspaceSettingsDialog = lazy(() =>
  import('./WorkspaceSettingsDialog').then((module) => ({
    default: module.WorkspaceSettingsDialog,
  })),
);

/**
 * {@link WorkspaceSettingsDialogProps | WorkspaceSettingsDialog}, loaded when
 * the dialog first opens. The sidebar renders this so the web chat routes,
 * whose first load is budgeted, do not carry the dialog until it is needed.
 */
export function DeferredWorkspaceSettingsDialog(
  props: WorkspaceSettingsDialogProps,
): JSX.Element {
  return (
    <Suspense fallback={null}>
      <LazyWorkspaceSettingsDialog {...props} />
    </Suspense>
  );
}

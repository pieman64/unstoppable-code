/* eslint-disable react-refresh/only-export-components */
import { useMemo, type JSX } from 'react';
import {
  PanelContentRoot as SharedPanelContentRoot,
  type PanelContentRootProps as SharedPanelContentRootProps,
} from '@canopy/ui-app/panel-content-root';
import { panelErrorBoundaryHost } from '@/lib/desktop-error-boundary-host';
import { renderPanelContent } from '@/lib/panels/registry';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';

export type PanelContentRootProps = Omit<
  SharedPanelContentRootProps,
  'renderPanelContent' | 'auxLayoutKeys' | 'errorHost'
>;

export function PanelContentRoot(props: PanelContentRootProps): JSX.Element {
  const auxWindows = usePanelWindowsStore((state) => state.auxWindows);
  const auxLayoutKeys = useMemo(
    () => Object.values(auxWindows).map((record) => record.layoutKey),
    [auxWindows],
  );
  return (
    <SharedPanelContentRoot
      {...props}
      renderPanelContent={renderPanelContent}
      auxLayoutKeys={auxLayoutKeys}
      errorHost={panelErrorBoundaryHost}
    />
  );
}

export {
  acquirePanelContentElement,
  resetPanelContentContainersForTests,
} from '@canopy/ui-app/panel-content-root';

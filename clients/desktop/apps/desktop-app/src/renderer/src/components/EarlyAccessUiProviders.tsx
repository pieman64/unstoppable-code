import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import {
  ChatLookProvider,
  ContextMenuPlacementProvider,
  IconStyleProvider,
  LoadingIndicatorStyleProvider,
  PrHoverCardsProvider,
  SpinnerStyleProvider,
  SubagentsViewProvider,
  TooltipStackingProvider,
} from '@canopy/ui-shared/components';
import { PanelTabLiveReorderContext } from '@canopy/ui-shared/components/panels/panel-tab-live-reorder-context';
import { usePanelTabLiveReorder } from '@canopy/ui-shared/components/panels/use-panel-tab-live-reorder';
import type { JSX, ReactNode } from 'react';

/**
 * Comet spinners, the Subagents view, the clean chat look and Pull request
 * cards follow their independent Labs choices. Providers stay
 * mounted while their values change; the other presentation styles are standard. Live tab reorder
 * is supplied once; only filled panel tabs use it.
 */
export function EarlyAccessUiProviders({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const comet = useLabsExperimentEnabled('comet-spinners');
  const subagentsView = useLabsExperimentEnabled('subagents-view');
  const cleanChat = useLabsExperimentEnabled('clean-chat');
  const prHoverCards = useLabsExperimentEnabled('pr-hover-cards');

  return (
    <PanelTabLiveReorderContext.Provider value={usePanelTabLiveReorder}>
      <SpinnerStyleProvider value={comet ? 'comet' : 'dots'}>
        <ContextMenuPlacementProvider value="cursor">
          <TooltipStackingProvider value={'single'}>
            <LoadingIndicatorStyleProvider value={'spinner'}>
              <IconStyleProvider value={'central'}>
                <SubagentsViewProvider value={subagentsView}>
                  <ChatLookProvider value={cleanChat ? 'clean' : 'classic'}>
                    <PrHoverCardsProvider value={prHoverCards}>
                      {children}
                    </PrHoverCardsProvider>
                  </ChatLookProvider>
                </SubagentsViewProvider>
              </IconStyleProvider>
            </LoadingIndicatorStyleProvider>
          </TooltipStackingProvider>
        </ContextMenuPlacementProvider>
      </SpinnerStyleProvider>
    </PanelTabLiveReorderContext.Provider>
  );
}

import type { JSX } from 'react';
import { McpSignInStrip } from '@canopy/ui-app/capability';
import {
  useSelectedMcpSignIn,
  type SelectedMcpSignInOptions,
} from '@/components/mcp/useSelectedMcpSignIn';

export type HomeMcpSignInStripProps = SelectedMcpSignInOptions;

export function HomeMcpSignInStrip(
  props: HomeMcpSignInStripProps,
): JSX.Element {
  const model = useSelectedMcpSignIn(props);
  return (
    <>
      <McpSignInStrip
        selectionKey={`${props.ownerKey ?? 'default'}/${JSON.stringify(props.selections)}`}
        onRetryInventory={(): void => {
          void model.refresh();
        }}
        servers={model.rows}
        loading={model.loading}
        connectingKey={model.connectingKey}
        onConnect={model.onConnect}
        onCancelSignIn={(): void => model.cancelConnect()}
        getRowNavigation={model.getRowNavigation}
        getRowSettings={model.getRowSettings}
        renderRowExtra={model.renderRowExtra}
        notice={model.notice}
      />
      {model.dialogs}
    </>
  );
}

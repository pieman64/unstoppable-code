import {
  dispatchEditorSetupAction,
  type EditorSetupPort,
} from '@canopy/agent-actions/families/editor-setup/dispatch';
import type { EditorSetupAction } from '@canopy/agent-actions/families/editor-setup/actions';
import type { AgentActionResponse } from '@canopy/agent-actions';
import type { AppAdvisorToolRuntime } from '../app-advisor/runtime';

/** App Advisor's presentation port. No scan or consent is delegated to an agent. */
export function dispatchDesktopEditorSetupReview(
  action: EditorSetupAction,
  runtime: AppAdvisorToolRuntime,
  requestId?: string,
  expectedUiRevision?: number,
  signal?: AbortSignal,
): Promise<AgentActionResponse<string>> {
  const port: EditorSetupPort<AppAdvisorToolRuntime> = {
    openReview: (input, call) =>
      call.host.dispatchRendererAction(
        { type: 'navigation.open_editor_setup', ...input },
        expectedUiRevision,
        requestId,
        call.signal,
      ),
  };
  return dispatchEditorSetupAction(action, port, { host: runtime, signal });
}

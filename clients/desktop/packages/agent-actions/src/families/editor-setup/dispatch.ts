import type { AgentActionResponse } from '../../response';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionFamily,
} from '../../surface/family';
import {
  EDITOR_SETUP_ACTION_TYPES,
  editorSetupActionSchema,
  type EditorSetupAction,
} from './actions';
import { editorSetupActionCatalog } from './catalog';

/** Host-owned navigation. This port grants no filesystem or policy access. */
export interface EditorSetupPort<H> {
  openReview(
    input: { workspaceId?: string },
    call: AgentActionCall<H>,
  ): Promise<AgentActionResponse<string>>;
}

export function dispatchEditorSetupAction<H>(
  action: EditorSetupAction,
  port: EditorSetupPort<H>,
  call: AgentActionCall<H>,
): Promise<AgentActionResponse<string>> {
  return port.openReview(
    { ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}) },
    call,
  );
}

export function createEditorSetupActionFamily<H>(
  port: EditorSetupPort<H>,
): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'editor-setup',
    types: EDITOR_SETUP_ACTION_TYPES,
    actionSchema: editorSetupActionSchema,
    catalog: () => editorSetupActionCatalog,
    supportedTypes: (capabilities) =>
      EDITOR_SETUP_ACTION_TYPES.filter((type) =>
        capabilities.actionTypes.includes(type),
      ),
    dispatch: (action, call) => dispatchEditorSetupAction(action, port, call),
  });
}

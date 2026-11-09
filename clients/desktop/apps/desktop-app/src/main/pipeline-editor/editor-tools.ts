import {
  canopyJsonValueSchemaWithin,
  INTERFACE_TOOL_INPUT_MAX_BYTES,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  type PipelineEditorRendererToolResponse,
} from '@canopy/desktop-shared/types';
import { getSessionInterfaceToolRegistry } from '../agents/interface-tool-binding';
import {
  pipelineEditorOutcomeToResponse,
  pipelineEditorSurfaceUnavailableResponse,
} from '../ipc/pipeline-editor';

export type PipelineEditorInterfaceToolName = Extract<
  InterfaceToolName,
  `ui.pipeline_editor.${string}`
>;

const inputSchema = canopyJsonValueSchemaWithin(INTERFACE_TOOL_INPUT_MAX_BYTES);

/** The interface tools the live session of this Pipeline Editor chat was created with. */
export async function boundPipelineEditorInterfaceTools(
  chatId: string,
): Promise<readonly InterfaceToolName[]> {
  const { getActiveSessionCapabilityProfile } =
    await import('../agents/session-manager');
  return (
    getActiveSessionCapabilityProfile(
      PIPELINE_EDITOR_PROJECT_ID,
      PIPELINE_EDITOR_WORKTREE_ID,
      chatId,
    )?.interfaceTools ?? []
  );
}

/**
 * CAN-5822: one Pipeline Editor tool, served by the main window's interface
 * lease. A session that did not bind it, or no registry, gets today's
 * unavailable response with no delivery. The reply carries `requestId`, the
 * id the tool result always showed, not the lease's call id.
 */
export async function invokePipelineEditorTool(input: {
  toolName: PipelineEditorInterfaceToolName;
  requestId: string;
  chatId: string;
  boundTools: readonly InterfaceToolName[];
  args?: Record<string, unknown>;
}): Promise<PipelineEditorRendererToolResponse> {
  const { toolName, requestId, chatId } = input;
  const registry = getSessionInterfaceToolRegistry();
  if (!registry || !input.boundTools.includes(toolName))
    return pipelineEditorSurfaceUnavailableResponse(requestId);
  const serialized: unknown = JSON.parse(
    JSON.stringify({ ...input.args, originChatId: chatId }),
  );
  const parsed = inputSchema.safeParse(serialized);
  if (
    !parsed.success ||
    typeof parsed.data !== 'object' ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  )
    return {
      requestId,
      ok: false,
      error: 'The request is too large to send to the Pipeline Editor.',
    };
  const outcome = await registry.invoke({
    toolName,
    input: parsed.data,
    scope: {
      workspaceId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId,
    },
  });
  return pipelineEditorOutcomeToResponse(outcome, requestId);
}

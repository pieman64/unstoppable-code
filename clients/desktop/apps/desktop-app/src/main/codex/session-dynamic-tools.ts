import type { AssistantMode } from '@canopy/desktop-shared/types';
import type { DynamicToolSpec } from '@canopy/desktop-shared/node/codex-runtime/generated/v2/DynamicToolSpec';
import { buildAppAdvisorDynamicToolSpecs } from '../app-advisor/codex-dynamic-tools';
import { buildPipelineEditorDynamicToolSpecs } from '../pipeline-editor/codex-dynamic-tools';
import { buildCanopyDynamicToolSpecs } from './canopy-dynamic-tools';
import type { AiGatewayToolSchemaProfile } from '@canopy/protocol/ai-gateway-models';

export function buildCodexSessionDynamicToolSpecs(options: {
  assistantMode?: AssistantMode;
  workspaceMode: 'cowork' | 'worktree';
  isCodeReview: boolean;
  includeCodeGraph: boolean;
  includeChatVisuals: boolean;
  /** Only for a session that passed the Ledger exposure gate. */
  includeLedger?: boolean;
  toolSchemaProfile: AiGatewayToolSchemaProfile;
}): DynamicToolSpec[] {
  if (options.assistantMode === 'app-advisor') {
    return buildAppAdvisorDynamicToolSpecs({
      includeLedger: options.includeLedger === true,
    });
  }
  if (options.assistantMode === 'pipeline-editor') {
    return buildPipelineEditorDynamicToolSpecs();
  }
  return buildCanopyDynamicToolSpecs({
    mode: options.workspaceMode,
    includeCodeGraph: options.includeCodeGraph,
    includeChatVisuals: options.includeChatVisuals,
    includeLedger: options.includeLedger === true,
    isCodeReview: options.isCodeReview,
    toolSchemaProfile: options.toolSchemaProfile,
  });
}

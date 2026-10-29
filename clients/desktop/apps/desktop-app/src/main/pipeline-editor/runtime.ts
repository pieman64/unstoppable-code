import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type {
  AgentProviderType,
  ChatModel,
  ChatTabPluginSelections,
  McpQuestion,
  McpQuestionAnswer,
  PipelineEditorRendererToolResponse,
  PipelineEditorRow,
} from '@canopy/desktop-shared/types';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  type PipelineEditorRendererToolRequest,
} from '@canopy/desktop-shared/types';
import { ASK_USER_TIMEOUT_MS } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { type CanopyInjectedToolRuntime } from '../canopy-tools/core';
import type { ScriptOutputSnapshot } from '../mcp/script-output';
import { requestAnswersFromRenderer } from '../canopy-tools/session-runtime';
import { requestPipelineEditorRendererTool } from '../ipc/pipeline-editor';
import type { PipelineEditorAction } from './definitions';
import {
  getBuiltinActionDefinition,
  type BuiltinActionDefinitionResult,
} from './builtin-actions';

export interface PipelineEditorToolRuntime extends CanopyInjectedToolRuntime {
  dispatchEditorAction(
    action: PipelineEditorAction,
    requestId?: string,
  ): Promise<PipelineEditorRendererToolResponse>;
  requestEditorState(
    requestId?: string,
  ): Promise<PipelineEditorRendererToolResponse>;
  listPipelines(requestId?: string): Promise<PipelineEditorRow[]>;
  /**
   * Resolve the raw `action.yml` for a bundled builtin action. Reads the
   * brand-prepared bundled resources in the main process — no renderer
   * round-trip — so it is synchronous.
   */
  getBuiltinActionDefinition(name: string): BuiltinActionDefinitionResult;
}

export interface PipelineEditorToolRuntimeSurfaces {
  getMainWindow: () => BrowserWindow | null;
}

export interface PipelineEditorToolRuntimeIdentity {
  projectId: string;
  worktreeId: string;
  chatId: string;
  providerType: AgentProviderType;
  model?: ChatModel;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
}

function unavailableScriptOutput(message: string): ScriptOutputSnapshot {
  return {
    found: false,
    lines: [],
    error: `surface_unavailable: ${message}`,
  };
}

function requestForAction(
  action: PipelineEditorAction,
  requestId: string,
  originChatId: string,
): PipelineEditorRendererToolRequest {
  switch (action.type) {
    case 'pipeline.list':
      return { kind: 'list', requestId, originChatId };
    case 'pipeline.open':
      return { kind: 'open', requestId, originChatId, locator: action.locator };
    case 'pipeline.create':
      return { kind: 'create', requestId, originChatId };
    case 'pipeline.get_current':
      return { kind: 'get_current', requestId, originChatId };
    case 'pipeline.set_yaml':
      return { kind: 'set_yaml', requestId, originChatId, yaml: action.yaml };
    case 'pipeline.save':
      return { kind: 'save', requestId, originChatId };
    case 'navigation.to_list':
      return { kind: 'to_list', requestId, originChatId };
  }
}

export function createPipelineEditorToolRuntime(
  surfaces: PipelineEditorToolRuntimeSurfaces,
  identity: PipelineEditorToolRuntimeIdentity,
): PipelineEditorToolRuntime {
  return {
    deferredToolsRuntime: {
      scope: {
        projectId: identity.projectId,
        worktreeId: identity.worktreeId,
        chatId: identity.chatId,
      },
      providerType: identity.providerType,
      interfaceMode: 'canopy',
      assistantMode: 'pipeline-editor',
      pluginSelections: identity.pluginSelections,
      allowed: identity.deferredToolsAllowed !== false,
    },

    requestUserAnswers: (
      questions: McpQuestion[],
      options?: { toolUseId?: string; signal?: AbortSignal },
    ): Promise<McpQuestionAnswer[]> =>
      requestAnswersFromRenderer({
        sessionKey: `${identity.projectId}/${identity.worktreeId}/${identity.chatId}`,
        projectId: identity.projectId,
        worktreeId: identity.worktreeId,
        chatId: identity.chatId,
        questions,
        getWindow: surfaces.getMainWindow,
        toolUseId: options?.toolUseId,
        providerType: identity.providerType,
        model: identity.model,
        askUserTimeoutMs: ASK_USER_TIMEOUT_MS,
        signal: options?.signal,
      }),

    loadScriptOutput: () =>
      Promise.resolve(
        unavailableScriptOutput(
          'Pipeline Editor chat is not attached to a real worktree script log.',
        ),
      ),

    dispatchEditorAction: (action, requestId = randomUUID()) =>
      requestPipelineEditorRendererTool(
        requestForAction(action, requestId, identity.chatId),
        surfaces,
      ),

    requestEditorState: (requestId = randomUUID()) =>
      requestPipelineEditorRendererTool(
        { kind: 'get_current', requestId, originChatId: identity.chatId },
        surfaces,
      ),

    listPipelines: async (
      requestId = randomUUID(),
    ): Promise<PipelineEditorRow[]> => {
      const response = await requestPipelineEditorRendererTool(
        { kind: 'list', requestId, originChatId: identity.chatId },
        surfaces,
      );
      if (!response.ok) {
        throw new Error(response.error ?? 'Failed to list pipelines.');
      }
      return response.pipelines ?? [];
    },

    getBuiltinActionDefinition: (name) => getBuiltinActionDefinition(name),

    worktreeWatcherRuntime: undefined,
    worktreeActionRuntime: undefined,
  };
}

export function assertPipelineEditorIdentity(
  projectId: string,
  worktreeId: string,
): void {
  if (
    projectId !== PIPELINE_EDITOR_PROJECT_ID ||
    worktreeId !== PIPELINE_EDITOR_WORKTREE_ID
  ) {
    throw new Error(
      'Pipeline Editor chat must use the pipeline-editor sentinel ids.',
    );
  }
}

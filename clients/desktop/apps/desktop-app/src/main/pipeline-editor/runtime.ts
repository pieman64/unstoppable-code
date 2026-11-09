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
  getRendererToolRequestScopeKey,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { ASK_USER_TIMEOUT_MS } from '@canopy/execution-engine/lib/canopy-injected-tools';
import { type CanopyInjectedToolRuntime } from '../canopy-tools/core';
import type { ScriptOutputSnapshot } from '../mcp/script-output';
import { requestAnswersFromRenderer } from '../canopy-tools/session-runtime';
import { parsePipelineEditorRendererToolResponse } from '../ipc/pipeline-editor';
import {
  boundPipelineEditorInterfaceTools,
  invokePipelineEditorTool,
  type PipelineEditorInterfaceToolName,
} from './editor-tools';
import { savePipelineEditorSnapshot } from './editor-save';
import { logMainProcessWarn } from '../lib/main-process-logging';
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

const INVALID_RESULT = 'The window returned an invalid result.';
const COMPLETED_RESPONSE_CACHE_LIMIT = 100;

// A provider can retry a tool call under the same tool use id. Keyed by chat
// plus request id, a retry joins the call in flight or gets its result, and
// never runs the editor action, or its save, a second time.
const inFlight = new Map<string, Promise<PipelineEditorRendererToolResponse>>();
const completed = new Map<string, PipelineEditorRendererToolResponse>();

function once(
  chatId: string,
  requestId: string,
  run: () => Promise<PipelineEditorRendererToolResponse>,
): Promise<PipelineEditorRendererToolResponse> {
  const key = getRendererToolRequestScopeKey(requestId, chatId);
  const cached = completed.get(key);
  if (cached) return Promise.resolve(cached);
  const running = inFlight.get(key);
  if (running) return running;
  const pending = run().then((response) => {
    completed.set(key, response);
    while (completed.size > COMPLETED_RESPONSE_CACHE_LIMIT) {
      const oldest = completed.keys().next().value;
      if (oldest === undefined) break;
      completed.delete(oldest);
    }
    return response;
  });
  inFlight.set(key, pending);
  void pending.finally(() => inFlight.delete(key)).catch(() => undefined);
  return pending;
}

/** Today's field order for a result built in main. */
function normalized(
  response: PipelineEditorRendererToolResponse,
): PipelineEditorRendererToolResponse {
  const parsed = parsePipelineEditorRendererToolResponse(response);
  if (!parsed)
    return { requestId: response.requestId, ok: false, error: INVALID_RESULT };
  delete parsed.snapshot;
  return parsed;
}

/**
 * CAN-5822: the window hands over its draft (`prepare_save`, or the YAML it
 * just applied for `set_yaml`); main saves it through core with the revision
 * the editor loaded, then the window adopts what core saved. A failed or
 * refused save leaves the editor's draft unsaved, never lost.
 */
async function saveFromWindow(
  prepared: PipelineEditorRendererToolResponse,
  call: (
    toolName: PipelineEditorInterfaceToolName,
    args?: Record<string, unknown>,
  ) => Promise<PipelineEditorRendererToolResponse>,
): Promise<PipelineEditorRendererToolResponse> {
  if (!prepared.ok) return normalized(prepared);
  const { snapshot } = prepared;
  if (!snapshot)
    return normalized({
      requestId: prepared.requestId,
      ok: false,
      error: INVALID_RESULT,
    });
  const outcome = await savePipelineEditorSnapshot(snapshot);
  // Reported whatever happened, so the editor frees its save guard. An
  // editor that cannot adopt keeps showing unsaved edits; its next save
  // is refused as stale rather than overwriting this one.
  const adopted = await call('ui.pipeline_editor.adopt_saved', {
    snapshotId: snapshot.id,
    ...(outcome.ok && outcome.saved ? { saved: outcome.saved } : {}),
  });
  if (!adopted.ok)
    logMainProcessWarn(
      '[pipeline-editor] the editor could not take its save report',
      adopted.error,
    );
  return normalized({
    requestId: prepared.requestId,
    ok: outcome.ok,
    ...(outcome.ok ? {} : { error: outcome.error }),
    ...(prepared.originChatId ? { originChatId: prepared.originChatId } : {}),
    ...(prepared.pipelineYaml === undefined
      ? {}
      : { pipelineYaml: prepared.pipelineYaml }),
    isDirty: outcome.ok ? false : (prepared.isDirty ?? true),
    ...(prepared.validation ? { validation: prepared.validation } : {}),
    readonly: false,
  });
}

async function runEditorAction(
  action: PipelineEditorAction,
  call: (
    toolName: PipelineEditorInterfaceToolName,
    args?: Record<string, unknown>,
  ) => Promise<PipelineEditorRendererToolResponse>,
): Promise<PipelineEditorRendererToolResponse> {
  switch (action.type) {
    case 'pipeline.list':
      return call('ui.pipeline_editor.list');
    case 'pipeline.open':
      return call('ui.pipeline_editor.open', { locator: action.locator });
    case 'pipeline.create':
      return call('ui.pipeline_editor.create');
    case 'pipeline.get_current':
      return call('ui.pipeline_editor.get_current');
    case 'pipeline.set_yaml':
      return saveFromWindow(
        await call('ui.pipeline_editor.set_yaml', { yaml: action.yaml }),
        call,
      );
    case 'pipeline.save':
      return saveFromWindow(
        await call('ui.pipeline_editor.prepare_save'),
        call,
      );
    case 'navigation.to_list':
      return call('ui.pipeline_editor.to_list');
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
      once(identity.chatId, requestId, async () => {
        const boundTools = await boundPipelineEditorInterfaceTools(
          identity.chatId,
        );
        return runEditorAction(action, (toolName, args) =>
          invokePipelineEditorTool({
            toolName,
            requestId,
            chatId: identity.chatId,
            boundTools,
            ...(args ? { args } : {}),
          }),
        );
      }),

    requestEditorState: (requestId = randomUUID()) =>
      once(identity.chatId, requestId, async () =>
        invokePipelineEditorTool({
          toolName: 'ui.pipeline_editor.get_current',
          requestId,
          chatId: identity.chatId,
          boundTools: await boundPipelineEditorInterfaceTools(identity.chatId),
        }),
      ),

    listPipelines: async (
      requestId = randomUUID(),
    ): Promise<PipelineEditorRow[]> => {
      const response = await once(identity.chatId, requestId, async () =>
        invokePipelineEditorTool({
          toolName: 'ui.pipeline_editor.list',
          requestId,
          chatId: identity.chatId,
          boundTools: await boundPipelineEditorInterfaceTools(identity.chatId),
        }),
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

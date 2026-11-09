import {
  createCorePipelineDefinitionHandlers,
  pipelineDefinitionError,
  type CorePipelineDefinitionHandlers,
  type CorePipelineDefinitionHost,
  type PipelineDefinitionService,
} from '@canopy/core-runtime/node/pipeline';
import type {
  CanopyCallerDescriptor,
  CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import { createPipelineDefinitionReplayStore } from '../pipelines/pipeline-definition-replay-store';
import { consumeSelfFilteringAgentRead } from './self-filtering-agent-reads';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

let desktopService: Promise<PipelineDefinitionService> | undefined;

// Loaded on the first call: the sources import the pipeline, cloud and
// sidebar modules, which import back into the runtime.
export const desktopPipelineDefinitionHost: CorePipelineDefinitionHost = {
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  replays: createPipelineDefinitionReplayStore(),
  load: () => {
    desktopService ??=
      import('../pipelines/core-pipeline-definition-sources').then((module) =>
        module.createDesktopPipelineDefinitionService(),
      );
    return desktopService;
  },
};

/** Which of `definitionIds` an agent calling from `scope` may not see (CAN-4551). */
export type AgentHiddenPipelines = (
  definitionIds: readonly string[],
  scope: CanopyWorkspaceScope,
) => Promise<ReadonlySet<string>>;

const desktopAgentHiddenPipelines: AgentHiddenPipelines = async (
  definitionIds,
  scope,
) => {
  const { agentHiddenOwnedPipelineIds } =
    await import('../automations/owned-pipeline');
  // Without the calling chat's place, no project grants access.
  return agentHiddenOwnedPipelineIds(definitionIds, {
    projectId: scope.workspaceId ?? '',
    worktreeId: scope.worktreeId ?? '',
  });
};

/** Agents call core as `mcp` principals; the window and Portal never do. */
const isAgentCaller = (caller: CanopyCallerDescriptor): boolean =>
  caller.interfaceKind === 'mcp';

/**
 * Which ids an agent caller may not see: checked against the place the call
 * names; a call that names no full place (a workspace and a worktree) sees
 * no owned workflow, unless main marked it as one of its self-filtering
 * reads.
 */
async function hiddenForCaller(
  hiddenFromAgents: AgentHiddenPipelines,
  caller: CanopyCallerDescriptor,
  definitionIds: readonly string[],
  scope: CanopyWorkspaceScope,
): Promise<ReadonlySet<string>> {
  if (!isAgentCaller(caller)) return new Set();
  // Main's shared agent resource-action reads (App Advisor and the worktree
  // pipeline actions) apply the rule with their own runtime's place.
  if (
    (scope.workspaceId === undefined || scope.worktreeId === undefined) &&
    consumeSelfFilteringAgentRead(caller)
  )
    return new Set();
  return hiddenFromAgents(definitionIds, scope);
}

/**
 * `core.pipeline.definition.*` handlers over the desktop's sources. Pipelines
 * an Orchestrator automation owns stay hidden from agent callers as missing,
 * exactly as from the agent tools before (CAN-4551, CAN-5991); the window
 * still reads them.
 */
export function createCorePipelineDefinitionAdapter(
  host: CorePipelineDefinitionHost = desktopPipelineDefinitionHost,
  hiddenFromAgents: AgentHiddenPipelines = desktopAgentHiddenPipelines,
): CorePipelineDefinitionHandlers {
  const handlers = createCorePipelineDefinitionHandlers(host);
  const list = handlers.queries['core.pipeline.definition.list'];
  const get = handlers.queries['core.pipeline.definition.get'];
  return {
    ...handlers,
    queries: {
      ...handlers.queries,
      'core.pipeline.definition.get': async (params, context) => {
        if (
          (
            await hiddenForCaller(
              hiddenFromAgents,
              context.caller,
              [params.definitionId],
              params.scope ?? {},
            )
          ).has(params.definitionId)
        )
          throw pipelineDefinitionError(
            'core.pipeline.definitionNotFound',
            `Workflow not found: ${params.definitionId}`,
          );
        return get(params, context);
      },
      'core.pipeline.definition.list': async (params, context) => {
        const result = await list(params, context);
        const hidden = await hiddenForCaller(
          hiddenFromAgents,
          context.caller,
          result.items.map((item) => item.definitionId),
          params.scope ?? {},
        );
        return hidden.size === 0
          ? result
          : {
              ...result,
              items: result.items.filter(
                (item) => !hidden.has(item.definitionId),
              ),
            };
      },
    },
  };
}

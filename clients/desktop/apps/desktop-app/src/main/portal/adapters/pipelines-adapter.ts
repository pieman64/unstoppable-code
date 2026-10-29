import { importCuratedPipeline } from '../../pipelines/curated-pipeline-catalog';
import { isCuratedCatalogKey } from '@canopy/protocol/plugin-catalog';
import { fitListResult, resultByteLength } from './result-budget';
import type {
  ChatStateSnapshot,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import {
  PORTAL_CATALOG_RESULT_MAX_BYTES,
  type PortalPipelineChatFollowUpOutput,
  type PortalPipelineChatFollowUpPrepareResult,
  type PortalPipelineDefinitionWireViewModel,
  type PortalPipelineExecutionListResult,
  type PortalPipelineGetResult,
  type PortalPipelineListResult,
} from '@canopy/protocol/portal';
import {
  cancelPipeline,
  getPipelineExecution,
  getPipeline,
  sharePortalPipeline,
  getPipelineLog,
  listPipelineExecutions,
  listPipelines,
  preparePipelineChatFollowUp,
  rerunPipeline,
  resumePipeline,
  retryPipeline,
  runPipeline,
} from '../../services/pipelines-service';
import type { PortalShareScope } from '@canopy/protocol/portal';
import type { PortalAdapterContext } from './types';
import { completePortalShareOffLoop } from './share-result';
import { queryPortalChatState } from './chat-state-query';
import { resolveTerminalDrivenChat } from '../../lib/terminal-driven-chat';
import {
  failServiceError,
  isRecord,
  requireWorktreeTarget,
} from './validation';
import { notifyDesktopInventoryChanged } from '../../services/desktop-inventory-sync-signals';
import { resolvePortalPipelineFileReferences } from '../portal-pipeline-file-references';

// Cap applied to required strings in the last-resort metadata fallback of
// fitPipelineGetResult. Worst-case JSON escaping is 6 bytes per character,
// so two capped strings stay far below PORTAL_CATALOG_RESULT_MAX_BYTES.
const METADATA_FALLBACK_MAX_CHARS = 2048;

/**
 * Prefix-cut a pipeline list to the portal catalog budget. Shared with the
 * cloud inventory sync (CAN-2830) so a synced document is byte-for-byte what
 * the live `portal.pipeline.list` command would have returned.
 */
export function fitPipelineListResult(
  pipelines: PortalPipelineListResult['pipelines'],
  options: {
    /**
     * The list is already known to be incomplete (a discovery bound cut
     * it): the marker is part of the sized result, so forcing it can never
     * push a fitted payload past the budget.
     */
    truncated?: boolean;
  } = {},
): PortalPipelineListResult {
  return fitListResult(
    pipelines,
    (rows, truncated): PortalPipelineListResult => ({
      pipelines: rows,
      ...(truncated ? { truncated: true } : {}),
    }),
    options.truncated,
  );
}

export function fitPipelineExecutionListResult(
  runs: PortalPipelineExecutionListResult['runs'],
  options: { truncated?: boolean } = {},
): PortalPipelineExecutionListResult {
  return fitListResult(
    runs,
    (rows, truncated): PortalPipelineExecutionListResult => ({
      runs: rows,
      ...(truncated ? { truncated: true } : {}),
    }),
    options.truncated,
  );
}

function definitionWithRowLimit(
  definition: PortalPipelineDefinitionWireViewModel,
  rowLimit: number,
): PortalPipelineDefinitionWireViewModel {
  let remaining = rowLimit;
  const jobs: PortalPipelineDefinitionWireViewModel['jobs'] = [];
  for (const job of definition.jobs) {
    if (remaining === 0) break;
    remaining -= 1;
    const stepCount = Math.min(job.steps.length, remaining);
    jobs.push({ ...job, steps: job.steps.slice(0, stepCount) });
    remaining -= stepCount;
    if (stepCount < job.steps.length) break;
  }
  return { ...definition, jobs };
}

function fitPipelineGetResult(
  result: PortalPipelineGetResult,
): PortalPipelineGetResult {
  if (resultByteLength(result) <= PORTAL_CATALOG_RESULT_MAX_BYTES) {
    return result;
  }

  const totalRows = result.definition.jobs.reduce(
    (count, job) => count + 1 + job.steps.length,
    0,
  );
  // The plan picker hydrates a shared pipeline's trigger inputs from this
  // result and from nowhere else (CAN-3021), so they are carried through the
  // cut rather than dropped with the definition rows — and they are counted
  // against the budget while the row limit is searched, so carrying them can
  // never push a fitted payload over. Only the last-resort fallback below,
  // which already caps every remaining field, gives them up.
  const preserved: Pick<
    PortalPipelineGetResult,
    'planReadyInputs' | 'dispatchInputs' | 'dispatchUnsupportedReason'
  > = {
    ...(result.planReadyInputs === undefined
      ? {}
      : { planReadyInputs: result.planReadyInputs }),
    // Mobile dispatch hydrates its form from here and nowhere else (CAN-3174).
    ...(result.dispatchInputs === undefined
      ? {}
      : { dispatchInputs: result.dispatchInputs }),
    ...(result.dispatchUnsupportedReason === undefined
      ? {}
      : { dispatchUnsupportedReason: result.dispatchUnsupportedReason }),
  };
  let low = 0;
  let high = totalRows;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate: PortalPipelineGetResult = {
      definition: definitionWithRowLimit(result.definition, mid),
      ...preserved,
      truncated: true,
    };
    if (resultByteLength(candidate) <= PORTAL_CATALOG_RESULT_MAX_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const bounded: PortalPipelineGetResult = {
    definition: definitionWithRowLimit(result.definition, low),
    ...preserved,
    truncated: true,
  };
  if (resultByteLength(bounded) > PORTAL_CATALOG_RESULT_MAX_BYTES) {
    // Even the zero-row candidate can exceed the budget when a metadata
    // field (e.g. a pathological description) is oversized on its own.
    // Degrade to required fields with capped strings so the command always
    // completes with a truncated result instead of failing.
    const fallbackDefinition = {
      name: result.definition.name.slice(0, METADATA_FALLBACK_MAX_CHARS),
      triggerSummary: result.definition.triggerSummary.slice(
        0,
        METADATA_FALLBACK_MAX_CHARS,
      ),
      scopes: result.definition.scopes,
      jobs: [],
    };
    // Carry the inputs here too whenever they fit. Dropping them yields a
    // NON-error result that the plan picker treats as authoritative: it would
    // hydrate to "no inputs" and arm Run for a pipeline that actually declares
    // required ones — the same failure the bare-acknowledgement guard exists to
    // prevent. Only an oversized metadata field AND oversized inputs give them
    // up, which no longer has a smaller budget than the caller can observe.
    const withInputs: PortalPipelineGetResult = {
      definition: fallbackDefinition,
      ...preserved,
      truncated: true,
    };
    if (resultByteLength(withInputs) <= PORTAL_CATALOG_RESULT_MAX_BYTES) {
      return withInputs;
    }
    // Last resort: the inputs themselves do not fit. Say so explicitly rather
    // than returning a success-shaped result that reads as "declares no
    // inputs" — `truncated` alone cannot distinguish the two, because the
    // ordinary row cut above sets it for a pipeline that genuinely has none.
    return {
      definition: fallbackDefinition,
      ...(result.planReadyInputs === undefined
        ? {}
        : { planReadyInputsOmitted: true }),
      ...(result.dispatchInputs === undefined
        ? {}
        : { dispatchInputsOmitted: true }),
      ...(result.dispatchUnsupportedReason === undefined
        ? {}
        : { dispatchUnsupportedReason: result.dispatchUnsupportedReason }),
      truncated: true,
    };
  }
  return bounded;
}

/**
 * Complete a command from a detached async operation, so a slow filesystem or
 * Cloud round trip never occupies the serial portal command loop.
 */
function completeOffLoop<TResult>(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  operation: () => Promise<TResult>,
): void {
  void (async (): Promise<void> => {
    try {
      context.complete(command, await operation());
    } catch (error) {
      failServiceError(command, context, error);
    }
  })();
}

async function completeWithService<TPayload, TResult>(
  command: PortalCommandEnvelope<TPayload>,
  context: PortalAdapterContext,
  service: (payload: TPayload) => Promise<TResult> | TResult,
  afterComplete?: () => void,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid pipeline payload.');
    return;
  }
  try {
    context.complete(command, await service(command.payload));
    afterComplete?.();
  } catch (error) {
    failServiceError(command, context, error);
  }
}

function withCommandTargetScope<TPayload extends object>(
  command: PortalCommandEnvelope<TPayload>,
): TPayload & { projectId?: string; worktreeId?: string } {
  const payload = command.payload as Record<string, unknown>;
  return {
    ...command.payload,
    projectId:
      typeof payload.projectId === 'string'
        ? payload.projectId
        : command.target?.workspaceLocalId,
    worktreeId:
      typeof payload.worktreeId === 'string'
        ? payload.worktreeId
        : command.target?.worktreeLocalId,
  };
}

function withRequiredCommandTargetScope<TPayload extends object>(
  command: PortalCommandEnvelope<TPayload>,
  context: PortalAdapterContext,
): (TPayload & { projectId: string; worktreeId: string }) | null {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid pipeline payload.');
    return null;
  }
  const target = requireWorktreeTarget(command, context);
  if (!target) return null;
  const payload = command.payload;
  if (
    (payload.projectId !== undefined &&
      payload.projectId !== target.workspaceLocalId) ||
    (payload.worktreeId !== undefined &&
      payload.worktreeId !== target.worktreeLocalId)
  ) {
    context.fail(
      command,
      'invalid_target',
      'Pipeline payload scope does not match the routed target.',
    );
    return null;
  }
  return {
    ...command.payload,
    projectId: target.workspaceLocalId,
    worktreeId: target.worktreeLocalId,
  };
}

function completeOffLoopWithTargetScope<TPayload extends object, TResult>(
  command: PortalCommandEnvelope<TPayload>,
  context: PortalAdapterContext,
  operation: (
    payload: TPayload & { projectId: string; worktreeId: string },
  ) => Promise<TResult>,
): Promise<void> {
  const payload = withRequiredCommandTargetScope(command, context);
  if (!payload) return Promise.resolve();
  completeOffLoop(command, context, () => operation(payload));
  return Promise.resolve();
}

async function completeWithTargetScope<TPayload extends object, TResult>(
  command: PortalCommandEnvelope<TPayload>,
  context: PortalAdapterContext,
  operation: (
    payload: TPayload & { projectId: string; worktreeId: string },
  ) => Promise<TResult>,
): Promise<void> {
  const payload = withRequiredCommandTargetScope(command, context);
  if (!payload) return;
  try {
    context.complete(command, await operation(payload));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export const handlePortalPipelineList = (
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.pipeline.list']
  >,
  context: PortalAdapterContext,
): Promise<void> =>
  completeWithService(
    command,
    context,
    async (payload) => ({
      ...fitPipelineListResult(await listPipelines(payload)),
    }),
    (): void => notifyDesktopInventoryChanged(['pipelines']),
  );

export const handlePortalPipelineGet = (
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> => {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.pipelineId !== 'string' ||
    typeof payload.projectId !== 'string' ||
    (payload.worktreeId !== undefined && typeof payload.worktreeId !== 'string')
  ) {
    context.fail(command, 'invalid_payload', 'Invalid pipeline payload.');
    return Promise.resolve();
  }
  const pipelineRequest: PortalCommandPayloadMap['portal.pipeline.get'] = {
    pipelineId: payload.pipelineId,
    projectId: payload.projectId,
    ...(payload.worktreeId === undefined
      ? {}
      : { worktreeId: payload.worktreeId }),
  };
  return completeWithService(command, context, async () =>
    fitPipelineGetResult(await getPipeline(pipelineRequest)),
  );
};

/**
 * `portal.pipeline.share`: the browser names a pipeline and a scope; the
 * desktop re-reads its YAML and mints the share under its own Cloud
 * credentials. Definition-only — a packaged share needs the desktop editor's
 * interactive analyze/select flow.
 */
export const handlePortalPipelineShare = (
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> => {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.pipelineId !== 'string' ||
    typeof payload.projectId !== 'string' ||
    (payload.worktreeId !== undefined &&
      typeof payload.worktreeId !== 'string') ||
    !isPortalShareScope(payload.scope)
  ) {
    context.fail(command, 'invalid_payload', 'Invalid pipeline share payload.');
    return Promise.resolve();
  }
  const { pipelineId, projectId, worktreeId } = payload;
  if (
    typeof pipelineId !== 'string' ||
    typeof projectId !== 'string' ||
    (worktreeId !== undefined && typeof worktreeId !== 'string')
  ) {
    context.fail(command, 'invalid_payload', 'Invalid pipeline share payload.');
    return Promise.resolve();
  }
  const scope = payload.scope;
  const teamId =
    typeof payload.teamId === 'string' ? payload.teamId : undefined;
  const organizationId =
    typeof payload.organizationId === 'string'
      ? payload.organizationId
      : undefined;
  // Fail closed rather than downgrading a group share to a private copy.
  if (
    (scope === 'team' && teamId === undefined) ||
    (scope === 'organization' && organizationId === undefined)
  ) {
    context.fail(
      command,
      'invalid_payload',
      scope === 'team'
        ? 'A team share requires teamId.'
        : 'An organization share requires organizationId.',
    );
    return Promise.resolve();
  }
  // Off-loop like the skill share: portal poll commands are processed
  // serially, and a slow disk read or Cloud round trip would otherwise stall
  // every later command, chat included (review on #3166).
  completePortalShareOffLoop(command, context, async () =>
    sharePortalPipeline({
      projectId,
      pipelineId,
      scope,
      ...(worktreeId === undefined ? {} : { worktreeId }),
      ...(teamId === undefined ? {} : { teamId }),
      ...(organizationId === undefined ? {} : { organizationId }),
    }),
  );
  return Promise.resolve();
};

function isPortalShareScope(value: unknown): value is PortalShareScope {
  return (
    value === 'private' ||
    value === 'team' ||
    value === 'organization' ||
    value === 'public'
  );
}

export const handlePortalPipelineRun = (
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.pipeline.run']
  >,
  context: PortalAdapterContext,
): Promise<void> => {
  completeOffLoop(command, context, () => {
    const payload = withCommandTargetScope(command);
    const resolved = resolvePortalPipelineFileReferences(payload, {
      sessionId: context.sessionId ?? '',
      projectId: command.target?.workspaceLocalId ?? '',
      worktreeId: command.target?.worktreeLocalId ?? '',
      canRead: context.canReadAssets,
    });
    return runPipeline(resolved, {
      portalCommandId: command.id,
    });
  });
  return Promise.resolve();
};

export const handlePortalPipelineCancel = (
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.pipeline.cancel']
  >,
  context: PortalAdapterContext,
): Promise<void> =>
  completeOffLoopWithTargetScope(command, context, (payload) =>
    cancelPipeline(payload, {
      portalCommandId: command.id,
      getWindow: context.getWindow,
    }),
  );

export const handlePortalPipelineExecutionGet = (
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.pipeline.execution.get']
  >,
  context: PortalAdapterContext,
): Promise<void> =>
  completeWithService(command, context, async () => {
    return getPipelineExecution(withCommandTargetScope(command), {
      portalCommandId: command.id,
    });
  });

export const handlePortalPipelineExecutionList = (
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.pipeline.execution_list']
  >,
  context: PortalAdapterContext,
): Promise<void> =>
  completeWithTargetScope(command, context, async (payload) => {
    const result = await listPipelineExecutions(payload);
    return fitPipelineExecutionListResult(result.runs, {
      truncated: result.truncated,
    });
  });

export const handlePortalPipelineResume = (
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.pipeline.resume']
  >,
  context: PortalAdapterContext,
): Promise<void> =>
  completeOffLoopWithTargetScope(command, context, (payload) =>
    resumePipeline(payload, {
      portalCommandId: command.id,
    }),
  );

export const handlePortalPipelineRetry = (
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.pipeline.retry']
  >,
  context: PortalAdapterContext,
): Promise<void> =>
  completeOffLoopWithTargetScope(command, context, (payload) =>
    retryPipeline(payload, {
      portalCommandId: command.id,
    }),
  );

export const handlePortalPipelineRerun = (
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.pipeline.rerun']
  >,
  context: PortalAdapterContext,
): Promise<void> =>
  completeOffLoopWithTargetScope(command, context, (payload) =>
    rerunPipeline(payload, {
      portalCommandId: command.id,
    }),
  );

export const handlePortalPipelineLogRequest = (
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.pipeline.log_request']
  >,
  context: PortalAdapterContext,
): Promise<void> =>
  completeWithService(command, context, async () => {
    await getPipelineLog(withCommandTargetScope(command), {
      portalCommandId: command.id,
    });
    return {};
  });

/** The browser supplies only identity/hash; desktop fetches and verifies its own bytes. */
export const handlePortalPipelineInstallCurated = (
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> => {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.key !== 'string' ||
    !isCuratedCatalogKey(payload.key) ||
    typeof payload.expectedContentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.expectedContentHash)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid curated pipeline import payload.',
    );
    return Promise.resolve();
  }
  const { key, expectedContentHash } = payload;
  completeOffLoop(command, context, async () => ({
    pipelineId: (await importCuratedPipeline({ key, expectedContentHash })).id,
  }));
  return Promise.resolve();
};

const CHAT_FOLLOW_UP_PAYLOAD_KEYS = new Set([
  'projectId',
  'worktreeId',
  'executionId',
  'output',
]);

function isChatFollowUpOutput(
  value: unknown,
): value is PortalPipelineChatFollowUpOutput {
  return value === 'plan' || value === 'report';
}

/**
 * The owner chat a follow-up is sent to: its active writable chat, then
 * another writable chat. A chat its Claude Code terminal drives is skipped,
 * because the portal send refuses it (`resolveTerminalDrivenChat`, the rule
 * the revisioned send authorizes with). None means the client creates one
 * with the normal scoped defaults.
 */
async function followUpChatId(
  owner: { projectId: string; worktreeId: string },
  tabsFile: ChatStateSnapshot['tabsFile'],
): Promise<string | undefined> {
  const active = tabsFile.tabs.find((tab) => tab.id === tabsFile.activeTabId);
  const candidates = active
    ? [active, ...tabsFile.tabs.filter((tab) => tab !== active)]
    : tabsFile.tabs;
  for (const tab of candidates) {
    if (tab.kind === 'file' || tab.readOnly === true) continue;
    if (await resolveTerminalDrivenChat({ ...owner, tab })) continue;
    return tab.id;
  }
  return undefined;
}

/**
 * `portal.pipeline.chat_follow_up.prepare` (CAN-3719): resolves the review
 * prompt for the routed run owner and chooses its receiving chat. The payload
 * names only the run and output; a path, prompt or chat from the client is
 * rejected. Nothing is created or sent here: the client sends the prompt
 * through the normal chat send so drafts, queueing and recovery apply.
 */
export const handlePortalPipelineChatFollowUpPrepare = (
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> => {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => !CHAT_FOLLOW_UP_PAYLOAD_KEYS.has(key)) ||
    typeof payload.executionId !== 'string' ||
    !isChatFollowUpOutput(payload.output)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid pipeline chat follow-up payload.',
    );
    return Promise.resolve();
  }
  const target = requireWorktreeTarget(command, context);
  if (!target) return Promise.resolve();
  if (
    payload.projectId !== target.workspaceLocalId ||
    payload.worktreeId !== target.worktreeLocalId
  ) {
    context.fail(
      command,
      'invalid_target',
      'Pipeline payload scope does not match the routed target.',
    );
    return Promise.resolve();
  }
  const output = payload.output;
  const request = {
    projectId: target.workspaceLocalId,
    worktreeId: target.worktreeLocalId,
    executionId: payload.executionId,
    output,
  };
  completeOffLoop(
    command,
    context,
    async (): Promise<PortalPipelineChatFollowUpPrepareResult> => {
      const { prompt } = await preparePipelineChatFollowUp(request);
      const chatState = await queryPortalChatState(context, {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
      });
      const chatId = await followUpChatId(
        { projectId: request.projectId, worktreeId: request.worktreeId },
        chatState.tabsFile,
      );
      return { ...request, prompt, ...(chatId ? { chatId } : {}) };
    },
  );
  return Promise.resolve();
};

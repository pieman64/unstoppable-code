import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type PipelineDefinition,
} from '@canopy/protocol/canopy-core';
import type {
  IPCResult,
  Pipeline,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import { getDesktopCanopyRuntime } from './desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/*
 * The `core.pipeline.definition.upsert` and `delete` projection shared by the
 * `pipelines:save` and `pipelines:delete` IPC handlers and the agent
 * pipeline actions. Each caller keeps its legacy result shape and records
 * the owner and agent author of what it wrote; core validates, refuses
 * stale revisions and read-only sources, and runs the store's effects.
 */

/** Electron main writing on behalf of the desktop window. */
export const PIPELINE_DEFINITION_DESKTOP_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-pipeline-definitions',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [PIPELINE_GRANTS.write],
};

/** An agent pipeline action through the injected Canopy tools. */
export const PIPELINE_DEFINITION_AGENT_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-agent-actions',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [PIPELINE_GRANTS.write],
};

export interface UserPipelineWrite {
  /** Absent creates a pipeline under a new id. */
  id?: string;
  /** The revision the caller loaded; absent writes without a precondition. */
  expectedRevision?: number;
  name: string;
  description: string;
  icon: string;
  content: Pipeline;
  /** Validated bytes to keep verbatim instead of serializing `content`. */
  rawContent?: string;
  /** Absent keeps the pipeline's enabled state. */
  enabled?: boolean;
}

/** The message a legacy caller showed for a failed write. */
function pipelineWriteErrorMessage(error: unknown): string {
  if (error instanceof CanopyOperationError) return error.payload.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether raw bytes parse to something other than the content sent beside
 * them. Core keeps the bytes, so the pair must agree, as the store required;
 * unparsable bytes are left for core to refuse.
 */
function rawContentMismatch(rawContent: string, content: Pipeline): boolean {
  let raw: Pipeline;
  try {
    raw = { ...parsePipelineText(rawContent) };
  } catch {
    return false;
  }
  const parsed = { ...content };
  delete raw.readonly;
  delete parsed.readonly;
  return !isDeepStrictEqual(raw, parsed);
}

/**
 * A saved pipeline an automation owns changes what that automation's chat
 * stands for (CAN-4551), so windows get the automations snapshot again and
 * an open editor sees the change. Best effort: a stale save is refused
 * regardless.
 */
async function republishOwnerAutomation(pipelineId: string): Promise<void> {
  try {
    const { readPipelineLocalMetadata } =
      await import('../pipelines/pipeline-local-metadata-store');
    const { ownerAutomationId } = readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: pipelineId,
    });
    if (ownerAutomationId === undefined) return;
    const { getAutomationsService } = await import('../automations/service');
    await getAutomationsService().republish();
  } catch {
    // Nothing to tell the windows; their next snapshot carries the change.
  }
}

/**
 * Saves a user pipeline through core and answers with the store's legacy
 * row, so callers keep their result shape.
 */
export async function saveUserPipeline(
  write: UserPipelineWrite,
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
): Promise<IPCResult<PipelineInfo>> {
  if (
    write.rawContent !== undefined &&
    rawContentMismatch(write.rawContent, write.content)
  )
    return {
      success: false,
      error: 'Raw pipeline document does not match parsed pipeline content.',
    };
  const idempotencyKey = randomUUID();
  try {
    const { definition } = await getDesktopCanopyRuntime().instruction(
      'core.pipeline.definition.upsert',
      {
        definitionId: write.id ?? null,
        expectedRevision: write.expectedRevision ?? null,
        scope: {},
        source: 'user',
        name: write.name,
        description: write.description,
        icon: write.icon,
        ...(write.enabled === undefined ? {} : { enabled: write.enabled }),
        format: 'yaml',
        document: write.rawContent ?? { pipeline: write.content },
        _meta: { idempotencyKey },
      },
      { caller, metadata: { idempotencyKey } },
    );
    void republishOwnerAutomation(definition.definitionId);
    return { success: true, data: savedPipelineInfo(definition, write) };
  } catch (error) {
    return { success: false, error: pipelineWriteErrorMessage(error) };
  }
}

/**
 * The legacy row for a saved definition. Everything a save changes comes
 * from the snapshot core returned, so a later writer's revision is never
 * paired with this caller's content; the store supplies only what an id
 * fixes (file name, share link and curated origin).
 */
function savedPipelineInfo(
  definition: PipelineDefinition,
  write: UserPipelineWrite,
): PipelineInfo {
  const stored = getStoredPipelineBySource('user', definition.definitionId);
  const row = stored.success ? stored.data?.info : undefined;
  return {
    id: definition.definitionId,
    name: definition.name,
    filename: row?.filename ?? `${definition.definitionId}.yaml`,
    description: definition.description,
    icon: definition.icon,
    createdAt: definition.createdAt ?? row?.createdAt ?? '',
    updatedAt: definition.updatedAt ?? row?.updatedAt ?? '',
    ...(row?.curatedOrigin ? { curatedOrigin: row.curatedOrigin } : {}),
    ...(row?.remote ? { remote: row.remote } : {}),
    triggerTypes: definition.triggerTypes,
    stepCount: Object.values(write.content.jobs).reduce(
      (count, job) => count + job.steps.length,
      0,
    ),
    scopes: definition.executionScopes,
    revision: definition.revision,
    source: 'user',
    readonly: false,
  };
}

/** Deletes a user pipeline through core, with the store's effects. */
export async function deleteUserPipeline(
  id: string,
  expectedRevision: number | null,
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
): Promise<IPCResult> {
  const idempotencyKey = randomUUID();
  try {
    await getDesktopCanopyRuntime().instruction(
      'core.pipeline.definition.delete',
      { definitionId: id, expectedRevision, _meta: { idempotencyKey } },
      { caller, metadata: { idempotencyKey } },
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: pipelineWriteErrorMessage(error) };
  }
}

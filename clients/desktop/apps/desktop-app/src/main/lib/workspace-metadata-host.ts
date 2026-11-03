import {
  CoreWorkspaceRepositorySchema,
  CoreWorkspaceUpdateResultSchema,
  type CanopyCallerDescriptor,
  type CanopyJsonValue,
  type CoreWorkspaceRepository,
  type CoreWorkspaceUpdateResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CoreWorkspaceMetadataCall,
  CoreWorkspaceMetadataHost,
} from '@canopy/core-runtime/node/workspace/metadata-commands';
import { CoreWorkspaceAddressRefusedError } from '@canopy/core-runtime/node/workspace/metadata-wire-errors';
import type {
  W5ManifestRepositoryView,
  W5WorkspaceCommandHost,
} from '@canopy/core-runtime/node/w5/workspace-metadata/ports';
import type { WorkspaceMetadataPatch as CoreWorkspaceMetadataPatch } from '@canopy/core-runtime/node/w5/workspace-metadata/metadata';
import type { ScriptHookSettingsSource } from '@canopy/core-runtime/node/w5/workspace-metadata/settings';
import { isActivitySectionId } from '@canopy/desktop-shared/constants/activity';
import type { ActivitySectionId } from '@canopy/desktop-shared/types';
import { readDecidedCoreWorkspace } from '../canopy-runtime/core-workspace-adapter';
import {
  runWorkspaceMetadataProjection,
  takeWorkspaceMetadataProjection,
  WorkspaceMetadataProjectionAnswered,
} from '../canopy-runtime/workspace-metadata-dispatch';
import { sanitizeRemoteUrl } from './plan-share-repos';
import { getWorkspaceIndexRepository } from './sidebar-items';
import { w5UnreadableMessage } from './w5-file-store';
import { desktopW5WireCommandHost } from './w5-workspace-command-host';
import {
  createDesktopWorkspaceMetadataCommands,
  WorkspaceMetadataRefusedError,
  type WorkspaceMetadataPatch,
} from './workspace-metadata';
import {
  readWorkspaceConfigDetailed,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import { createDesktopWorkspacePrivateMemoryCommand } from './workspace-private-memory';
import {
  createDesktopWorkspaceRepositoryCommands,
  WorkspaceRepositoryRefusedError,
} from './workspace-repositories';
import { createDesktopWorkspaceSettingsCommands } from './workspace-script-hook-settings';

/*
 * The desktop host behind the registered `core.workspace.*` metadata
 * commands (W7a, CAN-5523). An IPC projection's call runs the host request
 * its projection carries, unchanged (`workspace-metadata-dispatch.ts`). Any
 * other caller (the renderer relay, agents) is a wire call: it is addressed
 * before any key is reserved (RR5), its receipts name its principal, and it
 * runs the same command cores with the same post-commit effects.
 */

const INDEX_UNAVAILABLE_MESSAGE =
  "Couldn't update this project because the project list couldn't be read. Try again.";
const ORGANIZATION_OWNED_MESSAGE =
  "An organization project's repositories can't be changed this way yet.";

/** A wire caller's settings source, as `core.script.definition.*` names it. */
function settingsSource(
  caller: CanopyCallerDescriptor,
): ScriptHookSettingsSource {
  return caller.interfaceKind === 'portal' ? 'portal' : 'desktop';
}

/**
 * RR5: the workspace is in the index exactly once, or the call is refused
 * before any key is reserved. `missing` is the refusal for an unknown one.
 */
export async function admitWorkspace(
  workspaceId: string,
  missing: 'not-found' | 'configuration-unavailable',
): Promise<void> {
  const { entries, authority, unserved, unreadableRowIds } =
    await getWorkspaceIndexRepository().read();
  if (authority === 'unreadable')
    throw new CoreWorkspaceAddressRefusedError(
      'index-unavailable',
      w5UnreadableMessage(INDEX_UNAVAILABLE_MESSAGE, unserved),
    );
  const readable = entries.filter((entry) => entry.id === workspaceId).length;
  // An unreadable row with this ID is a duplicate: a write would drop it.
  const unreadable = (unreadableRowIds ?? []).filter(
    (id) => id === workspaceId,
  ).length;
  if (readable + unreadable > 1)
    throw new CoreWorkspaceAddressRefusedError(
      'duplicate-workspace',
      `More than one project is stored as ${workspaceId}. Repair the project list and try again.`,
    );
  if (readable === 0)
    throw new CoreWorkspaceAddressRefusedError(
      missing,
      missing === 'not-found'
        ? `Project ${workspaceId} not found.`
        : new WorkspaceConfigUnreadableError().message,
    );
}

function isOrganizationOwned(view: {
  type: string;
  owner?: { readonly type?: string };
}): boolean {
  return view.type === 'multi-repo' && view.owner?.type === 'organization';
}

/** A workspace the organization multi-repo sync covers has no wire form yet. */
async function admitPersonalRepositories(workspaceId: string): Promise<void> {
  const { config } = await readWorkspaceConfigDetailed(workspaceId);
  if (isOrganizationOwned(config))
    throw new CoreWorkspaceAddressRefusedError(
      'organization-owned',
      ORGANIZATION_OWNED_MESSAGE,
    );
}

function refuseOrganizationOwned(
  _workspaceId: string,
  view: { type: string; owner?: { readonly type?: string } },
): void {
  if (isOrganizationOwned(view))
    throw new WorkspaceRepositoryRefusedError(
      'organization-owned',
      ORGANIZATION_OWNED_MESSAGE,
    );
}

function activitySectionOrder(
  order: readonly string[],
): readonly ActivitySectionId[] {
  const sections = order.filter(isActivitySectionId);
  if (sections.length !== order.length)
    throw new WorkspaceMetadataRefusedError(
      'invalid-patch',
      'Invalid activity section order.',
    );
  return sections;
}

function desktopPatch(
  patch: CoreWorkspaceMetadataPatch<string>,
): WorkspaceMetadataPatch {
  const { activitySectionOrder: order, ...fields } = patch;
  return order === undefined
    ? fields
    : { ...fields, activitySectionOrder: activitySectionOrder(order) };
}

function resultUnavailable(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message:
      "This project's details can't be returned here, so nothing was changed.",
    details: { reason: 'result-unavailable' },
    retry: { kind: 'never' },
  });
}

/**
 * The workspace as the decision leaves it, read inside its scope before the
 * commit. A workspace the result cannot carry (a stored name over 256
 * characters) or a failed read refuses there, so the key is released and no
 * committed change goes unanswered.
 */
async function decidedWorkspace(workspaceId: string): Promise<CanopyJsonValue> {
  try {
    return await currentWorkspace(workspaceId);
  } catch (error) {
    if (error instanceof CanopyOperationError) throw error;
    throw new CanopyOperationError(
      {
        kind: 'unavailable',
        message:
          "This project's details couldn't be read, so nothing was changed. Try again.",
        retry: { kind: 'same_idempotency_key' },
      },
      error,
    );
  }
}

/** The workspace's #3 result as stored now. */
async function currentWorkspace(
  workspaceId: string,
): Promise<CoreWorkspaceUpdateResult> {
  const result = CoreWorkspaceUpdateResultSchema.safeParse(
    await readDecidedCoreWorkspace(workspaceId),
  );
  if (!result.success) throw resultUnavailable();
  return result.data;
}

/** A stored repository without its path; an unsanitizable URL is omitted. */
function projectRepository(
  repository: Pick<
    W5ManifestRepositoryView,
    'id' | 'name' | 'source' | 'manifestUrl'
  >,
): CoreWorkspaceRepository {
  const url = sanitizeRemoteUrl(repository.manifestUrl ?? null);
  const manifestUrl =
    url !== null &&
    CoreWorkspaceRepositorySchema.shape.manifestUrl.safeParse(url).success
      ? url
      : undefined;
  return {
    id: repository.id,
    name: repository.name,
    ...(repository.source !== undefined && { source: repository.source }),
    ...(manifestUrl !== undefined && { manifestUrl }),
  };
}

function wireHost<Source extends string>(
  call: CoreWorkspaceMetadataCall,
  admitAddress: () => Promise<void>,
): W5WorkspaceCommandHost<Source> {
  return desktopW5WireCommandHost<Source>(
    call.caller.principalId,
    admitAddress,
  );
}

export const desktopWorkspaceMetadataHost: CoreWorkspaceMetadataHost = {
  async update(input, call) {
    const projection = takeWorkspaceMetadataProjection('core.workspace.update');
    if (projection) {
      await runWorkspaceMetadataProjection(projection);
      throw new WorkspaceMetadataProjectionAnswered();
    }
    const commands = createDesktopWorkspaceMetadataCommands(
      wireHost(call, () => admitWorkspace(input.workspaceId, 'not-found')),
      decidedWorkspace,
    );
    const outcome = await commands.update({
      workspaceId: input.workspaceId,
      patch: desktopPatch(input.patch),
      source: 'desktop_canopy_client',
      ...(input.expectedRevision !== undefined && {
        expectedRevision: input.expectedRevision,
      }),
      idempotencyKey: call.idempotencyKey,
    });
    // Version 1 receipts (the qualification port's) saved no workspace.
    return outcome.workspace === undefined
      ? currentWorkspace(input.workspaceId)
      : CoreWorkspaceUpdateResultSchema.parse(outcome.workspace);
  },
  async reorder(input, call) {
    const projection = takeWorkspaceMetadataProjection(
      'core.workspace.reorder',
    );
    if (projection) {
      await runWorkspaceMetadataProjection(projection);
      return;
    }
    const commands = createDesktopWorkspaceMetadataCommands(
      wireHost(call, async () => {
        await admitWorkspace(input.activeWorkspaceId, 'not-found');
        await admitWorkspace(input.overWorkspaceId, 'not-found');
      }),
    );
    await commands.reorder({
      visibleWorkspaceIds: input.visibleWorkspaceIds,
      activeWorkspaceId: input.activeWorkspaceId,
      overWorkspaceId: input.overWorkspaceId,
      ...(input.expectedRevision !== undefined && {
        expectedRevision: input.expectedRevision,
      }),
      idempotencyKey: call.idempotencyKey,
    });
  },
  async updateScripts(input, call) {
    await createDesktopWorkspaceSettingsCommands(
      wireHost(call, () =>
        admitWorkspace(input.workspaceId, 'configuration-unavailable'),
      ),
    ).updateScripts({
      ...input,
      source: settingsSource(call.caller),
      idempotencyKey: call.idempotencyKey,
    });
  },
  async updatePlanDetection(input, call) {
    const projection = takeWorkspaceMetadataProjection(
      'core.workspace.planDetection.update',
    );
    if (projection) {
      await runWorkspaceMetadataProjection(projection);
      return;
    }
    await createDesktopWorkspaceSettingsCommands(
      wireHost(call, () =>
        admitWorkspace(input.workspaceId, 'configuration-unavailable'),
      ),
    ).updatePlanDetection({
      ...input,
      source: settingsSource(call.caller),
      idempotencyKey: call.idempotencyKey,
    });
  },
  async updatePrivateMemory(input, call) {
    const projection = takeWorkspaceMetadataProjection(
      'core.workspace.privateMemory.update',
    );
    const outcome = projection
      ? await runWorkspaceMetadataProjection(projection)
      : await createDesktopWorkspacePrivateMemoryCommand(
          wireHost(call, () => admitWorkspace(input.workspaceId, 'not-found')),
        )({
          ...input,
          source: 'workspace_settings',
          idempotencyKey: call.idempotencyKey,
        });
    return {
      workspaceId: outcome.workspaceId,
      privateMemory: outcome.privateMemory,
    };
  },
  async addRepository() {
    const projection = takeWorkspaceMetadataProjection(
      'core.workspace.repository.add',
    );
    if (!projection)
      // No selection mint or redeem service exists yet (DM-5 #3).
      throw new CanopyOperationError({
        kind: 'capability_unavailable',
        message: 'Choosing a repository folder is unavailable on this host.',
        retry: { kind: 'never' },
      });
    return {
      repository: projectRepository(
        await runWorkspaceMetadataProjection(projection),
      ),
    };
  },
  async removeRepository(input, call) {
    const projection = takeWorkspaceMetadataProjection(
      'core.workspace.repository.remove',
    );
    const { removed } = projection
      ? await runWorkspaceMetadataProjection(projection)
      : await createDesktopWorkspaceRepositoryCommands(
          wireHost(call, async () => {
            await admitWorkspace(input.workspaceId, 'not-found');
            await admitPersonalRepositories(input.workspaceId);
          }),
          refuseOrganizationOwned,
        ).remove({
          ...input,
          source: 'workspace_settings',
          idempotencyKey: call.idempotencyKey,
        });
    return { removed: removed === null ? null : projectRepository(removed) };
  },
};

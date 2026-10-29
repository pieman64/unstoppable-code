/**
 * Portal command adapters for session-level / workspace-level UI state that
 * the browser persists server-side. These mutate state stores rather than
 * dispatching IPC into the renderer.
 *
 * `portal.session.set_view_mode` — the browser tells the local app which
 *   top-level mode it last selected (`worktrees` vs. `standalone-chats`).
 *   Persisted via `persistPortalViewMode` so the next snapshot picks it up.
 *
 * `portal.workspace.set_section_order` — the browser tells the local app the
 *   user's preferred activity-rail section order for a given workspace.
 *   Persisted into the workspace index via `setWorkspaceActivitySectionOrder`
 *   so both desktop and portal render the same order on the next reload.
 */
import {
  IPC_CHANNELS,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
  type ActivitySectionId,
} from '@canopy/desktop-shared/types';
import { isActivitySectionId } from '@canopy/desktop-shared/constants/activity';
import { setWorkspaceActivitySectionOrder } from '../../lib/sidebar-items';
import { validateId } from '../../lib/validation';
import { sendToWindow } from '../../lib/window-send';
import {
  persistPortalViewMode,
  type PersistedPortalViewMode,
} from '../portal-state-store';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

function isPortalViewMode(value: unknown): value is PersistedPortalViewMode {
  return value === 'worktrees' || value === 'standalone-chats';
}

function normalizeOrder(value: unknown): ActivitySectionId[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: ActivitySectionId[] = [];
  const seen = new Set<ActivitySectionId>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !isActivitySectionId(entry)) {
      return null;
    }
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

export async function handlePortalSetViewMode(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.session.set_view_mode']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid view-mode payload.');
    return;
  }
  const { viewMode } = command.payload as { viewMode?: unknown };
  if (!isPortalViewMode(viewMode)) {
    context.fail(
      command,
      'invalid_payload',
      'viewMode must be "worktrees" or "standalone-chats".',
    );
    return;
  }

  try {
    await persistPortalViewMode(viewMode);
    context.complete(command, { viewMode });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalSetSectionOrder(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace.set_section_order']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid section-order payload.');
    return;
  }
  const payload = command.payload as {
    workspaceLocalId?: unknown;
    order?: unknown;
  };
  if (
    typeof payload.workspaceLocalId !== 'string' ||
    payload.workspaceLocalId.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      'workspaceLocalId must be a non-empty string.',
    );
    return;
  }
  // Defense in depth: enforce the canonical id format on browser-originated
  // input before it reaches the workspace index, consistent with every other
  // portal adapter that handles ids.
  try {
    validateId(payload.workspaceLocalId, 'workspaceLocalId');
  } catch (error) {
    context.fail(
      command,
      'invalid_payload',
      error instanceof Error ? error.message : 'Invalid workspaceLocalId.',
    );
    return;
  }
  const order = normalizeOrder(payload.order);
  if (order === null) {
    context.fail(
      command,
      'invalid_payload',
      'order must be an array of known activity section ids.',
    );
    return;
  }

  try {
    const persisted = await setWorkspaceActivitySectionOrder(
      payload.workspaceLocalId,
      order,
    );
    if (!persisted) {
      context.fail(
        command,
        'not_found',
        `Workspace ${payload.workspaceLocalId} not found.`,
      );
      return;
    }
    // The renderer never initiated this write, so tell it the workspace index
    // changed (CAN-1304). The workspace-id-only event triggers its debounced
    // silent full projects reload, which re-reads the persisted section order.
    sendToWindow(
      context.getWindow?.() ?? null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: payload.workspaceLocalId },
    );
    context.complete(command, {
      workspaceLocalId: payload.workspaceLocalId,
      order,
    });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

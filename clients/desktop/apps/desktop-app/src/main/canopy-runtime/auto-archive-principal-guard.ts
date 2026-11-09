import { canopyPermissionDeniedError } from '@canopy/core-runtime';
import {
  CoreChatUpdateParamsSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';

/** SetAutoArchive's principal (CAN-6014): it may only set its own chat's marker. */
export const AGENT_AUTO_ARCHIVE_PRINCIPAL_ID = 'desktop-agent-auto-archive';

/**
 * Refuses the SetAutoArchive principal any `core.chat.update` but a settings
 * patch whose only field is `autoArchive`. The table already limits it to
 * `core.chat.update`; this keeps the chat write grant from reaching any other
 * setting.
 */
export function assertAutoArchivePatchOnly(
  caller: CanopyCallerDescriptor,
  params: unknown,
): void {
  if (caller.principalId !== AGENT_AUTO_ARCHIVE_PRINCIPAL_ID) return;
  const parsed = CoreChatUpdateParamsSchema.safeParse(params);
  const action = parsed.success ? parsed.data.action : undefined;
  if (
    action?.type === 'chat.patch_tab_settings' &&
    action.fileRef === undefined &&
    action.expectedPendingPlanExitRequestId === undefined &&
    action.expectedPluginSelections === undefined &&
    Object.keys(action.patch).length === 1 &&
    'autoArchive' in action.patch
  )
    return;
  throw canopyPermissionDeniedError(
    'SetAutoArchive may only set the auto-archive marker.',
  );
}

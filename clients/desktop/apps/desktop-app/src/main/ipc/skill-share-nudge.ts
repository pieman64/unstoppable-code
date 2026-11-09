import type { WebContents } from 'electron';
import {
  SKILL_SHARE_NUDGE_CHANNELS,
  isShareTarget,
  isSkillShareNudgeResolution,
  type SkillShareNudgeOrigin,
  type ResolveSkillShareNudgeRequest,
  type PendingSkillShareNudge,
} from '@canopy/desktop-shared/lib/skill-share-nudge';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import { skillShareNudgeState } from '../agents/skill-share-nudge-state';
import { validateId } from '../lib/validation';
import { sendToWebContents } from '../lib/web-contents-send';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validateSkillShareNudgeOrigin(
  value: unknown,
): SkillShareNudgeOrigin {
  if (
    !record(value) ||
    typeof value.projectId !== 'string' ||
    typeof value.worktreeId !== 'string' ||
    typeof value.chatId !== 'string'
  )
    throw new Error('Invalid skill share nudge origin');
  if (
    [value.projectId, value.worktreeId, value.chatId].some(
      (id) => id.length > 256,
    )
  )
    throw new Error('Invalid skill share nudge origin');
  validateId(value.projectId, 'projectId');
  validateId(value.worktreeId, 'worktreeId');
  validateId(value.chatId, 'chatId');
  return {
    projectId: value.projectId,
    worktreeId: value.worktreeId,
    chatId: value.chatId,
  };
}
export function validateSkillShareNudgeResolution(
  value: unknown,
): ResolveSkillShareNudgeRequest {
  const origin = validateSkillShareNudgeOrigin(value);
  if (
    !record(value) ||
    typeof value.pendingId !== 'string' ||
    !isShareTarget(value.target) ||
    !isSkillShareNudgeResolution(value.resolution)
  )
    throw new Error('Invalid skill share nudge resolution');
  if (value.pendingId.length > 256)
    throw new Error('Invalid skill share nudge resolution');
  validateId(value.pendingId, 'pendingId');
  return {
    ...origin,
    pendingId: value.pendingId,
    target: value.target,
    resolution: value.resolution,
  };
}

export function registerSkillShareNudgeHandlers(
  resolveCaller: DesktopIpcCallerResolver,
): () => void {
  const senders = new Map<number, WebContents>();
  const remember = (sender: WebContents): void => {
    if (senders.has(sender.id)) return;
    senders.set(sender.id, sender);
    sender.once('destroyed', () => senders.delete(sender.id));
  };
  const unsubscribe = skillShareNudgeState.subscribe((origin) => {
    for (const sender of Array.from(senders.values())) {
      if (sender.isDestroyed()) continue;
      try {
        sendToWebContents(sender, SKILL_SHARE_NUDGE_CHANNELS.changed, origin);
      } catch {
        /* A closing window must not fail an already durable resolution. */
      }
    }
  });
  registerIpcHandler<[unknown], IPCResult<PendingSkillShareNudge | null>>(
    SKILL_SHARE_NUDGE_CHANNELS.getPending,
    (event, value) => {
      resolveCaller(event);
      const origin = validateSkillShareNudgeOrigin(value);
      remember(event.sender);
      return {
        success: true,
        data: skillShareNudgeState.getPending(origin, event.sender.id),
      };
    },
  );
  registerIpcHandler<[unknown], IPCResult<boolean>>(
    SKILL_SHARE_NUDGE_CHANNELS.resolve,
    async (event, value) => {
      resolveCaller(event);
      const request = validateSkillShareNudgeResolution(value);
      remember(event.sender);
      try {
        return {
          success: true,
          data: await skillShareNudgeState.resolve(request, event.sender.id),
        };
      } catch {
        // No registry identities or skill content in diagnostics/errors.
        // eslint-disable-next-line no-console
        console.error('Failed to persist local share suggestion resolution');
        return {
          success: false,
          error: 'Could not save share suggestion state. Please retry.',
        };
      }
    },
  );
  return () => {
    unsubscribe();
    senders.clear();
  };
}

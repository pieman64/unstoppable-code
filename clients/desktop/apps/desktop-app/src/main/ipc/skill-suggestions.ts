import type { WebContents } from 'electron';
import {
  isSkillSuggestionResolution,
  SKILL_SUGGESTION_CHANNELS,
  SKILL_SUGGESTION_MODAL_SOURCE,
  type PendingSkillSuggestion,
  type ResolveSkillSuggestionRequest,
  type SkillSuggestion,
  type SkillSuggestionOrigin,
} from '@canopy/desktop-shared/lib/skill-suggestions';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import { validateId } from '../lib/validation';
import { sendToWebContents } from '../lib/web-contents-send';
import { skillSuggestionSurfacing } from '../skill-suggestions';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 256) {
    throw new Error('Invalid skill suggestion request');
  }
  validateId(value, name);
  return value;
}

export function validateSkillSuggestionOrigin(
  value: unknown,
): SkillSuggestionOrigin {
  if (!record(value)) throw new Error('Invalid skill suggestion origin');
  return {
    projectId: boundedId(value.projectId, 'projectId'),
    worktreeId: boundedId(value.worktreeId, 'worktreeId'),
    chatId: boundedId(value.chatId, 'chatId'),
  };
}

export function validateSkillSuggestionResolveRequest(
  value: unknown,
): ResolveSkillSuggestionRequest {
  if (!record(value)) throw new Error('Invalid skill suggestion resolution');
  const suggestionId = boundedId(value.suggestionId, 'suggestionId');
  if (value.source === SKILL_SUGGESTION_MODAL_SOURCE) {
    if (value.resolution !== 'dismissed' && value.resolution !== 'accepted') {
      throw new Error('Invalid skill suggestion resolution');
    }
    return {
      source: SKILL_SUGGESTION_MODAL_SOURCE,
      suggestionId,
      resolution: value.resolution,
    };
  }
  if (
    value.source !== 'banner' ||
    !isSkillSuggestionResolution(value.resolution)
  ) {
    throw new Error('Invalid skill suggestion resolution');
  }
  return {
    ...validateSkillSuggestionOrigin(value),
    source: 'banner',
    pendingId: boundedId(value.pendingId, 'pendingId'),
    suggestionId,
    resolution: value.resolution,
  };
}

/**
 * Repeat-task skill suggestion IPC (CAN-385). `getPending` and `list` return
 * nothing while the feature gate is closed; `resolve` stays available so
 * pending resolution retries can drain.
 */
export function registerSkillSuggestionHandlers(
  resolveCaller: DesktopIpcCallerResolver,
): () => void {
  const senders = new Map<number, WebContents>();
  const remember = (sender: WebContents): void => {
    if (senders.has(sender.id)) return;
    senders.set(sender.id, sender);
    sender.once('destroyed', () => senders.delete(sender.id));
  };
  const unsubscribe = skillSuggestionSurfacing.subscribe((event) => {
    for (const sender of Array.from(senders.values())) {
      if (sender.isDestroyed()) continue;
      try {
        sendToWebContents(sender, SKILL_SUGGESTION_CHANNELS.changed, event);
      } catch {
        /* A closing window must not fail an already durable resolution. */
      }
    }
  });
  registerIpcHandler<[unknown], IPCResult<PendingSkillSuggestion | null>>(
    SKILL_SUGGESTION_CHANNELS.getPending,
    (event, value) => {
      resolveCaller(event);
      const origin = validateSkillSuggestionOrigin(value);
      remember(event.sender);
      return {
        success: true,
        data: skillSuggestionSurfacing.getPending(origin, event.sender.id),
      };
    },
  );
  registerIpcHandler<[], IPCResult<SkillSuggestion[]>>(
    SKILL_SUGGESTION_CHANNELS.list,
    async (event) => {
      resolveCaller(event);
      remember(event.sender);
      try {
        return { success: true, data: await skillSuggestionSurfacing.list() };
      } catch {
        // eslint-disable-next-line no-console
        console.error('Failed to read local skill suggestions');
        return { success: false, error: 'Could not load skill suggestions.' };
      }
    },
  );
  registerIpcHandler<[unknown], IPCResult<boolean>>(
    SKILL_SUGGESTION_CHANNELS.resolve,
    async (event, value) => {
      resolveCaller(event);
      const request = validateSkillSuggestionResolveRequest(value);
      remember(event.sender);
      try {
        return {
          success: true,
          data: await skillSuggestionSurfacing.resolve(
            request,
            event.sender.id,
          ),
        };
      } catch {
        // No suggestion content in diagnostics or errors.
        // eslint-disable-next-line no-console
        console.error('Failed to persist local skill suggestion resolution');
        return {
          success: false,
          error: 'Could not save skill suggestion state. Please retry.',
        };
      }
    },
  );
  return () => {
    unsubscribe();
    senders.clear();
  };
}

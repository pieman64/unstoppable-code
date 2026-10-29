import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';

export type DelegationReadAction = Extract<
  AppAdvisorAction,
  {
    type:
      | 'delegation.tree'
      | 'delegation.roots'
      | 'delegation.transcript'
      | 'delegation.worktree_summary';
  }
>;
export function isDelegationReadAction(
  action: AppAdvisorAction,
): action is DelegationReadAction {
  return [
    'delegation.tree',
    'delegation.roots',
    'delegation.transcript',
    'delegation.worktree_summary',
  ].includes(action.type);
}
/** Convert known portable DTOs without bypassing the action JSON contract. */
function json(value: unknown): AppAdvisorJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, AppAdvisorJson> = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) result[key] = json(item);
    return result;
  }
  throw new Error('Invalid delegation projection');
}
export async function dispatchDelegationReadAction(
  action: DelegationReadAction,
): Promise<Omit<AppAdvisorActionResponse, 'requestId'>> {
  try {
    validateId(action.projectId, 'projectId');
    validateId(action.worktreeId, 'worktreeId');
    if ('chatId' in action) validateId(action.chatId, 'chatId');
    if ('delegationId' in action)
      validateId(action.delegationId, 'delegationId');
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_target', message: 'Invalid delegation target.' },
    };
  }
  try {
    const service = await import('../agents/delegation/service');
    switch (action.type) {
      case 'delegation.tree':
        return {
          ok: true,
          result: json(
            await service.readManagedDelegationTreeForUser({
              projectId: action.projectId,
              worktreeId: action.worktreeId,
              chatId: action.chatId,
            }),
          ),
        };
      case 'delegation.roots':
        return {
          ok: true,
          result: json(
            await service.readManagedDelegationRootsForUser({
              projectId: action.projectId,
              worktreeId: action.worktreeId,
            }),
          ),
        };
      case 'delegation.transcript': {
        const result = await service.readManagedDelegationTranscriptForUser({
          projectId: action.projectId,
          worktreeId: action.worktreeId,
          chatId: action.chatId,
          delegationId: action.delegationId,
          ...(action.beforeSequence === undefined
            ? {}
            : { beforeSequence: action.beforeSequence }),
          ...(action.limit === undefined ? {} : { limit: action.limit }),
          ...(action.runGeneration === undefined
            ? {}
            : { runGeneration: action.runGeneration }),
        });
        return result.ok
          ? { ok: true, result: json(result) }
          : {
              ok: false,
              error: { code: 'invalid_target', message: result.error },
            };
      }
      case 'delegation.worktree_summary': {
        if (!/^[a-f0-9]{40,64}$/.test(action.revision))
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'Invalid starting revision.',
            },
          };
        return {
          ok: true,
          result: json(
            await service.readManagedDelegationWorktreeSummaryForUser(
              { projectId: action.projectId, worktreeId: action.worktreeId },
              action.delegationId,
              action.revision,
              AbortSignal.timeout(30_000),
            ),
          ),
        };
      }
    }
  } catch {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: "Couldn't read the delegation.",
      },
    };
  }
}

import { ResourceContextUnavailableError } from '../lib/resource-context-error';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import {
  assertResourceContextSnapshot,
  resourceContextEnabled,
  resourceContextSnapshot,
} from '../lib/resource-context';
import { validateId } from '../lib/validation';

/** Bind a local catalog write to the project and session that authorized it. */
export async function createPortalCollectionWriteGuard(
  projectId: string,
  sessionIsCurrent?: () => boolean,
): Promise<() => Promise<void>> {
  try {
    validateId(projectId, 'projectId');
  } catch {
    throw Object.assign(new Error('Invalid project id.'), {
      code: 'invalid_payload',
    });
  }
  const snapshot = await resourceContextSnapshot();
  const { resolveBackgroundWorkspaceContext } =
    await import('./background-execution-context');
  const projectContext = await resolveBackgroundWorkspaceContext(projectId);
  const assertSession = (): void => {
    if (sessionIsCurrent && !sessionIsCurrent())
      throw Object.assign(new Error('The session is no longer authorized.'), {
        code: 'permission_denied',
      });
  };
  return async () => {
    try {
      assertSession();
      await assertResourceContextSnapshot(snapshot);
      if (
        (await resolveBackgroundWorkspaceContext(projectId)) !==
          projectContext ||
        (resourceContextEnabled() &&
          serializeWorkspaceContext(
            getWorkspaceContextService().getState().context,
          ) !== projectContext)
      )
        throw Object.assign(
          new Error('The project context changed or is unavailable.'),
          { code: 'permission_denied' },
        );
      await assertResourceContextSnapshot(snapshot);
      assertSession();
    } catch (error) {
      if (error instanceof ResourceContextUnavailableError)
        throw Object.assign(new Error(error.message), {
          code: 'permission_denied',
        });
      throw error;
    }
  };
}

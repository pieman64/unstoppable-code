import type { WorkerScriptContext } from '@canopy/protocol/canopy-core';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';

import type { FilesystemScopeCatalog } from '../../filesystem/scope-reader';

/**
 * The directory a script context runs in, from the scope's filesystem root
 * catalog (CAN-5087): `project` and `workspace-root` use the root whose id is
 * the workspace id, else `__workspace_root__`; `workspace-repo` uses the root
 * with its repo id. `null` for other contexts or a missing root. Both the
 * daemon and Electron main's routing check use it.
 */
export function scriptContextDirectory(
  catalog: Pick<FilesystemScopeCatalog, 'byId'>,
  scope: { readonly workspaceId: string },
  context: WorkerScriptContext,
): string | null {
  const root =
    context.kind === 'project' || context.kind === 'workspace-root'
      ? (catalog.byId.get(scope.workspaceId) ??
        catalog.byId.get(WORKSPACE_ROOT_REPO_ID))
      : context.kind === 'workspace-repo'
        ? catalog.byId.get(context.repoId)
        : undefined;
  if (root === undefined || root.kind === 'attachments') return null;
  return root.absolutePath;
}

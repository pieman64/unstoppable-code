import type { CodeGraphRepositoryInput } from '../../../types/code-graph';
import { setMetadataValue, type CodeGraphDatabase } from '../store/database';
import type { CodeGraphStore } from '../store/graph-store';
import type { CodeGraphBuildTimer } from '../build-timings';
import { resolveConfigExtendsEdges } from './config-extends-resolver';
import { resolveDocLinkEdges } from './doc-link-resolver';
import { resolveImportEdges } from './import-edge-resolver';
import { resolveIpcEdges } from './ipc-resolver';
import { linkTests } from './test-linker';
import { TsModuleResolver } from './ts-module-resolver';
import { resolveCallEdges } from './call-resolver';
import { SqliteResolutionProjection } from './resolution-projection';
import { resolveWorkflowActionEdges } from './workflow-action-resolver';
import type { ResolutionProjectionCounters } from './resolution-projection';

/**
 * Recompute every binding in the same order as the full-reset oracle, while
 * keeping proposals in worker-local TEMP tables until all passes succeed.
 */
export function runFullResolutionDiff(
  db: CodeGraphDatabase,
  store: CodeGraphStore,
  repositories: readonly CodeGraphRepositoryInput[],
  timer: CodeGraphBuildTimer,
): ResolutionProjectionCounters {
  const projection = timer.measure(
    'resetMs',
    () => new SqliteResolutionProjection(db, store),
  );
  try {
    for (const repository of repositories) {
      const resolver = new TsModuleResolver(repository.rootPath);
      timer.measure('importsMs', () =>
        resolveImportEdges({
          store: projection,
          resolver,
          repoId: repository.repoId,
          rootPath: repository.rootPath,
        }),
      );
      setMetadataValue(
        db,
        `resolution_inputs:${repository.repoId}`,
        JSON.stringify(resolver.getInputFingerprints()),
      );
      timer.measure('configExtendsMs', () =>
        resolveConfigExtendsEdges({
          store: projection,
          repoId: repository.repoId,
          rootPath: repository.rootPath,
        }),
      );
      timer.measure('docLinksMs', () =>
        resolveDocLinkEdges({
          store: projection,
          repoId: repository.repoId,
          rootPath: repository.rootPath,
        }),
      );
      timer.measure('ipcMs', () =>
        resolveIpcEdges({ store: projection, repoId: repository.repoId }),
      );
      timer.measure('workflowActionsMs', () =>
        resolveWorkflowActionEdges({
          store: projection,
          repoId: repository.repoId,
        }),
      );
      timer.measure('callsMs', () =>
        resolveCallEdges({ store: projection, repoId: repository.repoId }),
      );
      timer.measure('testsMs', () =>
        linkTests({ store: projection, repoId: repository.repoId }),
      );
    }
    const counters = projection.apply();
    timer.persist(
      'resetMs',
      'importsMs',
      'configExtendsMs',
      'docLinksMs',
      'ipcMs',
      'workflowActionsMs',
      'callsMs',
      'testsMs',
    );
    return counters;
  } finally {
    // Any resolver/apply/cleanup error propagates through the engine's outer
    // build transaction, so facts, bindings, FTS, summary and markers roll back.
    projection.close();
  }
}

import { z } from 'zod';
import {
  getMetadataValue,
  setMetadataValue,
  type CodeGraphDatabase,
} from '../store/database';
import { TsModuleResolver } from './ts-module-resolver';
import { resolveImportEdges } from './import-edge-resolver';
import { resolveConfigExtendsEdges } from './config-extends-resolver';
import { resolveDocLinkEdges } from './doc-link-resolver';
import { resolveIpcEdges } from './ipc-resolver';
import { resolveWorkflowActionEdges } from './workflow-action-resolver';
import { resolveCallEdges } from './call-resolver';
import { linkTests } from './test-linker';
import {
  CapturedResolutionProjectionStore,
  ResolutionDependencyCapture,
  RESOLUTION_CAPTURE_RESOLVERS,
  type ResolutionCaptureResolver,
  type ResolutionDependencyCaptureSnapshot,
  type TrustedResolutionDependencyPrior,
} from './resolution-dependency-capture';
import { SqliteResolutionDependencyWriter } from './resolution-dependency-store';
import type { ResolutionProjectionStore } from './resolution-projection';

/** Kept separate from engine's untouched default full-reset oracle branch. */
export function runCapturedRepositoryResolution(input: {
  db: CodeGraphDatabase;
  store: ResolutionProjectionStore;
  repoId: string;
  rootPath: string;
  sourceFileIds?: readonly string[];
  trustedPrior?: TrustedResolutionDependencyPrior;
  incompleteReasons?: readonly string[];
  /** Existing timer may be supplied; it must not affect resolver selection. */
  measure?: (
    resolver: ResolutionCaptureResolver,
    operation: () => number,
  ) => number;
}): ResolutionDependencyCaptureSnapshot {
  const writer = new SqliteResolutionDependencyWriter(input.db);
  try {
    const capture = new ResolutionDependencyCapture(
      input.repoId,
      input.rootPath,
      writer,
      input.trustedPrior,
    );
    const store = new CapturedResolutionProjectionStore(input.store, capture);
    for (const reason of input.incompleteReasons ?? []) {
      for (const resolver of RESOLUTION_CAPTURE_RESOLVERS)
        capture.markIncomplete(resolver, reason);
    }
    const run = (
      resolver: ResolutionCaptureResolver,
      operation: () => number,
    ): void => {
      capture.beginResolver(resolver, input.sourceFileIds);
      // Exceptions deliberately escape: never swap paths halfway through a build.
      if (input.measure === undefined) operation();
      else input.measure(resolver, operation);
      capture.finishResolver(resolver, input.sourceFileIds);
    };
    const resolver = new TsModuleResolver(input.rootPath, capture);
    run('ts-module-resolution', (): number =>
      resolveImportEdges({
        store,
        resolver,
        repoId: input.repoId,
        rootPath: input.rootPath,
        capture,
        sourceFileIds: input.sourceFileIds,
      }),
    );
    // Preserve resolution_inputs validation, including unchanged sources' probes
    // in a selective pass. Full passes replace it with their complete observation.
    const fresh = resolver.getInputFingerprints();
    let fingerprints: Record<string, string | null> = fresh;
    if (input.sourceFileIds !== undefined) {
      const previous = getMetadataValue(
        input.db,
        `resolution_inputs:${input.repoId}`,
      );
      if (previous === null)
        throw new Error(
          'Selective imports require validated prior resolution_inputs',
        );
      let raw: unknown;
      try {
        raw = JSON.parse(previous);
      } catch {
        throw new Error('Invalid prior resolution_inputs');
      }
      const parsed = z.record(z.string(), z.string().nullable()).safeParse(raw);
      if (!parsed.success) throw new Error('Invalid prior resolution_inputs');
      fingerprints = { ...parsed.data, ...fresh };
    }
    setMetadataValue(
      input.db,
      `resolution_inputs:${input.repoId}`,
      JSON.stringify(fingerprints),
    );
    run('config-extends', (): number =>
      resolveConfigExtendsEdges({
        store,
        repoId: input.repoId,
        rootPath: input.rootPath,
        capture,
        sourceFileIds: input.sourceFileIds,
      }),
    );
    run('doc-link', (): number =>
      resolveDocLinkEdges({
        store,
        repoId: input.repoId,
        rootPath: input.rootPath,
        capture,
        sourceFileIds: input.sourceFileIds,
      }),
    );
    run('ipc-channel', (): number =>
      resolveIpcEdges({
        store,
        repoId: input.repoId,
        capture,
        sourceFileIds: input.sourceFileIds,
      }),
    );
    run('workflow-action', (): number =>
      resolveWorkflowActionEdges({
        store,
        repoId: input.repoId,
        capture,
        sourceFileIds: input.sourceFileIds,
      }),
    );
    run('call-resolution', (): number =>
      resolveCallEdges({
        store,
        repoId: input.repoId,
        capture,
        sourceFileIds: input.sourceFileIds,
      }),
    );
    run('test-linker', (): number =>
      linkTests({
        store,
        repoId: input.repoId,
        capture,
        sourceFileIds: input.sourceFileIds,
      }),
    );
    return capture.finishRepository();
  } finally {
    writer.close();
  }
}

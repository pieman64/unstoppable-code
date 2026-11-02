import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  SharedMultiRepoCreateCommandSchema,
  PrepareSharedMultiRepoParamsSchema,
  CORE_SHARED_MULTI_REPO_QUERIES,
} from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

/** Authenticated thin projections; native paths never enter core DTOs. */
export function registerSharedMultiRepoHandlers(runtime: {
  dispatcher: Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;
  resolveCaller: DesktopIpcCallerResolver;
}): void {
  registerIpcHandler(
    IPC_CHANNELS.orgProjectsSharedMultiRepoPrepare,
    (event, request: unknown) =>
      runtime.dispatcher.query(
        'core.workspace.sharedMultiRepo.prepare',
        PrepareSharedMultiRepoParamsSchema.parse(request),
        {
          caller: {
            ...runtime.resolveCaller(event),
            grants: ['core.workspace.read'],
          },
        },
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.orgProjectsSharedMultiRepoCreate,
    (event, request: unknown) =>
      runtime.dispatcher.instruction(
        'core.workspace.sharedMultiRepo.create',
        SharedMultiRepoCreateCommandSchema.parse(request),
        {
          caller: {
            ...runtime.resolveCaller(event),
            grants: ['core.workspace.write'],
          },
        },
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.orgProjectsSharedMultiRepoGetCreation,
    (event, request: unknown) =>
      runtime.dispatcher.query(
        'core.workspace.sharedMultiRepo.getCreation',
        CORE_SHARED_MULTI_REPO_QUERIES[
          'core.workspace.sharedMultiRepo.getCreation'
        ].params.parse(request),
        {
          caller: {
            ...runtime.resolveCaller(event),
            grants: ['core.workspace.read'],
          },
        },
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.orgProjectsSharedMultiRepoListCreations,
    (event, request: unknown) =>
      runtime.dispatcher.query(
        'core.workspace.sharedMultiRepo.listCreations',
        CORE_SHARED_MULTI_REPO_QUERIES[
          'core.workspace.sharedMultiRepo.listCreations'
        ].params.parse(request),
        {
          caller: {
            ...runtime.resolveCaller(event),
            grants: ['core.workspace.read'],
          },
        },
      ),
  );
}

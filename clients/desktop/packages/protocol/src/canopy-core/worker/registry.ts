import {
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStreamRegistry,
} from '../definitions';
import {
  WorkerFilesystemDirectoryListParamsSchema,
  WorkerFilesystemDirectoryListErrorSchema,
  WorkerFilesystemDirectoryListResultSchema,
  WorkerFilesystemRootsListParamsSchema,
  WorkerFilesystemRootsListErrorSchema,
  WorkerFilesystemRootsListResultSchema,
} from './filesystem';

export const WORKER_QUERY_DEFINITIONS = defineCanopyQueryRegistry('worker', {
  'worker.filesystem.roots.list': defineCanopyQuery({
    plane: 'worker',
    domain: 'filesystem',
    version: 1,
    placement: 'target-selectable',
    params: WorkerFilesystemRootsListParamsSchema,
    result: WorkerFilesystemRootsListResultSchema,
    error: WorkerFilesystemRootsListErrorSchema,
    idempotency: 'inherent',
    requiredGrants: ['worker.filesystem.read'],
  }),
  'worker.filesystem.directory.list': defineCanopyQuery({
    plane: 'worker',
    domain: 'filesystem',
    version: 1,
    placement: 'target-selectable',
    params: WorkerFilesystemDirectoryListParamsSchema,
    result: WorkerFilesystemDirectoryListResultSchema,
    error: WorkerFilesystemDirectoryListErrorSchema,
    idempotency: 'inherent',
    requiredGrants: ['worker.filesystem.read'],
  }),
});
export const WORKER_INSTRUCTION_DEFINITIONS = defineCanopyInstructionRegistry(
  'worker',
  {},
);
export const WORKER_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'worker',
  {},
);

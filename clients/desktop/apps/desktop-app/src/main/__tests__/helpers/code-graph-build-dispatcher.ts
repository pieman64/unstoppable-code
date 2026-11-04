import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import type { WorkerCodeGraphHandlers } from '@canopy/core-runtime/node/code-graph';
import { createWorkerCodeGraphAdapter } from '../../canopy-runtime/worker-code-graph-adapter';
import { setCodeGraphBuildDispatcherForTests } from '../../code-graph/graph-builds';

/**
 * Routes Electron main's agent builds through a dispatcher over the real
 * `worker.codeGraph` build definitions and adapter, as the desktop runtime
 * does, without composing the whole runtime. Returns the uninstall.
 */
export function installCodeGraphBuildDispatcherForTests(
  adapter: WorkerCodeGraphHandlers = createWorkerCodeGraphAdapter(),
): () => void {
  const dispatcher = createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
      instructions: WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: adapter.queries,
      instructions: adapter.instructions,
      streams: {},
    },
  });
  // The helper's dispatcher serves only the code-graph subset of the desktop's.
  setCodeGraphBuildDispatcherForTests(dispatcher);
  return () => setCodeGraphBuildDispatcherForTests(null);
}
